/**
 * 模块 3：呆滞品多轮出库核扣（分页防卡死 + 三级回溯 + 红字退库冲减）
 * 独立隔离模块：与现有生产工具完全隔离。
 */
(function () {
  'use strict';
  const U = WB.Utils;

  let state = {
    baseSheets: {},      // { sheetName: { headers, rows } }
    sheetNames: [],
    activeSheet: '',
    flowCount: 0,
    matchedCount: 0,
    periodLabel: '',
    page: 1,
    consumeLog: []
  };

  function persistState() {
    WB.Store.save('mod_stagnant', {
      baseSheets: state.baseSheets,
      sheetNames: state.sheetNames,
      activeSheet: state.activeSheet,
      flowCount: state.flowCount,
      matchedCount: state.matchedCount,
      periodLabel: state.periodLabel,
      consumeLog: state.consumeLog
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_stagnant');
    if (saved) {
      state.baseSheets = saved.baseSheets || {};
      state.sheetNames = saved.sheetNames || [];
      state.activeSheet = saved.activeSheet || state.sheetNames[0] || '';
      state.flowCount = saved.flowCount || 0;
      state.matchedCount = saved.matchedCount || 0;
      state.periodLabel = saved.periodLabel || '';
      state.consumeLog = saved.consumeLog || [];
    }
  }

  function parseRemaining(val) {
    const s = U.cleanStr(val);
    if (!s || s === '0' || s === '0.0') return null;
    if (s.includes('全部出库')) return 0;
    const m = s.match(/剩余\s*([+-]?\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function detectCols(headers) {
    let codeCol = headers.findIndex(h => /物料编码|存货编码|物资编码/.test(h));
    let baseCol = headers.findIndex(h => /结存主数量|结存数量/.test(h));
    const histCols = [];
    headers.forEach((h, i) => {
      if (h.includes('出库数量') && !h.includes('总数量')) histCols.push(i);
    });
    if (codeCol < 0) codeCol = 3;
    if (baseCol < 0) baseCol = 6;
    return { codeCol, baseCol, histCols };
  }

  function getBacktrackedBase(row, baseCol, histCols) {
    for (let i = histCols.length - 1; i >= 0; i--) {
      const rem = parseRemaining(row[histCols[i]]);
      if (rem !== null) return { qty: rem, hasHistory: true };
    }
    return { qty: U.parseNum(row[baseCol]), hasHistory: false };
  }

  async function loadBaseFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const sheets = {};
    const names = [];
    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      if (/Sheet\d+/i.test(sn) && aoa.length <= 2) return;
      names.push(sn);
      sheets[sn] = {
        headers: aoa[0].map(h => U.cleanStr(h)),
        rows: aoa.slice(1).map(r => r.map(v => U.cleanStr(v)))
      };
    });
    state.baseSheets = sheets;
    state.sheetNames = names;
    state.activeSheet = names[0] || '';
    state.page = 1;
    persistState();
    U.toast(`已载入呆滞品底表：${names.join(' / ')}`, 'success');
  }

  async function applyFlowFile(file) {
    if (!state.sheetNames.length) {
      U.toast('请先上传【呆滞品底表】', 'warn');
      return;
    }
    const parsed = await U.readSpreadsheet(file);
    const aoa = parsed.sheets[parsed.sheetNames[0]] || [];
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      if (aoa[i].join(' ').includes('编码')) { hdrIdx = i; break; }
    }
    const fh = aoa[hdrIdx].map(v => U.cleanStr(v));
    const iWh = fh.findIndex(h => h.includes('仓库'));
    const iCode = fh.findIndex(h => /物料编码|存货编码|物资编码/.test(h));
    const iQty = fh.findIndex(h => /实发数量|出库主数量|出库数量|数量/.test(h));
    const iDate = fh.findIndex(h => /日期/.test(h));
    const iName = fh.findIndex(h => /名称/.test(h));
    if (iCode < 0 || iQty < 0) throw new Error('流水账未找到物料编码或数量列');

    const colTitle = state.periodLabel.trim() || `本期出库数量`;
    const flowByWhCode = new Map();
    let flowCount = 0;
    const rawFlowEntries = [];

    for (let i = hdrIdx + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const code = U.formatCode(r[iCode], true);
      const qty = U.parseNum(r[iQty]);
      if (!code || /合计|总计/.test(code) || Math.abs(qty) < 1e-9) continue;
      flowCount++;
      const wh = iWh >= 0 ? U.cleanStr(r[iWh]) : '';
      const key = `${wh}||${code}`;
      flowByWhCode.set(key, (flowByWhCode.get(key) || 0) + qty);
      rawFlowEntries.push({
        key,
        row: [iDate >= 0 ? U.formatDate(r[iDate]) : '', wh, code, iName >= 0 ? U.cleanStr(r[iName]) : '', qty]
      });
    }

    let matched = 0;
    const matchedFlowKeys = new Set();
    state.sheetNames.forEach(sn => {
      if (sn.includes('消耗') || sn.includes('统计')) return;
      const sh = state.baseSheets[sn];
      const { codeCol, baseCol, histCols } = detectCols(sh.headers);
      sh.headers.push(colTitle);
      const newColIdx = sh.headers.length - 1;

      // 按编码分组，优先扣减前轮有活动记录的行，兼容红字退库（负数量）
      const groups = new Map();
      sh.rows.forEach((row, rIdx) => {
        while (row.length < sh.headers.length) row.push('');
        const rawCode = U.cleanStr(row[codeCol]);
        if (!rawCode || /合计|总计/.test(rawCode)) return;
        const code = U.formatCode(rawCode, true);
        row[codeCol] = code;
        if (!code) return;
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(rIdx);
      });

      const cleanSn = sn.replace(/呆滞.*/, '').trim();
      groups.forEach((rIndices, code) => {
        // 匹配同仓库或无仓库标识的全局流水（避免 cleanSn 为空时跨仓误匹配）
        let delta = 0;
        for (const [k, v] of flowByWhCode.entries()) {
          const [fWh, fCode] = k.split('||');
          const whMatch = !fWh || sn.includes(fWh) || (cleanSn && fWh.includes(cleanSn));
          if (fCode === code && whMatch) {
            delta += v;
            matchedFlowKeys.add(k);
          }
        }
        if (Math.abs(delta) < 1e-9) return;
        matched++;

        // 排序：前轮有记录的行优先
        const sorted = [...rIndices].sort((a, b) => {
          const ha = getBacktrackedBase(sh.rows[a], baseCol, histCols).hasHistory ? 0 : 1;
          const hb = getBacktrackedBase(sh.rows[b], baseCol, histCols).hasHistory ? 0 : 1;
          return ha - hb;
        });

        let remainDelta = delta;
        for (const rIdx of sorted) {
          if (Math.abs(remainDelta) < 1e-9) break;
          const { qty: baseRem } = getBacktrackedBase(sh.rows[rIdx], baseCol, histCols);
          if (remainDelta > 0) {
            if (baseRem <= 0) continue;
            const take = Math.min(baseRem, remainDelta);
            const after = baseRem - take;
            sh.rows[rIdx][newColIdx] = after <= 1e-9 ? `出库${U.fmtNum(take)}，全部出库` : `出库${U.fmtNum(take)}，剩余${U.fmtNum(after)}`;
            remainDelta -= take;
          } else {
            // 红字退库冲减（允许对已“全部出库”行回冲）
            const refund = Math.abs(remainDelta);
            const after = baseRem + refund;
            sh.rows[rIdx][newColIdx] = `退库${U.fmtNum(refund)}，剩余${U.fmtNum(after)}`;
            remainDelta = 0;
          }
        }
      });
    });

    const consumeLog = rawFlowEntries.filter(e => matchedFlowKeys.has(e.key)).map(e => e.row);
    state.flowCount = flowCount;
    state.matchedCount = matched;
    state.consumeLog = consumeLog;
    persistState();
    U.toast(`核扣完成：流水 ${flowCount} 笔，命中呆滞品 ${matched} 项（已新增列：${colTitle}）`, 'success');
  }

  function renderModule(root) {
    const cur = state.baseSheets[state.activeSheet];
    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>🧱 呆滞品多轮核扣（分页防卡死 · 11位前导0强保 · 红字退库冲减）</span>
          <span class="pill pill-blue">${state.sheetNames.length ? '已加载 ' + state.sheetNames.length + ' 个工作表' : '待导入底表'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">当前工作表行数</div><div class="kpi-val">${cur ? cur.rows.length : 0}</div></div>
          <div class="kpi-card"><div class="kpi-label">本期导入流水笔数</div><div class="kpi-val">${state.flowCount}</div></div>
          <div class="kpi-card green"><div class="kpi-label">命中核扣编码数</div><div class="kpi-val">${state.matchedCount}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="s-up-base">📂 1. 导入上一轮呆滞品底表</button>
          <input type="file" id="s-in-base" accept=".xlsx,.xls" class="hidden-input" />
          <input type="text" id="s-period" value="${U.escHtml(state.periodLabel)}" placeholder="新列名，如：11.15-11.22出库数量" style="width:210px;" />
          <button class="btn btn-warning" id="s-up-flow">📥 2. 导入本期出入库流水账</button>
          <input type="file" id="s-in-flow" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <span style="flex:1"></span>
          <button class="btn btn-success" id="s-exp" ${!state.sheetNames.length ? 'disabled' : ''}>💾 导出核扣后总表 (.xlsx)</button>
        </div>
      </div>

      <div class="panel">
        <div class="toolbar">
          ${state.sheetNames.map(sn => `<button class="btn ${sn === state.activeSheet ? 'btn-primary' : ''}" data-sn="${U.escHtml(sn)}">${U.escHtml(sn)}</button>`).join('')}
        </div>
        <div id="s-table-box"></div>
      </div>
    `;

    root.querySelector('#s-period').oninput = e => { state.periodLabel = e.target.value; };
    const inBase = root.querySelector('#s-in-base');
    root.querySelector('#s-up-base').onclick = () => inBase.click();
    inBase.onchange = async e => { if (e.target.files[0]) { await loadBaseFile(e.target.files[0]); renderModule(root); } e.target.value = ''; };

    const inFlow = root.querySelector('#s-in-flow');
    root.querySelector('#s-up-flow').onclick = () => inFlow.click();
    inFlow.onchange = async e => {
      if (e.target.files[0]) {
        try { await applyFlowFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('核扣异常：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    root.querySelectorAll('button[data-sn]').forEach(btn => {
      btn.onclick = () => { state.activeSheet = btn.dataset.sn; state.page = 1; renderModule(root); };
    });

    root.querySelector('#s-exp').onclick = () => {
      const cfgs = state.sheetNames.map(sn => {
        const sh = state.baseSheets[sn];
        const { codeCol } = detectCols(sh.headers);
        return { name: sn, headers: sh.headers, rows: sh.rows, textCols: [codeCol] };
      });
      if (state.consumeLog.length) {
        cfgs.push({ name: '本期消耗量统计', headers: ['日期', '仓库', '物料编码', '物料名称', '出库/退库数量'], rows: state.consumeLog, textCols: [2], numCols: [4] });
      }
      U.exportWorkbook(cfgs, `呆滞品核扣结果.xlsx`);
      U.toast('已导出呆滞品核扣结果.xlsx', 'success');
    };

    if (cur) {
      U.renderPagedTable(root.querySelector('#s-table-box'), {
        headers: cur.headers,
        rows: cur.rows,
        page: state.page,
        pageSize: 100,
        rowClassFn: r => {
          const last = r[r.length - 1] || '';
          if (last.includes('全部出库')) return 'row-ok';
          if (last.includes('剩余') || last.includes('退库')) return 'row-warn';
          return '';
        },
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else {
      root.querySelector('#s-table-box').innerHTML = `<div class="empty-cell">请导入呆滞品底表开始核扣</div>`;
    }
  }

  WB.register({
    id: 'mod_stagnant',
    icon: '🧱',
    title: '呆滞品核扣',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      for (const f of files) {
        if (/流水|出库单/i.test(f.name)) await applyFlowFile(f);
        else await loadBaseFile(f);
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
