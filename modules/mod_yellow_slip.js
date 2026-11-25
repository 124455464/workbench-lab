/**
 * 独立模块：黄单回收核对（专攻无表头/有表头 16 列黄单追踪表 + 扫描 PDF/单号提取 + N 列原位回填）
 * 与【16列精简与自取】100% 物理隔离、独立存储，互不覆盖。
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
  const QUICK_REASONS = ['车间未签回', '今日未送达', '补交中', '现场自取未标', '黄单遗失待补'];
  const DOC_REGEX = /(?:CCHF|CK)\d{10,22}/gi;

  let state = {
    rows: [],           // 16列黄单追踪表（原行序100%锁死）
    hasHeaderInSource: false,
    recoveredSet: new Set(),
    unrecReasons: {},   // { docNo: reasonText }
    filterMode: 'all',  // 'all' | 'delivery' | 'unrec' | 'rec'
    page: 1,
    pdfLog: '',
    sourceName: ''
  };

  function persistState() {
    WB.Store.save('mod_yellow_slip', {
      rows: state.rows,
      hasHeaderInSource: state.hasHeaderInSource,
      recoveredList: Array.from(state.recoveredSet),
      unrecReasons: state.unrecReasons,
      pdfLog: state.pdfLog,
      sourceName: state.sourceName
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_yellow_slip');
    if (saved) {
      state.rows = saved.rows || [];
      state.hasHeaderInSource = !!saved.hasHeaderInSource;
      state.recoveredSet = new Set(saved.recoveredList || []);
      state.unrecReasons = saved.unrecReasons || {};
      state.pdfLog = saved.pdfLog || '';
      state.sourceName = saved.sourceName || '';
    }
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

  /** 支持《黄单.xlsx》无表头 16 列切片，也兼容带表头的 16 列台账 */
  async function loadYellowTable(file) {
    const parsed = await U.readSpreadsheet(file);
    const sn = parsed.sheetNames[0];
    const aoa = parsed.sheets[sn] || [];
    if (aoa.length === 0) throw new Error('黄单追踪表为空');

    // 判断前 5 行是否有表头行，还是 R1 直接是数据行（如 CCHF... 单据号）
    let hdrIdx = -1;
    for (let i = 0; i < Math.min(5, aoa.length); i++) {
      const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
      if ((line.includes('单据号') || line.includes('出库单号')) && (line.includes('物料编码') || line.includes('仓库') || line.includes('黄单'))) {
        hdrIdx = i;
        break;
      }
    }

    let dataRows = hdrIdx >= 0 ? aoa.slice(hdrIdx + 1) : aoa.slice(0);
    while (dataRows.length > 0) {
      const last = dataRows[dataRows.length - 1];
      const firstCell = U.cleanStr(last[0]);
      if (firstCell === '合计' || firstCell === '总计' || last.every(v => !U.cleanStr(v))) {
        dataRows.pop();
      } else {
        break;
      }
    }

    const rows16 = [];
    if (hdrIdx >= 0) {
      const h = aoa[hdrIdx].map(v => U.cleanStr(v));
      const idxMap = [
        findCol(h, ['库存组织']),
        findCol(h, ['单据号', '出库单号']),
        findCol(h, ['出库日期', '单据日期', '日期']),
        findCol(h, ['仓库', '仓库名称']),
        findCol(h, ['出入库类型', '出库类型']),
        findCol(h, ['领料部门', '部门']),
        findCol(h, ['物料编码', '存货编码']),
        findCol(h, ['物料名称', '存货名称']),
        findCol(h, ['单位', '主单位']),
        findCol(h, ['实发数量', '出库数量']),
        findCol(h, ['备注']),
        findCol(h, ['行备注']),
        findCol(h, ['是否配送']),
        findCol(h, ['黄单是否回收']),
        findCol(h, ['欠请购单']),
        findCol(h, ['货位编码', '货位'])
      ];
      for (const r of dataRows) {
        if (r.every(v => !U.cleanStr(v))) continue;
        rows16.push([
          idxMap[0] >= 0 ? U.cleanStr(r[idxMap[0]]) : '',
          idxMap[1] >= 0 ? U.cleanStr(r[idxMap[1]]) : '',
          idxMap[2] >= 0 ? U.formatDate(r[idxMap[2]]) : '',
          idxMap[3] >= 0 ? U.cleanStr(r[idxMap[3]]) : '',
          idxMap[4] >= 0 ? U.cleanStr(r[idxMap[4]]) : '',
          idxMap[5] >= 0 ? U.cleanStr(r[idxMap[5]]) : '',
          idxMap[6] >= 0 ? U.formatCode(r[idxMap[6]]) : '',
          idxMap[7] >= 0 ? U.cleanStr(r[idxMap[7]]) : '',
          idxMap[8] >= 0 ? U.cleanStr(r[idxMap[8]]) : '',
          idxMap[9] >= 0 ? U.parseNum(r[idxMap[9]]) : 0,
          idxMap[10] >= 0 ? U.cleanStr(r[idxMap[10]]) : '',
          idxMap[11] >= 0 ? U.cleanStr(r[idxMap[11]]) : '',
          idxMap[12] >= 0 ? U.cleanStr(r[idxMap[12]]) : '',
          idxMap[13] >= 0 ? U.cleanStr(r[idxMap[13]]) : '',
          idxMap[14] >= 0 ? U.cleanStr(r[idxMap[14]]) : '',
          idxMap[15] >= 0 ? U.cleanStr(r[idxMap[15]]) : ''
        ]);
      }
    } else {
      // 无表头 16 列黄单追踪表（如 黄单.xlsx）：按列 0~15 严格原位映射，绝不吞第 1 行
      for (const r of dataRows) {
        if (r.every(v => !U.cleanStr(v))) continue;
        rows16.push([
          U.cleanStr(r[0]),
          U.cleanStr(r[1]),
          U.formatDate(r[2]),
          U.cleanStr(r[3]),
          U.cleanStr(r[4]),
          U.cleanStr(r[5]),
          U.formatCode(r[6]),
          U.cleanStr(r[7]),
          U.cleanStr(r[8]),
          U.parseNum(r[9]),
          U.cleanStr(r[10]),
          U.cleanStr(r[11]),
          U.cleanStr(r[12]), // M列：是否配送（原样保留）
          U.cleanStr(r[13]), // N列：黄单是否回收（原样保留）
          U.cleanStr(r[14]), // O列：欠请购单（原样保留）
          U.cleanStr(r[15])  // P列：货位编码
        ]);
      }
    }

    state.rows = rows16;
    state.hasHeaderInSource = hdrIdx >= 0;
    state.sourceName = file.name;
    state.page = 1;
    // 同步当前表内已经标为“是”的单号
    applyYellowAndReasons();
    persistState();
    U.toast(`黄单追踪表载入成功：共 ${rows16.length} 行（${hdrIdx >= 0 ? '带表头' : '无表头直读，零吞行'}）`, 'success');
  }

  /** 仅回填 N 列（索引 13「黄单是否回收」），严禁改动 M 列（是否配送）或 O 列（欠请购单） */
  function applyYellowAndReasons() {
    for (let i = 0; i < state.rows.length; i++) {
      const row = state.rows[i];
      const doc = U.cleanStr(row[1]).toUpperCase();
      if (!doc) continue;
      if (state.recoveredSet.has(doc)) {
        row[13] = '是';
      } else if (state.unrecReasons[doc] !== undefined && row[13] !== '是') {
        row[13] = state.unrecReasons[doc];
      }
    }
  }

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

  function getUnrecoveredGroups() {
    const map = new Map();
    state.rows.forEach((row, idx) => {
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
    const rows = state.rows;
    const delivRows = rows.filter(r => r[12] === '是');
    const recRows = rows.filter(r => r[13] === '是');
    const unrecGroups = getUnrecoveredGroups();
    const pendingExplain = unrecGroups.filter(g => !U.cleanStr(state.unrecReasons[g.doc]) && !U.cleanStr(rows[g.rowIndices[0] - 1][13])).length;

    let displayRows = rows;
    if (state.filterMode === 'delivery') displayRows = rows.filter(r => r[12] === '是');
    else if (state.filterMode === 'rec') displayRows = rows.filter(r => r[13] === '是');
    else if (state.filterMode === 'unrec') displayRows = rows.filter(r => r[12] === '是' && r[13] !== '是');

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📄 黄单回收追踪核对（独立模块 · 兼容无表头黄单切片 · 仅回填 N 列「黄单是否回收」）</span>
          <span class="pill pill-blue">${state.sourceName ? '当前黄单表：' + U.escHtml(state.sourceName) : '等待上传黄单追踪表 (.xlsx)'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">黄单表总行数（100%对齐）</div><div class="kpi-val">${rows.length}</div></div>
          <div class="kpi-card"><div class="kpi-label">需配送行数 (M列=是)</div><div class="kpi-val">${delivRows.length}</div></div>
          <div class="kpi-card green"><div class="kpi-label">已回收行数 (N列=是)</div><div class="kpi-val">${recRows.length}</div></div>
          <div class="kpi-card ${unrecGroups.length ? 'orange' : 'green'}"><div class="kpi-label">未回收配送单据数 (待说明: ${pendingExplain})</div><div class="kpi-val">${unrecGroups.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="y-up-xlsx">📂 1. 上传黄单追踪表 (.xlsx)</button>
          <input type="file" id="y-in-xlsx" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <button class="btn btn-warning" id="y-up-pdf">📄 2. 导入手机扫描黄单 PDF</button>
          <input type="file" id="y-in-pdf" accept=".pdf" multiple class="hidden-input" />
          <button class="btn" id="y-paste-docs">📋 手动粘贴已回收单号</button>
          <span style="flex:1"></span>
          <button class="btn" id="y-copy-col" ${!rows.length ? 'disabled' : ''} title="仅复制 N 列（黄单是否回收），按原行序 1:1 贴回原表，绝不动 M/O 列">📋 仅复制 N 列</button>
          <button class="btn btn-success" id="y-copy-all" ${!rows.length ? 'disabled' : ''}>📋 复制整表（无表头原序）</button>
          <button class="btn" id="y-exp" ${!rows.length ? 'disabled' : ''}>💾 导出黄单核对结果 (.xlsx)</button>
        </div>
        <div id="y-pdf-status" style="font-size:12px;color:#0369a1;margin-bottom:4px;">${U.escHtml(state.pdfLog)}</div>
      </div>

      ${unrecGroups.length > 0 ? `
      <div class="unrec-box">
        <div class="panel-title" style="margin-bottom:4px;">
          <span>⚠️ 未回收快填栏：共 <b>${unrecGroups.length}</b> 张配送单（M=是）尚未回收黄单（填一次自动同步 N 列，原顺序 100% 锁定）</span>
          <span class="pill pill-orange">剩余 ${pendingExplain} 张未填说明</span>
        </div>
        <div class="unrec-list">
          ${unrecGroups.map((g, idx) => {
            const curVal = state.unrecReasons[g.doc] ?? (rows[g.rowIndices[0] - 1][13] || '');
            const rowSpan = g.rowIndices.length === 1
              ? `第 ${g.rowIndices[0]} 行`
              : `第 ${g.rowIndices[0]}~${g.rowIndices[g.rowIndices.length - 1]} 行（共 ${g.rowIndices.length} 行）`;
            return `<div class="unrec-item" data-doc="${g.doc}">
              <div class="unrec-meta">
                <div><b>${idx + 1}. ${g.doc}</b> <span class="pill pill-blue">${U.escHtml(g.dept || '未知部门')}</span> <span style="color:#64748b;font-size:11.5px;">${g.date || ''} · ${rowSpan}</span></div>
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
            <select id="y-filter">
              <option value="all" ${state.filterMode === 'all' ? 'selected' : ''}>显示：全部行 (${rows.length})</option>
              <option value="unrec" ${state.filterMode === 'unrec' ? 'selected' : ''}>仅看：未回收配送单 (M=是 且 N≠是)</option>
              <option value="rec" ${state.filterMode === 'rec' ? 'selected' : ''}>仅看：已回收 (N=是)</option>
              <option value="delivery" ${state.filterMode === 'delivery' ? 'selected' : ''}>仅看：需配送 (M=是)</option>
            </select>
          </div>
          <span style="font-size:11.5px;color:#64748b;">铁律：仅回填 N 列（第14列「黄单是否回收」），严禁改动 M 列（是否配送）与 O 列（欠请购单）</span>
        </div>
        <div id="y-table-box"></div>
      </div>
    `;

    const inXlsx = root.querySelector('#y-in-xlsx');
    root.querySelector('#y-up-xlsx').onclick = () => inXlsx.click();
    inXlsx.onchange = async e => {
      if (!e.target.files[0]) return;
      try {
        await loadYellowTable(e.target.files[0]);
        renderModule(root);
      } catch (err) {
        U.toast('黄单表解析失败：' + err.message, 'error');
      }
      e.target.value = '';
    };

    const inPdf = root.querySelector('#y-in-pdf');
    root.querySelector('#y-up-pdf').onclick = () => inPdf.click();
    inPdf.onchange = async e => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const statusEl = root.querySelector('#y-pdf-status');
      try {
        const res = await extractDocsFromPdfs(files, msg => { statusEl.textContent = '⏳ ' + msg; });
        res.found.forEach(d => state.recoveredSet.add(d));
        applyYellowAndReasons();
        state.pdfLog = `✅ 已扫描 ${files.length} 个 PDF（共 ${res.totalPages} 页，OCR ${res.ocrPages} 页），累计识别 ${state.recoveredSet.size} 个单号并已回填 N 列。`;
        persistState();
        U.toast(`黄单识别完成：提取到 ${res.found.size} 个单号并回填 N 列`, 'success');
        renderModule(root);
      } catch (err) {
        U.toast('PDF 识别异常：' + err.message, 'error');
      }
      e.target.value = '';
    };

    root.querySelector('#y-paste-docs').onclick = () => {
      const raw = prompt('请粘贴已回收黄单的单据号（任意文本均可，自动提取 CCHF/CK 单号）：');
      if (!raw) return;
      const matches = raw.match(DOC_REGEX) || [];
      if (!matches.length) {
        U.toast('未检测到有效的 CCHF/CK 单据号', 'warn');
        return;
      }
      const uniqueDocs = Array.from(new Set(matches.map(m => m.toUpperCase())));
      uniqueDocs.forEach(m => state.recoveredSet.add(m));
      applyYellowAndReasons();
      state.pdfLog = `✅ 手动导入 ${uniqueDocs.length} 个去重已回收单号，累计 ${state.recoveredSet.size} 个。`;
      persistState();
      U.toast(`已回填 ${uniqueDocs.length} 个已回收单号到 N 列`, 'success');
      renderModule(root);
    };

    root.querySelectorAll('.chip-btn').forEach(btn => {
      btn.onclick = () => {
        const doc = btn.dataset.doc;
        const reason = btn.dataset.reason;
        state.unrecReasons[doc] = reason;
        applyYellowAndReasons();
        persistState();
        renderModule(root);
        U.toast(`已同步 [${doc}] -> "${reason}" 至 N 列`, 'success');
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

    root.querySelector('#y-copy-col').onclick = async () => {
      const lines = state.rows.map(r => String(r[13] ?? '').replace(/[\t\r\n]+/g, ' '));
      const ok = await U.copyText(lines.join('\n'));
      U.toast(ok ? `✅ 已复制 N 列（共 ${lines.length} 行，1:1 对齐原行序，可直接贴回原黄单表 N 列）` : '复制失败', ok ? 'success' : 'error');
    };

    root.querySelector('#y-copy-all').onclick = async () => {
      const ok = await U.copyAsTSV(HEADERS_16, state.rows, false);
      U.toast(ok ? `✅ 已复制 ${state.rows.length} 行完整原顺序黄单数据` : '复制失败', ok ? 'success' : 'error');
    };

    root.querySelector('#y-exp').onclick = () => {
      U.exportWorkbook([
        { name: '黄单核对结果', headers: HEADERS_16, rows: state.rows, textCols: [1, 2, 6, 15], numCols: [9], colWidths: COL_WIDTHS }
      ], '黄单回收核对结果.xlsx');
      U.toast('已导出：黄单回收核对结果.xlsx', 'success');
    };

    root.querySelector('#y-filter').onchange = e => {
      state.filterMode = e.target.value;
      state.page = 1;
      renderModule(root);
    };

    U.renderPagedTable(root.querySelector('#y-table-box'), {
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
    id: 'mod_yellow_slip',
    icon: '📄',
    title: '黄单回收核对',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
      if (excels.length) await loadYellowTable(excels[0]);
      if (pdfs.length) {
        const res = await extractDocsFromPdfs(pdfs, msg => {
          const el = this._root && this._root.querySelector('#y-pdf-status');
          if (el) el.textContent = '⏳ ' + msg;
        });
        res.found.forEach(d => state.recoveredSet.add(d));
        applyYellowAndReasons();
        state.pdfLog = `✅ 智能导入 ${pdfs.length} 个 PDF，识别 ${res.found.size} 个单号并已回填 N 列。`;
        persistState();
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
