/**
 * 模块 5：劳保物资发放统计 & 中/印双花名册批量交叉核对（实验隔离版 · 纯劳保口径）
 * 核心铁律：
 * 1. 支持分别导入【中方人员名单】与【印方人员名单】，双库联合核对。
 * 2. 支持一次批量多选/多拖导入多份车间劳保申请表（串行稳妥解析，零状态冲突），支持单车间查看与全车间汇总。
 * 3. 休假人员不用管（直接跳过不核对），仅处理未休假的实际申领人员。
 * 4. 纯劳保口径：自动剔除全部纸巾类（纸巾/抽纸/卷纸/卫生纸/面巾纸/擦手纸/餐巾纸）。
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const EXCLUDE_NON_LAOBAO = ['纸巾', '抽纸', '卷纸', '卫生纸', '面巾纸', '擦手纸', '餐巾纸'];
  const META_COL_RE = /^(序号|no\.?|岗位分类|岗位名称|岗位|部门|车间|公司|姓名|领用人|人员|id卡号|id|工号|nik|状态|是否休假|休假|备注|说明|正确id|照片)$/i;

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
    workshops: [],           // [{ fileName, sheetName, expectedCompany, activePeople, cnActive, idActive, leaveSkipped, itemMap, issues, details }]
    workshopFilter: 'ALL',   // 'ALL' | fileName
    page: 1
  };

  function persistState() {
    // 仅持久化轻量统计结果与元信息，避免大花名册超浏览器存储上限
    WB.Store.save('mod_laobao', {
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
    if (saved) {
      state.viewMode = saved.viewMode || 'items';
      state.cnRosterCount = saved.cnRosterCount || 0;
      state.cnRosterFileName = saved.cnRosterFileName || '';
      state.idRosterCount = saved.idRosterCount || 0;
      state.idRosterHjfCount = saved.idRosterHjfCount || 0;
      state.idRosterOstCount = saved.idRosterOstCount || 0;
      state.idRosterFileName = saved.idRosterFileName || '';
      state.workshops = Array.isArray(saved.workshops) ? saved.workshops : [];
      state.workshopFilter = saved.workshopFilter || 'ALL';
    }
  }

  function normId(val) {
    return U.cleanStr(val).replace(/[\s\r\n]+/g, '').toUpperCase();
  }

  function isChineseName(name) {
    return /[\u4e00-\u9fa5]/.test(String(name || ''));
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
    persistState();
    U.toast(`中方人员名单载入成功：共 ${count} 人索引`, 'success');
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
    persistState();
    U.toast(`印方人员名单载入成功：HJF ${hjfCnt} 人 / OST ${ostCnt} 人（共 ${total} 人索引）`, 'success');
  }

  /** 解析单份车间劳保申请表（不修改全局状态，保证批量连算零冲突） */
  async function parseSingleWorkshopFile(file) {
    const parsed = await U.readSpreadsheet(file);
    let targetSn = parsed.sheetNames[0];
    let bestScore = -1;
    let bestHdrIdx = 0;

    for (const sn of parsed.sheetNames) {
      if (/^(Sheet\d+|纸巾领用|无ID信息|问题人员名单|车间物资明细)$/i.test(sn)) continue;
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) continue;
      for (let i = 0; i < Math.min(8, aoa.length); i++) {
        const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
        let score = 0;
        if (/姓名|领用人/.test(line)) score += 4;
        if (/ID卡号|工号|NIK/i.test(line)) score += 4;
        if (/休假|状态/.test(line)) score += 2;
        if (/手套|口罩|过滤棉|劳保|安全帽/.test(line)) score += 3;
        if (/名单|明细/.test(sn)) score += 3;
        if (score > bestScore && aoa.length > 5) {
          bestScore = score;
          targetSn = sn;
          bestHdrIdx = i;
        }
      }
    }

    const aoa = parsed.sheets[targetSn] || [];
    if (aoa.length < 2) throw new Error(`[${file.name}] 无有效数据`);

    const rawH = aoa[bestHdrIdx].map(v => U.cleanStr(v).replace(/\s+/g, ' '));
    let lastCol = rawH.length - 1;
    while (lastCol >= 0 && !rawH[lastCol]) lastCol--;
    const h = rawH.slice(0, lastCol + 1);

    const iSeq = h.findIndex(x => /^序号|no\.?$/i.test(x));
    const iDept = h.findIndex(x => /岗位分类|部门|车间/.test(x));
    const iRole = h.findIndex(x => /岗位名称|岗位/.test(x) && !/分类/.test(x));
    const iName = h.findIndex(x => /姓名|领用人|人员/.test(x));
    const iId = h.findIndex(x => /ID卡号|工号|NIK|^ID$/i.test(x));
    const iLeave = h.findIndex(x => /休假|状态/.test(x));
    const iRem = h.findIndex(x => /备注|说明/.test(x));

    const ppeCols = [];
    let excludedTissueCols = 0;
    h.forEach((colName, idx) => {
      if (!colName) return;
      if ([iSeq, iDept, iRole, iName, iId, iLeave, iRem].includes(idx)) return;
      if (META_COL_RE.test(colName.replace(/（.*?）|\(.*?\)/g, '').trim())) return;
      if (isTissueName(colName)) {
        excludedTissueCols++;
        return;
      }
      ppeCols.push({ idx, name: colName.replace(/\n+/g, '') });
    });

    const isMatrix = ppeCols.length >= 2 && iName >= 0;
    const expectedCompany = detectCompanyFromText(`${file.name} ${targetSn}`, 'HJF');
    const hasCnRoster = Object.keys(state.cnById).length > 0;
    const hasIdRoster = Object.keys(state.idByNik).length > 0;

    const itemMap = {};      // itemName -> { qty, people }
    const issues = [];       // [来源表, 序号, 岗位/部门, 姓名, ID卡号, 中/印方, 问题类型, 花名册核对说明]
    const details = [];      // [来源表, 岗位/部门, 姓名, 纯劳保物资, 数量]
    let activePeople = 0;
    let cnActive = 0;
    let idActive = 0;
    let leaveSkipped = 0;

    if (isMatrix) {
      for (let i = bestHdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
        const idRaw = iId >= 0 ? normId(r[iId]) : '';
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : (iRole >= 0 ? U.cleanStr(r[iRole]) : '未分部门');
        if (!name && !idRaw) continue;
        if (/^(合计|总计|小计)$/.test(name) || /^(合计|总计|小计)$/.test(dept)) continue;

        // 铁律：休假人员不用管，直接跳过，仅处理未休假人员
        const leaveRaw = iLeave >= 0 ? U.cleanStr(r[iLeave]) : '';
        const isLeave = /^(是|休假|请假|离职|yes|y)$/i.test(leaveRaw);
        if (isLeave) {
          leaveSkipped++;
          continue;
        }

        activePeople++;
        const isCn = isChineseName(name);
        if (isCn) cnActive++;
        else idActive++;

        const seq = iSeq >= 0 ? U.cleanStr(r[iSeq]) : String(activePeople);
        const rem = iRem >= 0 ? U.cleanStr(r[iRem]) : '';

        // 汇总纯劳保物资（仅未休假）
        ppeCols.forEach(col => {
          const qty = U.parseNum(r[col.idx]);
          if (!itemMap[col.name]) itemMap[col.name] = { qty: 0, people: 0 };
          if (qty > 0) {
            itemMap[col.name].qty += qty;
            itemMap[col.name].people += 1;
            details.push([file.name, dept, name, col.name, qty]);
          }
        });

        // 中/印双花名册交叉核对（仅未休假人员）
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
                const nameHits = state.cnByName[name] || [];
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

        if (issueType) {
          issues.push([file.name, seq, dept, name, idRaw, isCn ? '中方' : '印方', issueType, issueDesc]);
        }
      }
    } else {
      // 兼容传统竖表明细格式
      const iItem = h.findIndex(x => /物资|名称|品名|劳保/.test(x) && !/部门|岗位|公司/.test(x));
      const iQty = h.findIndex(x => /数量|实发|发放/.test(x));
      for (let i = bestHdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '未分部门';
        const person = iName >= 0 ? U.cleanStr(r[iName]) : '';
        const item = iItem >= 0 ? U.cleanStr(r[iItem]) : '';
        const qty = iQty >= 0 ? U.parseNum(r[iQty]) : 1;
        const leaveRaw = iLeave >= 0 ? U.cleanStr(r[iLeave]) : '';
        if (!person && !item) continue;
        if (/^(合计|总计|小计)$/.test(dept) || /^(合计|总计|小计)$/.test(person)) continue;
        if (/^(是|休假|请假|离职|yes|y)$/i.test(leaveRaw)) { leaveSkipped++; continue; }
        if (isTissueName(item)) { excludedTissueCols++; continue; }
        activePeople++;
        const k = item || '劳保物资';
        if (!itemMap[k]) itemMap[k] = { qty: 0, people: 0 };
        itemMap[k].qty += qty;
        itemMap[k].people += 1;
        details.push([file.name, dept, person, k, qty]);
      }
    }

    return {
      fileName: file.name,
      sheetName: targetSn,
      expectedCompany,
      activePeople,
      cnActive,
      idActive,
      leaveSkipped,
      excludedTissueCols,
      itemMap,
      issues,
      details
    };
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
        // 同名文件覆盖更新，不同车间文件累加保存
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

    const itemRows = Array.from(itemTotals.entries()).map(([name, info]) => [name, U.fmtNum(info.qty), info.people]);
    const wsRows = state.workshops.map(w => [
      w.fileName,
      w.sheetName,
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
          <span>🦺 劳保物资批量汇总 & 中/印双花名册核对（仅处理未休假人员 · 自动剔除纸巾类）</span>
          <span class="pill pill-blue">已载入 ${state.workshops.length} 个车间劳保表</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">未休假在岗人数 (中方/印方)</div><div class="kpi-val">${agg.activePeople} (${agg.cnActive}/${agg.idActive})</div></div>
          <div class="kpi-card"><div class="kpi-label">已跳过休假人数（不处理）</div><div class="kpi-val">${agg.leaveSkipped}</div></div>
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
