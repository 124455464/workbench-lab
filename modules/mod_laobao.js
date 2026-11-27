/**
 * 模块 5：劳保物资发放统计 & 中/印双花名册批量交叉核对（实验隔离版 · 纯劳保口径）
 * 核心铁律：
 * 1. 支持分别导入【中方人员名单】与【印方人员名单】，双库真实持久化到本机 IndexedDB（刷新不丢、绝不假绿灯），导入/更新名单后自动重核已导入车间。
 * 2. 支持一次批量多选/多拖导入多份车间劳保申请表：
 *    - 标准宽表矩阵（如《HJF电厂》）
 *    - 单表 Sheet1 + 上申报单/下人员名单（如《维修科》《HJF码头》）
 *    - 同表并排双栏/多栏花名册（左栏印方 No/NIK/Nama + 右栏中方 No/NIK/Nama/Jabatan，自动从上方申报单提取纯劳保汇总，绝不丢任何一栏！）
 *    - 两行合并表头与小车间表
 * 3. 休假人员不用管（自动跳过文字“是/休假/休息/Cuti/请假/离职”以及“红色底纹标休假”人员），仅处理未休假的实际申领人员。
 * 4. 纯劳保口径：自动剔除全部纸巾类（纸巾/抽纸/卷纸/卫生纸/面巾纸/擦手纸/餐巾纸）。
 */
