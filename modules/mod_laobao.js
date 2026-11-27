/**
 * 模块 5：劳保物资发放统计 & 中/印双花名册核对（极简免模板版 · SCHEMA_VER = 5）
 * 核心设计（杜绝阈值堆砌与模板冲突）：
 * 1. 人员与问题核对【完全免模板】：直接按全表「工号/ID特征」（如 F07235024 / T0525000381）定位所有人员栏位（单栏、双栏并排、三栏、无表头通吃），
 *    自动识别相邻姓名、文字休假（是/休息/休假/Cuti/请假/离职）与红色底纹休假，零冲突核对中/印双花名册。
 * 2. 纯劳保物资汇总【仅 2 条通用规则】：① 优先汇总人员行右侧/同行逐人劳保列（自动剔除纸巾）；② 若为纯花名册，自动提取上方「通用物资领料申报单」数量。
 * 3. 每份导入的车间表均可随时在界面【手动切换工作表】重算，彻底告别靠猜模板赌运气。
 * 4. 中/印双花名册真实持久化至本地 IndexedDB（刷新不丢、绝不假绿灯），导入/更新名单后自动重核已导入车间。
 */
(function () {
  'use strict';
  const U = WB.Utils;
  const SCHEMA_VER = 5;
  const ROSTER_IDB_NAME = 'WB_LaoBao_Rosters_v1';
  const ROSTER_IDB_KEY = 'rosters_v1';

  const EXCLUDE_TISSUE = ['纸巾', '抽纸', '卷纸', '卫生纸', '面巾纸', '擦手纸', '餐巾纸'];
  const SKIP_SHEET_RE = /纸巾|抽纸|卷纸|卫生纸|无ID信息|问题人员名单|车间物资明细|^(汇总|总汇总|统计)$/i;
  const META_COL_RE = /^(序号|no\.?|编号|岗位分类|岗位名称|岗位|职位|工种|jabatan|posisi|position|部门|departemen|department|bagian|divisi|车间|班组|单位|公司|姓名|中文名|印方姓名|领用人|领料人|人员|员工|name|nama|id卡号|id号|卡号|工号|id|nik|状态|是否休假|休假|请假|在岗|在职|status|备注|说明|keterangan|ket|正确id|照片|签字|签名|领用签字|领取签字|日期|时间|合计|总计|小计)$/i;
  const GENERIC_GROUP_RE = /^(劳保物资|劳保用品|领用物资|劳保明细|申领物资|发放物资|物资名称|物品)$/i;
  const LEAVE_TEXT_RE = /休假|请假|休息|离职|回国|不在岗|cuti|resign/i;

  // 当前会话保留原始工作簿引用，支持用户在界面一键切换工作表即时重算
  const sessionWorkbooks = new Map(); // fileName -> parsed

  let state = {
    viewMode: 'items',       // 'items' | 'issues' | 'workshops' | 'detail'
    cnRosterCount: 0,
    cnRosterFileName: '',
    cnById: {},
    cnByName: {},
    idRosterCount: 0,
    idRosterHjfCount: 0,
    idRosterOstCount: 0,
    idRosterFileName: '',
    idByNik: {},
    workshops: [],           // [{ fileName, sheetName, availableSheets, expectedCompany, activePeople, cnActive, idActive, leaveSkipped, groupCount, itemMap, people, issues, details }]
    workshopFilter: 'ALL',
    page: 1
  };

  /* ==================== 本地 IndexedDB 花名册持久化 ==================== */
  function openRosterDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const req = indexedDB.open(ROSTER_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveLocalRosters() {
    try {
      const db = await openRosterDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({
          cnById: state.cnById,
          cnByName: state.cnByName,
          cnRosterCount: state.cnRosterCount,
          cnRosterFileName: state.cnRosterFileName,
          idByNik: state.idByNik,
          idRosterCount: state.idRosterCount,
          idRosterHjfCount: state.idRosterHjfCount,
          idRosterOstCount: state.idRosterOstCount,
          idRosterFileName: state.idRosterFileName
        }, ROSTER_IDB_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch { /* ignore */ }
  }

  async function loadLocalRosters() {
    try {
      const db = await openRosterDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(ROSTER_IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  function persistState() {
    WB.Store.save('mod_laobao', {
      schemaVer: SCHEMA_VER,
      viewMode: state.viewMode,
      cnRosterCount: state.cnRosterCount,
      cnRosterFileName: state.cnRosterFileName,
      idRosterCount: state.idRosterCount,
      idRosterHjfCount: state.idRosterHjfCount,
      idRosterOstCount: state.idRosterOstCount,
      idRosterFileName: state.idRosterFileName,
      workshops: state.workshops,
      workshopFilter: state.workshopFilter
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_laobao');
    // 严格校验 schemaVer，彻底清除旧版本所有错误残留缓存
    if (saved && saved.schemaVer === SCHEMA_VER) {
      state.viewMode = saved.viewMode || 'items';
      state.workshops = Array.isArray(saved.workshops) ? saved.workshops : [];
      state.workshopFilter = saved.workshopFilter || 'ALL';
    } else {
      state.workshops = [];
      state.workshopFilter = 'ALL';
      persistState();
    }

    const rosters = await loadLocalRosters();
    if (rosters) {
      state.cnById = rosters.cnById || {};
      state.cnByName = rosters.cnByName || {};
      state.cnRosterCount = (Object.keys(state.cnById).length || Object.keys(state.cnByName).length) ? (rosters.cnRosterCount || 0) : 0;
      state.cnRosterFileName = state.cnRosterCount ? (rosters.cnRosterFileName || '') : '';

      state.idByNik = rosters.idByNik || {};
      state.idRosterCount = Object.keys(state.idByNik).length ? (rosters.idRosterCount || 0) : 0;
      state.idRosterHjfCount = state.idRosterCount ? (rosters.idRosterHjfCount || 0) : 0;
      state.idRosterOstCount = state.idRosterCount ? (rosters.idRosterOstCount || 0) : 0;
      state.idRosterFileName = state.idRosterCount ? (rosters.idRosterFileName || '') : '';
    } else {
      state.cnRosterCount = (Object.keys(state.cnById).length || Object.keys(state.cnByName).length) ? state.cnRosterCount : 0;
      state.idRosterCount = Object.keys(state.idByNik).length ? state.idRosterCount : 0;
      if (!state.idRosterCount) { state.idRosterHjfCount = 0; state.idRosterOstCount = 0; }
    }
  }

  /* ==================== 基础特征判定函数 ==================== */
  function normId(val) {
    return U.cleanStr(val).replace(/[\s\r\n]+/g, '').toUpperCase();
  }

  function isChineseName(name) {
    const s = String(name || '').trim();
    if (!/[\u4e00-\u9fa5]/.test(s)) return false;
    // 若以拉丁字母开头且含完整英文单词（如 "EDIKA WAMI艾迪" / "Carina马福佳"），判定为印方带中文绰号
    if (/^[A-Za-z]{2,}/.test(s)) return false;
    return true;
  }

  function extractPureChineseName(name) {
    const m = String(name || '').match(/[\u4e00-\u9fa5]+/g);
    return m ? m.join('') : '';
  }

  function isTissueName(text) {
    const s = String(text || '');
    return EXCLUDE_TISSUE.some(k => s.includes(k));
  }

  function detectCompanyFromText(text, fallback = '') {
    const s = String(text || '').toUpperCase();
    if (/OST|OBI\s*SINAR\s*TIMUR|电厂[（(]O/.test(s)) return 'OST';
    if (/HJF|HALMAHERA|电厂[（(]H/.test(s)) return 'HJF';
    const m = s.match(/\b(KPS|CKM|BJL|HJS|ONC|HPL|DPL)\b/) || s.match(/^(KPS|CKM|BJL|HJS|ONC|HPL|DPL)/);
    if (m) return m[1];
    return fallback;
  }

  /** 判断单元格是否为真实员工工号/ID卡号（自动排除 0500/0800/1001P 物资编码与纯日期） */
  function isEmployeeIdLike(val) {
    const s = normId(val);
    if (!s || s.length < 7 || s.length > 16) return false;
    if (/^(?:0[1-9]\d{6,10}|1001P\d+|100P\d+)$/i.test(s)) return false;
    if (/^[A-Z]{1,3}\d{6,13}$/.test(s)) return true;
    return false;
  }

  /** 判断单元格是否像人名（排除纯数字、空值、工号、常见状态/表头词） */
  function isPersonNameLike(val) {
    const s = U.cleanStr(val);
    if (!s || s.length < 2 || s.length > 60) return false;
    if (/^\d+(\.\d+)?$/.test(s)) return false;
    if (isEmployeeIdLike(s)) return false;
    if (META_COL_RE.test(s) || /^(是|否|yes|no|合计|总计|小计|汇总|综合仓|通用仓|劳保仓|工程物资仓)$/i.test(s)) return false;
    return /[\u4e00-\u9fa5A-Za-z]{2,}/.test(s);
  }

  /** 检测单元格红色底纹（识别“红色为休假”，不误判黄/绿/蓝/白） */
  function isRedFillCell(ws, r, c) {
    if (!ws || r < 0 || c < 0 || typeof XLSX === 'undefined' || !XLSX.utils || !XLSX.utils.encode_cell) return false;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell || !cell.s || cell.s.patternType === 'none') return false;
    const rgbRaw = (cell.s.fgColor && cell.s.fgColor.rgb) || (cell.s.bgColor && cell.s.bgColor.rgb) || '';
    const hex = String(rgbRaw).replace(/^#/, '').toUpperCase();
    const rgb6 = hex.length === 8 ? hex.slice(2) : (hex.length === 6 ? hex : '');
    if (!/^[0-9A-F]{6}$/.test(rgb6)) return false;
    const R = parseInt(rgb6.slice(0, 2), 16);
    const G = parseInt(rgb6.slice(2, 4), 16);
    const B = parseInt(rgb6.slice(4, 6), 16);
    return R >= 170 && G <= 95 && B <= 95 && (R - G) >= 90 && (R - B) >= 90;
  }

  /* ==================== 近似人员（模糊姓名）检索索引 ==================== */
  const COMMON_ID_STOP_TOKENS = new Set(['BIN', 'BINTI', 'MUH', 'MOH', 'MUHAMMAD', 'MOHAMMAD', 'ABDUL', 'ANDI', 'SITI', 'PUTRA', 'PUTRI', 'AGUS', 'AHMAD', 'BUDI', 'DEDI', 'HADI', 'JOKO', 'RIKO', 'YUSUF']);
  let _idIndexRef = null;
  let _idUniqueList = [];
  let _idTokenMap = new Map();

  function extractLatinTokens(name) {
    // 剥离中文字符与标点（如 "EDIKA WAMI艾迪" -> ["EDIKA", "WAMI"]，"AGUSTIAN ALDRIN C." -> ["AGUSTIAN", "ALDRIN"]）
    const latin = String(name || '').replace(/[\u4e00-\u9fa5]+/g, ' ').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
    if (!latin) return [];
    return latin.split(/\s+/).filter(t => t.length >= 2);
  }

  function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > 2) return 99;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let minRow = curr[0];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (curr[j] < minRow) minRow = curr[j];
      }
      if (minRow > 2) return 99;
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  function ensureIdFuzzyIndex() {
    if (_idIndexRef === state.idByNik) return;
    _idIndexRef = state.idByNik;
    const seen = new Set();
    const list = [];
    const tMap = new Map();

    Object.values(state.idByNik || {}).forEach(rec => {
      if (!rec || !rec.nik || seen.has(rec.nik)) return;
      seen.add(rec.nik);
      const tokens = extractLatinTokens(rec.name);
      const entry = { rec, tokens, flat: tokens.join(' ') };
      const idx = list.length;
      list.push(entry);
      tokens.forEach(t => {
        if (t.length < 3) return;
        if (!tMap.has(t)) tMap.set(t, []);
        tMap.get(t).push(idx);
      });
    });
    _idUniqueList = list;
    _idTokenMap = tMap;
  }

  /** 在印方花名册中查找近似姓名（支持简称如 WAMI -> EDIKA WAMI、中印混写如 EDIKA WAMI艾迪、拼写小错如 RIFLDO -> RIFALDO） */
  function findFuzzyIdMatches(name, idRaw) {
    ensureIdFuzzyIndex();
    if (!_idUniqueList.length) return [];
    const qTokens = extractLatinTokens(name).filter(t => t.length >= 3);
    if (!qTokens.length) return [];
    const qFlat = qTokens.join(' ');

    // 1. 优先用倒排索引收集候选（极快）；若倒排无命中且仅 1~3 词，兜底全表做编辑距离检索
    const candIdxSet = new Set();
    qTokens.forEach(t => {
      const arr = _idTokenMap.get(t);
      if (arr) arr.forEach(i => candIdxSet.add(i));
    });

    const pool = candIdxSet.size > 0
      ? Array.from(candIdxSet).map(i => _idUniqueList[i])
      : _idUniqueList;

    const scored = [];
    for (const entry of pool) {
      if (!entry.tokens.length) continue;
      let score = 0;

      if (entry.flat === qFlat) {
        score = 100;
      } else {
        let exactHits = 0;
        let fuzzyHits = 0;
        let rareHit = false;

        for (const qt of qTokens) {
          if (entry.tokens.includes(qt)) {
            exactHits++;
            if (!COMMON_ID_STOP_TOKENS.has(qt) && qt.length >= 4) rareHit = true;
          } else {
            // 允许单字拼写误差（如 RIFLDO vs RIFALDO）或前缀/后缀包含（长度>=4）
            const maxDist = qt.length >= 6 ? 2 : (qt.length >= 4 ? 1 : 0);
            const matchedFuzzy = entry.tokens.some(ct =>
              (ct.length >= 4 && qt.length >= 4 && (ct.includes(qt) || qt.includes(ct))) ||
              (maxDist > 0 && editDistance(qt, ct) <= maxDist)
            );
            if (matchedFuzzy) fuzzyHits++;
          }
        }

        const totalMatched = exactHits + fuzzyHits;
        if (qTokens.length === 1) {
          // 单词简称（如只写 "WAMI" 匹配 "EDIKA WAMI"）：精确命中非高频通用词即可判为近似
          const qt = qTokens[0];
          if (exactHits === 1 && (!COMMON_ID_STOP_TOKENS.has(qt) || entry.tokens.length <= 2)) {
            score = 88;
          } else if (fuzzyHits === 1 && qt.length >= 5) {
            score = 72;
          }
        } else {
          // 多词姓名：至少命中 2 词，或命中 1 个高区分度词且覆盖率 >= 50%
          if (exactHits === qTokens.length) score = 95;
          else if (totalMatched >= 2) score = 78 + exactHits * 5 + fuzzyHits * 2;
          else if (exactHits === 1 && rareHit && qTokens.length === 2) score = 70;
        }
      }

      if (score >= 70) {
        // 若工号也很接近（仅错 1~2 位或前 5 位一致），额外加分置顶
        if (idRaw && entry.rec.nik) {
          if (editDistance(idRaw, entry.rec.nik) <= 2) score += 15;
          else if (idRaw.slice(0, 5) === entry.rec.nik.slice(0, 5)) score += 8;
        }
        scored.push({ rec: entry.rec, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(x => x.rec);
  }

  /** 在中方花名册中查找近似姓名（支持去拼音、包含关系、3字姓名错1字） */
  function findFuzzyCnMatches(name, idRaw) {
    const pureCn = extractPureChineseName(name);
    if (!pureCn || pureCn.length < 2) return [];
    const exact = state.cnByName[name] || state.cnByName[pureCn];
    if (exact && exact.length) return exact.slice(0, 3);

    const scored = [];
    Object.entries(state.cnByName || {}).forEach(([cnName, recs]) => {
      const cPure = extractPureChineseName(cnName);
      if (!cPure || cPure.length < 2) return;
      let score = 0;
      if (cPure.includes(pureCn) || pureCn.includes(cPure)) {
        score = 88;
      } else if (cPure.length === pureCn.length && pureCn.length >= 3) {
        let same = 0;
        for (let i = 0; i < pureCn.length; i++) if (cPure[i] === pureCn[i]) same++;
        if (same >= pureCn.length - 1) score = 78;
      }
      if (score > 0 && recs && recs[0]) {
        if (idRaw && recs[0].id) {
          if (editDistance(idRaw, recs[0].id) <= 2) score += 15;
          else if (idRaw.slice(0, 5) === recs[0].id.slice(0, 5)) score += 8;
        }
        scored.push({ rec: recs[0], score });
      }
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(x => x.rec);
  }

  function formatCandidateList(cands) {
    return cands.map(c => {
      const code = c.nik || c.id || '无ID';
      const st = c.leftDate ? `离职:${c.leftDate}` : (c.status || '在职');
      return `${c.name}[${code}|${c.company}|${st}]`;
    }).join('；');
  }

  /* ==================== 中/印双花名册核对 ==================== */
  function auditSinglePerson(p, fileName, expectedCompany) {
    const hasCnRoster = Object.keys(state.cnById).length > 0 || Object.keys(state.cnByName).length > 0;
    const hasIdRoster = Object.keys(state.idByNik).length > 0;
    const { seq, dept, name, idRaw, rem } = p;
    const isCn = isChineseName(name);

    let issueType = '';
    let issueDesc = '';
    if (!idRaw) {
      const fuzzy = isCn ? findFuzzyCnMatches(name, '') : findFuzzyIdMatches(name, '');
      if (fuzzy.length) {
        issueType = '近似人员(缺ID)';
        issueDesc = `未填ID，疑似花名册：${formatCandidateList(fuzzy)}`;
      } else {
        issueType = '缺失ID卡号';
        issueDesc = rem || '未填写ID卡号/工号';
      }
    } else if (isCn) {
      if (hasCnRoster) {
        const hit = state.cnById[idRaw];
        if (hit) {
          if (hit.leftDate) {
            issueType = '中方已离职';
            issueDesc = `中方花名册已登记离职（离职日期: ${hit.leftDate}，${hit.dept}）`;
          } else if (hit.company !== '未知' && hit.company !== expectedCompany) {
            issueType = `串公司(${hit.company})`;
            issueDesc = `中方花名册归属 ${hit.company}（${hit.dept} / ${hit.workshop}）`;
          }
        } else {
          const idFallback = hasIdRoster ? state.idByNik[idRaw] : null;
          if (idFallback) {
            if (idFallback.company !== expectedCompany) {
              issueType = `串公司(${idFallback.company})`;
              issueDesc = `印方花名册归属 ${idFallback.company}（${idFallback.dept || '未知部门'}，状态:${idFallback.status}）`;
            } else if (idFallback.status && !/aktif|active|在职/i.test(idFallback.status)) {
              issueType = `印方非在职(${idFallback.status})`;
              issueDesc = `印方花名册状态为 ${idFallback.status}`;
            }
          } else {
            const pureCn = extractPureChineseName(name);
            const nameHits = state.cnByName[name] || (pureCn ? state.cnByName[pureCn] : null) || [];
            if (nameHits.length > 0) {
              const first = nameHits[0];
              if (first.leftDate) {
                issueType = '中方已离职';
                issueDesc = `按姓名匹配已离职（离职日期: ${first.leftDate}，原ID: ${first.id || '无'}）`;
              } else {
                issueType = '中方ID不符';
                issueDesc = `花名册同名人员ID为 ${first.id || '空'}（${first.dept}/${first.workshop}）`;
              }
            } else {
              const fuzzyCn = findFuzzyCnMatches(name, idRaw);
              const fuzzyId = !fuzzyCn.length && hasIdRoster ? findFuzzyIdMatches(name, idRaw) : [];
              const fuzzy = fuzzyCn.length ? fuzzyCn : fuzzyId;
              if (fuzzy.length) {
                issueType = '近似人员';
                issueDesc = `ID未匹配，疑似花名册：${formatCandidateList(fuzzy)}`;
              } else {
                issueType = '中方名单查无此人';
                issueDesc = '在中方人员ID卡信息表中未查到该ID与近似姓名';
              }
            }
          }
        }
      }
    } else {
      if (hasIdRoster) {
        const hit = state.idByNik[idRaw];
        if (hit) {
          if (hit.company !== expectedCompany) {
            issueType = `串公司(${hit.company})`;
            issueDesc = `印方花名册归属 ${hit.company}（${hit.dept || '未知部门'}，状态:${hit.status}）`;
          } else if (hit.status && !/aktif|active|在职/i.test(hit.status)) {
            issueType = `印方非在职(${hit.status})`;
            issueDesc = `印方花名册状态为 ${hit.status}`;
          }
        } else {
          const fuzzy = findFuzzyIdMatches(name, idRaw);
          if (fuzzy.length) {
            issueType = '近似人员';
            issueDesc = `NIK未匹配，疑似花名册：${formatCandidateList(fuzzy)}`;
          } else {
            issueType = '印方名单查无此ID';
            issueDesc = '在 MP HJF / MP OST 中均未匹配到该 NIK 或近似姓名（可能离职/工号错误）';
          }
        }
      }
    }

    if (!issueType) return null;
    return [fileName, seq, dept, name, idRaw, isCn ? '中方' : '印方', issueType, issueDesc];
  }

  function reAuditAllWorkshops() {
    let totalIssues = 0;
    state.workshops.forEach(w => {
      if (!Array.isArray(w.people)) return;
      const issues = [];
      w.people.forEach(p => {
        const row = auditSinglePerson(p, w.fileName, w.expectedCompany);
        if (row) issues.push(row);
      });
      w.issues = issues;
      totalIssues += issues.length;
    });
    return totalIssues;
  }

  async function loadCnRosterFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const byId = {};
    const byName = {};
    let count = 0;

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(10, aoa.length); i++) {
        const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/姓名/.test(line) && /ID卡号|工号|离职|部门|车间/i.test(line)) { hdrIdx = i; break; }
      }
      if (hdrIdx < 0) return;
      const h = aoa[hdrIdx].map(v => U.cleanStr(v));
      const iName = h.findIndex(x => /姓名/.test(x));
      const iDept = h.findIndex(x => /^部门|所属部门/.test(x));
      const iWs = h.findIndex(x => /车间/.test(x));
      const iRole = h.findIndex(x => /岗位/.test(x));
      const iId = h.findIndex(x => /ID卡号|工号|^ID$/i.test(x));
      const iLeft = h.findIndex(x => /离职/.test(x));

      for (let i = hdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
        const id = iId >= 0 ? normId(r[iId]) : '';
        if (!name && !id) continue;
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '';
        const workshop = iWs >= 0 ? U.cleanStr(r[iWs]) : '';
        const role = iRole >= 0 ? U.cleanStr(r[iRole]) : '';
        const leftDate = iLeft >= 0 ? U.cleanStr(r[iLeft]) : '';
        const company = detectCompanyFromText(`${dept} ${workshop}`, '未知');
        const rec = { company, name, dept, workshop, role, id, leftDate };
        if (id) byId[id] = rec;
        if (name) {
          if (!byName[name]) byName[name] = [];
          byName[name].push(rec);
        }
        count++;
      }
    });

    if (count === 0) throw new Error('未在中方名单中识别到【姓名 / ID卡号】列');
    state.cnById = byId;
    state.cnByName = byName;
    state.cnRosterCount = count;
    state.cnRosterFileName = file.name;
    const reCnt = state.workshops.length ? reAuditAllWorkshops() : 0;
    await saveLocalRosters();
    persistState();
    const extra = state.workshops.length ? `（已自动重核 ${state.workshops.length} 个车间，检出问题人员 ${reCnt} 人）` : '';
    U.toast(`中方人员名单载入成功：共 ${count} 人索引${extra}`, 'success');
  }

  async function loadIdRosterFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const byNik = {};
    let hjfCnt = 0;
    let ostCnt = 0;

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(10, aoa.length); i++) {
        const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/\bNIK\b/i.test(line) && /Nama|Name|姓名/i.test(line)) { hdrIdx = i; break; }
      }
      if (hdrIdx < 0) return;
      const h = aoa[hdrIdx].map(v => U.cleanStr(v));
      const iNik = h.findIndex(x => /^NIK$/i.test(x));
      const iOldNik = h.findIndex(x => /NIK\s*Sebelumnya/i.test(x));
      const iNama = h.findIndex(x => /^Nama$|姓名/i.test(x));
      const iStatus = h.findIndex(x => /^Status$|状态/i.test(x));
      const iComp = h.findIndex(x => /Perusahaan|公司/i.test(x));
      const iDept = h.findIndex(x => /^Department$|部门/i.test(x));

      const defaultComp = /OST/i.test(sn) ? 'OST' : 'HJF';
      for (let i = hdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const nik = iNik >= 0 ? normId(r[iNik]) : '';
        const oldNik = iOldNik >= 0 ? normId(r[iOldNik]) : '';
        const nama = iNama >= 0 ? U.cleanStr(r[iNama]) : '';
        if (!nik && !oldNik) continue;
        const status = iStatus >= 0 ? U.cleanStr(r[iStatus]) : 'Aktif';
        const compRaw = iComp >= 0 ? U.cleanStr(r[iComp]) : '';
        const company = detectCompanyFromText(compRaw, defaultComp);
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '';
        const rec = { company, name: nama, status, dept, nik };
        if (nik) byNik[nik] = rec;
        if (oldNik && !byNik[oldNik]) byNik[oldNik] = rec;
        if (company === 'OST') ostCnt++;
        else hjfCnt++;
      }
    });

    const total = hjfCnt + ostCnt;
    if (total === 0) throw new Error('未在印方名单中识别到【NIK / Nama】列');
    state.idByNik = byNik;
    state.idRosterHjfCount = hjfCnt;
    state.idRosterOstCount = ostCnt;
    state.idRosterCount = total;
    state.idRosterFileName = file.name;
    const reCnt = state.workshops.length ? reAuditAllWorkshops() : 0;
    await saveLocalRosters();
    persistState();
    const extra = state.workshops.length ? `（已自动重核 ${state.workshops.length} 个车间，检出问题人员 ${reCnt} 人）` : '';
    U.toast(`印方人员名单载入成功：HJF ${hjfCnt} 人 / OST ${ostCnt} 人（共 ${total} 人索引）${extra}`, 'success');
  }

  /* ==================== 核心引擎：按工号/ID特征全表直扫（免模板） ==================== */

  /**
   * 在任意工作表中直接按「工号/ID特征」定位全部人员栏位（支持 1 栏、2 栏并排、3 栏、无表头）
   * 返回 [{ iId, iName, iSeq, iDept, iLeave, firstRow }]
   */
  function detectPersonGroupsByData(aoa) {
    const colHits = new Map(); // colIdx -> { count, firstRow }
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (isEmployeeIdLike(row[c])) {
          const rec = colHits.get(c) || { count: 0, firstRow: r };
          rec.count++;
          colHits.set(c, rec);
        }
      }
    }

    // 保留所有至少出现 1 次真实工号的列（若存在出现>=2次的列，则过滤偶发噪声单格）
    const maxHit = Math.max(0, ...Array.from(colHits.values()).map(v => v.count));
    const minThreshold = maxHit >= 2 ? 2 : 1;
    const idCols = Array.from(colHits.entries())
      .filter(([, v]) => v.count >= minThreshold)
      .sort((a, b) => a[0] - b[0]);

    if (!idCols.length) return [];

    const groups = [];
    for (let g = 0; g < idCols.length; g++) {
      const [iId, info] = idCols[g];
      const leftLimit = g === 0 ? 0 : idCols[g - 1][0] + 1;
      const rightLimit = g === idCols.length - 1 ? 99 : idCols[g + 1][0] - 1;

      // 在工号列的左1/右1/左2/右2中找最像「姓名」的邻列
      const candOffsets = [-1, 1, -2, 2];
      let bestNameCol = -1;
      let bestNameScore = -1;
      for (const off of candOffsets) {
        const nc = iId + off;
        if (nc < leftLimit || nc > rightLimit) continue;
        let nameHits = 0;
        let checked = 0;
        for (let r = info.firstRow; r < Math.min(aoa.length, info.firstRow + 40); r++) {
          const row = aoa[r] || [];
          if (!isEmployeeIdLike(row[iId])) continue;
          checked++;
          if (isPersonNameLike(row[nc])) nameHits++;
        }
        // 紧邻列（±1）优先于隔列（±2）
        const score = nameHits * 10 - Math.abs(off);
        if (nameHits > 0 && score > bestNameScore) {
          bestNameScore = score;
          bestNameCol = nc;
        }
      }

      // 查看该栏数据首行上方 1~2 行（若存在表头），仅用于辅助定位 序号 / 部门 / 状态列
      const hdrRow = info.firstRow > 0 ? (aoa[info.firstRow - 1] || []).map(v => U.cleanStr(v)) : [];
      const hdrRow2 = info.firstRow > 1 ? (aoa[info.firstRow - 2] || []).map(v => U.cleanStr(v)) : [];
      const maxC = Math.min(rightLimit, Math.max(hdrRow.length, hdrRow2.length) - 1);

      const findNearHeader = (re) => {
        for (let c = leftLimit; c <= maxC; c++) {
          if (c === iId || c === bestNameCol) continue;
          const hTxt = `${hdrRow2[c] || ''} ${hdrRow[c] || ''}`.trim();
          if (re.test(hTxt)) return c;
        }
        return -1;
      };

      const iSeq = findNearHeader(/^序号|^no\.?$/i);
      const iDept = findNearHeader(/岗位分类|部门|车间|班组|岗位名称|岗位|jabatan|department/i);
      const iLeave = findNearHeader(/休假|状态|请假|在岗|^status$/i);

      groups.push({
        iId,
        iName: bestNameCol,
        iSeq,
        iDept,
        iLeave,
        firstRow: info.firstRow,
        leftLimit,
        rightLimit
      });
    }
    return groups;
  }

  /** 规则 ②：从人员名单上方的「通用物资领料申报单」提取纯劳保汇总 */
  function extractTopRequisitionItems(aoa, beforeRowIdx) {
    const items = {};
    let excludedTissue = 0;
    let sumHdrIdx = -1;
    let iSumName = -1;
    let iSumQty = -1;

    for (let i = 0; i < Math.min(beforeRowIdx, aoa.length); i++) {
      const row = (aoa[i] || []).map(v => U.cleanStr(v));
      const idxName = row.findIndex(x => /存货名称|物资名称|物料名称|品名/.test(x));
      const idxQty = row.findIndex(x => /领用数量|申领数量|发放数量|数量/.test(x));
      if (idxName >= 0 && idxQty >= 0) {
        sumHdrIdx = i;
        iSumName = idxName;
        iSumQty = idxQty;
        break;
      }
    }
    if (sumHdrIdx < 0) return { items, excludedTissue };

    for (let i = sumHdrIdx + 1; i < Math.min(beforeRowIdx, aoa.length); i++) {
      const r = aoa[i] || [];
      const name = U.cleanStr(r[iSumName]);
      const qty = U.parseNum(r[iSumQty]);
      if (!name || qty <= 0) continue;
      if (/^(合计|总计|小计|存货名称|物资名称)/.test(name)) continue;
      if (isTissueName(name)) { excludedTissue++; continue; }
      const cleanName = name.replace(/\s+/g, ' ');
      if (!items[cleanName]) items[cleanName] = { qty: 0, people: 0 };
      items[cleanName].qty += qty;
    }
    return { items, excludedTissue };
  }

  /** 解析指定工作表（100% 免模板：工号直扫 + 2 条物资汇总规则） */
  function parseWorkshopSheet(aoa, rawWs, sn, fileName) {
    const groups = detectPersonGroupsByData(aoa);
    if (!groups.length) return null;

    const wsRange = rawWs && rawWs['!ref'] ? XLSX.utils.decode_range(rawWs['!ref']) : { s: { r: 0, c: 0 } };
    const minFirstRow = Math.min(...groups.map(g => g.firstRow));
    const expectedCompany = detectCompanyFromText(`${fileName} ${sn}`, 'HJF');
    const defaultDeptName = fileName.replace(/\.[^.]+$/, '');

    // 规则 ①：仅在单栏人员表时，检测表头行是否存在逐人数值型劳保物资列（自动支持两行合并表头，剔除纸巾与元信息列）
    const ppeCols = [];
    let excludedTissueCols = 0;
    if (groups.length === 1 && minFirstRow > 0) {
      const g0 = groups[0];
      const usedSet = new Set([g0.iId, g0.iName, g0.iSeq, g0.iDept, g0.iLeave].filter(x => x >= 0));
      const hRow1 = (aoa[minFirstRow - 1] || []).map(v => U.cleanStr(v).replace(/\s+/g, ' '));
      const hRow0 = minFirstRow >= 2 ? (aoa[minFirstRow - 2] || []).map(v => U.cleanStr(v).replace(/\s+/g, ' ')) : [];
      const maxCols = Math.max(hRow1.length, hRow0.length);

      for (let c = 0; c < maxCols; c++) {
        if (usedSet.has(c)) continue;
        const t1 = hRow1[c] || '';
        const t0 = hRow0[c] || '';
        const colName = t1 || (!GENERIC_GROUP_RE.test(t0) ? t0 : '');
        if (!colName) continue;
        const stripped = colName.replace(/（.*?）|\(.*?\)/g, '').trim();
        if (!stripped || /^\d+$/.test(stripped)) continue;
        if (META_COL_RE.test(stripped) || GENERIC_GROUP_RE.test(stripped)) continue;
        if (isTissueName(colName)) { excludedTissueCols++; continue; }

        // 确认该列在人员行中确实包含数量数字（如 "30" / "1副" / "0"），防止误把备注/领用人文字当物资列
        let numHits = 0;
        let textOnlyHits = 0;
        for (let r = minFirstRow; r < Math.min(aoa.length, minFirstRow + 30); r++) {
          const v = U.cleanStr((aoa[r] || [])[c]);
          if (!v) continue;
          if (/^\d+(\.\d+)?/.test(v)) numHits++;
          else textOnlyHits++;
        }
        if (numHits > 0 && numHits >= textOnlyHits) {
          ppeCols.push({ idx: c, name: colName.replace(/\n+/g, '') });
        }
      }
    }

    const itemMap = {};
    const people = [];
    const issues = [];
    const details = [];
    let activePeople = 0;
    let cnActive = 0;
    let idActive = 0;
    let leaveSkipped = 0;

    for (let r = minFirstRow; r < aoa.length; r++) {
      const row = aoa[r] || [];
      const wsRowIdx = wsRange.s.r + r;

      for (const g of groups) {
        if (r < g.firstRow) continue;
        const idRaw = normId(row[g.iId]);
        const name = g.iName >= 0 ? U.cleanStr(row[g.iName]) : '';
        if (!idRaw && !name) continue;
        // 若既不是有效工号、也没有合法姓名（例如表尾“合计”或空序号行），跳过
        if (!isEmployeeIdLike(idRaw) && !isPersonNameLike(name)) continue;
        if (/^(合计|总计|小计|汇总|人数|统计|制表|审核|审批|签字)/.test(name)) continue;

        // 休假判定：① 状态列或本栏邻格出现 休息/休假/Cuti/请假/离职/是；② 单元格红色底纹标休假
        const leaveCellTxt = g.iLeave >= 0 ? U.cleanStr(row[g.iLeave]) : '';
        const textLeave = /^(是|yes|y)$/i.test(leaveCellTxt) || LEAVE_TEXT_RE.test(leaveCellTxt);
        const colorLeave = rawWs && (
          isRedFillCell(rawWs, wsRowIdx, wsRange.s.c + g.iId) ||
          (g.iName >= 0 && isRedFillCell(rawWs, wsRowIdx, wsRange.s.c + g.iName))
        );
        if (textLeave || colorLeave) {
          leaveSkipped++;
          continue;
        }

        activePeople++;
        const isCn = isChineseName(name);
        if (isCn) cnActive++;
        else idActive++;

        const seq = g.iSeq >= 0 && U.cleanStr(row[g.iSeq]) ? U.cleanStr(row[g.iSeq]) : String(activePeople);
        const dept = g.iDept >= 0 && U.cleanStr(row[g.iDept]) ? U.cleanStr(row[g.iDept]) : defaultDeptName;

        // 规则 ①：逐人劳保列累加
        if (ppeCols.length > 0) {
          ppeCols.forEach(col => {
            const qty = U.parseNum(row[col.idx]);
            if (!itemMap[col.name]) itemMap[col.name] = { qty: 0, people: 0 };
            if (qty > 0) {
              itemMap[col.name].qty += qty;
              itemMap[col.name].people += 1;
              details.push([fileName, dept, name || idRaw, col.name, qty]);
            }
          });
        }

        const personRec = { seq, dept, name: name || idRaw, idRaw, rem: '' };
        people.push(personRec);
        const issueRow = auditSinglePerson(personRec, fileName, expectedCompany);
        if (issueRow) issues.push(issueRow);
      }
    }

    // 规则 ②：若无逐人劳保列（如并排双栏纯人员名单），自动从上方「通用物资领料申报单」提取纯劳保汇总
    if (ppeCols.length === 0) {
      const topSum = extractTopRequisitionItems(aoa, minFirstRow);
      excludedTissueCols += topSum.excludedTissue;
      Object.entries(topSum.items).forEach(([k, v]) => {
        itemMap[k] = { qty: v.qty, people: activePeople };
      });
    }

    if (activePeople === 0 && leaveSkipped === 0) return null;
    return {
      fileName,
      sheetName: sn,
      expectedCompany,
      activePeople,
      cnActive,
      idActive,
      leaveSkipped,
      excludedTissueCols,
      groupCount: groups.length,
      itemMap,
      people,
      issues,
      details
    };
  }

  /** 自动选择含工号的有效工作表（跳过纸巾/汇总辅助表），同时保存全部可选工作表供界面一键切换 */
  function buildWorkshopFromParsed(parsed, forcedSheetName = '') {
    const fileName = parsed.fileName;
    const availableSheets = parsed.sheetNames.filter(sn => (parsed.sheets[sn] || []).length >= 2);

    if (forcedSheetName) {
      const aoa = parsed.sheets[forcedSheetName] || [];
      const rawWs = parsed.wb && parsed.wb.Sheets ? parsed.wb.Sheets[forcedSheetName] : null;
      const part = parseWorkshopSheet(aoa, rawWs, forcedSheetName, fileName);
      if (!part) throw new Error(`工作表 [${forcedSheetName}] 中未扫描到有效工号/人员记录`);
      part.availableSheets = availableSheets;
      return part;
    }

    // 自动扫描所有非纸巾、非汇总工作表，按扫描到的工号数量选出全部有效人员表
    const validParts = [];
    for (const sn of availableSheets) {
      if (SKIP_SHEET_RE.test(sn.trim())) continue;
      const aoa = parsed.sheets[sn] || [];
      const rawWs = parsed.wb && parsed.wb.Sheets ? parsed.wb.Sheets[sn] : null;
      const part = parseWorkshopSheet(aoa, rawWs, sn, fileName);
      if (part && (part.activePeople + part.leaveSkipped) > 0) {
        validParts.push(part);
      }
    }

    if (!validParts.length) {
      throw new Error(`[${fileName}] 未在非纸巾工作表中扫描到有效员工工号（如 F07235024 / T0525000381），请检查表格`);
    }

    if (validParts.length === 1) {
      validParts[0].availableSheets = availableSheets;
      return validParts[0];
    }

    // 同一文件若拆分多张人员表（如「中方」+「印方」），全部合并
    const merged = {
      fileName,
      sheetName: validParts.map(p => p.sheetName).join(' + '),
      availableSheets,
      expectedCompany: detectCompanyFromText(fileName, 'HJF'),
      activePeople: 0,
      cnActive: 0,
      idActive: 0,
      leaveSkipped: 0,
      excludedTissueCols: 0,
      groupCount: 0,
      itemMap: {},
      people: [],
      issues: [],
      details: []
    };
    validParts.forEach(p => {
      merged.activePeople += p.activePeople;
      merged.cnActive += p.cnActive;
      merged.idActive += p.idActive;
      merged.leaveSkipped += p.leaveSkipped;
      merged.excludedTissueCols += p.excludedTissueCols;
      merged.groupCount = Math.max(merged.groupCount, p.groupCount);
      Object.entries(p.itemMap).forEach(([k, v]) => {
        if (!merged.itemMap[k]) merged.itemMap[k] = { qty: 0, people: 0 };
        merged.itemMap[k].qty += v.qty;
        merged.itemMap[k].people += v.people;
      });
      p.people.forEach(x => merged.people.push(x));
      p.issues.forEach(x => merged.issues.push(x));
      p.details.forEach(x => merged.details.push(x));
    });
    return merged;
  }

  async function loadWorkshopFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let okCnt = 0;
    const errs = [];

    for (const f of files) {
      try {
        const parsed = await U.readSpreadsheet(f);
        sessionWorkbooks.set(f.name, parsed);
        const res = buildWorkshopFromParsed(parsed);
        const idx = state.workshops.findIndex(w => w.fileName === res.fileName);
        if (idx >= 0) state.workshops[idx] = res;
        else state.workshops.push(res);
        okCnt++;
      } catch (e) {
        errs.push(`${f.name}: ${e.message}`);
      }
    }

    state.workshopFilter = 'ALL';
    state.page = 1;
    persistState();
    if (errs.length) {
      U.toast(`批量导入完成：成功 ${okCnt} 份，失败 ${errs.length} 份（${errs[0]}）`, 'warn');
    } else {
      U.toast(`批量导入成功：本次处理 ${okCnt} 份，累计已载入 ${state.workshops.length} 个车间劳保表`, 'success');
    }
  }

  function getAggregatedView() {
    const scoped = state.workshopFilter === 'ALL'
      ? state.workshops
      : state.workshops.filter(w => w.fileName === state.workshopFilter);

    let activePeople = 0, cnActive = 0, idActive = 0, leaveSkipped = 0;
    const itemTotals = new Map();
    const allIssues = [];
    const allDetails = [];

    scoped.forEach(w => {
      activePeople += w.activePeople;
      cnActive += w.cnActive;
      idActive += w.idActive;
      leaveSkipped += w.leaveSkipped;
      Object.entries(w.itemMap || {}).forEach(([name, info]) => {
        if (!itemTotals.has(name)) itemTotals.set(name, { qty: 0, people: 0 });
        const acc = itemTotals.get(name);
        acc.qty += info.qty;
        acc.people += info.people;
      });
      (w.issues || []).forEach(r => allIssues.push(r));
      (w.details || []).forEach(r => allDetails.push(r));
    });

    const itemRows = Array.from(itemTotals.entries())
      .filter(([, info]) => info.qty > 0)
      .map(([name, info]) => [name, U.fmtNum(info.qty), info.people]);
    const wsRows = state.workshops.map(w => [
      w.fileName,
      w.sheetName + (w.groupCount > 1 ? ` (${w.groupCount}栏并排)` : ''),
      w.expectedCompany,
      w.activePeople,
      `${w.cnActive} / ${w.idActive}`,
      w.leaveSkipped,
      (w.issues || []).length
    ]);

    return { activePeople, cnActive, idActive, leaveSkipped, itemRows, allIssues, allDetails, wsRows };
  }

  function renderModule(root) {
    const agg = getAggregatedView();
    const activeSingleWs = state.workshopFilter !== 'ALL'
      ? state.workshops.find(w => w.fileName === state.workshopFilter)
      : null;
    const canSwitchSheet = activeSingleWs &&
      Array.isArray(activeSingleWs.availableSheets) &&
      activeSingleWs.availableSheets.length > 1 &&
      sessionWorkbooks.has(activeSingleWs.fileName);

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>🦺 劳保物资汇总 & 中/印双花名册核对（工号特征直扫免模板 · 跳过休假/红底 · 自动剔除纸巾）</span>
          <span class="pill pill-blue">已载入 ${state.workshops.length} 个车间劳保表</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">未休假在岗人数 (中方/印方)</div><div class="kpi-val">${agg.activePeople} (${agg.cnActive}/${agg.idActive})</div></div>
          <div class="kpi-card"><div class="kpi-label">已跳过休假人数（含红底标休）</div><div class="kpi-val">${agg.leaveSkipped}</div></div>
          <div class="kpi-card ${agg.allIssues.length ? 'red' : 'green'}"><div class="kpi-label">未休假问题人员数</div><div class="kpi-val">${agg.allIssues.length}</div></div>
          <div class="kpi-card green"><div class="kpi-label">纯劳保物资种类</div><div class="kpi-val">${agg.itemRows.length}</div></div>
        </div>

        <div class="toolbar">
          <button class="btn" id="l-up-cn">📚 1. 导入中方人员名单 (.xlsx)</button>
          <input type="file" id="l-in-cn" accept=".xlsx,.xls" class="hidden-input" />
          <span class="pill ${state.cnRosterCount ? 'pill-green' : 'pill-orange'}">
            ${state.cnRosterCount ? `中方已载入：${state.cnRosterCount} 人` : '未导入中方名单'}
          </span>
          <button class="btn" id="l-up-id">📚 2. 导入印方人员名单 (.xlsx)</button>
          <input type="file" id="l-in-id" accept=".xlsx,.xls" class="hidden-input" />
          <span class="pill ${state.idRosterCount ? 'pill-green' : 'pill-orange'}">
            ${state.idRosterCount ? `印方已载入：HJF ${state.idRosterHjfCount} / OST ${state.idRosterOstCount}` : '未导入印方名单'}
          </span>
        </div>

        <div class="toolbar">
          <button class="btn btn-primary" id="l-up-ws">📂 3. 批量导入车间劳保表 (可一次多选/多拖)</button>
          <input type="file" id="l-in-ws" accept=".xlsx,.xls,.csv" multiple class="hidden-input" />
          ${state.workshops.length > 0 ? `
            <select id="l-ws-filter">
              <option value="ALL" ${state.workshopFilter === 'ALL' ? 'selected' : ''}>全部已导入车间汇总 (${state.workshops.length} 份)</option>
              ${state.workshops.map(w => `<option value="${U.escHtml(w.fileName)}" ${w.fileName === state.workshopFilter ? 'selected' : ''}>单看：${U.escHtml(w.fileName)}</option>`).join('')}
            </select>
            ${canSwitchSheet ? `
              <select id="l-sheet-switch" title="手动切换该文件读取的工作表">
                <option value="">自动识别 (${U.escHtml(activeSingleWs.sheetName)})</option>
                ${activeSingleWs.availableSheets.map(sn => `<option value="${U.escHtml(sn)}" ${sn === activeSingleWs.sheetName ? 'selected' : ''}>切至工作表：${U.escHtml(sn)}</option>`).join('')}
              </select>
            ` : ''}
            <button class="btn btn-danger" id="l-clear-ws">🗑️ 清空车间表</button>
          ` : ''}
          <span style="flex:1"></span>
          <button class="btn btn-success" id="l-exp" ${!state.workshops.length ? 'disabled' : ''}>💾 导出汇总+问题人员 (.xlsx)</button>
        </div>

        <div class="toolbar" style="margin-bottom:0;">
          <button class="btn ${state.viewMode === 'items' ? 'btn-primary' : ''}" id="l-v-items">📊 纯劳保物资汇总</button>
          <button class="btn ${state.viewMode === 'issues' ? 'btn-primary' : ''}" id="l-v-issues">⚠️ 问题人员核对 (${agg.allIssues.length})</button>
          <button class="btn ${state.viewMode === 'workshops' ? 'btn-primary' : ''}" id="l-v-ws">🏭 已导入车间清单 (${state.workshops.length})</button>
          <button class="btn ${state.viewMode === 'detail' ? 'btn-primary' : ''}" id="l-v-detail">📑 未休假发放明细</button>
        </div>
      </div>

      <div class="panel">
        ${state.workshops.length > 0 && (!state.cnRosterCount || !state.idRosterCount) ? `
          <div style="background:#fffbeb;border:1px solid #f59e0b;color:#92400e;border-radius:8px;padding:9px 12px;margin-bottom:10px;font-size:12.5px;">
            ⚠️ 尚未导入${!state.cnRosterCount && !state.idRosterCount ? '【中方人员名单】与【印方人员名单】' : (!state.cnRosterCount ? '【中方人员名单】' : '【印方人员名单】')}，未导入侧的问题人员无法核对！请先点上方按钮导入名单（导入后会自动重核已载入的 ${state.workshops.length} 份车间表）。
          </div>
        ` : ''}
        <div id="l-table-box"></div>
      </div>
    `;

    const inCn = root.querySelector('#l-in-cn');
    root.querySelector('#l-up-cn').onclick = () => inCn.click();
    inCn.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadCnRosterFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('中方名单导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    const inId = root.querySelector('#l-in-id');
    root.querySelector('#l-up-id').onclick = () => inId.click();
    inId.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadIdRosterFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('印方名单导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    const inWs = root.querySelector('#l-in-ws');
    root.querySelector('#l-up-ws').onclick = () => inWs.click();
    inWs.onchange = async e => {
      if (e.target.files && e.target.files.length) {
        await loadWorkshopFiles(e.target.files);
        renderModule(root);
      }
      e.target.value = '';
    };

    const selWs = root.querySelector('#l-ws-filter');
    if (selWs) {
      selWs.onchange = e => { state.workshopFilter = e.target.value; state.page = 1; renderModule(root); };
    }
    const selSheet = root.querySelector('#l-sheet-switch');
    if (selSheet && activeSingleWs) {
      selSheet.onchange = e => {
        const chosen = e.target.value;
        const parsed = sessionWorkbooks.get(activeSingleWs.fileName);
        if (!parsed) return;
        try {
          const updated = buildWorkshopFromParsed(parsed, chosen);
          const idx = state.workshops.findIndex(w => w.fileName === activeSingleWs.fileName);
          if (idx >= 0) state.workshops[idx] = updated;
          persistState();
          renderModule(root);
          U.toast(`已切换 [${activeSingleWs.fileName}] 工作表为：${updated.sheetName}`, 'success');
        } catch (err) {
          U.toast(err.message, 'warn');
          renderModule(root);
        }
      };
    }

    const btnClear = root.querySelector('#l-clear-ws');
    if (btnClear) {
      btnClear.onclick = () => {
        state.workshops = [];
        state.workshopFilter = 'ALL';
        state.page = 1;
        sessionWorkbooks.clear();
        persistState();
        renderModule(root);
        U.toast('已清空已导入的车间劳保表（中/印人员名单保留）', 'info');
      };
    }

    root.querySelector('#l-v-items').onclick = () => { state.viewMode = 'items'; state.page = 1; renderModule(root); };
    root.querySelector('#l-v-issues').onclick = () => { state.viewMode = 'issues'; state.page = 1; renderModule(root); };
    root.querySelector('#l-v-ws').onclick = () => { state.viewMode = 'workshops'; state.page = 1; renderModule(root); };
    root.querySelector('#l-v-detail').onclick = () => { state.viewMode = 'detail'; state.page = 1; renderModule(root); };

    root.querySelector('#l-exp').onclick = () => {
      const sheets = [
        { name: '纯劳保物资汇总', headers: ['纯劳保物资名称（已剔除纸巾）', '未休假申领总数', '申领人数'], rows: agg.itemRows, numCols: [1, 2] },
        { name: '各车间汇总对比', headers: ['来源文件', '工作表', '识别公司', '未休假人数', '中方/印方', '跳过休假人数', '问题人数'], rows: agg.wsRows, numCols: [3, 5, 6] }
      ];
      if (agg.allIssues.length) {
        sheets.push({ name: '问题人员核对清单', headers: ['来源车间表', '序号', '岗位/部门', '姓名', 'ID卡号', '中/印方', '问题类型', '核对说明'], rows: agg.allIssues, textCols: [4] });
      }
      U.exportWorkbook(sheets, `纯劳保批量核对与汇总.xlsx`);
      U.toast('已导出：纯劳保批量核对与汇总.xlsx', 'success');
    };

    const box = root.querySelector('#l-table-box');
    if (state.viewMode === 'issues') {
      U.renderPagedTable(box, {
        headers: ['来源车间表', '序号', '岗位/部门', '姓名', 'ID卡号', '中/印方', '问题类型', '核对说明'],
        rows: agg.allIssues,
        page: state.page,
        pageSize: 100,
        rowClassFn: r => (r[6].includes('离职') || r[6].includes('串公司')) ? 'row-err' : 'row-warn',
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else if (state.viewMode === 'workshops') {
      U.renderPagedTable(box, {
        headers: ['来源车间表', '读取工作表', '归属公司', '未休假人数', '中方 / 印方', '跳过休假人数', '问题人数'],
        rows: agg.wsRows,
        page: state.page,
        pageSize: 100,
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else if (state.viewMode === 'detail') {
      U.renderPagedTable(box, {
        headers: ['来源车间表', '岗位/部门', '姓名', '纯劳保物资', '申领数量'],
        rows: agg.allDetails,
        page: state.page,
        pageSize: 100,
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else {
      U.renderPagedTable(box, {
        headers: ['纯劳保物资名称（已剔除纸巾）', '未休假申领总数', '申领人数'],
        rows: agg.itemRows,
        page: state.page,
        pageSize: 100,
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    }
  }

  WB.register({
    id: 'mod_laobao',
    icon: '🦺',
    title: '劳保发放统计',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      const wsFiles = [];
      for (const f of files) {
        if (/ID卡信息|中方人员|中方名单/i.test(f.name)) {
          await loadCnRosterFile(f);
        } else if (/印方|花名册|manpower/i.test(f.name) && !/劳保/.test(f.name)) {
          await loadIdRosterFile(f);
        } else {
          wsFiles.push(f);
        }
      }
      if (wsFiles.length) await loadWorkshopFiles(wsFiles);
      if (this._root) renderModule(this._root);
    }
  });
})();
