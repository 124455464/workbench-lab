/**
 * 模块 1：材料出库单 74 列 → 16 列精简与自取物资转换（纯粹转换版，与黄单回收彻底独立）
 */
(function () {
  'use strict';

  const U = WB.Utils;
  const HEADERS_16 = [
    '库存组织', '单据号', '出库日期', '仓库', '出入库类型', '领料部门',
    '物料编码', '物料名称', '单位', '实发数量', '备注', '行备注',
    '是否配送', '黄单是否回收', '欠请购单', '货位编码'
  ];
  const COL_WIDTHS = [24, 22, 12, 10, 26, 18, 14, 22, 8, 12, 26, 32, 10, 14, 12, 18];
  const EXCLUDE_LOCS = new Set(['6104CD-C1', '6105-1']);
  const GAS_OIL_WORDS = [
    '氧气', '乙炔', '氮气', '氩气', '二氧化碳', '丙烷', '液化气', '丁烷',
    '柴油', '汽油', '煤油', '机油', '润滑油', '液压油', '齿轮油', '重油', '黄油'
  ];
  const KEEP_TOOL_WORDS = ['表', '管', '阀', '枪'];

  let state = {
    mainRows: [],       // 16列完整原表（行顺序100%锁死）
    selfRows: [],       // 自取物资表
    activeView: 'main', // 'main' | 'self'
    page: 1,
    sourceName: ''
  };

  function persistState() {
    WB.Store.save('mod_16col_yellow', {
      mainRows: state.mainRows,
      selfRows: state.selfRows,
      sourceName: state.sourceName
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_16col_yellow');
    if (saved) {
      state.mainRows = saved.mainRows || [];
      state.selfRows = saved.selfRows || [];
      state.sourceName = saved.sourceName || '';
    }
  }

  function isExcludedGasOrOil(name) {
    const s = String(name || '');
    if (KEEP_TOOL_WORDS.some(k => s.includes(k))) return false;
    return GAS_OIL_WORDS.some(w => s.includes(w));
  }

  function findCol(headers, candidates) {
    for (const c of candidates) {
      const idx = headers.findIndex(h => h === c);
      if (idx !== -1) return idx;
    }
    for (const c of candidates) {
      const idx = headers.findIndex(h => h.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  async function processExcelFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const sheetName = parsed.sheetNames.includes('材料出库单列表') ? '材料出库单列表' : parsed.sheetNames[0];
    const aoa = parsed.sheets[sheetName] || [];
    if (aoa.length < 2) throw new Error('表格无有效数据行');

    // 自动扫描前 10 行定位真实表头行（兼容 ERP 首行为“材料出库单列表”合并标题）
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const rowStr = aoa[i].map(c => U.cleanStr(c)).join(' ');
      if ((rowStr.includes('单据号') || rowStr.includes('出库单号')) && (rowStr.includes('物料编码') || rowStr.includes('存货编码') || rowStr.includes('仓库'))) {
        hdrIdx = i;
        break;
      }
    }

    const rawHeaders = aoa[hdrIdx].map(h => U.cleanStr(h));
    let dataRows = aoa.slice(hdrIdx + 1);
    while (dataRows.length > 0) {
      const lastRow = dataRows[dataRows.length - 1];
      const firstCell = U.cleanStr(lastRow[0]);
      if (firstCell === '合计' || firstCell === '总计' || lastRow.every(v => !U.cleanStr(v))) {
        dataRows.pop();
      } else {
        break;
      }
    }

    const iOrg = findCol(rawHeaders, ['库存组织']);
    const iDoc = findCol(rawHeaders, ['单据号', '出库单号']);
    const iDate = findCol(rawHeaders, ['出库日期', '单据日期', '日期']);
    const iWh = findCol(rawHeaders, ['仓库', '仓库名称']);
    const iType = findCol(rawHeaders, ['出入库类型', '出库类型']);
    const iDept = findCol(rawHeaders, ['领料部门', '部门']);
    const iCode = findCol(rawHeaders, ['物料编码', '存货编码']);
    const iName = findCol(rawHeaders, ['物料名称', '存货名称']);
    const iUnit = findCol(rawHeaders, ['单位', '主单位']);
    const iQty = findCol(rawHeaders, ['实发数量', '出库数量']);
    const iRem = findCol(rawHeaders, ['备注']);
    const iLrem = findCol(rawHeaders, ['行备注']);
    const iDeliv = findCol(rawHeaders, ['是否配送']);
    const iYellow = findCol(rawHeaders, ['黄单是否回收']);
    const iOwe = findCol(rawHeaders, ['欠请购单']);
    const iLoc = findCol(rawHeaders, ['货位编码', '货位']);

    const mainRows = [];
    const selfRows = [];

    for (const r of dataRows) {
      const org = iOrg >= 0 ? U.cleanStr(r[iOrg]) : '';
      const docNo = iDoc >= 0 ? U.cleanStr(r[iDoc]) : '';
      const dt = iDate >= 0 ? U.formatDate(r[iDate]) : '';
      const wh = iWh >= 0 ? U.cleanStr(r[iWh]) : '';
      const ioType = iType >= 0 ? U.cleanStr(r[iType]) : '';
      const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '';
      const code = iCode >= 0 ? U.formatCode(r[iCode]) : '';
      const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
      const unit = iUnit >= 0 ? U.cleanStr(r[iUnit]) : '';
      const qty = iQty >= 0 ? U.parseNum(r[iQty]) : 0;
      const rem = iRem >= 0 ? U.cleanStr(r[iRem]) : '';
      const lrem = iLrem >= 0 ? U.cleanStr(r[iLrem]) : '';
      const loc = iLoc >= 0 ? U.cleanStr(r[iLoc]) : '';
      const combined = `${rem} ${lrem}`;

      const delivery = iDeliv >= 0 && U.cleanStr(r[iDeliv]) !== ''
        ? U.cleanStr(r[iDeliv])
        : (combined.includes('自取') || combined.includes('补单') ? '' : '是');
      const yellow = iYellow >= 0 ? U.cleanStr(r[iYellow]) : '';
      const owe = iOwe >= 0 ? U.cleanStr(r[iOwe]) : '';

      const row16 = [org, docNo, dt, wh, ioType, dept, code, name, unit, qty, rem, lrem, delivery, yellow, owe, loc];
      mainRows.push(row16);

      if ((wh === '通用仓' || wh === '综合仓') && combined.includes('自取') && !combined.includes('补单')) {
        if (!EXCLUDE_LOCS.has(loc) && !isExcludedGasOrOil(name)) {
          selfRows.push([...row16]);
        }
      }
    }

    state.mainRows = mainRows;
    state.selfRows = selfRows;
    state.sourceName = file.name;
    state.page = 1;
    persistState();
    U.toast(`16列转换完成：共 ${mainRows.length} 行（与源表 100% 一致），自取物资 ${selfRows.length} 行`, 'success');
  }

  function renderModule(root) {
    const mainRows = state.mainRows;
    const delivRows = mainRows.filter(r => r[12] === '是');
    const displayRows = state.activeView === 'self' ? state.selfRows : mainRows;

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📦 材料出库单 74 列 → 16 列精简与自取物资转换</span>
          <span class="pill pill-blue">${state.sourceName ? '当前底表：' + U.escHtml(state.sourceName) : '等待上传 ERP 74 列材料出库单'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">总记录行数（源表100%对齐）</div><div class="kpi-val">${mainRows.length}</div></div>
          <div class="kpi-card"><div class="kpi-label">需配送行数 (M列=是)</div><div class="kpi-val">${delivRows.length}</div></div>
          <div class="kpi-card green"><div class="kpi-label">自取物资筛选行数</div><div class="kpi-val">${state.selfRows.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="btn-up-xlsx">📂 上传 74 列材料出库单 (.xlsx)</button>
          <input type="file" id="in-up-xlsx" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <span style="flex:1"></span>
          <button class="btn btn-success" id="btn-copy-tsv" ${!mainRows.length ? 'disabled' : ''}>📋 一键复制当前表（无表头原序，直接贴入总表）</button>
          <button class="btn" id="btn-exp-xlsx" ${!mainRows.length ? 'disabled' : ''}>💾 导出 16 列双表 (.xlsx)</button>
        </div>
      </div>

      <div class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn ${state.activeView === 'main' ? 'btn-primary' : ''}" id="tab-main">材料出库单列表 (${mainRows.length})</button>
            <button class="btn ${state.activeView === 'self' ? 'btn-primary' : ''}" id="tab-self">自取物资 (${state.selfRows.length})</button>
          </div>
          <span style="font-size:11.5px;color:#64748b;">纯 16 列精简与自取转换，与【黄单回收核对】完全独立</span>
        </div>
        <div id="m1-table-box"></div>
      </div>
    `;

    const inXlsx = root.querySelector('#in-up-xlsx');
    root.querySelector('#btn-up-xlsx').onclick = () => inXlsx.click();
    inXlsx.onchange = async e => {
      if (!e.target.files[0]) return;
      try {
        await processExcelFile(e.target.files[0]);
        renderModule(root);
      } catch (err) {
        U.toast('Excel 解析失败：' + err.message, 'error');
      }
      e.target.value = '';
    };

    root.querySelector('#btn-copy-tsv').onclick = async () => {
      const rowsToCopy = state.activeView === 'self' ? state.selfRows : state.mainRows;
      const ok = await U.copyAsTSV(HEADERS_16, rowsToCopy, false);
      U.toast(ok ? `✅ 已复制 ${rowsToCopy.length} 行完整原顺序数据！直接按 Ctrl+V 贴入总表即可` : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
    };

    root.querySelector('#btn-exp-xlsx').onclick = () => {
      const outName = `材料出库单列表（16列精简与自取）.xlsx`;
      U.exportWorkbook([
        { name: '材料出库单列表', headers: HEADERS_16, rows: state.mainRows, textCols: [1, 2, 6, 15], numCols: [9], colWidths: COL_WIDTHS },
        { name: '自取物资', headers: HEADERS_16, rows: state.selfRows, textCols: [1, 2, 6, 15], numCols: [9], colWidths: COL_WIDTHS }
      ], outName);

      // 自动留存进【📑 出库PDF核对】，第二天只需直接拖入扫描 PDF 即可自动核对
      const pdfMod = WB.modules && WB.modules.mod_photo_check;
      if (pdfMod && typeof pdfMod.syncFrom16Col === 'function') {
        const cnt = pdfMod.syncFrom16Col(state.mainRows, state.sourceName || outName);
        U.toast(`已导出 ${outName}，并已自动留存 ${cnt} 张独立单据到【📑 出库PDF核对】！第二天直接拖 PDF 即可核对`, 'success');
      } else {
        U.toast('已导出：' + outName, 'success');
      }
    };

    root.querySelector('#tab-main').onclick = () => { state.activeView = 'main'; state.page = 1; renderModule(root); };
    root.querySelector('#tab-self').onclick = () => { state.activeView = 'self'; state.page = 1; renderModule(root); };

    U.renderPagedTable(root.querySelector('#m1-table-box'), {
      headers: HEADERS_16,
      rows: displayRows,
      page: state.page,
      pageSize: 100,
      onPageChange: pg => { state.page = pg; renderModule(root); }
    });
  }

  WB.register({
    id: 'mod_16col_yellow',
    icon: '📦',
    title: '16列精简与自取',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      if (excels.length) await processExcelFile(excels[0]);
      if (this._root) renderModule(this._root);
    }
  });
})();
