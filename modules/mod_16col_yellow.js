/**
 * 模块 1：材料出库单 16 列精简 + 手机扫描 PDF 黄单回收 + 未回收原位快填复制动态表格
 * 独立隔离模块：仅负责本业务，出错不影响其他任何模块。
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
  const QUICK_REASONS = ['车间未签回', '今日未送达', '补交中', '现场自取未标', '黄单遗失待补'];
  const DOC_REGEX = /(?:CCHF|CK)\d{10,22}/gi;

  let state = {
    mainRows: [],       // 16列完整原表（行顺序100%锁死）
    selfRows: [],       // 自取物资表
    recoveredSet: new Set(),
    unrecReasons: {},   // { docNo: reasonText }
    activeView: 'main', // 'main' | 'self'
    filterMode: 'all',  // 'all' | 'delivery' | 'unrec' | 'rec'
    page: 1,
    pdfLog: '',
    sourceName: '',
    _hydrated: false
  };

  function persistState() {
    WB.Store.save('mod_16col_yellow', {
      mainRows: state.mainRows,
      selfRows: state.selfRows,
      recoveredList: Array.from(state.recoveredSet),
      unrecReasons: state.unrecReasons,
      pdfLog: state.pdfLog,
      sourceName: state.sourceName
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_16col_yellow');
    if (saved) {
      state.mainRows = saved.mainRows || [];
      state.selfRows = saved.selfRows || [];
      state.recoveredSet = new Set(saved.recoveredList || []);
      state.unrecReasons = saved.unrecReasons || {};
      state.pdfLog = saved.pdfLog || '';
      state.sourceName = saved.sourceName || '';
    }
    state._hydrated = true;
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

    const rawHeaders = aoa[0].map(h => U.cleanStr(h));
    let dataRows = aoa.slice(1);
    // 剔除末尾合计行
    while (dataRows.length > 0) {
      const firstCell = U.cleanStr(dataRows[dataRows.length - 1][0]);
      if (firstCell === '合计' || firstCell === '总计' || dataRows[dataRows.length - 1].every(v => !U.cleanStr(v))) {
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
    // 若已有已识别的黄单集合，立刻同步回填
    applyYellowAndReasons();
    persistState();
    U.toast(`成功解析 ${mainRows.length} 行（与源表 100% 行数一致），自取物资 ${selfRows.length} 行`, 'success');
  }

  /** 将已回收单号 & 未回收原因严格回填到 N 列（索引 13），原表顺序 100% 不变 */
  function applyYellowAndReasons() {
    for (let i = 0; i < state.mainRows.length; i++) {
      const row = state.mainRows[i];
      const doc = U.cleanStr(row[1]).toUpperCase();
      if (!doc) continue;
      if (state.recoveredSet.has(doc)) {
        row[13] = '是'; // N 列（第 14 列「黄单是否回收」）
      } else if (state.unrecReasons[doc] !== undefined) {
        row[13] = state.unrecReasons[doc];
      }
    }
  }

  /** 从手机扫描 PDF 中提取 CCHF/CK 单号（优先高速文本层，若无文本层则自动切换 OCR 识图） */
  async function extractDocsFromPdfs(pdfFiles, progressCb) {
    const found = new Set();
    let totalPages = 0;
    let ocrPages = 0;

    for (const file of pdfFiles) {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      totalPages += pdf.numPages;

      for (let p = 1; p <= pdf.numPages; p++) {
        progressCb(`正在扫描 ${file.name} 第 ${p}/${pdf.numPages} 页...`);
        const page = await pdf.getPage(p);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(it => it.str).join(' ');
        const matches = pageText.match(DOC_REGEX) || [];
        if (matches.length > 0) {
          matches.forEach(m => found.add(m.toUpperCase()));
        } else if (window.Tesseract) {
          // 手机纯图片扫描件：渲染为 Canvas 后用 Tesseract OCR 提取单号
          ocrPages++;
          progressCb(`第 ${p}/${pdf.numPages} 页为纯图片扫描件，正在 OCR 提取单号...`);
          const viewport = page.getViewport({ scale: 1.8 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const res = await Tesseract.recognize(canvas, 'eng', {
            tessedit_char_whitelist: 'CCHFK0123456789'
          });
          const ocrText = (res.data.text || '').replace(/\s+/g, '');
          const ocrMatches = ocrText.match(/(?:CCHF|CK)\d{10,22}/gi) || [];
          ocrMatches.forEach(m => found.add(m.toUpperCase()));
        }
      }
    }
    return { found, totalPages, ocrPages };
  }

  /** 获取所有 M列="是" 且尚未回收黄单的去重单据清单（用于上方快填栏） */
  function getUnrecoveredGroups() {
    const map = new Map();
    state.mainRows.forEach((row, idx) => {
      const doc = U.cleanStr(row[1]).toUpperCase();
      const isDeliv = U.cleanStr(row[12]) === '是';
      const isRec = state.recoveredSet.has(doc) || U.cleanStr(row[13]) === '是';
      if (!doc || !isDeliv || isRec) return;
      if (!map.has(doc)) {
        map.set(doc, {
          doc,
          dept: row[5],
          wh: row[3],
          date: row[2],
          rowIndices: [],
          samples: []
        });
      }
      const g = map.get(doc);
      g.rowIndices.push(idx + 1);
      if (g.samples.length < 3) g.samples.push(`${row[7]}(${row[9]}${row[8]})`);
    });
    return Array.from(map.values());
  }

  function renderModule(root) {
    const mainRows = state.mainRows;
    const delivRows = mainRows.filter(r => r[12] === '是');
    const recRows = delivRows.filter(r => r[13] === '是');
    const unrecGroups = getUnrecoveredGroups();
    const pendingExplain = unrecGroups.filter(g => !U.cleanStr(state.unrecReasons[g.doc])).length;

    let displayRows = state.activeView === 'self' ? state.selfRows : mainRows;
    if (state.activeView === 'main') {
      if (state.filterMode === 'delivery') displayRows = mainRows.filter(r => r[12] === '是');
      else if (state.filterMode === 'rec') displayRows = mainRows.filter(r => r[13] === '是');
      else if (state.filterMode === 'unrec') displayRows = mainRows.filter(r => r[12] === '是' && r[13] !== '是');
    }

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📦 材料出库单 16 列精简 & 次日黄单回收（原位锁序快填版）</span>
          <span class="pill pill-blue">${state.sourceName ? '当前底表：' + U.escHtml(state.sourceName) : '等待拖入 74 列或 16 列出库表'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">总记录行数（源表100%对齐）</div><div class="kpi-val">${mainRows.length}</div></div>
          <div class="kpi-card"><div class="kpi-label">需配送行数 (M列=是)</div><div class="kpi-val">${delivRows.length}</div></div>
          <div class="kpi-card green"><div class="kpi-label">黄单已回收行数 (N列=是)</div><div class="kpi-val">${recRows.length}</div></div>
          <div class="kpi-card ${unrecGroups.length ? 'orange' : 'green'}"><div class="kpi-label">未回收配送单据数 (待说明: ${pendingExplain})</div><div class="kpi-val">${unrecGroups.length}</div></div>
          <div class="kpi-card"><div class="kpi-label">自取物资筛选行数</div><div class="kpi-val">${state.selfRows.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="btn-up-xlsx">📂 1. 上传 74列/16列出库单</button>
          <input type="file" id="in-up-xlsx" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <button class="btn btn-warning" id="btn-up-pdf">📄 2. 导入手机扫描黄单 PDF</button>
          <input type="file" id="in-up-pdf" accept=".pdf" multiple class="hidden-input" />
          <button class="btn" id="btn-paste-docs">📋 手动粘贴已回收单号</button>
          <span style="flex:1"></span>
          <button class="btn btn-success" id="btn-copy-tsv" ${!mainRows.length ? 'disabled' : ''}>📋 一键复制全表（原顺序贴入动态表格）</button>
          <button class="btn" id="btn-exp-xlsx" ${!mainRows.length ? 'disabled' : ''}>💾 导出双表 Excel (.xlsx)</button>
        </div>
        <div id="pdf-status" style="font-size:12px;color:#0369a1;margin-bottom:4px;">${U.escHtml(state.pdfLog)}</div>
      </div>

      ${unrecGroups.length > 0 ? `
      <div class="unrec-box">
        <div class="panel-title" style="margin-bottom:4px;">
          <span>⚠️ 上层快填栏：共 <b>${unrecGroups.length}</b> 张配送单尚未回收黄单（在此填一次，下方大表【原位置、原顺序100%不变】自动同步填入 N 列）</span>
          <span class="pill pill-orange">剩余 ${pendingExplain} 张未填说明</span>
        </div>
        <div class="unrec-list">
          ${unrecGroups.map((g, idx) => {
            const curVal = state.unrecReasons[g.doc] || '';
            const rowSpan = g.rowIndices.length === 1
              ? `原表第 ${g.rowIndices[0]} 行`
              : `原表第 ${g.rowIndices[0]}~${g.rowIndices[g.rowIndices.length - 1]} 行（共 ${g.rowIndices.length} 行）`;
            return `<div class="unrec-item" data-doc="${g.doc}">
              <div class="unrec-meta">
                <div><b>${idx + 1}. ${g.doc}</b> <span class="pill pill-blue">${U.escHtml(g.dept || '未知部门')}</span> <span style="color:#64748b;font-size:11.5px;">${rowSpan}</span></div>
                <div style="font-size:11.5px;color:#475569;">物资摘要：${U.escHtml(g.samples.join('、'))}${g.rowIndices.length > 3 ? ' ...' : ''}</div>
              </div>
              <div class="unrec-actions">
                ${QUICK_REASONS.map(r => `<button class="chip-btn" data-doc="${g.doc}" data-reason="${r}">${r}</button>`).join('')}
                <input type="text" class="unrec-input" data-doc="${g.doc}" value="${U.escHtml(curVal)}" placeholder="输入原因，自动填回原表N列..." />
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <div class="panel">
        <div class="toolbar" style="justify-content:space-between;">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn ${state.activeView === 'main' ? 'btn-primary' : ''}" id="tab-main">材料出库单列表 (${mainRows.length})</button>
            <button class="btn ${state.activeView === 'self' ? 'btn-primary' : ''}" id="tab-self">自取物资 (${state.selfRows.length})</button>
            ${state.activeView === 'main' ? `
              <select id="sel-filter">
                <option value="all" ${state.filterMode === 'all' ? 'selected' : ''}>显示：全部行（原表完整顺序）</option>
                <option value="delivery" ${state.filterMode === 'delivery' ? 'selected' : ''}>仅看：需配送 (M=是)</option>
                <option value="unrec" ${state.filterMode === 'unrec' ? 'selected' : ''}>仅看：未回收黄单</option>
                <option value="rec" ${state.filterMode === 'rec' ? 'selected' : ''}>仅看：已回收黄单 (N=是)</option>
              </select>` : ''}
          </div>
          <span style="font-size:11.5px;color:#64748b;">提示：无论筛选看哪部分，点击【一键复制全表】始终复制 100% 完整原顺序数据</span>
        </div>
        <div id="m1-table-box"></div>
      </div>
    `;

    // 绑定上传 Excel
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

    // 绑定上传手机扫描 PDF
    const inPdf = root.querySelector('#in-up-pdf');
    root.querySelector('#btn-up-pdf').onclick = () => inPdf.click();
    inPdf.onchange = async e => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const statusEl = root.querySelector('#pdf-status');
      try {
        const res = await extractDocsFromPdfs(files, msg => {
          statusEl.textContent = '⏳ ' + msg;
        });
        res.found.forEach(d => state.recoveredSet.add(d));
        applyYellowAndReasons();
        state.pdfLog = `✅ 已扫描 ${files.length} 个 PDF（共 ${res.totalPages} 页，其中 OCR 识图 ${res.ocrPages} 页），累计识别已回收单号 ${state.recoveredSet.size} 个并已精准回填 N 列。`;
        persistState();
        U.toast(`黄单识别完成：提取到 ${res.found.size} 个单号并回填 N 列`, 'success');
        renderModule(root);
      } catch (err) {
        U.toast('PDF 识别异常：' + err.message, 'error');
      }
      e.target.value = '';
    };

    // 手动粘贴单号
    root.querySelector('#btn-paste-docs').onclick = () => {
      const raw = prompt('请粘贴已回收黄单的单据号（任意文本均可，系统自动提取 CCHF/CK 单号）：');
      if (!raw) return;
      const matches = raw.match(DOC_REGEX) || [];
      if (!matches.length) {
        U.toast('未检测到有效的 CCHF/CK 单据号', 'warn');
        return;
      }
      const uniqueDocs = Array.from(new Set(matches.map(m => m.toUpperCase())));
      uniqueDocs.forEach(m => state.recoveredSet.add(m));
      applyYellowAndReasons();
      state.pdfLog = `✅ 手动导入 ${uniqueDocs.length} 个去重已回收单号，当前累计 ${state.recoveredSet.size} 个。`;
      persistState();
      U.toast(`已回填 ${uniqueDocs.length} 个已回收单号到 N 列`, 'success');
      renderModule(root);
    };

    // 上层未回收快填栏 -> 原表原位同步
    root.querySelectorAll('.chip-btn').forEach(btn => {
      btn.onclick = () => {
        const doc = btn.dataset.doc;
        const reason = btn.dataset.reason;
        state.unrecReasons[doc] = reason;
        applyYellowAndReasons();
        persistState();
        renderModule(root);
        U.toast(`已同步 [${doc}] -> "${reason}" 至原表对应行`, 'success');
      };
    });
    root.querySelectorAll('.unrec-input').forEach(inp => {
      inp.onchange = () => {
        const doc = inp.dataset.doc;
        state.unrecReasons[doc] = inp.value.trim();
        applyYellowAndReasons();
        persistState();
        renderModule(root);
      };
    });

    // 一键复制全表（贴入动态表格，不带表头或按需选择）
    root.querySelector('#btn-copy-tsv').onclick = async () => {
      const rowsToCopy = state.activeView === 'self' ? state.selfRows : state.mainRows;
      const ok = await U.copyAsTSV(HEADERS_16, rowsToCopy, false);
      if (ok) {
        U.toast(`✅ 已复制 ${rowsToCopy.length} 行完整原顺序数据！直接去动态表格按 Ctrl+V 即可`, 'success');
      } else {
        U.toast('复制失败，请检查浏览器剪贴板权限', 'error');
      }
    };

    // 导出双表 Excel
    root.querySelector('#btn-exp-xlsx').onclick = () => {
      const outName = `材料出库单列表（精简与黄单核对）.xlsx`;
      U.exportWorkbook([
        { name: '材料出库单列表', headers: HEADERS_16, rows: state.mainRows, textCols: [1, 2, 6, 15], numCols: [9], colWidths: COL_WIDTHS },
        { name: '自取物资', headers: HEADERS_16, rows: state.selfRows, textCols: [1, 2, 6, 15], numCols: [9], colWidths: COL_WIDTHS }
      ], outName);
      U.toast('已导出：' + outName, 'success');
    };

    // 视图与筛选切换
    root.querySelector('#tab-main').onclick = () => { state.activeView = 'main'; state.page = 1; renderModule(root); };
    root.querySelector('#tab-self').onclick = () => { state.activeView = 'self'; state.page = 1; renderModule(root); };
    const selFilter = root.querySelector('#sel-filter');
    if (selFilter) {
      selFilter.onchange = () => { state.filterMode = selFilter.value; state.page = 1; renderModule(root); };
    }

    // 渲染分页防卡死表格
    U.renderPagedTable(root.querySelector('#m1-table-box'), {
      headers: HEADERS_16,
      rows: displayRows,
      page: state.page,
      pageSize: 100,
      rowClassFn: row => {
        if (row[13] === '是') return 'row-ok';
        if (row[12] === '是' && !row[13]) return 'row-warn';
        return '';
      },
      cellRenderFn: (val, row, absIdx, cIdx) => {
        if (cIdx === 13 && val === '是') return `<span class="pill pill-green">是（已回收）</span>`;
        if (cIdx === 13 && val) return `<span class="pill pill-orange">${U.escHtml(val)}</span>`;
        if (cIdx === 13 && row[12] === '是') return `<span style="color:#dc2626;font-weight:600;">待回收</span>`;
        return U.escHtml(val);
      },
      onPageChange: pg => { state.page = pg; renderModule(root); }
    });
  }

  WB.register({
    id: 'mod_16col_yellow',
    icon: '📦',
    title: '16列与黄单回收',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
      if (excels.length) await processExcelFile(excels[0]);
      if (pdfs.length) {
        const res = await extractDocsFromPdfs(pdfs, msg => {
          const el = this._root && this._root.querySelector('#pdf-status');
          if (el) el.textContent = '⏳ ' + msg;
        });
        res.found.forEach(d => state.recoveredSet.add(d));
        applyYellowAndReasons();
        state.pdfLog = `✅ 智能导入 ${pdfs.length} 个 PDF，识别 ${res.found.size} 个单号并自动回填 N 列。`;
        persistState();
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
