/**
 * 模块 3：出库扫描 PDF 自动核对工作台（纯 PDF 版 · 平台自动检索核销，人工只核对未检索单据）
 * 核心能力：
 * 1. 双格式出库单自动拆票：
 *    - ERP《材料出库单列表》（无空行、带单据号）-> 自动定位真实表头，按「单据号」拆分为独立单据卡片
 *    - HJF 14列 / 总账（按空行分票）-> 自动识别日期列偏移，按空行拆分为独立单据卡片
 *    - 强制剔除含丁烷气罐在内的全部气体
 * 2. 平台后台自动核对扫描 PDF（文本层毫秒扫 + 双核复用 OCR 后台跑，切标签不中断）：
 *    - 自动从 PDF 每页提取单据号（CCHF/CK）与 10/11 位物料编码
 *    - 自动匹配并核销右侧对应单据，标注匹配页码（点击一键跳转该页复查）
 * 3. 核对区默认聚焦「🔴 待人工核对（平台未检索到）」，左侧支持「仅看未匹配PDF页」，每张单据独立点击核销。
 */
(function () {
  'use strict';
  const U = WB.Utils;
  const SCHEMA_VER = 2;
  const GAS_KEYWORDS = ['氧气', '乙炔', '二氧化碳', '氩气', '氮气', '丙烷', '液化气', '混合气', '丁烷气', '丁烷'];
  const DOC_REGEX = /(?:CCHF|CK)\d{10,22}/gi;
  // 兼容扫描件常见 OCR 误识（如 C->G/O, H->N, F->E/P, 0->O, 1->I/L）
  const FUZZY_DOC_REGEX = /(?:[CGOQ0]{2}[HN][FEP]|C[KH])\s*[0-9OIL]{10,22}/gi;
  const CODE_REGEX = /\b0[356789]\d{8,9}\b/g;

  function extractDocsFromText(rawText) {
    const out = new Set();
    const compact = String(rawText || '').replace(/[\r\n\t ]+/g, '');
    (compact.match(DOC_REGEX) || []).forEach(m => out.add(m.toUpperCase()));
    (String(rawText || '').match(FUZZY_DOC_REGEX) || []).forEach(m => {
      const s = m.replace(/\s+/g, '').toUpperCase();
      if (s.length >= 14 && /^[CGOQ0]{2}[HN][FEP]/.test(s)) {
        const digits = s.slice(4).replace(/O/g, '0').replace(/[IL]/g, '1');
        if (/^\d{10,22}$/.test(digits)) out.add('CCHF' + digits);
      } else if (s.length >= 12 && /^CK/.test(s)) {
        const digits = s.slice(2).replace(/O/g, '0').replace(/[IL]/g, '1');
        if (/^\d{10,22}$/.test(digits)) out.add('CK' + digits);
      }
    });
    return Array.from(out);
  }

  let activeRoot = null;
  let ocrWorkers = null;

  let state = {
    tickets: [],          // [{ id, docNo, shortDoc, date, dept, rec, wh, tag, items: [{code,name,qty,unit}], checked, matchType: ''|'auto'|'manual', matchedPage: 0 }]
    availDates: [],
    targetDate: '',
    sheetName: '',
    sourceName: '',
    parseMode: '',        // 'erp_doc' | 'blank_block'
    pdfPages: [],         // [{ pageNum, fileName, url, docs: [], codes: [], matchedTicketIds: [] }]
    activePageIdx: 0,
    onlyUnmatchedPages: false,
    auditFilter: 'unmatched', // 'unmatched' | 'auto' | 'all'
    scanning: false,
    scanLog: '',
    _hydrated: false
  };

  function setGlobalBgPill(text, show = true, done = false) {
    const el = document.getElementById('wb-bg-pill');
    if (!el) return;
    if (!show) { el.style.display = 'none'; return; }
    el.dataset.targetMod = 'mod_photo_check';
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
    WB.Store.save('mod_photo_check', {
      schemaVer: SCHEMA_VER,
      tickets: state.tickets,
      availDates: state.availDates,
      targetDate: state.targetDate,
      sheetName: state.sheetName,
      sourceName: state.sourceName,
      parseMode: state.parseMode,
      auditFilter: state.auditFilter,
      scanLog: state.scanLog
    });
  }

  async function hydrateState() {
    if (state.scanning || state._hydrated) return;
    const saved = await WB.Store.load('mod_photo_check');
    // 自动丢弃旧版 v1 错误缓存（避免出现旧版合并成 1 张大卡片导致误报 0/0）
    if (saved && saved.schemaVer === SCHEMA_VER && !state.scanning) {
      state.tickets = saved.tickets || [];
      state.availDates = saved.availDates || [];
      state.targetDate = saved.targetDate || '';
      state.sheetName = saved.sheetName || '';
      state.sourceName = saved.sourceName || '';
      state.parseMode = saved.parseMode || '';
      state.auditFilter = saved.auditFilter || 'unmatched';
      state.scanLog = saved.scanLog || '';
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

  /** 智能载入当天出库清单：自动兼容 ERP《材料出库单列表》(按单据号拆票) 与 HJF 14列总账(按空行拆票) */
  async function loadTicketsFile(file) {
    const parsed = await U.readSpreadsheet(file);
    let bestSn = parsed.sheetNames[0];
    let bestCount = -1;
    for (const sn of parsed.sheetNames) {
      const rows = parsed.sheets[sn] || [];
      const nonEmpty = rows.filter(r => r.some(v => U.cleanStr(v) !== '')).length;
      if (nonEmpty > bestCount) {
        bestCount = nonEmpty;
        bestSn = sn;
      }
    }
    const aoa = parsed.sheets[bestSn] || [];
    if (aoa.length < 2) throw new Error('表格无有效数据行');

    // 1. 检测是否为 ERP 材料出库单列表 / 16列台账（含「单据号」列）
    let erpHdrIdx = -1;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
      if ((line.includes('单据号') || line.includes('出库单号')) && (line.includes('物料编码') || line.includes('存货编码') || line.includes('物料名称'))) {
        erpHdrIdx = i;
        break;
      }
    }

    const tickets = [];
    const dateSet = new Set();

    if (erpHdrIdx >= 0) {
      // 模式 A：ERP 材料出库单列表 / 16 列台账 -> 按单据号分组拆票，绝不合并成一张！
      const h = aoa[erpHdrIdx].map(v => U.cleanStr(v));
      const iDoc = findCol(h, ['单据号', '出库单号']);
      const iDate = findCol(h, ['出库日期', '单据日期', '日期']);
      const iWh = findCol(h, ['仓库', '仓库名称']);
      const iDept = findCol(h, ['领料部门', '部门', '车间']);
      const iCode = findCol(h, ['物料编码', '存货编码', '物资编码']);
      const iName = findCol(h, ['物料名称', '存货名称', '物资名称']);
      const iUnit = findCol(h, ['单位', '主单位']);
      const iQty = findCol(h, ['实发数量', '出库数量', '数量']);
      const iRem = findCol(h, ['备注']);
      const iLrem = findCol(h, ['行备注']);

      const docGroups = new Map();
      let dataRows = aoa.slice(erpHdrIdx + 1);
      while (dataRows.length > 0) {
        const last = dataRows[dataRows.length - 1];
        const c0 = U.cleanStr(last[0]);
        if (c0 === '合计' || c0 === '总计' || last.every(v => !U.cleanStr(v))) dataRows.pop();
        else break;
      }

      for (const r of dataRows) {
        const docNo = iDoc >= 0 ? U.cleanStr(r[iDoc]).toUpperCase() : '';
        const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
        if (!docNo || !name) continue;
        if (GAS_KEYWORDS.some(g => name.includes(g))) continue; // 铁律：剔除全部气体含丁烷气罐

        const dateStr = iDate >= 0 ? U.formatDate(r[iDate]) : '';
        if (dateStr) dateSet.add(dateStr);
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '未知车间';
        const wh = iWh >= 0 ? U.cleanStr(r[iWh]) : '';
        const rem = iRem >= 0 ? U.cleanStr(r[iRem]) : '';
        const lrem = iLrem >= 0 ? U.cleanStr(r[iLrem]) : '';
        const code = iCode >= 0 ? U.formatCode(r[iCode]) : '';
        const qty = iQty >= 0 ? U.fmtNum(r[iQty]) : '';
        const unit = iUnit >= 0 ? U.cleanStr(r[iUnit]) : '';

        if (!docGroups.has(docNo)) {
          const isSelf = `${rem} ${lrem}`.includes('自取');
          docGroups.set(docNo, {
            id: docGroups.size + 1,
            docNo,
            shortDoc: docNo.length > 8 ? `…${docNo.slice(-6)}` : docNo,
            date: dateStr,
            dept: dept || '未知车间',
            rec: rem,
            wh,
            tag: isSelf ? `${wh}（自取）` : wh,
            items: [],
            checked: false,
            matchType: '',
            matchedPage: 0
          });
        }
        docGroups.get(docNo).items.push({ code, name, qty, unit });
      }
      docGroups.forEach(t => { if (t.items.length > 0) tickets.push(t); });
      state.parseMode = 'erp_doc';
    } else {
      // 模式 B：HJF 14 列 / 历史出库总账 -> 按空行切分独立单据
      const firstCleaned = (aoa[0] || []).map(v => U.cleanStr(v));
      const hasHeader = /^(日期|车间|部门|领料部门)$/.test(firstCleaned[0] || '') ||
        (firstCleaned.includes('车间') && firstCleaned.includes('仓库'));

      let hasDateCol = firstCleaned[0] === '日期' || firstCleaned[0].includes('日期');
      if (!hasDateCol) {
        for (let i = hasHeader ? 1 : 0; i < Math.min(10, aoa.length); i++) {
          const c0 = U.cleanStr((aoa[i] || [])[0]);
          if (c0) {
            if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(c0)) hasDateCol = true;
            break;
          }
        }
      }
      const off = hasDateCol ? 1 : 0;

      const rawBlocks = [];
      let cur = [];
      aoa.forEach((row, idx) => {
        const cleaned = row.map(v => U.cleanStr(v));
        if (idx === 0 && hasHeader) return;
        if (cleaned.every(v => v === '')) {
          if (cur.length) { rawBlocks.push(cur); cur = []; }
        } else {
          cur.push(cleaned);
        }
      });
      if (cur.length) rawBlocks.push(cur);

      rawBlocks.forEach((rows, bIdx) => {
        const dateStr = hasDateCol ? U.formatDate(rows[0][0]) : '';
        if (dateStr) dateSet.add(dateStr);
        const dept = rows[0][off + 0] || '未知车间';
        const rec = rows[0][off + 1] || '';
        const wh = (rows[0][off + 2] || '').replace(/（.*）$/, '');
        const sp = rows[0][off + 13] || '';
        const zq = rows[0][off + 12] || '';
        const tag = (sp || zq) ? `${wh}（${sp || zq}）` : wh;

        const items = [];
        for (const r of rows) {
          const code = U.formatCode(r[off + 3] || '');
          const name = r[off + 4] || '';
          const qty = r[off + 5] || '';
          const unit = r[off + 6] || '';
          if (!name) continue;
          if (GAS_KEYWORDS.some(g => name.includes(g))) continue;
          items.push({ code, name, qty, unit });
        }
        if (items.length > 0) {
          tickets.push({
            id: bIdx + 1,
            docNo: '',
            shortDoc: `#${bIdx + 1}`,
            date: dateStr,
            dept,
            rec,
            wh,
            tag,
            items,
            checked: false,
            matchType: '',
            matchedPage: 0
          });
        }
      });
      state.parseMode = 'blank_block';
    }

    state.tickets = tickets;
    state.availDates = Array.from(dateSet).sort().reverse();
    state.targetDate = '';
    state.sheetName = bestSn;
    state.sourceName = file.name;
    state.auditFilter = 'unmatched';

    // 若已载入 PDF 页，立刻重新自动核对一次
    if (state.pdfPages.length > 0) runAutoMatchAgainstPages();
    persistState();
    const modeTxt = state.parseMode === 'erp_doc' ? '按单据号拆票' : '按空行拆票';
    U.toast(`从 [${bestSn}] ${modeTxt}：共 ${tickets.length} 张非气体独立单据（已剔除全部气体）`, 'success');
  }

  /** 将已扫描的 PDF 页面提取结果（单据号 + 物料编码）与右侧出库单据自动比对核销 */
  function runAutoMatchAgainstPages() {
    if (!state.tickets.length || !state.pdfPages.length) return 0;

    // 重置页面反查索引
    state.pdfPages.forEach(p => { p.matchedTicketIds = []; });

    // 建立 单据号 -> 页码 索引，及 编码 -> 页码集合 索引
    const docToPage = new Map();
    state.pdfPages.forEach((p, idx) => {
      (p.docs || []).forEach(d => {
        if (!docToPage.has(d)) docToPage.set(d, idx + 1);
      });
    });

    let newlyAuto = 0;
    state.tickets.forEach(t => {
      // 保留人工已核销的记录；对未人工核销的尝试自动匹配
      if (t.matchType === 'manual') return;

      let matchedPage = 0;
      // 优先 1：单据号精确匹配（ERP 出库单 100% 精准）
      if (t.docNo && docToPage.has(t.docNo)) {
        matchedPage = docToPage.get(t.docNo);
      } else {
        // 优先 2：按单据内 10/11 位物料编码集合比对各 PDF 页（兼容无单据号清单或单据号 OCR 模糊页）
        const tCodes = Array.from(new Set(t.items.map(it => it.code).filter(c => /^0[356789]\d{8,9}$/.test(c))));
        if (tCodes.length > 0) {
          let bestPage = 0;
          let bestHits = 0;
          state.pdfPages.forEach((p, idx) => {
            if (!p.codes || !p.codes.length) return;
            const pSet = new Set(p.codes);
            let hits = 0;
            tCodes.forEach(c => { if (pSet.has(c)) hits++; });
            const need = tCodes.length === 1 ? 1 : Math.ceil(tCodes.length * 0.5);
            if (hits >= need && hits > bestHits) {
              bestHits = hits;
              bestPage = idx + 1;
            }
          });
          if (bestPage > 0) matchedPage = bestPage;
        }
      }

      if (matchedPage > 0) {
        if (!t.checked) newlyAuto++;
        t.checked = true;
        t.matchType = 'auto';
        t.matchedPage = matchedPage;
        const pageObj = state.pdfPages[matchedPage - 1];
        if (pageObj && !pageObj.matchedTicketIds.includes(t.id)) {
          pageObj.matchedTicketIds.push(t.id);
        }
      }
    });
    return newlyAuto;
  }

  async function getOcrWorkerPool() {
    if (!window.Tesseract || typeof Tesseract.createWorker !== 'function') return null;
    if (ocrWorkers && ocrWorkers.length) return ocrWorkers;
    const pool = [];
    for (let i = 0; i < 2; i++) {
      const w = await Tesseract.createWorker('eng');
      await w.setParameters({ tessedit_char_whitelist: 'CCHFKGOQIL0123456789' });
      pool.push(w);
    }
    ocrWorkers = pool;
    return pool;
  }

  /** 后台导入并自动核对出库扫描 PDF（纯 PDF，支持切标签不中断） */
  function startBackgroundPdfAudit(files) {
    const pdfs = Array.from(files || []).filter(f => /\.pdf$/i.test(f.name));
    if (!pdfs.length) {
      U.toast('本模块已统一为纯 PDF 核对，请拖入出库扫描件 (.pdf)', 'warn');
      return;
    }
    if (state.scanning) {
      U.toast('后台正在核对上一份出库 PDF，请稍候完成', 'warn');
      return;
    }

    state.scanning = true;
    state.pdfPages = [];
    state.activePageIdx = 0;
    state.scanLog = `⏳ 后台已启动：正在解析 ${pdfs.length} 份出库 PDF 并自动核对（可自由切去其他标签页）...`;
    setGlobalBgPill('⏳ 出库PDF后台核对中...', true, false);
    refreshIfVisible();
    U.toast('出库 PDF 已转入后台自动核对，完成后你只需人工复核未检索到的单据！', 'info');

    (async () => {
      let totalPages = 0;
      let donePages = 0;
      let ocrPages = 0;

      const updateStatus = (msg) => {
        const autoCnt = state.tickets.filter(t => t.matchType === 'auto').length;
        const foundDocs = new Set(state.pdfPages.flatMap(p => p.docs || [])).size;
        state.scanLog = state.tickets.length
          ? `⏳ ${msg} ｜ 已检出 ${foundDocs} 个单号 · 平台自动核销 ${autoCnt}/${state.tickets.length} 张`
          : `⏳ ${msg} ｜ 已检出 ${foundDocs} 个单号（请顺手导入「1. 出库清单」即可自动匹配）`;
        setGlobalBgPill(`⏳ 出库PDF ${donePages}/${totalPages || '?'}页 · 检出${foundDocs}单`, true, false);
        const stEl = activeRoot && activeRoot.isConnected ? activeRoot.querySelector('#p-scan-log') : null;
        if (stEl) stEl.textContent = state.scanLog;
      };

      try {
        const loaded = [];
        for (const f of pdfs) {
          const buf = await f.arrayBuffer();
          const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          totalPages += pdf.numPages;
          loaded.push({ name: f.name, pdf });
        }

        const ocrQueue = [];
        let globalPageSeq = 0;

        for (const item of loaded) {
          for (let p = 1; p <= item.pdf.numPages; p++) {
            globalPageSeq++;
            const page = await item.pdf.getPage(p);
            // 渲染清晰度 1.8x（保证单据号小字清晰可 OCR）
            const vp = page.getViewport({ scale: 1.8 });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
            const dataUrl = canvas.toDataURL('image/jpeg', 0.78);

            const textContent = await page.getTextContent();
            const textStr = textContent.items.map(it => it.str).join(' ');
            const docs = extractDocsFromText(textStr);
            const codes = Array.from(new Set(textStr.match(CODE_REGEX) || []));

            const pageEntry = {
              pageNum: globalPageSeq,
              fileName: `${item.name} 第${p}页`,
              url: dataUrl,
              docs,
              codes,
              matchedTicketIds: []
            };
            state.pdfPages.push(pageEntry);

            if (docs.length > 0 || codes.length > 0) {
              donePages++;
              runAutoMatchAgainstPages();
              updateStatus(`高速解析第 ${donePages}/${totalPages} 页`);
            } else {
              ocrQueue.push({ pageEntry, canvas });
            }
          }
        }

        refreshIfVisible();

        // 对纯图片扫描页启用双核复用 OCR（优先高清晰裁剪单据头区抓单号，再扫全页抓物料编码）
        if (ocrQueue.length > 0 && window.Tesseract) {
          updateStatus(`开始双核 OCR 自动核对 ${ocrQueue.length} 页扫描单据...`);
          const pool = await getOcrWorkerPool();
          let qIdx = 0;

          async function runWorker(worker) {
            while (qIdx < ocrQueue.length) {
              const job = ocrQueue[qIdx++];
              ocrPages++;
              const src = job.canvas;

              // 1) 重点放大裁剪上半部表头区（单据号 OrderNum 所在区），大幅提高 CCHF 单号识别率
              const topCanvas = document.createElement('canvas');
              topCanvas.width = src.width;
              topCanvas.height = Math.max(100, Math.round(src.height * 0.42));
              topCanvas.getContext('2d').drawImage(src, 0, 0, topCanvas.width, topCanvas.height, 0, 0, topCanvas.width, topCanvas.height);

              const rTop = worker
                ? await worker.recognize(topCanvas)
                : await Tesseract.recognize(topCanvas, 'eng');
              let docs = extractDocsFromText(rTop.data.text || '');

              // 2) 全页识别（提取全部 10/11 位物料编码 + 兜底补抓单号）
              const rFull = worker
                ? await worker.recognize(src)
                : await Tesseract.recognize(src, 'eng');
              const fullTxt = rFull.data.text || '';
              const moreDocs = extractDocsFromText(fullTxt);
              docs = Array.from(new Set([...docs, ...moreDocs]));
              const codes = Array.from(new Set(fullTxt.match(CODE_REGEX) || []));

              job.pageEntry.docs = docs;
              job.pageEntry.codes = codes;
              donePages++;

              const added = runAutoMatchAgainstPages();
              if (added > 0) {
                persistState();
                refreshIfVisible();
              }
              updateStatus(`后台 OCR 核对 ${donePages}/${totalPages} 页`);
            }
          }

          if (pool && pool.length) await Promise.all(pool.map(w => runWorker(w)));
          else await runWorker(null);
        }

        runAutoMatchAgainstPages();
        const foundDocs = new Set(state.pdfPages.flatMap(p => p.docs || [])).size;
        const foundCodes = new Set(state.pdfPages.flatMap(p => p.codes || [])).size;
        const autoCnt = state.tickets.filter(t => t.matchType === 'auto').length;
        const remainCnt = state.tickets.filter(t => !t.checked).length;

        if (!state.tickets.length) {
          state.scanLog = `⚠️ 已扫完 ${totalPages} 页 PDF（检出 ${foundDocs} 个单号 / ${foundCodes} 个物料编码），但你尚未导入「1. 出库清单」，请拖入 Excel 即可瞬间完成自动核对！`;
          setGlobalBgPill(`⚠️ PDF已扫完(${foundDocs}单) · 请导入清单`, true, true);
          U.toast(`PDF 已扫完（检出 ${foundDocs} 个单号），请再导入「1. 出库清单」自动比对！`, 'warn');
        } else {
          state.scanLog = `✅ 平台自动核对完成：共 ${totalPages} 页 PDF（检出 ${foundDocs} 个单号 / ${foundCodes} 个编码）｜ 平台已核销 ${autoCnt}/${state.tickets.length} 张，剩余 ${remainCnt} 张待你人工核对！`;
          persistState();
          setGlobalBgPill(`✅ 出库PDF核完 · 已核${autoCnt}/剩${remainCnt}`, true, true);
          setTimeout(() => { if (!state.scanning) setGlobalBgPill('', false); }, 12000);
          U.toast(`平台已自动核销 ${autoCnt} 张，剩余 ${remainCnt} 张未检索到需人工复核！`, 'success');
        }
      } catch (err) {
        state.scanLog = `❌ 出库 PDF 核对异常：${err.message}`;
        setGlobalBgPill('', false);
        U.toast('PDF 核对异常：' + err.message, 'error');
      } finally {
        state.scanning = false;
        refreshIfVisible();
      }
    })();
  }

  function renderModule(root) {
    const scopedTickets = state.targetDate
      ? state.tickets.filter(t => t.date === state.targetDate)
      : state.tickets;
    const total = scopedTickets.length;
    const autoDone = scopedTickets.filter(t => t.checked && t.matchType === 'auto').length;
    const manualDone = scopedTickets.filter(t => t.checked && t.matchType === 'manual').length;
    const missing = scopedTickets.filter(t => !t.checked);

    let listToShow = scopedTickets;
    if (state.auditFilter === 'unmatched') listToShow = missing;
    else if (state.auditFilter === 'auto') listToShow = scopedTickets.filter(t => t.checked);

    // 左侧 PDF 展示列表（支持只看未匹配到单据的孤立 PDF 页，方便人工排查）
    const visiblePages = state.onlyUnmatchedPages
      ? state.pdfPages.filter(p => !p.matchedTicketIds || p.matchedTicketIds.length === 0)
      : state.pdfPages;
    if (state.activePageIdx >= visiblePages.length) state.activePageIdx = Math.max(0, visiblePages.length - 1);
    const curPage = visiblePages[state.activePageIdx];

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📑 出库扫描 PDF 自动核对（平台自动检索核销 · 人工仅复核未检索单据 · 自动剔除气体）</span>
          <span class="pill ${missing.length ? 'pill-red' : 'pill-green'}">待人工核对：${missing.length} / ${total}${state.sheetName ? ` · ${state.sheetName}` : ''}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">清单有效独立单据数</div><div class="kpi-val">${total}</div></div>
          <div class="kpi-card green"><div class="kpi-label">🤖 平台自动检索已核</div><div class="kpi-val">${autoDone}</div></div>
          <div class="kpi-card"><div class="kpi-label">👤 人工确认已核</div><div class="kpi-val">${manualDone}</div></div>
          <div class="kpi-card ${missing.length ? 'red' : 'green'}"><div class="kpi-label">🔴 未检索到（待人工核对）</div><div class="kpi-val">${missing.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="p-up-csv">📂 1. 导入出库清单 (ERP列表 / HJF总账)</button>
          <input type="file" id="p-in-csv" accept=".csv,.xlsx,.xls" class="hidden-input" />
          <button class="btn btn-warning" id="p-up-pdf">📄 2. 导入出库扫描 PDF（平台自动核对）</button>
          <input type="file" id="p-in-pdf" accept=".pdf" multiple class="hidden-input" />
          ${state.availDates.length > 0 ? `
            <select id="p-date-sel" title="按表格内自然日筛选">
              <option value="">全部日期 (${state.tickets.length} 单)</option>
              ${state.availDates.map(d => `<option value="${d}" ${d === state.targetDate ? 'selected' : ''}>仅看：${d}</option>`).join('')}
            </select>
          ` : ''}
          <span style="flex:1"></span>
          <button class="btn btn-success" id="p-copy-missing" ${!missing.length ? 'disabled' : ''}>📋 复制未核对缺单清单 (${missing.length})</button>
        </div>
        <div id="p-scan-log" style="font-size:12px;color:#0369a1;margin-top:2px;">${U.escHtml(state.scanLog)}</div>
      </div>

      <div class="split-grid">
        <div class="panel">
          <div class="panel-title">
            <span>📄 左侧：出库扫描 PDF (${visiblePages.length ? `${state.activePageIdx + 1}/${visiblePages.length}` : '0'}页)</span>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <label style="font-size:11.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;gap:3px;">
                <input type="checkbox" id="p-only-unmatched-pdf" ${state.onlyUnmatchedPages ? 'checked' : ''} /> 仅看未匹配页
              </label>
              <button class="btn-sm" id="m-prev" ${state.activePageIdx <= 0 ? 'disabled' : ''}>⬅ 上一页</button>
              <button class="btn-sm" id="m-next" ${state.activePageIdx >= visiblePages.length - 1 ? 'disabled' : ''}>下一页 ➡</button>
            </div>
          </div>
          ${curPage ? `
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#475569;margin-bottom:6px;flex-wrap:wrap;gap:6px;">
              <span><b>第 ${curPage.pageNum} 页</b> · ${U.escHtml(curPage.fileName)}</span>
              <span>${curPage.docs && curPage.docs.length ? `<span class="pill pill-green">检出单号：${curPage.docs.map(d => '…' + d.slice(-6)).join(', ')}</span>` : '<span class="pill pill-orange">本页未自动检出单号</span>'}</span>
            </div>
            <div style="max-height:580px;overflow:auto;text-align:center;background:#0f172a;border-radius:8px;padding:6px;">
              <img src="${curPage.url}" style="max-width:100%;border-radius:4px;" />
            </div>
          ` : `<div class="dropzone" id="p-media-drop">把当天的出库单扫描 PDF 拖到这里，平台将在后台自动识别单号/编码并核销右侧清单</div>`}
        </div>

        <div class="panel">
          <div class="panel-title">
            <span>📑 右侧：单据核对区（每张单据独立核销）</span>
            <div style="display:flex;gap:5px;">
              <button class="btn-sm ${state.auditFilter === 'unmatched' ? 'btn-primary' : ''}" id="p-f-unmatched">🔴 未检索到 (${missing.length})</button>
              <button class="btn-sm ${state.auditFilter === 'auto' ? 'btn-primary' : ''}" id="p-f-done">✅ 已核对 (${autoDone + manualDone})</button>
              <button class="btn-sm ${state.auditFilter === 'all' ? 'btn-primary' : ''}" id="p-f-all">全部 (${total})</button>
            </div>
          </div>
          <div style="max-height:600px;overflow-y:auto;padding-right:4px;">
            ${listToShow.length === 0 ? `<div class="empty-cell">${total === 0 ? '请先导入当天出库清单（支持 ERP 材料出库单列表 或 HJF 总账）' : '🎉 当前筛选下没有未核对单据！'}</div>` :
              listToShow.map(t => `
                <div class="photo-card ${t.checked ? 'checked' : 'missing'}" style="cursor:default;">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <b style="font-size:13px;">${t.checked ? '✅' : '🔴'} ${U.escHtml(t.dept)}</b>
                      ${t.tag ? `<span class="pill pill-blue">${U.escHtml(t.tag)}</span>` : ''}
                      <span style="font-size:11.5px;color:#64748b;" title="${U.escHtml(t.docNo || '')}">单号 ${U.escHtml(t.shortDoc)}${t.date ? ' · ' + t.date : ''}</span>
                    </div>
                    <div style="display:flex;gap:5px;align-items:center;">
                      ${t.matchedPage ? `<button class="btn-sm p-jump-page" data-page="${t.matchedPage}" title="跳转到左侧 PDF 对应页复查">👁 第${t.matchedPage}页</button>` : ''}
                      ${t.checked
                        ? `<span class="pill pill-green">${t.matchType === 'auto' ? '🤖 平台已核' : '👤 人工已核'}</span>
                           <button class="btn-sm p-toggle-one" data-tid="${t.id}">↩ 撤销</button>`
                        : `<button class="btn-sm btn-primary p-toggle-one" data-tid="${t.id}" style="background:#2563eb;color:#fff;border-color:#2563eb;">✔ 人工确认已发</button>`}
                    </div>
                  </div>
                  <div style="font-size:12px;color:#1e293b;line-height:1.55;">
                    ${t.items.map(it => `${U.escHtml(it.name)}(<b>${U.escHtml(it.qty)}${U.escHtml(it.unit)}</b>)`).join('、')}
                  </div>
                </div>
              `).join('')}
          </div>
        </div>
      </div>
    `;

    const inCsv = root.querySelector('#p-in-csv');
    root.querySelector('#p-up-csv').onclick = () => inCsv.click();
    inCsv.onchange = async e => {
      if (!e.target.files[0]) return;
      try {
        await loadTicketsFile(e.target.files[0]);
        renderModule(root);
      } catch (err) {
        U.toast('出库清单解析失败：' + err.message, 'error');
      }
      e.target.value = '';
    };

    const inPdf = root.querySelector('#p-in-pdf');
    root.querySelector('#p-up-pdf').onclick = () => inPdf.click();
    const drop = root.querySelector('#p-media-drop');
    if (drop) {
      drop.onclick = () => inPdf.click();
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('dragover'); };
      drop.ondragleave = () => drop.classList.remove('dragover');
      drop.ondrop = e => {
        e.preventDefault();
        drop.classList.remove('dragover');
        startBackgroundPdfAudit(e.dataTransfer.files);
      };
    }
    inPdf.onchange = e => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) startBackgroundPdfAudit(files);
    };

    const selDate = root.querySelector('#p-date-sel');
    if (selDate) {
      selDate.onchange = e => { state.targetDate = e.target.value; persistState(); renderModule(root); };
    }

    root.querySelector('#p-only-unmatched-pdf').onchange = e => {
      state.onlyUnmatchedPages = e.target.checked;
      state.activePageIdx = 0;
      renderModule(root);
    };
    root.querySelector('#m-prev').onclick = () => { state.activePageIdx = Math.max(0, state.activePageIdx - 1); renderModule(root); };
    root.querySelector('#m-next').onclick = () => { state.activePageIdx = Math.min(visiblePages.length - 1, state.activePageIdx + 1); renderModule(root); };

    root.querySelector('#p-f-unmatched').onclick = () => { state.auditFilter = 'unmatched'; renderModule(root); };
    root.querySelector('#p-f-done').onclick = () => { state.auditFilter = 'auto'; renderModule(root); };
    root.querySelector('#p-f-all').onclick = () => { state.auditFilter = 'all'; renderModule(root); };

    // 每张单据独立手动确认 / 撤销，绝不会误点全选
    root.querySelectorAll('.p-toggle-one').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const tid = Number(btn.dataset.tid);
        const t = state.tickets.find(x => x.id === tid);
        if (!t) return;
        if (t.checked) {
          t.checked = false;
          t.matchType = '';
        } else {
          t.checked = true;
          t.matchType = 'manual';
        }
        persistState();
        renderModule(root);
      };
    });

    // 点击「第X页」直接跳到左侧对应 PDF 页面复查
    root.querySelectorAll('.p-jump-page').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const targetPageNum = Number(btn.dataset.page);
        state.onlyUnmatchedPages = false;
        const idx = state.pdfPages.findIndex(p => p.pageNum === targetPageNum);
        if (idx >= 0) {
          state.activePageIdx = idx;
          renderModule(root);
        }
      };
    });

    root.querySelector('#p-copy-missing').onclick = async () => {
      const lines = missing.map(t => `${t.dept} | ${t.tag || t.wh} | ${t.docNo || t.shortDoc} | ` + t.items.map(i => `${i.name}(${i.qty}${i.unit})`).join('、'));
      const ok = await U.copyText(lines.join('\n'));
      U.toast(ok ? `已复制 ${lines.length} 张未核对缺单明细` : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
    };
  }

  WB.register({
    id: 'mod_photo_check',
    icon: '📑',
    title: '出库PDF核对',
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
      if (excels.length) await loadTicketsFile(excels[0]);
      if (pdfs.length) startBackgroundPdfAudit(pdfs);
      refreshIfVisible();
    }
  });
})();