(function () {
  'use strict';
  const U = WB.Utils;
  const SCHEMA_VER = 4;
  const ROSTER_IDB_NAME = 'WB_LaoBao_Rosters_v1';
  const ROSTER_IDB_KEY = 'rosters_v1';

  const EXCLUDE_NON_LAOBAO = ['纸巾', '抽纸', '卷纸', '卫生纸', '面巾纸', '擦手纸', '餐巾纸'];
  const META_COL_RE = /^(序号|no\.?|编号|岗位分类|岗位名称|岗位|职位|工种|jabatan|posisi|position|部门|departemen|department|bagian|divisi|车间|班组|单位|公司|姓名|中文名|印方姓名|领用人|领料人|人员|员工|name|nama|id卡号|id号|卡号|工号|id|nik|状态|是否休假|休假|请假|在岗|在职|status|备注|说明|keterangan|ket|正确id|照片|签字|签名|领用签字|领取签字|日期|时间|合计|总计|小计)$/i;
  const GENERIC_GROUP_RE = /^(劳保物资|劳保用品|领用物资|劳保明细|申领物资|发放物资|物资名称|物品)$/i;
  const PPE_HINT_RE = /手套|口罩|过滤棉|滤棉|滤盒|滤毒|劳保|安全帽|耳塞|耳罩|安全鞋|劳保鞋|胶鞋|雨鞋|水鞋|眼镜|护目镜|面罩|面屏|围裙|套袖|袖套|工作服|防护服|雨衣|反光|毛巾|肥皂|香皂|洗衣粉|鞋垫|袜|防尘|防毒|焊|电工|耐酸|耐油|帆布|尼龙|线手套|浸胶|丁腈|乳胶/i;

  let state = {
    viewMode: 'items',       // 'items' | 'issues' | 'workshops' | 'detail'
    // 中方人员花名册（人员ID卡信息表）
    cnRosterCount: 0,
    cnRosterFileName: '',
    cnById: {},              // idUpper -> { company, name, dept, workshop, role, id, leftDate }
    cnByName: {},            // name -> [{ ... }]
    // 印方人员花名册（印方人员名单）
    idRosterCount: 0,
    idRosterHjfCount: 0,
    idRosterOstCount: 0,
    idRosterFileName: '',
    idByNik: {},             // nikUpper -> { company, name, status, dept, nik }
    // 批量导入的各车间劳保表（按 fileName 去重存储，支持多表连算）
    workshops: [],           // [{ fileName, sheetName, expectedCompany, activePeople, cnActive, idActive, leaveSkipped, itemMap, people, issues, details }]
    workshopFilter: 'ALL',   // 'ALL' | fileName
    page: 1
  };

  /** 本地 IndexedDB 真实持久化花名册索引（不占 Gist 体积，刷新后 100% 恢复可核对） */
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
    if (saved && saved.schemaVer === SCHEMA_VER) {
      state.viewMode = saved.viewMode || 'items';
      state.workshops = Array.isArray(saved.workshops) ? saved.workshops : [];
      state.workshopFilter = saved.workshopFilter || 'ALL';
    } else {
      state.workshops = [];
      state.workshopFilter = 'ALL';
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

  function normId(val) {
    return U.cleanStr(val).replace(/[\s\r\n]+/g, '').toUpperCase();
  }

  function isChineseName(name) {
    return /[\u4e00-\u9fa5]/.test(String(name || ''));
  }

  function extractPureChineseName(name) {
    const m = String(name || '').match(/[\u4e00-\u9fa5]+/g);
    return m ? m.join('') : '';
  }

  function isTissueName(text) {
    const s = String(text || '');
    return EXCLUDE_NON_LAOBAO.some(k => s.includes(k));
  }

  function detectCompanyFromText(text, fallback = '') {
    const s = String(text || '').toUpperCase();
    if (/OST|OBI\s*SINAR\s*TIMUR|电厂[（(]O/.test(s)) return 'OST';
    if (/HJF|HALMAHERA|电厂[（(]H/.test(s)) return 'HJF';
    const m = s.match(/\b(KPS|CKM|BJL|HJS|ONC|HPL|DPL)\b/) || s.match(/^(KPS|CKM|BJL|HJS|ONC|HPL|DPL)/);
    if (m) return m[1];
    return fallback;
  }

  /** 检测单元格是否填充了红色背景（用于识别车间表“红色为休假”标记，绝不误判黄/绿/蓝/白） */
  function isRedFillCell(ws, r, c) {
    if (!ws || r < 0 || c < 0 || typeof XLSX === 'undefined' || !XLSX.utils || !XLSX.utils.encode_cell) return false;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell || !cell.s) return false;
    const s = cell.s;
    if (s.patternType === 'none') return false;
    const rgbRaw = (s.fgColor && s.fgColor.rgb) || (s.bgColor && s.bgColor.rgb) || '';
    const hex = String(rgbRaw).replace(/^#/, '').toUpperCase();
    const rgb6 = hex.length === 8 ? hex.slice(2) : (hex.length === 6 ? hex : '');
    if (!/^[0-9A-F]{6}$/.test(rgb6)) return false;
    const R = parseInt(rgb6.slice(0, 2), 16);
    const G = parseInt(rgb6.slice(2, 4), 16);
    const B = parseInt(rgb6.slice(4, 6), 16);
    return R >= 170 && G <= 95 && B <= 95 && (R - G) >= 90 && (R - B) >= 90;
  }

  /** 对单个未休假人员执行中/印双花名册交叉核对 */
  function auditSinglePerson(p, fileName, expectedCompany) {
    const hasCnRoster = Object.keys(state.cnById).length > 0 || Object.keys(state.cnByName).length > 0;
    const hasIdRoster = Object.keys(state.idByNik).length > 0;
    const { seq, dept, name, idRaw, rem } = p;
    const isCn = isChineseName(name);

    let issueType = '';
    let issueDesc = '';
    if (!idRaw) {
      issueType = '缺失ID卡号';
      issueDesc = rem || '未填写ID卡号/工号';
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
          // 兜底：部分印方翻译姓名带中文译名（如 Carina...马福佳），顺手核查印方花名册
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
            // 兼容「张羊羊 zhang yang yang」中英双语格式，剥离拼音匹配中方花名册
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
              issueType = '中方名单查无此人';
              issueDesc = '在中方人员ID卡信息表中未查到该ID与姓名';
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
          issueType = '印方名单查无此ID';
          issueDesc = '在 MP HJF / MP OST 中均未匹配到该 NIK（可能离职/工号错误）';
        }
      }
    }

    if (!issueType) return null;
    return [fileName, seq, dept, name, idRaw, isCn ? '中方' : '印方', issueType, issueDesc];
  }

  /** 当导入/更新中或印方花名册时，自动对所有已载入车间重新核对问题人员 */
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

  /** 1. 导入中方人员名单（如 人员ID卡信息表7.10(1).xlsx） */
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

  /** 2. 导入印方人员名单（如 印方人员名单_11.16_(1).xlsx） */
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

  /**
   * 扫描同一表头行中的所有并排人员栏位组（支持单栏，也支持左印方 No|NIK|Nama + 右中方 No|NIK|Nama|Jabatan 并排双栏/多栏）
   */
  function findPersonColumnGroups(h) {
    const nameCols = [];
    h.forEach((col, idx) => {
      if (/姓名|^Name$|^Nama$/i.test(col)) nameCols.push(idx);
    });
    if (nameCols.length === 0) {
      const fb = h.findIndex(x => /领用人|领料人|员工名/.test(x));
      if (fb >= 0) nameCols.push(fb);
    }
    if (nameCols.length === 0) return [];

    // 单栏标准表
    if (nameCols.length === 1) {
      const iName = nameCols[0];
      return [{
        iSeq: h.findIndex(x => /^序号|^no\.?$/i.test(x)),
        iDept: h.findIndex(x => /岗位分类|部门|车间|班组|departemen|department/i.test(x)),
        iRole: h.findIndex(x => /岗位名称|岗位|工种|职位|jabatan|posisi|position/i.test(x) && !/分类/.test(x)),
        iName,
        iId: h.findIndex(x => /ID卡号|ID号|卡号|工号|^NIK$|^ID$/i.test(x)),
        iLeave: h.findIndex(x => /休假|状态|请假|在岗|^status$/i.test(x)),
        iRem: h.findIndex(x => /备注|说明|keterangan/i.test(x))
      }];
    }

    // 多栏并排人员表：按每个「姓名/Nama」列拆出独立水平区间，不丢任何一栏！
    const groups = [];
    for (let g = 0; g < nameCols.length; g++) {
      const nc = nameCols[g];
      // 计算当前栏的左右边界：左界为上一栏姓名列后方（优先从本栏最近的 No/序号/NIK 起点起），右界到下一栏起始前
      let leftBound = g === 0 ? 0 : nameCols[g - 1] + 1;
      let rightBound = g === nameCols.length - 1 ? h.length - 1 : nameCols[g + 1] - 1;

      // 若下一栏左侧紧挨着 No/NIK，收紧本栏右界避免把下一栏的 No/NIK 算进本栏
      if (g < nameCols.length - 1) {
        const nextNc = nameCols[g + 1];
        for (let k = nextNc - 1; k > nc; k--) {
          if (/^序号|^no\.?$|ID卡号|ID号|卡号|工号|^NIK$|^ID$/i.test(h[k])) {
            rightBound = Math.min(rightBound, k - 1);
          } else if (h[k] === '') {
            rightBound = Math.min(rightBound, k - 1);
            break;
          } else {
            break;
          }
        }
      }
      // 同样收紧本栏左界到本栏之前最近的空列之后（如果有空列分隔左右两栏）
      if (g > 0) {
        for (let k = nc - 1; k >= leftBound; k--) {
          if (h[k] === '' && !/^序号|^no\.?$|ID卡号|ID号|卡号|工号|^NIK$|^ID$/i.test(h[k])) {
            leftBound = k + 1;
            break;
          }
        }
      }

      const findInRange = (re, exclRe) => {
        for (let k = leftBound; k <= rightBound; k++) {
          if (re.test(h[k]) && (!exclRe || !exclRe.test(h[k]))) return k;
        }
        return -1;
      };

      groups.push({
        iSeq: findInRange(/^序号|^no\.?$/i),
        iDept: findInRange(/岗位分类|部门|车间|班组|departemen|department/i),
        iRole: findInRange(/岗位名称|岗位|工种|职位|jabatan|posisi|position/i, /分类/),
        iName: nc,
        iId: findInRange(/ID卡号|ID号|卡号|工号|^NIK$|^ID$/i),
        iLeave: findInRange(/休假|状态|请假|在岗|^status$/i),
        iRem: findInRange(/备注|说明|keterangan/i)
      });
    }
    return groups;
  }

  /** 从同表上半部的「通用物资领料申报单」汇总区提取纯劳保物资汇总（用于下半部纯人员花名册无逐人物资列的场景） */
  function extractTopRequisitionItems(aoa, beforeRowIdx) {
    const items = {};
    let excludedTissue = 0;
    let sumHdrIdx = -1;
    let iSumName = -1;
    let iSumQty = -1;

    for (let i = 0; i < Math.min(beforeRowIdx, aoa.length); i++) {
      const row = aoa[i].map(v => U.cleanStr(v));
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
      const r = aoa[i];
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

  /** 解析单份车间劳保申请表中的单个工作表 */
  function parseWorkshopSheet(aoa, rawWs, sn, fileName, bestHdrIdx) {
    const wsRange = rawWs && rawWs['!ref'] ? XLSX.utils.decode_range(rawWs['!ref']) : { s: { r: 0, c: 0 } };

    // 合并可能存在的「两行合并表头」（如主表头写“劳保物资”，下一行写“帆布手套 / 口罩 / 安全帽”）
    const mainH = aoa[bestHdrIdx].map(v => U.cleanStr(v).replace(/\s+/g, ' '));
    const subRow = aoa[bestHdrIdx + 1] ? aoa[bestHdrIdx + 1].map(v => U.cleanStr(v).replace(/\s+/g, ' ')) : [];
    const maxCols = Math.max(mainH.length, subRow.length);

    let iNameTmp = mainH.findIndex(x => /姓名|^Name$|^Nama$/i.test(x));
    if (iNameTmp < 0) iNameTmp = mainH.findIndex(x => /领用人|领料人|员工名/.test(x));
    let iIdTmp = mainH.findIndex(x => /ID卡号|ID号|卡号|工号|^NIK$|^ID$/i.test(x));

    let hasSubHeader = false;
    if (subRow.length > 0) {
      const nameCellSub = iNameTmp >= 0 ? (subRow[iNameTmp] || '') : '';
      const idCellSub = iIdTmp >= 0 ? (subRow[iIdTmp] || '') : '';
      const subPpeHits = subRow.filter(x => x && PPE_HINT_RE.test(x)).length;
      const subTextNonNum = subRow.filter((x, idx) => idx !== iNameTmp && idx !== iIdTmp && x && !/^\d+(\.\d+)?$/.test(x) && !/^(是|否|yes|no)$/i.test(x)).length;
      if (!nameCellSub && !idCellSub && (subPpeHits >= 1 || subTextNonNum >= 3)) {
        hasSubHeader = true;
      }
    }

    const h = [];
    for (let c = 0; c < maxCols; c++) {
      const m = mainH[c] || '';
      const s = hasSubHeader ? (subRow[c] || '') : '';
      if (hasSubHeader && s && (!m || GENERIC_GROUP_RE.test(m))) {
        h.push(s);
      } else if (hasSubHeader && s && m && !m.includes(s)) {
        h.push(`${m}${s}`);
      } else {
        h.push(m || s);
      }
    }
    while (h.length > 0 && !h[h.length - 1]) h.pop();

    const dataStartIdx = bestHdrIdx + (hasSubHeader ? 2 : 1);

    // 识别全部并排人员栏位组（单栏 or 左/右并排双栏/多栏）
    const personGroups = findPersonColumnGroups(h);
    const groupUsedCols = new Set();
    personGroups.forEach(g => {
      [g.iSeq, g.iDept, g.iRole, g.iName, g.iId, g.iLeave, g.iRem].forEach(c => {
        if (c >= 0) groupUsedCols.add(c);
      });
    });

    const ppeCols = [];
    let excludedTissueCols = 0;
    h.forEach((colName, idx) => {
      if (!colName) return;
      if (groupUsedCols.has(idx)) return;
      const stripped = colName.replace(/（.*?）|\(.*?\)/g, '').trim();
      if (!stripped || /^\d+$/.test(stripped)) return;
      if (META_COL_RE.test(stripped) || GENERIC_GROUP_RE.test(stripped)) return;
      if (isTissueName(colName)) {
        excludedTissueCols++;
        return;
      }
      ppeCols.push({ idx, name: colName.replace(/\n+/g, '') });
    });

    const expectedCompany = detectCompanyFromText(`${fileName} ${sn}`, 'HJF');
    const defaultDeptName = fileName.replace(/\.[^.]+$/, '');

    const itemMap = {};
    const people = [];
    const issues = [];
    const details = [];
    let activePeople = 0;
    let cnActive = 0;
    let idActive = 0;
    let leaveSkipped = 0;

    const isPersonRosterMode = personGroups.length >= 1 && (ppeCols.length >= 1 || personGroups.length >= 2 || bestHdrIdx >= 3);

    if (isPersonRosterMode) {
      for (let i = dataStartIdx; i < aoa.length; i++) {
        const r = aoa[i];
        const wsRowIdx = wsRange.s.r + i;

        for (let gIdx = 0; gIdx < personGroups.length; gIdx++) {
          const g = personGroups[gIdx];
          const name = g.iName >= 0 ? U.cleanStr(r[g.iName]) : '';
          const idRaw = g.iId >= 0 ? normId(r[g.iId]) : '';
          if (!name && !idRaw) continue;

          const dept = g.iDept >= 0 ? U.cleanStr(r[g.iDept]) : (g.iRole >= 0 ? U.cleanStr(r[g.iRole]) : defaultDeptName);
          if (/^(合计|总计|小计|汇总|人数|统计|制表|审核|审批|签字)/.test(name) || /^(合计|总计|小计|汇总)/.test(dept)) continue;
          if (/^(姓名|领用人|Name|Nama)$/i.test(name) || /^(NIK|ID|ID卡号|工号)$/i.test(idRaw)) continue;

          const leaveRaw = g.iLeave >= 0 ? U.cleanStr(r[g.iLeave]) : '';
          const textLeave = /^(是|yes|y)$/i.test(leaveRaw) || /休假|请假|休息|离职|回国|不在岗|cuti|resign/i.test(leaveRaw);
          const colorLeave = rawWs && (
            (g.iName >= 0 && isRedFillCell(rawWs, wsRowIdx, wsRange.s.c + g.iName)) ||
            (g.iId >= 0 && isRedFillCell(rawWs, wsRowIdx, wsRange.s.c + g.iId))
          );
          if (textLeave || colorLeave) {
            leaveSkipped++;
            continue;
          }

          activePeople++;
          const isCn = isChineseName(name);
          if (isCn) cnActive++;
          else idActive++;

          const seq = g.iSeq >= 0 && U.cleanStr(r[g.iSeq]) ? U.cleanStr(r[g.iSeq]) : String(activePeople);
          const rem = g.iRem >= 0 ? U.cleanStr(r[g.iRem]) : '';

          if (ppeCols.length > 0 && personGroups.length === 1) {
            ppeCols.forEach(col => {
              const qty = U.parseNum(r[col.idx]);
              if (!itemMap[col.name]) itemMap[col.name] = { qty: 0, people: 0 };
              if (qty > 0) {
                itemMap[col.name].qty += qty;
                itemMap[col.name].people += 1;
                details.push([fileName, dept, name, col.name, qty]);
              }
            });
          }

          const personRec = { seq, dept, name, idRaw, rem };
          people.push(personRec);
          const issueRow = auditSinglePerson(personRec, fileName, expectedCompany);
          if (issueRow) issues.push(issueRow);
        }
      }

      if (ppeCols.length === 0) {
        const topSum = extractTopRequisitionItems(aoa, bestHdrIdx);
        excludedTissueCols += topSum.excludedTissue;
        Object.entries(topSum.items).forEach(([k, v]) => {
          itemMap[k] = { qty: v.qty, people: activePeople };
        });
      }
    } else {
      const g0 = personGroups[0] || { iSeq: -1, iDept: -1, iName: -1, iId: -1, iLeave: -1, iRem: -1 };
      const iItem = h.findIndex((x, idx) => !groupUsedCols.has(idx) && /物资|品名|名称|劳保|用品/.test(x) && !/部门|岗位|公司|姓名/.test(x));
      const iQty = h.findIndex((x, idx) => !groupUsedCols.has(idx) && /数量|实发|发放|申领/.test(x));
      if (iItem < 0) return null;

      const seenPerson = new Set();
      for (let i = dataStartIdx; i < aoa.length; i++) {
        const r = aoa[i];
        const dept = g0.iDept >= 0 ? U.cleanStr(r[g0.iDept]) : defaultDeptName;
        const person = g0.iName >= 0 ? U.cleanStr(r[g0.iName]) : '';
        const idRaw = g0.iId >= 0 ? normId(r[g0.iId]) : '';
        const item = U.cleanStr(r[iItem]);
        const qty = iQty >= 0 ? U.parseNum(r[iQty]) : 1;
        const leaveRaw = g0.iLeave >= 0 ? U.cleanStr(r[g0.iLeave]) : '';
        if (!item || /^\d+$/.test(item) || GENERIC_GROUP_RE.test(item)) continue;
        if (/^(合计|总计|小计|汇总)/.test(dept) || /^(合计|总计|小计|汇总)/.test(person) || /^(合计|总计|小计|汇总)/.test(item)) continue;
        if (/^(是|yes|y)$/i.test(leaveRaw) || /休假|请假|休息|离职|cuti/i.test(leaveRaw)) { leaveSkipped++; continue; }
        if (isTissueName(item)) { excludedTissueCols++; continue; }
        if (qty <= 0) continue;

        if (!itemMap[item]) itemMap[item] = { qty: 0, people: 0 };
        itemMap[item].qty += qty;
        itemMap[item].people += 1;
        details.push([fileName, dept, person || '-', item, qty]);

        const pKey = `${person}||${idRaw}`;
        if (person && !seenPerson.has(pKey)) {
          seenPerson.add(pKey);
          activePeople++;
          if (isChineseName(person)) cnActive++;
          else idActive++;
          const seq = g0.iSeq >= 0 ? U.cleanStr(r[g0.iSeq]) : String(activePeople);
          const rem = g0.iRem >= 0 ? U.cleanStr(r[g0.iRem]) : '';
          const personRec = { seq, dept, name: person, idRaw, rem };
          people.push(personRec);
          const issueRow = auditSinglePerson(personRec, fileName, expectedCompany);
          if (issueRow) issues.push(issueRow);
        }
      }
    }

    if (activePeople === 0 && Object.keys(itemMap).length === 0) return null;
    return {
      sheetName: sn,
      expectedCompany,
      activePeople,
      cnActive,
      idActive,
      leaveSkipped,
      excludedTissueCols,
      groupCount: personGroups.length,
      itemMap,
      people,
      issues,
      details
    };
  }

  /** 解析单份车间劳保申请表（自动跳过全部纸巾/汇总辅助表；兼容单表、多工作表拆分、并排双栏、红底标休假） */
  async function parseSingleWorkshopFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const candidates = [];

    for (const sn of parsed.sheetNames) {
      const snTrim = sn.trim();
      // 铁律：彻底跳过任何纸巾类工作表与汇总/问题/无ID辅助表
      if (/纸巾|抽纸|卷纸|卫生纸/i.test(snTrim)) continue;
      if (/^(无ID信息.*|问题人员名单|车间物资明细|汇总|总汇总|统计)$/i.test(snTrim)) continue;

      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) continue;

      const isGenericSheet = /^Sheet\d+$/i.test(snTrim);
      let sheetBestScore = -999;
      let sheetBestHdr = 0;

      for (let i = 0; i < Math.min(35, aoa.length); i++) {
        const cells = aoa[i].map(v => U.cleanStr(v));
        const line = cells.join(' ');
        const nextLine = (aoa[i + 1] || []).map(v => U.cleanStr(v)).join(' ');
        const combined = `${line} ${nextLine}`;
        let score = 0;

        const isRequisitionBanner = (/存货编码|物资编码|物料编码|仓库名称/.test(line) && /规格型号|存货名称|领用数量/.test(line));
        if (isRequisitionBanner) score -= 25;

        const nameMatchCnt = cells.filter(c => /姓名|^Nama$|^Name$/i.test(c)).length;
        const idMatchCnt = cells.filter(c => /ID卡号|ID号|卡号|工号|^NIK$|^ID$/i.test(c)).length;
        if (nameMatchCnt > 0) score += 10 + Math.min(6, (nameMatchCnt - 1) * 4);
        else if (/领用人|领料人|员工名/.test(line)) score += 4;
        if (idMatchCnt > 0) score += 10 + Math.min(6, (idMatchCnt - 1) * 4);
        if (/休假|状态|请假|在岗/.test(line)) score += 4;
        if (PPE_HINT_RE.test(line)) score += 4;
        else if (PPE_HINT_RE.test(combined)) score += 2;
        if (/名单|明细|劳保/.test(snTrim)) score += 3;
        if (!isGenericSheet) score += 1;
        if (aoa.length > 5) score += 1;
        const nonEmptyCells = cells.filter(v => v !== '').length;
        if (nonEmptyCells < 2) score -= 10;

        if (score > sheetBestScore) {
          sheetBestScore = score;
          sheetBestHdr = i;
        }
      }

      if (sheetBestScore >= 6) {
        candidates.push({ sn, score: sheetBestScore, hdrIdx: sheetBestHdr });
      }
    }

    if (!candidates.length) {
      throw new Error(`[${file.name}] 未识别到标准劳保人员表头（缺少 姓名/Nama 与 工号/ID卡号/NIK 列），已自动跳过纸巾/汇总表`);
    }

    candidates.sort((a, b) => b.score - a.score);
    // 若同一文件内存在多个高分人员工作表（如同时含「中方」与「印方」两张表），全部合并解析，绝不漏表！
    const topScore = candidates[0].score;
    const selected = candidates.filter((c, idx) => idx === 0 || (c.score >= 16 && c.score >= topScore - 6));

    const merged = {
      fileName: file.name,
      sheetName: '',
      expectedCompany: detectCompanyFromText(file.name, 'HJF'),
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
    const usedSheets = [];

    for (const cand of selected) {
      const aoa = parsed.sheets[cand.sn] || [];
      const rawWs = parsed.wb && parsed.wb.Sheets ? parsed.wb.Sheets[cand.sn] : null;
      const part = parseWorkshopSheet(aoa, rawWs, cand.sn, file.name, cand.hdrIdx);
      if (!part) continue;
      usedSheets.push(cand.sn);
      merged.activePeople += part.activePeople;
      merged.cnActive += part.cnActive;
      merged.idActive += part.idActive;
      merged.leaveSkipped += part.leaveSkipped;
      merged.excludedTissueCols += part.excludedTissueCols;
      merged.groupCount = Math.max(merged.groupCount, part.groupCount);
      Object.entries(part.itemMap).forEach(([k, v]) => {
        if (!merged.itemMap[k]) merged.itemMap[k] = { qty: 0, people: 0 };
        merged.itemMap[k].qty += v.qty;
        merged.itemMap[k].people += v.people;
      });
      part.people.forEach(p => merged.people.push(p));
      part.issues.forEach(r => merged.issues.push(r));
      part.details.forEach(d => merged.details.push(d));
    }

    if (!usedSheets.length) {
      throw new Error(`[${file.name}] 未提取到有效未休假发放记录`);
    }
    merged.sheetName = usedSheets.join(' + ');
    return merged;
  }

  /** 3. 批量导入多份车间劳保申请表（串行连算，绝不并发冲突） */
  async function loadWorkshopFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let okCnt = 0;
    const errs = [];

    for (const f of files) {
      try {
        const res = await parseSingleWorkshopFile(f);
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

  /** 聚合当前筛选范围（全部车间 or 单个车间）的统计结果 */
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

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>🦺 劳保物资批量汇总 & 中/印双花名册核对（仅处理未休假人员 · 支持并排双栏与红底休假 · 自动剔除纸巾）</span>
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
    const btnClear = root.querySelector('#l-clear-ws');
    if (btnClear) {
      btnClear.onclick = () => {
        state.workshops = [];
        state.workshopFilter = 'ALL';
        state.page = 1;
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
