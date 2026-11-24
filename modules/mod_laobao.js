/**
 * 模块 5：劳保物资发放统计 & 人员名单交叉核对（实验隔离版：纯劳保口径，自动剔除全部纸巾类）
 * 支持：
 * 1. 导入印方人员花名册（如 印方人员名单.xlsx，自动索引 MP HJF / MP OST 的 NIK、旧NIK、姓名与在职状态）
 * 2. 导入车间劳保申请明细表（支持宽表矩阵如 HJF电厂劳保名单，以及传统竖表明细表）
 * 3. 自动剔除所有纸巾类（纸巾/抽纸/卷纸/卫生纸/面巾纸/擦手纸/餐巾纸），精准汇总各纯劳保物资数量
 * 4. 自动交叉核对问题人员（OST/HJF串公司、离职/非在职、印方查无ID、缺失ID卡号、休假人员）
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const EXCLUDE_NON_LAOBAO = ['纸巾', '抽纸', '卷纸', '卫生纸', '面巾纸', '擦手纸', '餐巾纸'];
  const META_COL_RE = /^(序号|no\.?|岗位分类|岗位名称|岗位|部门|车间|公司|姓名|领用人|人员|id卡号|id|工号|nik|状态|是否休假|休假|备注|说明|正确id|照片)$/i;

  let state = {
    viewMode: 'items',     // 'items' | 'issues' | 'detail'
    rosterCount: 0,
    rosterHjfCount: 0,
    rosterOstCount: 0,
    rosterFileName: '',
    rosterByNik: {},       // nikUpper -> { company: 'HJF'|'OST', name, status, dept, subDept }
    fileName: '',
    sheetName: '',
    isMatrix: false,
    expectedCompany: 'HJF', // 根据文件名/表名自动推断 HJF 或 OST
    stats: {
      totalPeople: 0,
      cnCount: 0,
      idCount: 0,
      leaveCount: 0,
      issueCount: 0,
      excludedTissueCols: 0
    },
    itemSummaryRows: [],   // [劳保物资名称, 全员申领总数, 剔除休假实发数, 涉及人数]
    issueRows: [],         // [序号, 岗位/部门, 姓名, ID卡号, 中/印方, 休假, 问题类型, 花名册核对说明]
    detailRows: [],        // [岗位/部门, 姓名, 物资名称, 数量, 状态]
    deptFilter: 'ALL',
    depts: [],
    page: 1
  };

  function persistState() {
    WB.Store.save('mod_laobao', {
      viewMode: state.viewMode,
      rosterCount: state.rosterCount,
      rosterHjfCount: state.rosterHjfCount,
      rosterOstCount: state.rosterOstCount,
      rosterFileName: state.rosterFileName,
      fileName: state.fileName,
      sheetName: state.sheetName,
      isMatrix: state.isMatrix,
      expectedCompany: state.expectedCompany,
      stats: state.stats,
      itemSummaryRows: state.itemSummaryRows,
      issueRows: state.issueRows,
      detailRows: state.detailRows,
      depts: state.depts
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_laobao');
    if (saved) {
      state.viewMode = saved.viewMode || 'items';
      state.rosterCount = saved.rosterCount || 0;
      state.rosterHjfCount = saved.rosterHjfCount || 0;
      state.rosterOstCount = saved.rosterOstCount || 0;
      state.rosterFileName = saved.rosterFileName || '';
      state.fileName = saved.fileName || '';
      state.sheetName = saved.sheetName || '';
      state.isMatrix = !!saved.isMatrix;
      state.expectedCompany = saved.expectedCompany || 'HJF';
      state.stats = saved.stats || state.stats;
      state.itemSummaryRows = saved.itemSummaryRows || [];
      state.issueRows = saved.issueRows || [];
      state.detailRows = saved.detailRows || [];
      state.depts = saved.depts || [];
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

  /** 导入印方人员花名册（如 印方人员名单_11.16.xlsx） */
  async function loadRosterFile(file) {
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
        const company = /OBI\s*SINAR\s*TIMUR|OST/i.test(compRaw) ? 'OST' : (/HALMAHERA|HJF/i.test(compRaw) ? 'HJF' : defaultComp);
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '';
        const rec = { company, name: nama, status, dept, nik };
        if (nik) byNik[nik] = rec;
        if (oldNik && !byNik[oldNik]) byNik[oldNik] = rec;
        if (company === 'OST') ostCnt++;
        else hjfCnt++;
      }
    });

    const total = hjfCnt + ostCnt;
    if (total === 0) throw new Error('未在表格中识别到 NIK / Nama 花名册列');
    state.rosterByNik = byNik;
    state.rosterHjfCount = hjfCnt;
    state.rosterOstCount = ostCnt;
    state.rosterCount = total;
    state.rosterFileName = file.name;
    persistState();
    U.toast(`花名册载入成功：HJF ${hjfCnt} 人 / OST ${ostCnt} 人（共 ${total} 条索引）`, 'success');
  }

  /** 导入车间劳保申请表（自动识别宽表矩阵 vs 传统竖表） */
  async function loadLaobaoFile(file) {
    const parsed = await U.readSpreadsheet(file);
    // 优先选择包含人员劳保明细的工作表（如 HJF电厂劳保名单）
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
    if (aoa.length < 2) throw new Error('表格无有效数据');

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

    // 检测是否为横向宽表矩阵（含多列纯劳保物品）
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
    const expectedCompany = /OST/i.test(`${file.name} ${targetSn}`) ? 'OST' : 'HJF';
    const hasRoster = Object.keys(state.rosterByNik).length > 0;

    if (isMatrix) {
      const itemAgg = ppeCols.map(c => ({ name: c.name, totalAll: 0, totalActive: 0, people: 0 }));
      const issueRows = [];
      const detailRows = [];
      const deptSet = new Set();
      let totalPeople = 0;
      let cnCount = 0;
      let idCount = 0;
      let leaveCount = 0;

      for (let i = bestHdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
        const idRaw = iId >= 0 ? normId(r[iId]) : '';
        const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : (iRole >= 0 ? U.cleanStr(r[iRole]) : '未分部门');
        if (!name && !idRaw) continue;
        if (/^(合计|总计|小计)$/.test(name) || /^(合计|总计|小计)$/.test(dept)) continue;

        totalPeople++;
        if (dept) deptSet.add(dept);
        const isCn = isChineseName(name);
        if (isCn) cnCount++;
        else idCount++;

        const leaveRaw = iLeave >= 0 ? U.cleanStr(r[iLeave]) : '';
        const isLeave = /^(是|休假|请假|离职|yes|y)$/i.test(leaveRaw);
        if (isLeave) leaveCount++;

        const seq = iSeq >= 0 ? U.cleanStr(r[iSeq]) : String(totalPeople);
        const rem = iRem >= 0 ? U.cleanStr(r[iRem]) : '';

        // 统计各纯劳保物资列
        ppeCols.forEach((col, cIdx) => {
          const qty = U.parseNum(r[col.idx]);
          if (qty > 0) {
            itemAgg[cIdx].totalAll += qty;
            if (!isLeave) itemAgg[cIdx].totalActive += qty;
            itemAgg[cIdx].people += 1;
            detailRows.push([dept, name, col.name, qty, isLeave ? '休假' : '正常']);
          }
        });

        // 人员交叉核对（配合印方人员名单）
        let issueType = '';
        let issueDesc = '';
        if (!idRaw) {
          issueType = '缺失ID卡号';
          issueDesc = rem || '未填写ID卡号/工号';
        } else if (hasRoster) {
          const hit = state.rosterByNik[idRaw];
          if (hit) {
            if (hit.company !== expectedCompany) {
              issueType = `串公司(${hit.company})`;
              issueDesc = `花名册归属 ${hit.company}（${hit.dept || '未知部门'}，状态:${hit.status}）`;
            } else if (hit.status && !/aktif|active|在职/i.test(hit.status)) {
              issueType = `非在职(${hit.status})`;
              issueDesc = `花名册状态为 ${hit.status}`;
            }
          } else if (!isCn) {
            issueType = '印方花名册无此ID';
            issueDesc = '在 MP HJF / MP OST 中均未匹配到该 NIK（可能离职/工号错误）';
          }
        }
        if (issueType) {
          issueRows.push([seq, dept, name, idRaw, isCn ? '中方' : '印方', isLeave ? '是' : '否', issueType, issueDesc]);
        }
      }

      state.isMatrix = true;
      state.fileName = file.name;
      state.sheetName = targetSn;
      state.expectedCompany = expectedCompany;
      state.stats = {
        totalPeople,
        cnCount,
        idCount,
        leaveCount,
        issueCount: issueRows.length,
        excludedTissueCols
      };
      state.itemSummaryRows = itemAgg.map(x => [x.name, U.fmtNum(x.totalAll), U.fmtNum(x.totalActive), x.people]);
      state.issueRows = issueRows;
      state.detailRows = detailRows;
      state.depts = Array.from(deptSet).sort();
      state.deptFilter = 'ALL';
      state.page = 1;
      persistState();
      U.toast(`劳保矩阵解析完成 [${targetSn}]：共 ${totalPeople} 人（中方 ${cnCount} / 印方 ${idCount} / 休假 ${leaveCount}），纯劳保 ${ppeCols.length} 项，问题人员 ${issueRows.length} 人`, 'success');
      return;
    }

    // 兼容传统竖表明细格式（部门 / 姓名 / 物资名称 / 数量 / 状态）
    const iItem = h.findIndex(x => /物资|名称|品名|劳保/.test(x) && !/部门|岗位|公司/.test(x));
    const iQty = h.findIndex(x => /数量|实发|发放/.test(x));
    const agg = new Map();
    const deptSet = new Set();
    const detailRows = [];
    let excluded = 0;

    for (let i = bestHdrIdx + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '未分部门';
      const person = iName >= 0 ? U.cleanStr(r[iName]) : '';
      const item = iItem >= 0 ? U.cleanStr(r[iItem]) : '';
      const qty = iQty >= 0 ? U.parseNum(r[iQty]) : 1;
      const status = iLeave >= 0 ? U.cleanStr(r[iLeave]) : (iRem >= 0 ? U.cleanStr(r[iRem]) : '');
      if (!person && !item) continue;
      if (/^(合计|总计|小计)$/.test(dept) || /^(合计|总计|小计)$/.test(person)) continue;
      if (isTissueName(item)) { excluded++; continue; }

      deptSet.add(dept);
      detailRows.push([dept, person, item || '劳保物资', qty, status]);
      const k = item || '劳保物资';
      if (!agg.has(k)) agg.set(k, { name: k, totalAll: 0, totalActive: 0, people: 0 });
      const o = agg.get(k);
      o.totalAll += qty;
      o.totalActive += qty;
      o.people += 1;
    }

    state.isMatrix = false;
    state.fileName = file.name;
    state.sheetName = targetSn;
    state.stats = {
      totalPeople: detailRows.length,
      cnCount: 0,
      idCount: 0,
      leaveCount: 0,
      issueCount: 0,
      excludedTissueCols: excluded
    };
    state.itemSummaryRows = Array.from(agg.values()).map(x => [x.name, U.fmtNum(x.totalAll), U.fmtNum(x.totalActive), x.people]);
    state.issueRows = [];
    state.detailRows = detailRows;
    state.depts = Array.from(deptSet).sort();
    state.deptFilter = 'ALL';
    state.page = 1;
    persistState();
    U.toast(`纯劳保筛选完成：保留 ${detailRows.length} 条记录（已自动剔除 ${excluded} 条纸巾非劳保）`, 'success');
  }

  function renderModule(root) {
    const st = state.stats;
    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>🦺 劳保物资发放统计 & 人员名单交叉核对（纯劳保口径 · 自动剔除全部纸巾类）</span>
          <span class="pill pill-blue">${state.fileName ? `${state.fileName} [${state.sheetName}]` : '待导入劳保明细表'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">名单总人数 (中方/印方)</div><div class="kpi-val">${st.totalPeople}${state.isMatrix ? ` (${st.cnCount}/${st.idCount})` : ''}</div></div>
          <div class="kpi-card orange"><div class="kpi-label">休假人数</div><div class="kpi-val">${st.leaveCount}</div></div>
          <div class="kpi-card ${st.issueCount ? 'red' : 'green'}"><div class="kpi-label">交叉核对问题人员</div><div class="kpi-val">${st.issueCount}</div></div>
          <div class="kpi-card green"><div class="kpi-label">纯劳保物资种类</div><div class="kpi-val">${state.itemSummaryRows.length}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn" id="l-up-roster">📚 1. 导入印方人员花名册 (.xlsx)</button>
          <input type="file" id="l-in-roster" accept=".xlsx,.xls" class="hidden-input" />
          <span class="pill ${state.rosterCount ? 'pill-green' : 'pill-orange'}">
            ${state.rosterCount ? `花名册已载入：HJF ${state.rosterHjfCount} / OST ${state.rosterOstCount}` : '未导入花名册（导入后可自动揪出OST串公司/查无ID）'}
          </span>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="l-up">📂 2. 导入车间劳保申请表 (.xlsx)</button>
          <input type="file" id="l-in" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <button class="btn ${state.viewMode === 'items' ? 'btn-primary' : ''}" id="l-v-items">📊 纯劳保物资汇总</button>
          <button class="btn ${state.viewMode === 'issues' ? 'btn-primary' : ''}" id="l-v-issues">⚠️ 问题人员核对 (${st.issueCount})</button>
          <button class="btn ${state.viewMode === 'detail' ? 'btn-primary' : ''}" id="l-v-detail">📑 发放明细</button>
          <span style="flex:1"></span>
          <button class="btn btn-success" id="l-exp" ${!state.itemSummaryRows.length ? 'disabled' : ''}>💾 导出纯劳保+问题人员 (.xlsx)</button>
        </div>
      </div>
      <div class="panel">
        <div id="l-table-box"></div>
      </div>
    `;

    const inRoster = root.querySelector('#l-in-roster');
    root.querySelector('#l-up-roster').onclick = () => inRoster.click();
    inRoster.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadRosterFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('花名册导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    const inFile = root.querySelector('#l-in');
    root.querySelector('#l-up').onclick = () => inFile.click();
    inFile.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadLaobaoFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('劳保表导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    root.querySelector('#l-v-items').onclick = () => { state.viewMode = 'items'; state.page = 1; renderModule(root); };
    root.querySelector('#l-v-issues').onclick = () => { state.viewMode = 'issues'; state.page = 1; renderModule(root); };
    root.querySelector('#l-v-detail').onclick = () => { state.viewMode = 'detail'; state.page = 1; renderModule(root); };

    root.querySelector('#l-exp').onclick = () => {
      const sheets = [
        { name: '纯劳保物资汇总', headers: ['劳保物资名称', '全员申领总数', '剔除休假实发数', '涉及人数'], rows: state.itemSummaryRows, numCols: [1, 2, 3] }
      ];
      if (state.issueRows.length) {
        sheets.push({ name: '问题人员核对清单', headers: ['序号', '岗位/部门', '姓名', 'ID卡号', '中/印方', '是否休假', '问题类型', '核对说明'], rows: state.issueRows, textCols: [3] });
      }
      U.exportWorkbook(sheets, `纯劳保核对与汇总_${state.sheetName || '结果'}.xlsx`);
      U.toast('已导出纯劳保核对与汇总.xlsx', 'success');
    };

    const box = root.querySelector('#l-table-box');
    if (state.viewMode === 'issues') {
      U.renderPagedTable(box, {
        headers: ['序号', '岗位/部门', '姓名', 'ID卡号', '中/印方', '是否休假', '问题类型', '核对说明'],
        rows: state.issueRows,
        page: state.page,
        pageSize: 100,
        rowClassFn: r => r[6].includes('串公司') ? 'row-err' : 'row-warn',
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else if (state.viewMode === 'detail') {
      U.renderPagedTable(box, {
        headers: ['岗位/部门', '姓名', '纯劳保物资', '数量', '状态'],
        rows: state.detailRows,
        page: state.page,
        pageSize: 100,
        onPageChange: pg => { state.page = pg; renderModule(root); }
      });
    } else {
      U.renderPagedTable(box, {
        headers: ['纯劳保物资名称（已剔除纸巾）', '全员申领总数', '剔除休假实发数', '申领人数'],
        rows: state.itemSummaryRows,
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
      for (const f of files) {
        if (/印方|花名册|名单_11|manpower/i.test(f.name) && !/劳保/.test(f.name)) {
          await loadRosterFile(f);
        } else {
          await loadLaobaoFile(f);
        }
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
