/**
 * 模块 4：OST 电厂双核工具（📅 OST 每日物资筛选输出 + ⚡ OST P9 领料现存量核对）
 * 规则：
 * 1. OST 每日物资筛选：自然日切片 + 追加「子项号 / 用途编码 / 货位编码」+ 综合仓置顶 & P3/P7/P9 沉底排序
 * 2. OST P9 核对：兼容 ERP 导出的 HTML 伪装 .xls，自动清洗 &nbsp; 与强保前导 0，输出 10 列现存量核对表
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const AUDIT_HEADERS = ['行号', '编码', '名称', '规格', '单位', '申领数量', '现存量总计', 'P9(2105)货位', '全部仓库货位', '核对状态'];

  let state = {
    subTab: 'daily',     // 'daily' | 'p9'
    stockMap: new Map(), // code -> [{ name, spec, wh, loc, qty }]
    stockCount: 0,
    // OST 每日物资筛选态
    dailySheets: {},     // { sheetName: { headers, rows, availDates } }
    dailySheetNames: [],
    dailyActiveSheet: '',
    dailyRawHeaders: [],
    dailyRawRows: [],
    dailyFilteredHeaders: [],
    dailyFilteredRows: [],
    dailyTargetDate: '',
    dailyAvailDates: [],
    dailyFileName: '',
    dailyPage: 1,
    // OST P9 核对态
    auditRows: [],
    p9Page: 1
  };

  function persistState() {
    WB.Store.save('mod_ost', {
      subTab: state.subTab,
      stockEntries: Array.from(state.stockMap.entries()),
      stockCount: state.stockCount,
      dailySheets: state.dailySheets,
      dailySheetNames: state.dailySheetNames,
      dailyActiveSheet: state.dailyActiveSheet,
      dailyRawHeaders: state.dailyRawHeaders,
      dailyRawRows: state.dailyRawRows,
      dailyTargetDate: state.dailyTargetDate,
      dailyAvailDates: state.dailyAvailDates,
      dailyFileName: state.dailyFileName,
      auditRows: state.auditRows
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_ost');
    if (saved) {
      state.subTab = saved.subTab || 'daily';
      state.stockMap = new Map(saved.stockEntries || []);
      state.stockCount = saved.stockCount || 0;
      state.dailySheets = saved.dailySheets || {};
      state.dailySheetNames = saved.dailySheetNames || [];
      state.dailyActiveSheet = saved.dailyActiveSheet || state.dailySheetNames[state.dailySheetNames.length - 1] || '';
      state.dailyRawHeaders = saved.dailyRawHeaders || [];
      state.dailyRawRows = saved.dailyRawRows || [];
      state.dailyTargetDate = saved.dailyTargetDate || '';
      state.dailyAvailDates = saved.dailyAvailDates || [];
      state.dailyFileName = saved.dailyFileName || '';
      state.auditRows = saved.auditRows || [];
      if (state.dailyRawRows.length) rebuildDailyOutput();
    }
  }

  function findExactOrMatch(headers, exactList, includeList, excludeRe) {
    for (const ex of exactList) {
      const idx = headers.findIndex(h => h === ex);
      if (idx >= 0) return idx;
    }
    for (const inc of includeList) {
      const idx = headers.findIndex(h => h.includes(inc) && (!excludeRe || !excludeRe.test(h)));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  async function loadStockFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const map = new Map();
    let count = 0;

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = 0;
      for (let i = 0; i < Math.min(8, aoa.length); i++) {
        const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/存货编码|物资编码|物料编码/.test(line)) { hdrIdx = i; break; }
      }
      const h = aoa[hdrIdx].map(v => U.cleanStr(v));
      const iCode = findExactOrMatch(h, ['存货编码', '物料编码', '物资编码'], ['存货编码', '物料编码', '物资编码']);
      if (iCode < 0) return;
      const iName = findExactOrMatch(h, ['存货名称', '物料名称', '物资名称'], ['存货名', '物料名', '物资名', '名称'], /仓库|分类|货位|库位|组织|部门/);
      const iSpec = findExactOrMatch(h, ['规格型号', '规格'], ['规格']);
      const iWh = findExactOrMatch(h, ['仓库名称', '仓库'], ['仓库'], /编码|代码/);
      const iLoc = findExactOrMatch(h, ['货位编码', '库位编码', '货位'], ['货位', '库位'], /名称/);
      const iQty = findExactOrMatch(h, ['现存数量', '现存量', '可用数量', '结存主数量', '结存数量'], ['现存', '可用', '结存']);

      for (let i = hdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const code = U.formatCode(r[iCode]);
        if (!code || /合计|总计|编码/.test(code)) continue;
        count++;
        const rec = {
          code,
          name: iName >= 0 ? U.cleanStr(r[iName]) : '',
          spec: iSpec >= 0 ? U.cleanStr(r[iSpec]) : '',
          wh: iWh >= 0 ? U.cleanStr(r[iWh]) : sn,
          loc: iLoc >= 0 ? U.cleanStr(r[iLoc]) : '',
          qty: iQty >= 0 ? U.parseNum(r[iQty]) : 0
        };
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(rec);
      }
    });

    state.stockMap = map;
    state.stockCount = count;
    if (state.dailyRawRows.length) rebuildDailyOutput();
    persistState();
    U.toast(`现存量索引构建完成：${count} 条记录（${map.size} 个唯一编码，兼容 HTML 伪装 .xls）`, 'success');
  }

  function activateDailySheet(sn) {
    const sh = state.dailySheets[sn];
    if (!sh) return;
    state.dailyActiveSheet = sn;
    state.dailyRawHeaders = sh.headers;
    state.dailyRawRows = sh.rows;
    state.dailyAvailDates = sh.availDates;
    state.dailyTargetDate = '';
    state.dailyPage = 1;
    rebuildDailyOutput();
  }

  async function loadDailyFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const sheets = {};
    const validNames = [];

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(8, aoa.length); i++) {
        const txt = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/编码|物料|物资|存货名称/.test(txt) && /名称|数量|日期/.test(txt)) { hdrIdx = i; break; }
      }
      if (hdrIdx < 0) return;

      // 裁掉尾部全空列，避免出现多余空表头
      const rawH = aoa[hdrIdx].map(v => U.cleanStr(v));
      let lastNonEmptyCol = rawH.length - 1;
      while (lastNonEmptyCol >= 0 && !rawH[lastNonEmptyCol]) lastNonEmptyCol--;
      const headers = rawH.slice(0, lastNonEmptyCol + 1);
      const rows = aoa.slice(hdrIdx + 1)
        .filter(r => r.some(v => U.cleanStr(v) !== ''))
        .map(r => r.slice(0, headers.length));

      const iDate = headers.findIndex(h => h.includes('日期'));
      const dates = new Set();
      if (iDate >= 0) {
        rows.forEach(r => {
          const d = U.formatDate(r[iDate]);
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
        });
      }
      validNames.push(sn);
      sheets[sn] = { headers, rows, availDates: Array.from(dates).sort().reverse() };
    });

    if (!validNames.length) throw new Error('OST 申报表无有效数据工作表');

    // 多月份分表（如 26.01 ~ 26.11）：默认优先定位到最后一个有效表（最新月份）
    let defaultSn = validNames[validNames.length - 1];
    const mFile = file.name.match(/(\d{2,4})[.\-_](\d{1,2})[.\-_](\d{1,2})/);
    if (mFile) {
      const yy = mFile[1].slice(-2);
      const mm = mFile[2].padStart(2, '0');
      const matched = validNames.find(n => n.includes(`${yy}.${mm}`) || n.includes(`${yy}-${mm}`));
      if (matched) defaultSn = matched;
    }

    state.dailySheets = sheets;
    state.dailySheetNames = validNames;
    state.dailyFileName = file.name;
    activateDailySheet(defaultSn);
    persistState();
    U.toast(`OST 申报表载入成功：已定位最新表 [${defaultSn}]（${state.dailyRawRows.length} 行，共 ${validNames.length} 个工作表）`, 'success');
  }

  function rebuildDailyOutput() {
    const baseH = [...state.dailyRawHeaders];
    const appendCols = ['子项号', '用途编码', '货位编码'];
    appendCols.forEach(c => {
      if (!baseH.includes(c)) baseH.push(c);
    });

    const iDate = baseH.findIndex(h => h.includes('日期'));
    const iCode = baseH.findIndex(h => h.includes('编码') && !h.includes('货位') && !h.includes('用途'));
    const iWh = baseH.findIndex(h => h.includes('仓库'));
    const iLoc = baseH.indexOf('货位编码');
    const iAltLoc = baseH.findIndex((h, idx) => idx !== iLoc && h.includes('货位'));

    const target = state.dailyTargetDate.trim();
    const out = [];

    for (const rawRow of state.dailyRawRows) {
      if (target && iDate >= 0) {
        const d = U.formatDate(rawRow[iDate]);
        if (!d.includes(target)) continue;
      }
      const row = baseH.map((_, idx) => (idx < rawRow.length ? U.cleanStr(rawRow[idx]) : ''));
      if (iDate >= 0 && row[iDate]) {
        const normD = U.formatDate(row[iDate]);
        if (/^\d{4}-\d{2}-\d{2}$/.test(normD)) row[iDate] = normD;
      }
      if (iCode >= 0) {
        const code = U.formatCode(row[iCode]);
        row[iCode] = code;
        // 若已导入现存量且货位编码为空，自动补全货位
        if (code && !row[iLoc] && state.stockMap.has(code)) {
          const hits = state.stockMap.get(code);
          const locs = Array.from(new Set(hits.map(h => h.loc).filter(Boolean)));
          row[iLoc] = locs.join(' / ');
        }
      }
      out.push(row);
    }

    // 综合仓置顶 (0) -> 其他仓居中 (1) -> P3/P7/P9/110105/110110 沉底 (2)
    function getBucket(row) {
      const whTxt = iWh >= 0 ? (row[iWh] || '') : '';
      const locTxt = `${row[iLoc] || ''} ${iAltLoc >= 0 ? row[iAltLoc] : ''} ${whTxt}`.toUpperCase();
      if (/P3|P7|P9|110105|110110/.test(locTxt)) return 2;
      if (whTxt.includes('综合仓')) return 0;
      return 1;
    }

    const indexed = out.map((r, idx) => ({ r, idx, b: getBucket(r) }));
    indexed.sort((a, b) => (a.b - b.b) || (a.idx - b.idx));

    state.dailyFilteredHeaders = baseH;
    state.dailyFilteredRows = indexed.map(x => x.r);
  }

  async function auditRequisitionFile(file) {
    if (state.stockMap.size === 0) {
      U.toast('请先导入【OST 现存量表】', 'warn');
      return;
    }
    const parsed = await U.readSpreadsheet(file);
    const sn = parsed.sheetNames.includes('横版') ? '横版' : parsed.sheetNames[0];
    const aoa = parsed.sheets[sn] || [];
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(35, aoa.length); i++) {
      const txt = aoa[i].join(' ');
      if (txt.includes('编码') && txt.includes('名称')) { hdrIdx = i; break; }
    }
    const h = aoa[hdrIdx].map(v => U.cleanStr(v));
    const iCode = h.findIndex(x => x.includes('编码'));
    const iName = h.findIndex(x => x.includes('名称'));
    const iSpec = h.findIndex(x => x.includes('规格'));
    const iUnit = h.findIndex(x => x.includes('单位'));
    const iQty = h.findIndex(x => x.includes('数量'));

    const out = [];
    for (let i = hdrIdx + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const code = iCode >= 0 ? U.formatCode(r[iCode]) : '';
      const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
      if (!code && !name) continue;
      if (/^(合计|总计|小计|制单|审核|审批|主管|领料人)/.test(code || name)) continue;
      const reqQty = iQty >= 0 ? U.parseNum(r[iQty]) : 0;
      const matches = state.stockMap.get(code) || [];
      const totalStock = matches.reduce((s, m) => s + m.qty, 0);
      const p9Locs = matches.filter(m => m.wh.includes('P9') || m.loc.includes('2105')).map(m => `${m.loc}(${U.fmtNum(m.qty)})`).join('; ');
      const allLocs = matches.map(m => `${m.wh}:${m.loc || '无货位'}(${U.fmtNum(m.qty)})`).join(' | ');
      let status = '✅ 充足';
      if (matches.length === 0) status = '❌ 无库存记录';
      else if (totalStock < reqQty) status = `⚠️ 库存不足(缺${U.fmtNum(reqQty - totalStock)})`;

      out.push([
        i + 1, code, name,
        iSpec >= 0 ? U.cleanStr(r[iSpec]) : '',
        iUnit >= 0 ? U.cleanStr(r[iUnit]) : '',
        reqQty, U.fmtNum(totalStock), p9Locs, allLocs, status
      ]);
    }

    state.auditRows = out;
    state.p9Page = 1;
    persistState();
    U.toast(`P9 核对完成：共 ${out.length} 行领料明细`, 'success');
  }

  function renderModule(root) {
    const okCnt = state.auditRows.filter(r => r[9].startsWith('✅')).length;
    const errCnt = state.auditRows.length - okCnt;

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>⚡ OST 电厂物资工作台（每日物资筛选输出 & P9 现存量核对）</span>
          <div style="display:flex;gap:6px;">
            <button class="btn ${state.subTab === 'daily' ? 'btn-primary' : ''}" id="ost-sub-daily">📅 OST 每日物资筛选输出</button>
            <button class="btn ${state.subTab === 'p9' ? 'btn-primary' : ''}" id="ost-sub-p9">🔍 OST P9 领料核对</button>
          </div>
        </div>
        <div class="toolbar" style="margin-bottom:0;">
          <button class="btn" id="o-up-stock">📚 导入/更新 OST 现存量表 (.xls/.xlsx)</button>
          <input type="file" id="o-in-stock" accept=".xls,.xlsx,.csv" class="hidden-input" />
          <span class="pill ${state.stockMap.size ? 'pill-green' : 'pill-orange'}">
            ${state.stockMap.size ? `已载入现存量：${state.stockCount} 条 / ${state.stockMap.size} 唯一编码` : '尚未导入现存量（P9 核对必选，每日筛选可选自动补货位）'}
          </span>
        </div>
      </div>

      ${state.subTab === 'daily' ? `
        <div class="panel">
          <div class="panel-title">
            <span>📅 OST 每日物资筛选输出（自然日切片 · 追加子项号/用途编码/货位编码 · 综合仓置顶 / P3·P7·P9 沉底）</span>
            <span class="pill pill-blue">${state.dailyFileName || '待导入 OST 领料申报表'}</span>
          </div>
          <div class="toolbar">
            <button class="btn btn-primary" id="o-up-daily">📂 导入 OST 申报单 (.xlsx)</button>
            <input type="file" id="o-in-daily" accept=".xls,.xlsx,.csv" class="hidden-input" />
            ${state.dailySheetNames.length > 1 ? `
              <select id="o-daily-sheet" title="切换工作表/月份">
                ${state.dailySheetNames.map(sn => `<option value="${U.escHtml(sn)}" ${sn === state.dailyActiveSheet ? 'selected' : ''}>工作表：${U.escHtml(sn)}</option>`).join('')}
              </select>
            ` : ''}
            <select id="o-daily-date">
              <option value="">全部自然日 (${state.dailyRawRows.length} 行)</option>
              ${state.dailyAvailDates.map(d => `<option value="${d}" ${d === state.dailyTargetDate ? 'selected' : ''}>仅筛选：${d}</option>`).join('')}
            </select>
            <span style="flex:1"></span>
            <button class="btn btn-success" id="o-daily-copy" ${!state.dailyFilteredRows.length ? 'disabled' : ''}>📋 一键复制筛选结果</button>
            <button class="btn" id="o-daily-exp" ${!state.dailyFilteredRows.length ? 'disabled' : ''}>💾 导出 OST 每日输出 (.xlsx)</button>
          </div>
          <div id="o-daily-table"></div>
        </div>
      ` : `
        <div class="panel">
          <div class="kpi-grid">
            <div class="kpi-card blue"><div class="kpi-label">现存量记录数</div><div class="kpi-val">${state.stockCount}</div></div>
            <div class="kpi-card"><div class="kpi-label">P9 核对申领行数</div><div class="kpi-val">${state.auditRows.length}</div></div>
            <div class="kpi-card green"><div class="kpi-label">库存充足行数</div><div class="kpi-val">${okCnt}</div></div>
            <div class="kpi-card ${errCnt ? 'red' : 'green'}"><div class="kpi-label">无库存 / 不足行数</div><div class="kpi-val">${errCnt}</div></div>
          </div>
          <div class="toolbar">
            <button class="btn btn-warning" id="o-up-req">📋 导入 P9 领料单（横版）</button>
            <input type="file" id="o-in-req" accept=".xls,.xlsx" class="hidden-input" />
            <span style="flex:1"></span>
            <button class="btn btn-success" id="o-exp" ${!state.auditRows.length ? 'disabled' : ''}>💾 导出现存量核对表 (.xlsx)</button>
          </div>
          <div id="o-p9-table"></div>
        </div>
      `}
    `;

    root.querySelector('#ost-sub-daily').onclick = () => { state.subTab = 'daily'; renderModule(root); };
    root.querySelector('#ost-sub-p9').onclick = () => { state.subTab = 'p9'; renderModule(root); };

    const inStock = root.querySelector('#o-in-stock');
    root.querySelector('#o-up-stock').onclick = () => inStock.click();
    inStock.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadStockFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('现存量导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    if (state.subTab === 'daily') {
      const inDaily = root.querySelector('#o-in-daily');
      root.querySelector('#o-up-daily').onclick = () => inDaily.click();
      inDaily.onchange = async e => {
        if (e.target.files[0]) {
          try { await loadDailyFile(e.target.files[0]); renderModule(root); }
          catch (err) { U.toast('申报单导入失败：' + err.message, 'error'); }
        }
        e.target.value = '';
      };
      const selSheet = root.querySelector('#o-daily-sheet');
      if (selSheet) {
        selSheet.onchange = e => {
          activateDailySheet(e.target.value);
          persistState();
          renderModule(root);
        };
      }
      root.querySelector('#o-daily-date').onchange = e => {
        state.dailyTargetDate = e.target.value;
        state.dailyPage = 1;
        rebuildDailyOutput();
        renderModule(root);
      };
      root.querySelector('#o-daily-copy').onclick = async () => {
        await U.copyAsTSV(state.dailyFilteredHeaders, state.dailyFilteredRows, false);
        U.toast(`已复制 ${state.dailyFilteredRows.length} 行 OST 每日筛选数据`, 'success');
      };
      root.querySelector('#o-daily-exp').onclick = () => {
        const iCode = state.dailyFilteredHeaders.findIndex(h => h.includes('编码') && !h.includes('货位') && !h.includes('用途'));
        const iLoc = state.dailyFilteredHeaders.indexOf('货位编码');
        const tag = state.dailyTargetDate || '全量';
        U.exportWorkbook([{
          name: 'OST每日物资输出',
          headers: state.dailyFilteredHeaders,
          rows: state.dailyFilteredRows,
          textCols: [iCode, iLoc].filter(i => i >= 0)
        }], `OST每日物资输出_${tag}.xlsx`);
        U.toast(`已导出 OST每日物资输出_${tag}.xlsx`, 'success');
      };
      if (state.dailyFilteredHeaders.length) {
        const iLoc = state.dailyFilteredHeaders.indexOf('货位编码');
        U.renderPagedTable(root.querySelector('#o-daily-table'), {
          headers: state.dailyFilteredHeaders,
          rows: state.dailyFilteredRows,
          page: state.dailyPage,
          pageSize: 100,
          rowClassFn: r => (/P3|P7|P9|110105|110110/i.test(r[iLoc] || '') ? 'row-warn' : ''),
          onPageChange: pg => { state.dailyPage = pg; renderModule(root); }
        });
      } else {
        root.querySelector('#o-daily-table').innerHTML = `<div class="empty-cell">请导入 OST 申报单（自动追加子项号/用途编码/货位编码，综合仓置顶、P3/P7/P9 沉底）</div>`;
      }
    } else {
      const inReq = root.querySelector('#o-in-req');
      root.querySelector('#o-up-req').onclick = () => inReq.click();
      inReq.onchange = async e => {
        if (e.target.files[0]) {
          try { await auditRequisitionFile(e.target.files[0]); renderModule(root); }
          catch (err) { U.toast('P9 领料单核对失败：' + err.message, 'error'); }
        }
        e.target.value = '';
      };
      root.querySelector('#o-exp').onclick = () => {
        U.exportWorkbook([{ name: '现存量核对', headers: AUDIT_HEADERS, rows: state.auditRows, textCols: [1], numCols: [5, 6] }], 'OST_P9_现存量核对结果.xlsx');
        U.toast('已导出 OST_P9_现存量核对结果.xlsx', 'success');
      };
      U.renderPagedTable(root.querySelector('#o-p9-table'), {
        headers: AUDIT_HEADERS,
        rows: state.auditRows,
        page: state.p9Page,
        pageSize: 100,
        rowClassFn: r => r[9].startsWith('❌') ? 'row-err' : (r[9].startsWith('⚠️') ? 'row-warn' : 'row-ok'),
        onPageChange: pg => { state.p9Page = pg; renderModule(root); }
      });
    }
  }

  WB.register({
    id: 'mod_ost',
    icon: '⚡',
    title: 'OST 每日筛选与P9',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      for (const f of files) {
        if (/现存量/i.test(f.name)) await loadStockFile(f);
        else if (/P9|横版/i.test(f.name)) { state.subTab = 'p9'; await auditRequisitionFile(f); }
        else { state.subTab = 'daily'; await loadDailyFile(f); }
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
