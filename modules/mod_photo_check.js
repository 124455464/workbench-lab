/**
 * 模块 3：HJF 出库扫描 PDF 自动核对（直连 HJF「历史出库底表总账」· 按日期/日期区间精准锁定核对）
 * 核心口径：
 * 1. 彻底独立于【16列精简与自取】，直接对接【HJF 出库核算 -> 2. 历史出库底表（总账可编辑）】（自动直读同源 IndexedDB，亦支持手动导入《HJF物资出库总账.xlsx》）。
 * 2. 严格按日期区间锁定范围（支持单日如 27 号，或区间如 27~28 号；导入 PDF 时亦自动识别单据日期/文件名日期锁定范围，绝不串核其他日期）。
 * 3. 自动剔除含丁烷气罐在内的全部气体；平台后台双核 OCR 自动按物料编码/日期核销，人工只需复核「未检索到」的单据。
 */
(function () {
  'use strict';
  const U = WB.Utils;
  const SCHEMA_VER = 3;
  const HJF_IDB_NAME = 'HJF_Ledger_DB_v292';
  const HJF_MASTER_KEY = 'hjf_master_records_v292';

  const GAS_KEYWORDS = ['氧气', '乙炔', '二氧化碳', '氩气', '氮气', '丙烷', '液化气', '混合气', '丁烷气', '丁烷'];
  const DOC_REGEX = /(?:CCHF|CK)\d{10,22}/gi;
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

  function extractDatesFromPage(rawText, docs) {
    const out = new Set();
    // 1. 从 CCHF20261127... 单号提取精确日期
    (docs || []).forEach(d => {
      const m = d.match(/(?:CCHF|CK)(20\d{2})(\d{2})(\d{2})/);
      if (m) out.add(`${m[1]}-${m[2]}-${m[3]}`);
    });
    // 2. 从正文提取 2026-11-27
    (String(rawText || '').match(/20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/g) || []).forEach(s => {
      const norm = U.formatDate(s);
      if (/^20\d{2}-\d{2}-\d{2}$/.test(norm)) out.add(norm);
    });
    return Array.from(out).sort();
  }

  /** 从 PDF 文件名智能解析日期范围（如 "11.27.pdf" / "11.27-11.28.pdf" / "11.27-28.pdf" / "27-28日.pdf" / "27号.pdf" / "2026-11-27.pdf"） */
  function detectDateRangeFromFileNames(fileNames, availDates) {
    if (!availDates || !availDates.length) return null;
    const latestYear = availDates[0].slice(0, 4);
    const latestMonth = availDates[0].slice(5, 7);
    const hits = new Set();
    const tryAdd = (y, m, d) => {
      const cand = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (availDates.includes(cand)) hits.add(cand);
    };

    for (const fn of fileNames) {
      // 1. 匹配 YYYY-MM-DD / YYYY.MM.DD
      (fn.match(/20\d{2}[.\-_]\d{1,2}[.\-_]\d{1,2}/g) || []).forEach(s => {
        const d = U.formatDate(s);
        if (availDates.includes(d)) hits.add(d);
      });
      // 2. 匹配 MM.DD-DD 或 M月D-D日（同月区间）
      const sameMonthRange = fn.match(/(\d{1,2})[.\-_月](\d{1,2})\s*[-~至到]\s*(\d{1,2})(?=[日号\D]|$)/g) || [];
      sameMonthRange.forEach(tok => {
        const m = tok.match(/(\d{1,2})[.\-_月](\d{1,2})\s*[-~至到]\s*(\d{1,2})/);
        if (m) {
          tryAdd(latestYear, m[1], m[2]);
          tryAdd(latestYear, m[1], m[3]);
        }
      });
      // 3. 匹配 MM.DD / M月D日
      const mdMatches = fn.match(/(?:^|[^\d])(\d{1,2})[.\-_月](\d{1,2})(?=[日号\D]|$)/g) || [];
      mdMatches.forEach(tok => {
        const m = tok.match(/(\d{1,2})[.\-_月](\d{1,2})/);
        if (m) tryAdd(latestYear, m[1], m[2]);
      });
      // 4. 兜底：若前面未命中，匹配纯日区间如 "27-28日" / "27~28号" 或单日 "27号" / "27日"
      if (hits.size === 0) {
        const dRange = fn.match(/(?:^|[^\d])(\d{1,2})\s*[-~至到]\s*(\d{1,2})\s*[日号]/g) || [];
        dRange.forEach(tok => {
          const m = tok.match(/(\d{1,2})\s*[-~至到]\s*(\d{1,2})/);
          if (m) {
            tryAdd(latestYear, latestMonth, m[1]);
            tryAdd(latestYear, latestMonth, m[2]);
          }
        });
        const dSingle = fn.match(/(?:^|[^\d])(\d{1,2})\s*[日号]/g) || [];
        dSingle.forEach(tok => {
          const m = tok.match(/(\d{1,2})/);
          if (m) tryAdd(latestYear, latestMonth, m[1]);
        });
      }
    }
    const sorted = Array.from(hits).sort();
    if (!sorted.length) return null;
    return { start: sorted[0], end: sorted[sorted.length - 1] };
  }

  let activeRoot = null;
  let ocrWorkers = null;

  let state = {
    tickets: [],          // [{ id, key, date, dept, rec, wh, tag, items: [{code,name,qty,unit}], checked, matchType: ''|'auto'|'manual', matchedPage: 0, matchedDoc: '' }]
    availDates: [],       // 降序排列的 HJF 业务日期列表
    startDate: '',        // 核对起始日期（YYYY-MM-DD）
    endDate: '',          // 核对结束日期（YYYY-MM-DD）
    sourceLabel: '',      // 数据来源（直连 HJF 历史底表总账 / 手动导入总账文件）
    pdfPages: [],         // [{ pageNum, fileName, url, docs: [], codes: [], dates: [], matchedTicketIds: [] }]
    activePageIdx: 0,
    onlyUnmatchedPages: false,
    auditFilter: 'unmatched', // 'unmatched' | 'done' | 'all'
    scanning: false,
    scanLog: '',
    manualFileLoaded: false,
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
      startDate: state.startDate,
      endDate: state.endDate,
      sourceLabel: state.sourceLabel,
      auditFilter: state.auditFilter,
      scanLog: state.scanLog
    });
  }

  async function hydrateState() {
    if (state.scanning || state._hydrated) return;
    const saved = await WB.Store.load('mod_photo_check');
    if (saved && saved.schemaVer === SCHEMA_VER && !state.scanning) {
      state.tickets = saved.tickets || [];
      state.availDates = saved.availDates || [];
      state.startDate = saved.startDate || (state.availDates[0] || '');
      state.endDate = saved.endDate || state.startDate;
      state.sourceLabel = saved.sourceLabel || '';
      state.auditFilter = saved.auditFilter || 'unmatched';
      state.scanLog = saved.scanLog || '';
    }
    state._hydrated = true;
  }

  /** 直接从同源 HJF 出库核算的 IndexedDB / localStorage 读取「2. 历史出库底表（总账可编辑）」 */
  async function readHjfMasterRecordsFromBrowser() {
    // 1. 优先读取 IndexedDB HJF_Ledger_DB_v292 -> kv -> hjf_master_records_v292
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(HJF_IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rec = await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(HJF_MASTER_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (Array.isArray(rec) && rec.length > 0) return rec;
    } catch {}

    // 2. 兜底读取 localStorage
    try {
      const raw = localStorage.getItem(HJF_MASTER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  }

  /** 将 HJF 历史底表记录数组转为按【日期+车间+领料人+仓库+自取/特殊】分组的独立单据（保留已核对状态） */
  function buildTicketsFromHjfRecords(records, sourceLabel) {
    // 记录旧的人工/自动核销状态（避免同步底表时冲掉已核对进度）
    const prevCheckedByKey = new Map();
    state.tickets.forEach(t => {
      if (t.key && t.checked) {
        prevCheckedByKey.set(t.key, { checked: t.checked, matchType: t.matchType, matchedPage: t.matchedPage, matchedDoc: t.matchedDoc });
      }
    });

    const groups = new Map();
    const dateSet = new Set();

    for (const r of records) {
      if (!r || r._isBlank) continue;
      const name = U.cleanStr(r.name);
      if (!name) continue;
      if (GAS_KEYWORDS.some(g => name.includes(g))) continue; // 铁律：剔除含丁烷气罐在内的全部气体

      const dateStr = U.formatDate(r.date || '');
      if (dateStr) dateSet.add(dateStr);
      const dept = U.cleanStr(r.dept) || '未知车间';
      const rec = U.cleanStr(r.person);
      const wh = U.cleanStr(r.warehouse).replace(/（.*）$/, '');
      const pickup = U.cleanStr(r.pickup);
      const special = U.cleanStr(r.special);
      const tag = (special || pickup) ? `${wh}（${special || pickup}）` : wh;
      const code = U.formatCode(r.code || '');
      const qty = U.cleanStr(r.qty);
      const unit = U.cleanStr(r.unit);

      const gKey = `${dateStr}||${dept}||${rec}||${wh}||${pickup}||${special}`;
      if (!groups.has(gKey)) {
        const prev = prevCheckedByKey.get(gKey);
        groups.set(gKey, {
          id: groups.size + 1,
          key: gKey,
          date: dateStr,
          dept,
          rec,
          wh,
          tag,
          items: [],
          checked: prev ? prev.checked : false,
          matchType: prev ? prev.matchType : '',
          matchedPage: prev ? prev.matchedPage : 0,
          matchedDoc: prev ? prev.matchedDoc : ''
        });
      }
      groups.get(gKey).items.push({ code, name, qty, unit });
    }

    const tickets = [];
    groups.forEach(t => { if (t.items.length > 0) tickets.push(t); });
    const availDates = Array.from(dateSet).sort().reverse();

    state.tickets = tickets;
    state.availDates = availDates;
    // 若当前日期未设或不在新日期列表内，默认自动锁定 HJF 最新业务日期（单日）
    if (!state.startDate || !availDates.includes(state.startDate)) {
      state.startDate = availDates[0] || '';
      state.endDate = availDates[0] || '';
    }
    if (!state.endDate || !availDates.includes(state.endDate)) {
      state.endDate = state.startDate;
    }
    state.sourceLabel = sourceLabel;
  }

  /** 自动同步 HJF 出库核算 -> 历史出库底表（总账可编辑） */
  async function syncFromHjfLedger(silent = false) {
    const records = await readHjfMasterRecordsFromBrowser();
    if (!records.length) {
      if (!silent) U.toast('当前浏览器【HJF 出库核算 -> 历史出库底表】暂无记录，请先核算或手动导入 HJF 物资出库总账 (.xlsx)', 'warn');
      return false;
    }
    state.manualFileLoaded = false;
    buildTicketsFromHjfRecords(records, `直连 HJF 历史底表总账（${records.length} 条记录）`);
    if (state.pdfPages.length > 0) runAutoMatchScoped();
    persistState();
    if (!silent) {
      U.toast(`已同步 HJF 历史底表：共 ${state.tickets.length} 张非气体单据（覆盖 ${state.availDates.length} 个日期）`, 'success');
    }
    return true;
  }

  /** 手动导入《HJF物资出库总账.xlsx》或 14 列 HJF 出库单（备用，严格按 HJF 格式拆票） */
  async function loadHjfExcelFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const ledgerSn = parsed.sheetNames.find(n => n.includes('历史出库底表')) || parsed.sheetNames[0];
    const aoa = parsed.sheets[ledgerSn] || [];
    if (aoa.length < 2) throw new Error('HJF 出库总账无有效数据');

    const firstCleaned = (aoa[0] || []).map(v => U.cleanStr(v));
    const hasHeader = /^(业务日期|日期|车间|部门)$/.test(firstCleaned[0] || '') ||
      (firstCleaned.includes('车间') && firstCleaned.includes('仓库'));
    let hasDateCol = firstCleaned[0].includes('日期');
    if (!hasDateCol) {
      for (let i = hasHeader ? 1 : 0; i < Math.min(10, aoa.length); i++) {
        const c0 = U.cleanStr((aoa[i] || [])[0]);
        if (c0) { if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(c0)) hasDateCol = true; break; }
      }
    }
    const off = hasDateCol ? 1 : 0;

    // 按空行切块构建独立 HJF 单据
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

    const tickets = [];
    const dateSet = new Set();
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
          key: `file_${bIdx + 1}_${dateStr}_${dept}_${wh}`,
          date: dateStr,
          dept,
          rec,
          wh,
          tag,
          items,
          checked: false,
          matchType: '',
          matchedPage: 0,
          matchedDoc: ''
        });
      }
    });

    const availDates = Array.from(dateSet).sort().reverse();
    state.tickets = tickets;
    state.availDates = availDates;
    state.startDate = availDates[0] || '';
    state.endDate = availDates[0] || '';
    state.sourceLabel = `导入文件：${file.name} [${ledgerSn}]`;
    state.manualFileLoaded = true;
    state.auditFilter = 'unmatched';
    if (state.pdfPages.length > 0) runAutoMatchScoped();
    persistState();
    U.toast(`已载入 HJF 出库表：共 ${tickets.length} 张非气体单据（默认锁定最新日期 ${state.startDate || '全部'}）`, 'success');
  }

  /** 获取当前日期区间内需要核对的 HJF 单据（例如 27 号，或 27~28 号） */
  function getScopedTickets() {
    let s = state.startDate;
    let e = state.endDate;
    if (!s && !e) return state.tickets;
    if (s && !e) e = s;
    if (!s && e) s = e;
    if (s > e) [s, e] = [e, s];
    return state.tickets.filter(t => !t.date || (t.date >= s && t.date <= e));
  }

  /** 严格只对「当前日期区间内」的 HJF 单据执行自动核对（按物料编码集合 + 日期匹配 PDF 页） */
  function runAutoMatchScoped() {
    const scoped = getScopedTickets();
    if (!scoped.length || !state.pdfPages.length) return 0;

    state.pdfPages.forEach(p => { p.matchedTicketIds = []; });
    let sDate = state.startDate;
    let eDate = state.endDate || sDate;
    if (sDate && eDate && sDate > eDate) [sDate, eDate] = [eDate, sDate];

    let newlyAuto = 0;
    scoped.forEach(t => {
      if (t.matchType === 'manual') return;

      const tCodes = Array.from(new Set(
        t.items.map(it => U.formatCode(it.code)).filter(c => /^0[356789]\d{8,9}$/.test(c))
      ));
      if (!tCodes.length) return;

      let bestPage = 0;
      let bestScore = 0;
      let bestDoc = '';

      state.pdfPages.forEach((p, idx) => {
        // 若 PDF 页面识别出了明确日期，且该 HJF 单据也有明确日期，优先要求同日或落于选定区间内
        if (t.date && p.dates && p.dates.length > 0) {
          const sameDay = p.dates.includes(t.date);
          const inRange = sDate && eDate && p.dates.some(d => d >= sDate && d <= eDate);
          if (!sameDay && !inRange) return;
        }
        if (!p.codes || !p.codes.length) return;
        const pSet = new Set(p.codes);
        let hits = 0;
        tCodes.forEach(c => { if (pSet.has(c)) hits++; });
        const need = tCodes.length === 1 ? 1 : Math.ceil(tCodes.length * 0.5);
        if (hits >= need) {
          const sameDayBonus = (t.date && p.dates && p.dates.includes(t.date)) ? 10 : 0;
          const score = hits * 2 + sameDayBonus;
          if (score > bestScore) {
            bestScore = score;
            bestPage = idx + 1;
            bestDoc = (p.docs && p.docs[0]) || '';
          }
        }
      });

      if (bestPage > 0) {
        if (!t.checked) newlyAuto++;
        t.checked = true;
        t.matchType = 'auto';
        t.matchedPage = bestPage;
        t.matchedDoc = bestDoc;
        const pageObj = state.pdfPages[bestPage - 1];
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
      await w.setParameters({ tessedit_char_whitelist: 'CCHFKGOQIL0123456789-./' });
      pool.push(w);
    }
    ocrWorkers = pool;
    return pool;
  }

  /** 后台自动核对出库扫描 PDF：自动识别文件名/页内日期范围 -> 只核对对应日期的 HJF 出库单 */
  function startBackgroundPdfAudit(files) {
    const pdfs = Array.from(files || []).filter(f => /\.pdf$/i.test(f.name));
    if (!pdfs.length) {
      U.toast('本模块为纯 PDF 核对，请拖入出库扫描 PDF (.pdf)', 'warn');
      return;
    }
    if (state.scanning) {
      U.toast('后台正在核对上一份出库 PDF，请稍候完成', 'warn');
      return;
    }

    state.scanning = true;
    state.pdfPages = [];
    state.activePageIdx = 0;
    state.scanLog = `⏳ 后台已启动：正在同步 HJF 底表并解析 ${pdfs.length} 份 PDF（可切去其他板块）...`;
    setGlobalBgPill('⏳ HJF出库PDF后台核对中...', true, false);
    refreshIfVisible();

    (async () => {
      let totalPages = 0;
      let donePages = 0;
      let ocrPages = 0;

      const updateStatus = (msg) => {
        const scoped = getScopedTickets();
        const autoCnt = scoped.filter(t => t.matchType === 'auto').length;
        const foundCodes = new Set(state.pdfPages.flatMap(p => p.codes || [])).size;
        state.scanLog = scoped.length
          ? `⏳ ${msg} ｜ 检出 ${foundCodes} 个物料编码 · 当前日期区间(${state.startDate}~${state.endDate})已自动核销 ${autoCnt}/${scoped.length} 张`
          : `⏳ ${msg} ｜ 检出 ${foundCodes} 个编码（当前日期区间无 HJF 记录，请调整日期或点同步 HJF 底表）`;
        setGlobalBgPill(`⏳ HJF出库PDF ${donePages}/${totalPages || '?'}页 · 已核${autoCnt}/${scoped.length}`, true, false);
        const stEl = activeRoot && activeRoot.isConnected ? activeRoot.querySelector('#p-scan-log') : null;
        if (stEl) stEl.textContent = state.scanLog;
      };

      try {
        // 开始前先静默同步一次最新的 HJF 历史底表（保证刚在 HJF 板块算完的新单立即可用，且不覆盖用户刚手动导入的 Excel）
        if (!state.manualFileLoaded) await syncFromHjfLedger(true);

        // 按 PDF 文件名自动锁定对应的 HJF 日期区间（如 11.27.pdf / 27号.pdf -> 只看 27 号；27-28日.pdf -> 只看 27~28 号）
        const fnRange = detectDateRangeFromFileNames(pdfs.map(f => f.name), state.availDates);
        if (fnRange) {
          state.startDate = fnRange.start;
          state.endDate = fnRange.end;
          U.toast(`已按 PDF 文件名自动锁定 HJF 核对日期：${fnRange.start}${fnRange.end !== fnRange.start ? ' ~ ' + fnRange.end : ''}`, 'info');
        }
        // 重置当前区间内旧的自动核销标记（保留人工确认及其他日期的历史记录）
        getScopedTickets().forEach(t => {
          if (t.matchType === 'auto') { t.checked = false; t.matchType = ''; t.matchedPage = 0; t.matchedDoc = ''; }
        });
        refreshIfVisible();

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
            const dates = extractDatesFromPage(textStr, docs);

            const pageEntry = {
              pageNum: globalPageSeq,
              fileName: `${item.name} 第${p}页`,
              url: dataUrl,
              docs,
              codes,
              dates,
              matchedTicketIds: []
            };
            state.pdfPages.push(pageEntry);

            if (codes.length > 0 || docs.length > 0) {
              donePages++;
              runAutoMatchScoped();
              updateStatus(`高速解析第 ${donePages}/${totalPages} 页`);
            } else {
              ocrQueue.push({ pageEntry, canvas });
            }
          }
        }

        refreshIfVisible();

        if (ocrQueue.length > 0 && window.Tesseract) {
          updateStatus(`启动双核 OCR 识别 ${ocrQueue.length} 页出库单（抓物料编码与日期）...`);
          const pool = await getOcrWorkerPool();
          let qIdx = 0;

          async function runWorker(worker) {
            while (qIdx < ocrQueue.length) {
              const job = ocrQueue[qIdx++];
              ocrPages++;
              const src = job.canvas;

              // 1) 上半部表头区（抓单据号/日期）
              const topCanvas = document.createElement('canvas');
              topCanvas.width = src.width;
              topCanvas.height = Math.max(100, Math.round(src.height * 0.42));
              topCanvas.getContext('2d').drawImage(src, 0, 0, topCanvas.width, topCanvas.height, 0, 0, topCanvas.width, topCanvas.height);

              const rTop = worker ? await worker.recognize(topCanvas) : await Tesseract.recognize(topCanvas, 'eng');
              const topTxt = rTop.data.text || '';

              // 2) 全页识别（抓全部 10/11 位物料编码）
              const rFull = worker ? await worker.recognize(src) : await Tesseract.recognize(src, 'eng');
              const fullTxt = rFull.data.text || '';

              const docs = Array.from(new Set([...extractDocsFromText(topTxt), ...extractDocsFromText(fullTxt)]));
              const codes = Array.from(new Set(fullTxt.match(CODE_REGEX) || []));
              const dates = extractDatesFromPage(`${topTxt} ${fullTxt}`, docs);

              job.pageEntry.docs = docs;
              job.pageEntry.codes = codes;
              job.pageEntry.dates = dates;
              donePages++;

              const added = runAutoMatchScoped();
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

        // 若文件名没写日期，尝试根据 PDF 页内识别出的实际日期自动对齐日期范围
        if (!fnRange && state.availDates.length) {
          const detectedInAvail = Array.from(new Set(
            state.pdfPages.flatMap(p => p.dates || []).filter(d => state.availDates.includes(d))
          )).sort();
          if (detectedInAvail.length > 0) {
            state.startDate = detectedInAvail[0];
            state.endDate = detectedInAvail[detectedInAvail.length - 1];
          }
        }

        runAutoMatchScoped();
        const scoped = getScopedTickets();
        const foundCodes = new Set(state.pdfPages.flatMap(p => p.codes || [])).size;
        const autoCnt = scoped.filter(t => t.matchType === 'auto').length;
        const remainCnt = scoped.filter(t => !t.checked).length;

        const rangeTxt = state.startDate === state.endDate
          ? (state.startDate || '全部')
          : `${state.startDate} ~ ${state.endDate}`;

        if (!scoped.length) {
          state.scanLog = `⚠️ 已扫完 ${totalPages} 页 PDF（检出 ${foundCodes} 个物料编码），但当前选定日期 [${rangeTxt}] 在 HJF 历史底表中无单据，请切换上方日期区间或先同步 HJF 历史底表！`;
          setGlobalBgPill(`⚠️ 日期[${rangeTxt}]无HJF单据`, true, true);
        } else {
          state.scanLog = `✅ 核对完成 [${rangeTxt}]：共 ${totalPages} 页 PDF（检出 ${foundCodes} 个编码）｜ 平台已核销 ${autoCnt}/${scoped.length} 张 HJF 单据，仅剩 ${remainCnt} 张待你人工核对！`;
          persistState();
          setGlobalBgPill(`✅ HJF核完[${rangeTxt}] · 剩${remainCnt}单`, true, true);
          setTimeout(() => { if (!state.scanning) setGlobalBgPill('', false); }, 12000);
          U.toast(`HJF [${rangeTxt}] 自动核销 ${autoCnt} 张，仅剩 ${remainCnt} 张未检索到需人工复核！`, 'success');
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
    const scopedTickets = getScopedTickets();
    const total = scopedTickets.length;
    const autoDone = scopedTickets.filter(t => t.checked && t.matchType === 'auto').length;
    const manualDone = scopedTickets.filter(t => t.checked && t.matchType === 'manual').length;
    const missing = scopedTickets.filter(t => !t.checked);

    let listToShow = scopedTickets;
    if (state.auditFilter === 'unmatched') listToShow = missing;
    else if (state.auditFilter === 'done') listToShow = scopedTickets.filter(t => t.checked);

    const visiblePages = state.onlyUnmatchedPages
      ? state.pdfPages.filter(p => !p.matchedTicketIds || p.matchedTicketIds.length === 0)
      : state.pdfPages;
    if (state.activePageIdx >= visiblePages.length) state.activePageIdx = Math.max(0, visiblePages.length - 1);
    const curPage = visiblePages[state.activePageIdx];

    const rangeLabel = state.startDate && state.endDate
      ? (state.startDate === state.endDate ? state.startDate : `${state.startDate} ~ ${state.endDate}`)
      : '全部日期';

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📑 HJF 出库扫描 PDF 自动核对（直连 HJF 历史出库底表 · 按日期区间精准核对 · 自动剔除气体）</span>
          <span class="pill ${missing.length ? 'pill-red' : 'pill-green'}">日期：${U.escHtml(rangeLabel)} ｜ 待人工核对：${missing.length} / ${total}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">区间内 HJF 独立单据数</div><div class="kpi-val">${total}</div></div>
          <div class="kpi-card green"><div class="kpi-label">🤖 平台自动核销</div><div class="kpi-val">${autoDone}</div></div>
          <div class="kpi-card"><div class="kpi-label">👤 人工确认已核</div><div class="kpi-val">${manualDone}</div></div>
          <div class="kpi-card ${missing.length ? 'red' : 'green'}"><div class="kpi-label">🔴 未检索到（待人工核对）</div><div class="kpi-val">${missing.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="p-sync-hjf">🔄 1. 同步 HJF 历史出库底表</button>
          <button class="btn" id="p-up-csv" title="若在另一台电脑，也可手动导入 HJF物资出库总账.xlsx">📂 或手动导入 HJF 总账 (.xlsx)</button>
          <input type="file" id="p-in-csv" accept=".csv,.xlsx,.xls" class="hidden-input" />
          <button class="btn btn-warning" id="p-up-pdf">📄 2. 拖入/导入对应日期出库 PDF</button>
          <input type="file" id="p-in-pdf" accept=".pdf" multiple class="hidden-input" />
          <span class="pill pill-blue">${U.escHtml(state.sourceLabel || '等待同步 HJF 历史出库底表')}</span>
        </div>
        <div class="toolbar" style="margin-bottom:4px;">
          <span style="font-weight:600;color:#334155;">📅 核对日期区间：</span>
          <select id="p-date-start" title="起始业务日期">
            <option value="">全部开始</option>
            ${state.availDates.map(d => `<option value="${d}" ${d === state.startDate ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
          <span style="color:#64748b;">至</span>
          <select id="p-date-end" title="结束业务日期">
            <option value="">全部结束</option>
            ${state.availDates.map(d => `<option value="${d}" ${d === state.endDate ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
          <span style="font-size:11.5px;color:#64748b;">（单日选同一天，多日如 27~28 号选起止日即可，拖入带日期的 PDF 也会自动锁定）</span>
          <span style="flex:1"></span>
          <button class="btn btn-success" id="p-copy-missing" ${!missing.length ? 'disabled' : ''}>📋 复制缺单催办清单 (${missing.length})</button>
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
              <span>
                ${curPage.dates && curPage.dates.length ? `<span class="pill pill-blue">${curPage.dates.join(', ')}</span>` : ''}
                ${curPage.codes && curPage.codes.length ? `<span class="pill pill-green">检出 ${curPage.codes.length} 个编码</span>` : '<span class="pill pill-orange">未检出编码</span>'}
              </span>
            </div>
            <div style="max-height:580px;overflow:auto;text-align:center;background:#0f172a;border-radius:8px;padding:6px;">
              <img src="${curPage.url}" style="max-width:100%;border-radius:4px;" />
            </div>
          ` : `<div class="dropzone" id="p-media-drop">把对应日期（如 27 号或 27-28 号）的出库扫描 PDF 拖到这里，平台自动按 HJF 历史底表核对</div>`}
        </div>

        <div class="panel">
          <div class="panel-title">
            <span>📑 右侧：HJF 单据核对区（仅显示 [${U.escHtml(rangeLabel)}]）</span>
            <div style="display:flex;gap:5px;">
              <button class="btn-sm ${state.auditFilter === 'unmatched' ? 'btn-primary' : ''}" id="p-f-unmatched">🔴 未检索到 (${missing.length})</button>
              <button class="btn-sm ${state.auditFilter === 'done' ? 'btn-primary' : ''}" id="p-f-done">✅ 已核对 (${autoDone + manualDone})</button>
              <button class="btn-sm ${state.auditFilter === 'all' ? 'btn-primary' : ''}" id="p-f-all">全部 (${total})</button>
            </div>
          </div>
          <div style="max-height:600px;overflow-y:auto;padding-right:4px;">
            ${listToShow.length === 0 ? `<div class="empty-cell">${total === 0 ? '请点上方「🔄 同步 HJF 历史出库底表」或拖入《HJF物资出库总账.xlsx》' : '🎉 当前日期区间所有 HJF 单据均已核对完成！'}</div>` :
              listToShow.map(t => `
                <div class="photo-card ${t.checked ? 'checked' : 'missing'}" style="cursor:default;">
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                      <b style="font-size:13px;">${t.checked ? '✅' : '🔴'} ${U.escHtml(t.dept)}</b>
                      ${t.tag ? `<span class="pill pill-blue">${U.escHtml(t.tag)}</span>` : ''}
                      <span style="font-size:11.5px;color:#64748b;">${U.escHtml(t.date || '')}${t.rec ? ' · ' + U.escHtml(t.rec) : ''}</span>
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

    root.querySelector('#p-sync-hjf').onclick = async () => {
      await syncFromHjfLedger(false);
      renderModule(root);
    };

    const inCsv = root.querySelector('#p-in-csv');
    root.querySelector('#p-up-csv').onclick = () => inCsv.click();
    inCsv.onchange = async e => {
      if (!e.target.files[0]) return;
      try {
        await loadHjfExcelFile(e.target.files[0]);
        renderModule(root);
      } catch (err) {
        U.toast('HJF 出库表解析失败：' + err.message, 'error');
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

    root.querySelector('#p-date-start').onchange = e => {
      state.startDate = e.target.value;
      if (!state.endDate || (state.startDate && state.endDate < state.startDate)) {
        state.endDate = state.startDate;
      }
      if (state.pdfPages.length > 0) runAutoMatchScoped();
      persistState();
      renderModule(root);
    };
    root.querySelector('#p-date-end').onchange = e => {
      state.endDate = e.target.value;
      if (!state.startDate || (state.endDate && state.startDate > state.endDate)) {
        state.startDate = state.endDate;
      }
      if (state.pdfPages.length > 0) runAutoMatchScoped();
      persistState();
      renderModule(root);
    };

    root.querySelector('#p-only-unmatched-pdf').onchange = e => {
      state.onlyUnmatchedPages = e.target.checked;
      state.activePageIdx = 0;
      renderModule(root);
    };
    root.querySelector('#m-prev').onclick = () => { state.activePageIdx = Math.max(0, state.activePageIdx - 1); renderModule(root); };
    root.querySelector('#m-next').onclick = () => { state.activePageIdx = Math.min(visiblePages.length - 1, state.activePageIdx + 1); renderModule(root); };

    root.querySelector('#p-f-unmatched').onclick = () => { state.auditFilter = 'unmatched'; renderModule(root); };
    root.querySelector('#p-f-done').onclick = () => { state.auditFilter = 'done'; renderModule(root); };
    root.querySelector('#p-f-all').onclick = () => { state.auditFilter = 'all'; renderModule(root); };

    root.querySelectorAll('.p-toggle-one').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const tid = Number(btn.dataset.tid);
        const t = state.tickets.find(x => x.id === tid);
        if (!t) return;
        if (t.checked) { t.checked = false; t.matchType = ''; }
        else { t.checked = true; t.matchType = 'manual'; }
        persistState();
        renderModule(root);
      };
    });

    root.querySelectorAll('.p-jump-page').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const targetPageNum = Number(btn.dataset.page);
        state.onlyUnmatchedPages = false;
        const idx = state.pdfPages.findIndex(p => p.pageNum === targetPageNum);
        if (idx >= 0) { state.activePageIdx = idx; renderModule(root); }
      };
    });

    root.querySelector('#p-copy-missing').onclick = async () => {
      const lines = missing.map(t => `${t.date || ''} | ${t.dept} | ${t.tag || t.wh} | ` + t.items.map(i => `${i.name}(${i.qty}${i.unit})`).join('、'));
      const ok = await U.copyText(lines.join('\n'));
      U.toast(ok ? `已复制 ${lines.length} 张未核对 HJF 缺单明细` : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
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
      // 每次切进本板块，自动静默从同源 HJF「2. 历史出库底表」拉取最新出库记录（不覆盖当次手动导入的总账文件）
      if (!state.manualFileLoaded) await syncFromHjfLedger(true);
      if (activeRoot === container && container.isConnected) {
        renderModule(container);
      }
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
      if (excels.length) await loadHjfExcelFile(excels[0]);
      if (pdfs.length) startBackgroundPdfAudit(pdfs);
      refreshIfVisible();
    }
  });
})();
