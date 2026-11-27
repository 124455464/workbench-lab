/**
 * 模块 3：呆滞品多轮出库核扣（分页防卡死 + 三级回溯 + 红字退库冲减）
 * 独立隔离模块：与现有生产工具完全隔离。
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const SCHEMA_VER = 2;

  function deepCloneSheets(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  function parseChineseNum(str) {
    const s = String(str || '').trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (s === '十') return 10;
    if (s.includes('十')) {
      const [l, r] = s.split('十');
      const tens = l ? (map[l] || 0) : 1;
      const ones = r ? (map[r] || 0) : 0;
      return tens * 10 + ones;
    }
    return map[s] || 0;
  }

  function toChineseNum(n) {
    const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    if (n <= 0) return String(n);
    if (n < 10) return d[n];
    if (n === 10) return '十';
    if (n < 20) return '十' + d[n % 10];
    if (n < 100) {
      const t = Math.floor(n / 10);
      const o = n % 10;
      return d[t] + '十' + (o ? d[o] : '');
    }
    return String(n);
  }

  /** 自动读取留存底表的最大出库轮次，严格顺延生成下一轮列名（如 第十次出库数量 -> 第十一次出库数量） */
  function detectNextRoundTitle(sheetsObj) {
    let maxRound = 0;
    let hasPlainFirst = false;
    Object.entries(sheetsObj || {}).forEach(([sn, sh]) => {
      if (sn.includes('消耗') || sn.includes('统计')) return;
      (sh.headers || []).forEach(h => {
        const s = U.cleanStr(h);
        const m = s.match(/第([一二三四五六七八九十两\d]+)次出库/);
        if (m) {
          const num = parseChineseNum(m[1]);
          if (num > maxRound) maxRound = num;
        } else if (s === '出库数量') {
          hasPlainFirst = true;
        }
      });
    });
    const next = maxRound > 0 ? maxRound + 1 : (hasPlainFirst ? 2 : 1);
    return `第${toChineseNum(next)}次出库数量`;
  }

  let state = {
    // 留存基线层（默认保留上次导入或上次导出定稿后的底表，下次只拖出库单即可直接算下一轮）
    savedBaseSheets: {},
    savedSheetNames: [],
    savedBaseLabel: '',
    autoSaveOnExport: true,
    // 当前工作层（每次导入材料出库单都从留存基线层干净克隆计算，支持反复多次筛选不扣重）
    baseSheets: {},      // { sheetName: { headers, rows } }
    sheetNames: [],
    activeSheet: '',
    hasPendingRun: false,
    flowFileName: '',
    flowCount: 0,
    matchedCount: 0,
    periodLabel: '',
    page: 1,
    consumeLog: []
  };

  function persistState() {
    WB.Store.save('mod_stagnant', {
      schemaVer: SCHEMA_VER,
      savedBaseSheets: state.savedBaseSheets,
      savedSheetNames: state.savedSheetNames,
      savedBaseLabel: state.savedBaseLabel,
      autoSaveOnExport: state.autoSaveOnExport,
      baseSheets: state.baseSheets,
      sheetNames: state.sheetNames,
      activeSheet: state.activeSheet,
      hasPendingRun: state.hasPendingRun,
      flowFileName: state.flowFileName,
      flowCount: state.flowCount,
      matchedCount: state.matchedCount,
      periodLabel: state.periodLabel,
      consumeLog: state.consumeLog
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_stagnant');
    // 严格校验 schemaVer=2，自动丢弃旧版未分层的脏缓存（防止旧版重复的“本期出库数量”污染留存底表）
    if (saved && saved.schemaVer === SCHEMA_VER) {
      state.savedBaseSheets = saved.savedBaseSheets || {};
      state.savedSheetNames = saved.savedSheetNames || [];
      state.savedBaseLabel = saved.savedBaseLabel || (state.savedSheetNames.length ? '上次留存底表' : '');
      state.autoSaveOnExport = saved.autoSaveOnExport !== undefined ? !!saved.autoSaveOnExport : true;
      state.baseSheets = saved.baseSheets || deepCloneSheets(state.savedBaseSheets);
      state.sheetNames = saved.sheetNames || [...state.savedSheetNames];
      state.activeSheet = saved.activeSheet || state.sheetNames[0] || '';
      state.hasPendingRun = !!saved.hasPendingRun;
      state.flowFileName = saved.flowFileName || '';
      state.flowCount = saved.flowCount || 0;
      state.matchedCount = saved.matchedCount || 0;
      state.periodLabel = saved.periodLabel || (state.savedSheetNames.length ? detectNextRoundTitle(state.savedBaseSheets) : '');
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
      if (sn === '本期消耗量统计') return; // 跳过临时单期统计页
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      if (/Sheet\d+/i.test(sn) && aoa.length <= 2) return;
      names.push(sn);
      sheets[sn] = {
        headers: aoa[0].map(h => U.cleanStr(h)),
        rows: aoa.slice(1).map(r => r.map(v => U.cleanStr(v)))
      };
    });
    // 同时设为留存默认基线 + 当前工作表，并自动推算下一轮列名（如 第十一次出库数量）
    state.savedBaseSheets = deepCloneSheets(sheets);
    state.savedSheetNames = [...names];
    state.savedBaseLabel = file.name;
    state.baseSheets = sheets;
    state.sheetNames = names;
    state.activeSheet = names[0] || '';
    state.hasPendingRun = false;
    state.flowFileName = '';
    state.flowCount = 0;
    state.matchedCount = 0;
    state.consumeLog = [];
    state.periodLabel = detectNextRoundTitle(sheets);
    state.page = 1;
    persistState();
    U.toast(`已留存默认底表：${file.name}（下一轮自动顺延为【${state.periodLabel}】）`, 'success');
  }

  function resetToSavedBase() {
    if (!state.savedSheetNames.length) return;
    state.baseSheets = deepCloneSheets(state.savedBaseSheets);
    state.sheetNames = [...state.savedSheetNames];
    state.activeSheet = state.sheetNames[0] || '';
    state.hasPendingRun = false;
    state.flowFileName = '';
    state.flowCount = 0;
    state.matchedCount = 0;
    state.consumeLog = [];
    state.periodLabel = detectNextRoundTitle(state.savedBaseSheets);
    state.page = 1;
    persistState();
  }

  function clearSavedBase() {
    state.savedBaseSheets = {};
    state.savedSheetNames = [];
    state.savedBaseLabel = '';
    state.baseSheets = {};
    state.sheetNames = [];
    state.activeSheet = '';
    state.hasPendingRun = false;
    state.flowFileName = '';
    state.flowCount = 0;
    state.matchedCount = 0;
    state.consumeLog = [];
    state.periodLabel = '';
    state.page = 1;
    persistState();
  }

  async function applyFlowFile(file) {
    if (!state.savedSheetNames.length && !state.sheetNames.length) {
      U.toast('尚无留存底表，请先导入一次呆滞品底表', 'warn');
      return;
    }
    // 铁律：每次导入材料出库单都从「留存默认底表」干净克隆重算，可无限次重复筛选绝不扣重！
    if (state.savedSheetNames.length) {
      state.baseSheets = deepCloneSheets(state.savedBaseSheets);
      state.sheetNames = [...state.savedSheetNames];
    } else {
      state.savedBaseSheets = deepCloneSheets(state.baseSheets);
      state.savedSheetNames = [...state.sheetNames];
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
    const iName = fh.findIndex(h => /物料名称|存货名称|物资名称/.test(h)) >= 0
      ? fh.findIndex(h => /物料名称|存货名称|物资名称/.test(h))
      : fh.findIndex(h => /名称/.test(h) && !/仓库|部门|组织/.test(h));
    const iUnit = fh.findIndex(h => /^(主单位|主计量单位|计量单位|单位)$/.test(h)) >= 0
      ? fh.findIndex(h => /^(主单位|主计量单位|计量单位|单位)$/.test(h))
      : fh.findIndex(h => /单位/.test(h) && !/领用单位|组织/.test(h));
    if (iCode < 0 || iQty < 0) throw new Error('流水账未找到物料编码或数量列');

    const autoNext = detectNextRoundTitle(state.savedBaseSheets);
    const colTitle = (state.periodLabel || '').trim() || autoNext;
    state.periodLabel = colTitle;
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
        date: iDate >= 0 ? U.formatDate(r[iDate]) : '',
        wh,
        code,
        name: iName >= 0 ? U.cleanStr(r[iName]) : '',
        unit: iUnit >= 0 ? U.cleanStr(r[iUnit]) : '',
        qty
      });
    }

    // 收集底表同编码的默认主单位（流水缺少单位时自动兜底补全）
    const baseUnitByCode = new Map();
    let matched = 0;
    const matchedFlowKeys = new Set();
    state.sheetNames.forEach(sn => {
      if (sn.includes('消耗') || sn.includes('统计')) return;
      const sh = state.baseSheets[sn];
      const { codeCol, baseCol, histCols } = detectCols(sh.headers);
      const unitCol = sh.headers.findIndex(h => /主单位|单位/.test(h));
      sh.headers.push(colTitle);
      const newColIdx = sh.headers.length - 1;

      // 按编码分组，优先扣减前轮有活动记录的行，退库直接按负数冲减
      const groups = new Map();
      sh.rows.forEach((row, rIdx) => {
        while (row.length < sh.headers.length) row.push('');
        const rawCode = U.cleanStr(row[codeCol]);
        if (!rawCode || /合计|总计/.test(rawCode)) return;
        const code = U.formatCode(rawCode, true);
        row[codeCol] = code;
        if (!code) return;
        if (unitCol >= 0 && U.cleanStr(row[unitCol]) && !baseUnitByCode.has(code)) {
          baseUnitByCode.set(code, U.cleanStr(row[unitCol]));
        }
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
            // 红字退库冲减：直接写出负数，不另写退库记录
            const refund = Math.abs(remainDelta);
            const after = baseRem + refund;
            sh.rows[rIdx][newColIdx] = `出库-${U.fmtNum(refund)}，剩余${U.fmtNum(after)}`;
            remainDelta = 0;
          }
        }
      });
    });

    // 探测原「呆滞物资消耗量统计」表末尾最大序号与默认姓名（如图中 266 / 刘凯）
    let nextSeq = 1;
    let defaultPerson = '刘凯';
    const statSn = state.sheetNames.find(sn => sn.includes('消耗') || sn.includes('统计'));
    if (statSn && state.baseSheets[statSn]) {
      const statRows = state.baseSheets[statSn].rows || [];
      for (let i = statRows.length - 1; i >= 0; i--) {
        const seqNum = parseInt(U.cleanStr(statRows[i][0]), 10);
        if (!isNaN(seqNum) && seqNum >= nextSeq) {
          nextSeq = seqNum + 1;
          if (U.cleanStr(statRows[i][2])) defaultPerson = U.cleanStr(statRows[i][2]);
          break;
        }
      }
    }

    // 严格按标准 9 列格式生成消耗量统计：序号 | 日期 | 姓名 | 公司(固定HJF) | 物资编码 | 物资名称 | 单位 | 消耗数量(退库为负数) | 备注
    const consumeLog = rawFlowEntries
      .filter(e => matchedFlowKeys.has(e.key))
      .map(e => {
        const unit = e.unit || baseUnitByCode.get(e.code) || '';
        const numQty = Math.round(e.qty * 1e6) / 1e6; // 正数出库，负数退库
        return [
          nextSeq++,
          e.date,
          defaultPerson,
          'HJF',
          e.code,
          e.name,
          unit,
          numQty,
          ''
        ];
      });

    // 若底表存在「呆滞物资消耗量统计」，同步顺延追加到该表末尾
    if (statSn && state.baseSheets[statSn] && consumeLog.length) {
      const shStat = state.baseSheets[statSn];
      consumeLog.forEach(r => shStat.rows.push(r.map(v => (v === null || v === undefined ? '' : String(v)))));
    }

    state.hasPendingRun = true;
    state.flowFileName = file.name;
    state.flowCount = flowCount;
    state.matchedCount = matched;
    state.consumeLog = consumeLog;
    persistState();
    U.toast(`核扣完成（基于留存底表，可随时重拖其他出库单重算）：流水 ${flowCount} 笔，命中呆滞品 ${matched} 项`, 'success');
  }

  const CONSUME_HEADERS_9 = ['序号', '日期', '姓名', '公司', '物资编码', '物资名称', '单位', '消耗数量', '备注'];

  function renderModule(root) {
    const isConsumeView = state.activeSheet === '__CONSUME__';
    const cur = isConsumeView
      ? { headers: CONSUME_HEADERS_9, rows: state.consumeLog }
      : state.baseSheets[state.activeSheet];
    const hasSavedBase = state.savedSheetNames.length > 0;

    root.innerHTML = `
      <div class="panel" style="background:#f0f9ff;border-color:#7dd3fc;">
        <div class="panel-title" style="margin-bottom:6px;">
          <span>📌 上次留存默认底表（下一次只需直接拖入【材料出库单】即可自动筛选下一轮）</span>
          <span class="pill ${hasSavedBase ? 'pill-green' : 'pill-orange'}">
            ${hasSavedBase ? `当前默认底表：${U.escHtml(state.savedBaseLabel || '已留存底表')}` : '尚未留存底表（请先导入一次初始底表）'}
          </span>
        </div>
        <div class="toolbar" style="margin-bottom:0;">
          <button class="btn" id="s-up-base">📂 ${hasSavedBase ? '更换 / 手动导入新底表' : '导入初始呆滞品底表 (.xlsx)'}</button>
          <input type="file" id="s-in-base" accept=".xlsx,.xls" class="hidden-input" />
          ${state.hasPendingRun ? `<button class="btn btn-warning" id="s-reset-base" title="放弃当前试算结果，还原到上方留存默认底表">↩️ 还原到留存底表</button>` : ''}
          ${hasSavedBase ? `<button class="btn btn-danger" id="s-clear-base" title="清空当前留存底表，重新导入干净底表">🗑️ 清空底表</button>` : ''}
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#0369a1;cursor:pointer;margin-left:6px;">
            <input type="checkbox" id="s-autosave-exp" ${state.autoSaveOnExport ? 'checked' : ''} />
            导出总表时，自动将本次导出结果留存为下一次默认底表
          </label>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">
          <span>🧱 呆滞品出库核扣（可重复多次导入出库单试跑，绝不破坏留存底表 · 公司固定HJF · 退库写负数）</span>
          <span class="pill pill-blue">${state.hasPendingRun ? `当前试算流水：${U.escHtml(state.flowFileName)}` : (hasSavedBase ? '就绪：直接拖入材料出库单即可筛选' : '待导入底表')}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">当前工作表行数</div><div class="kpi-val">${cur ? cur.rows.length : 0}</div></div>
          <div class="kpi-card"><div class="kpi-label">本期导入流水笔数</div><div class="kpi-val">${state.flowCount}</div></div>
          <div class="kpi-card green"><div class="kpi-label">命中核扣编码数</div><div class="kpi-val">${state.matchedCount}</div></div>
          <div class="kpi-card orange"><div class="kpi-label">本期消耗量统计条数</div><div class="kpi-val">${state.consumeLog.length}</div></div>
        </div>
        <div class="toolbar">
          <input type="text" id="s-period" value="${U.escHtml(state.periodLabel)}" placeholder="自动顺延轮次，如：第十一次出库数量" style="width:220px;" />
          <button class="btn btn-primary" id="s-up-flow">📥 导入材料出库单筛选（可重复拖入重算）</button>
          <input type="file" id="s-in-flow" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <span style="flex:1"></span>
          <button class="btn" id="s-copy-consume" ${!state.consumeLog.length ? 'disabled' : ''}>📋 一键复制本期消耗量 (9列)</button>
          <button class="btn btn-success" id="s-exp" ${!state.sheetNames.length ? 'disabled' : ''}>💾 导出核扣后总表 (.xlsx)</button>
        </div>
      </div>

      <div class="panel">
        <div class="toolbar">
          ${state.sheetNames.map(sn => `<button class="btn ${sn === state.activeSheet ? 'btn-primary' : ''}" data-sn="${U.escHtml(sn)}">${U.escHtml(sn)}</button>`).join('')}
          ${state.consumeLog.length ? `<button class="btn ${isConsumeView ? 'btn-primary' : ''}" data-sn="__CONSUME__">📊 本期消耗量统计 (${state.consumeLog.length})</button>` : ''}
        </div>
        <div id="s-table-box"></div>
      </div>
    `;

    root.querySelector('#s-period').oninput = e => { state.periodLabel = e.target.value; };
    root.querySelector('#s-autosave-exp').onchange = e => {
      state.autoSaveOnExport = e.target.checked;
      persistState();
    };
    const btnReset = root.querySelector('#s-reset-base');
    if (btnReset) {
      btnReset.onclick = () => {
        resetToSavedBase();
        renderModule(root);
        U.toast('已还原到上次留存的默认底表', 'info');
      };
    }
    const btnClear = root.querySelector('#s-clear-base');
    if (btnClear) {
      btnClear.onclick = () => {
        clearSavedBase();
        renderModule(root);
        U.toast('已清空留存底表，请重新拖入干净底表', 'info');
      };
    }

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

    root.querySelector('#s-copy-consume').onclick = async () => {
      const ok = await U.copyAsTSV(CONSUME_HEADERS_9, state.consumeLog, false);
      U.toast(ok ? `已复制 ${state.consumeLog.length} 行标准 9 列消耗量（含单位、固定HJF、退库负数）` : '复制失败', ok ? 'success' : 'error');
    };

    root.querySelector('#s-exp').onclick = () => {
      const cfgs = state.sheetNames.map(sn => {
        const sh = state.baseSheets[sn];
        if (sn.includes('消耗') || sn.includes('统计')) {
          return { name: sn, headers: sh.headers, rows: sh.rows, textCols: [1, 4], numCols: [0, 7] };
        }
        const { codeCol } = detectCols(sh.headers);
        return { name: sn, headers: sh.headers, rows: sh.rows, textCols: [codeCol] };
      });
      if (state.consumeLog.length) {
        cfgs.push({
          name: '本期消耗量统计',
          headers: CONSUME_HEADERS_9,
          rows: state.consumeLog,
          textCols: [1, 4],
          numCols: [0, 7],
          colWidths: [8, 12, 10, 8, 15, 28, 8, 12, 16]
        });
      }
      const tag = state.periodLabel.trim() || detectNextRoundTitle(state.savedBaseSheets);
      U.exportWorkbook(cfgs, `呆滞品核扣结果_${tag}.xlsx`);

      // 导出后自动将本次定稿结果留存为下一次的默认底表，并自动顺延下一轮名称！
      if (state.autoSaveOnExport && state.hasPendingRun) {
        state.savedBaseSheets = deepCloneSheets(state.baseSheets);
        state.savedSheetNames = [...state.sheetNames];
        const ts = new Date().toTimeString().slice(0, 5);
        state.savedBaseLabel = `上次导出留存（${tag} · ${ts}）`;
        state.hasPendingRun = false;
        state.periodLabel = detectNextRoundTitle(state.savedBaseSheets);
        persistState();
        renderModule(root);
        U.toast(`已导出并留存为默认底表！下轮已自动顺延为【${state.periodLabel}】`, 'success');
      } else {
        U.toast(`已导出呆滞品核扣结果_${tag}.xlsx`, 'success');
      }
    };

    if (cur) {
      U.renderPagedTable(root.querySelector('#s-table-box'), {
        headers: cur.headers,
        rows: cur.rows,
        page: state.page,
        pageSize: 100,
        rowClassFn: r => {
          if (isConsumeView) return Number(r[7]) < 0 ? 'row-err' : '';
          const last = String(r[r.length - 1] || '');
          if (last.includes('全部出库')) return 'row-ok';
          if (last.includes('剩余') || last.includes('出库-')) return 'row-warn';
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
