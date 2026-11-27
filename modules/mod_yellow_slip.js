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
  const QUICK_REASONS = ['物资已领取', '自取延迟', '配送延迟', '开单延迟'];
  const DOC_REGEX = /(?:CCHF|CK)\d{10,22}/gi;

  let activeRoot = null;
  let ocrWorkers = null;
  let ocrIdleTimer = null;

  function scheduleOcrWorkerCleanup() {
    clearTimeout(ocrIdleTimer);
    ocrIdleTimer = setTimeout(async () => {
      if (state.scanning || !ocrWorkers || !ocrWorkers.length) return;
      const toKill = ocrWorkers;
      ocrWorkers = null;
      for (const w of toKill) {
        try { await w.terminate(); } catch (_) {}
      }
    }, 90000); // 识别全部结束空闲 90 秒后自动释放 ~400MB WASM 内存
  }

  let state = {
    rows: [],           // 16列黄单追踪表（原行序100%锁死）
    hasHeaderInSource: false,
    recoveredSet: new Set(),
    unrecReasons: {},   // { docNo: reasonText }
    filterMode: 'all',  // 'all' | 'delivery' | 'unrec' | 'rec'
    page: 1,
    pdfLog: '',
    scanning: false,
    sourceName: '',
    _hydrated: false
  };

  function setGlobalBgPill(text, show = true, done = false) {
    const el = document.getElementById('wb-bg-pill');
    if (!el) return;
    if (!show) { el.style.display = 'none'; return; }
    el.dataset.targetMod = 'mod_yellow_slip';
    el.style.display = 'inline-block';
    el.style.background = done ? '#15803d' : '#1d4ed8';
    el.style.color = done ? '#dcfce7' : '#dbeafe';
    el.textContent = text;
  }

  function refreshIfVisible() {
    if (activeRoot && activeRoot.isConnected) {
      renderModule(activeRoot);
    }
  }

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
    // 后台扫描运行中或已完成内存水合时，绝不用旧缓存覆写当前内存进度
    if (state.scanning || state._hydrated) return;
    const saved = await WB.Store.load('mod_yellow_slip');
    if (saved && !state.scanning) {
      state.rows = saved.rows || [];
      state.hasHeaderInSource = !!saved.hasHeaderInSource;
      state.recoveredSet = new Set(saved.recoveredList || []);
      state.unrecReasons = saved.unrecReasons || {};
      state.pdfLog = saved.pdfLog || '';
      state.sourceName = saved.sourceName || '';
    }
    state._hydrated = true;
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

  async function getOcrWorkerPool() {
    if (!window.Tesseract || typeof Tesseract.createWorker !== 'function') return null;
    if (ocrWorkers && ocrWorkers.length) return ocrWorkers;
    const pool = [];
    const concurrency = 2; // 双 Worker 并行复用，告别每页重启引擎的卡顿
    for (let i = 0; i < concurrency; i++) {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: 'CCHFK0123456789' });
      pool.push(w);
    }
    ocrWorkers = pool;
    return pool;
  }

  /** 后台常驻扫描 PDF：可随时切去其他板块干活，绝不中断、绝不丢进度，每页扫出即实时回填 N 列 */
  function startBackgroundPdfScan(pdfFiles) {
    const files = Array.from(pdfFiles || []);
    if (!files.length) return;
    if (state.scanning) {
      U.toast('后台正在识别上一批 PDF，请稍候完成后再追加', 'warn');
      return;
    }

    state.scanning = true;
    state.pdfLog = `⏳ 后台已启动：正在解析 ${files.length} 个 PDF（可自由切换其他标签页干活，绝不中断）...`;
    setGlobalBgPill(`⏳ 黄单PDF后台识别启动中...`, true, false);
    refreshIfVisible();
    U.toast('黄单 PDF 已转入后台极速识别，你可随时切去其他板块干活！', 'info');

    // 独立异步后台执行，绝不阻塞 UI 与标签页切换
    (async () => {
      let totalPages = 0;
      let donePages = 0;
      let ocrPages = 0;
      let newlyFound = 0;

      const updateProgress = (msg) => {
        state.pdfLog = `⏳ ${msg}（可自由切换其他标签页）`;
        setGlobalBgPill(`⏳ 黄单PDF ${donePages}/${totalPages || '?'}页 · 累计 ${state.recoveredSet.size} 单`, true, false);
        const stEl = activeRoot && activeRoot.isConnected ? activeRoot.querySelector('#y-pdf-status') : null;
        if (stEl) stEl.textContent = state.pdfLog;
      };

      try {
        // 1. 先载入全部 PDF 并统计总页数
        const loadedPdfs = [];
        for (const f of files) {
          const buf = await f.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          totalPages += pdf.numPages;
          loadedPdfs.push({ name: f.name, pdf });
        }

        // 2. 第一遍：毫秒级扫描全部页面的文本层，把需要 OCR 的纯图片页收入队列
        const ocrQueue = [];
        for (const item of loadedPdfs) {
          for (let p = 1; p <= item.pdf.numPages; p++) {
            const page = await item.pdf.getPage(p);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(it => it.str).join(' ');
            const matches = pageText.match(DOC_REGEX) || [];
            if (matches.length > 0) {
              let changed = false;
              matches.forEach(m => {
                const up = m.toUpperCase();
                if (!state.recoveredSet.has(up)) { state.recoveredSet.add(up); newlyFound++; changed = true; }
              });
              donePages++;
              if (changed) {
                applyYellowAndReasons();
                persistState();
                refreshIfVisible();
              }
              updateProgress(`高速文本层扫描 ${donePages}/${totalPages} 页...`);
            } else {
              ocrQueue.push({ name: item.name, p, page });
            }
          }
        }

        // 3. 第二遍：纯图片扫描页 -> 复用 2 个并行 OCR Worker 极速识别，每识别完 1 页实时回填落盘
        if (ocrQueue.length > 0 && window.Tesseract) {
          updateProgress(`文本层完成，正在启动双核 OCR 引擎处理 ${ocrQueue.length} 页纯图片扫描件...`);
          const pool = await getOcrWorkerPool();
          let qIdx = 0;

          async function runWorker(worker) {
            while (qIdx < ocrQueue.length) {
              const job = ocrQueue[qIdx++];
              ocrPages++;
              const viewport = job.page.getViewport({ scale: 1.5 });
              const canvas = document.createElement('canvas');
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              await job.page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

              const res = worker
                ? await worker.recognize(canvas)
                : await Tesseract.recognize(canvas, 'eng', { tessedit_char_whitelist: 'CCHFK0123456789' });

              const ocrText = (res.data.text || '').replace(/\s+/g, '');
              const ocrMatches = ocrText.match(/(?:CCHF|CK)\d{10,22}/gi) || [];
              let changed = false;
              ocrMatches.forEach(m => {
                const up = m.toUpperCase();
                if (!state.recoveredSet.has(up)) { state.recoveredSet.add(up); newlyFound++; changed = true; }
              });
              donePages++;
              if (changed) {
                applyYellowAndReasons();
                persistState();
                refreshIfVisible();
              }
              updateProgress(`后台 OCR 识别中 ${donePages}/${totalPages} 页（已新增 ${newlyFound} 单）`);
            }
          }

          if (pool && pool.length) {
            await Promise.all(pool.map(w => runWorker(w)));
          } else {
            await runWorker(null);
          }
        }

        applyYellowAndReasons();
        state.pdfLog = `✅ 后台识别完成：共扫描 ${files.length} 个 PDF（${totalPages} 页，其中 OCR ${ocrPages} 页），本次新增 ${newlyFound} 单，累计已回收 ${state.recoveredSet.size} 单并已精准回填 N 列。`;
        persistState();
        setGlobalBgPill(`✅ 黄单PDF已完成 (+${newlyFound}单)`, true, true);
        setTimeout(() => { if (!state.scanning) setGlobalBgPill('', false); }, 10000);
        U.toast(`黄单 PDF 后台扫描完成！新增 ${newlyFound} 个单号已自动回填 N 列`, 'success');
      } catch (err) {
        state.pdfLog = `❌ PDF 识别异常：${err.message}`;
        setGlobalBgPill('', false);
        U.toast('PDF 识别异常：' + err.message, 'error');
      } finally {
        state.scanning = false;
        scheduleOcrWorkerCleanup();
        refreshIfVisible();
      }
    })();
  }

  /** 统计未回收配送单据，并交叉核对「同一天 + 同一车间」其他仓库是否已回收 */
  function getUnrecoveredGroups() {
    // 1. 先按「日期||车间」统计每个仓库的回收情况
    const dayDeptWh = new Map(); // "date||dept" -> Map(wh -> { hasRec, hasUnrec })
    state.rows.forEach(row => {
      const date = U.cleanStr(row[2]);
      const dept = U.cleanStr(row[5]) || '未知车间';
      const wh = U.cleanStr(row[3]) || '未知仓';
      const doc = U.cleanStr(row[1]).toUpperCase();
      if (!doc) return;
      const isDeliv = U.cleanStr(row[12]) === '是';
      const isRec = state.recoveredSet.has(doc) || U.cleanStr(row[13]) === '是';
      if (!isDeliv && !isRec) return;

      const ddKey = `${date}||${dept}`;
      if (!dayDeptWh.has(ddKey)) dayDeptWh.set(ddKey, new Map());
      const whMap = dayDeptWh.get(ddKey);
      if (!whMap.has(wh)) whMap.set(wh, { hasRec: false, hasUnrec: false });
      const st = whMap.get(wh);
      if (isRec) st.hasRec = true;
      else if (isDeliv) st.hasUnrec = true;
    });

    // 2. 按未回收单据号聚合
    const map = new Map();
    state.rows.forEach((row, idx) => {
      const doc = U.cleanStr(row[1]).toUpperCase();
      const isDeliv = U.cleanStr(row[12]) === '是';
      const isRec = state.recoveredSet.has(doc) || U.cleanStr(row[13]) === '是';
      if (!doc || !isDeliv || isRec) return;
      if (!map.has(doc)) {
        map.set(doc, {
          doc,
          shortDoc: doc.length > 8 ? `…${doc.slice(-6)}` : doc,
          dept: U.cleanStr(row[5]) || '未知车间',
          wh: U.cleanStr(row[3]) || '未知仓',
          date: U.cleanStr(row[2]),
          rowIndices: [],
          samples: []
        });
      }
      const g = map.get(doc);
      g.rowIndices.push(idx + 1);
      if (g.samples.length < 4) g.samples.push(`${row[7]}(${row[9]}${row[8]})`);
    });

    // 3. 附加上同日同车间各仓库的交叉核对结论
    const list = Array.from(map.values());
    list.forEach(g => {
      const whMap = dayDeptWh.get(`${g.date}||${g.dept}`) || new Map();
      const recWhs = [];
      const unrecWhs = [];
      for (const [wh, st] of whMap.entries()) {
        if (st.hasUnrec) unrecWhs.push(wh);
        else if (st.hasRec) recWhs.push(wh);
      }
      const otherRecWhs = recWhs.filter(w => w !== g.wh);
      const otherUnrecWhs = unrecWhs.filter(w => w !== g.wh);

      if (otherRecWhs.length > 0 && otherUnrecWhs.length === 0) {
        g.whHint = `${otherRecWhs.join('、')}已回收（仅本仓未回收）`;
        g.whTone = 'pill-green';
      } else if (otherRecWhs.length > 0 && otherUnrecWhs.length > 0) {
        g.whHint = `${otherRecWhs.join('、')}已回收；本仓及${otherUnrecWhs.join('、')}未回收`;
        g.whTone = 'pill-orange';
      } else if (otherUnrecWhs.length > 0) {
        g.whHint = `当日该车间全部仓库均未回收（${unrecWhs.join('、')}）`;
        g.whTone = 'pill-red';
      } else {
        g.whHint = `当日该车间仅此仓（未回收）`;
        g.whTone = 'pill-red';
      }
    });
    return list;
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
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <b style="font-size:13.5px;color:#0f172a;">${idx + 1}. ${U.escHtml(g.dept)}</b>
                  <span class="pill pill-blue">${U.escHtml(g.wh)}</span>
                  <span class="pill ${g.whTone}">${U.escHtml(g.whHint)}</span>
                  <span style="color:#64748b;font-size:11.5px;" title="完整单据号：${g.doc}">${g.date || ''} · 单号${g.shortDoc} · ${rowSpan}</span>
                </div>
                <div style="font-size:12.5px;color:#1e293b;font-weight:600;margin-top:3px;">物品：${U.escHtml(g.samples.join('、'))}${g.rowIndices.length > 4 ? ' ...' : ''}</div>
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
    inPdf.onchange = e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (!files.length) return;
      startBackgroundPdfScan(files);
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
        if (cIdx === 13 && val === '是') return `<span class="pill pill-green">是</span>`;
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
      activeRoot = container;
      renderModule(container);
      await hydrateState();
      if (activeRoot === container && container.isConnected) {
        renderModule(container);
      }
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
      if (excels.length) await loadYellowTable(excels[0]);
      if (pdfs.length) startBackgroundPdfScan(pdfs);
      refreshIfVisible();
    }
  });
})();
