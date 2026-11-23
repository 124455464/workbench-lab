/**
 * 模块 5：劳保物资发放统计（仅限实验隔离版：纯劳保筛选，已移除全部无关耗材逻辑）
 * 独立隔离模块。
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const EXCLUDE_NON_LAOBAO = ['纸巾', '抽纸', '卷纸', '卫生纸', '面巾纸', '擦手纸', '餐巾纸'];

  let state = {
    rawRows: [],
    excludedCount: 0,
    summaryRows: [],
    deptFilter: 'ALL',
    depts: [],
    page: 1,
    fileName: ''
  };

  function persistState() {
    WB.Store.save('mod_laobao', {
      rawRows: state.rawRows,
      excludedCount: state.excludedCount,
      summaryRows: state.summaryRows,
      depts: state.depts,
      fileName: state.fileName
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_laobao');
    if (saved) {
      state.rawRows = saved.rawRows || [];
      state.excludedCount = saved.excludedCount || 0;
      state.summaryRows = saved.summaryRows || [];
      state.depts = saved.depts || [];
      state.fileName = saved.fileName || '';
    }
  }

  async function loadLaobaoFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const aoa = parsed.sheets[parsed.sheetNames[0]] || [];
    if (aoa.length < 2) throw new Error('表格无有效数据');

    let hdrIdx = 0;
    for (let i = 0; i < Math.min(8, aoa.length); i++) {
      const txt = aoa[i].join(' ');
      if (/姓名|领用人|部门|车间/.test(txt)) { hdrIdx = i; break; }
    }
    const h = aoa[hdrIdx].map(v => U.cleanStr(v));
    const iDept = h.findIndex(x => /部门|车间/.test(x));
    const iName = h.findIndex(x => /姓名|领用人|人员/.test(x));
    const iItem = h.findIndex(x => /物资|名称|品名|劳保/.test(x));
    const iQty = h.findIndex(x => /数量|实发|发放/.test(x));
    const iStatus = h.findIndex(x => /状态|异常|备注/.test(x));

    const agg = new Map();
    const deptSet = new Set();
    const raw = [];
    let excluded = 0;

    for (let i = hdrIdx + 1; i < aoa.length; i++) {
      const r = aoa[i];
      const dept = iDept >= 0 ? U.cleanStr(r[iDept]) : '未分部门';
      const person = iName >= 0 ? U.cleanStr(r[iName]) : '';
      const item = iItem >= 0 ? U.cleanStr(r[iItem]) : '劳保物资';
      const qty = iQty >= 0 ? U.parseNum(r[iQty]) : 1;
      const status = iStatus >= 0 ? U.cleanStr(r[iStatus]) : '';
      if (!person && !item) continue;
      if (/^(合计|总计|小计)$/.test(dept) || /^(合计|总计|小计)$/.test(person)) continue;

      // 实验区专属规则：自动剔除纸类非劳保项，仅保留劳保物资
      if (EXCLUDE_NON_LAOBAO.some(k => item.includes(k))) {
        excluded++;
        continue;
      }

      deptSet.add(dept);
      raw.push([dept, person, item, qty, status]);

      const key = `${dept}||${person}||${item}`;
      if (!agg.has(key)) agg.set(key, { dept, person, item, qty: 0, count: 0, status });
      const obj = agg.get(key);
      obj.qty += qty;
      obj.count += 1;
      if (status && !obj.status.includes(status)) obj.status = obj.status ? `${obj.status}; ${status}` : status;
    }

    state.rawRows = raw;
    state.excludedCount = excluded;
    state.depts = Array.from(deptSet).sort();
    state.summaryRows = Array.from(agg.values()).map(o => [o.dept, o.person, o.item, U.fmtNum(o.qty), o.count, o.status]);
    state.deptFilter = 'ALL';
    state.fileName = file.name;
    state.page = 1;
    persistState();
    U.toast(`纯劳保筛选完成：保留 ${raw.length} 条劳保记录（已自动剔除 ${excluded} 条非劳保记录）`, 'success');
  }

  function renderModule(root) {
    const filtered = state.deptFilter === 'ALL'
      ? state.summaryRows
      : state.summaryRows.filter(r => r[0] === state.deptFilter);

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>🦺 劳保物资发放统计（纯劳保筛选 · 部门/领用人汇总）</span>
          <span class="pill pill-blue">${state.fileName || '待导入劳保统计表'}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi-card blue"><div class="kpi-label">有效劳保记录条数</div><div class="kpi-val">${state.rawRows.length}</div></div>
          <div class="kpi-card green"><div class="kpi-label">去重汇总条目数</div><div class="kpi-val">${state.summaryRows.length}</div></div>
          <div class="kpi-card"><div class="kpi-label">涉及部门/车间数</div><div class="kpi-val">${state.depts.length}</div></div>
          <div class="kpi-card orange"><div class="kpi-label">已自动过滤非劳保条数</div><div class="kpi-val">${state.excludedCount}</div></div>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="l-up">📂 导入劳保发放表 (.xlsx)</button>
          <input type="file" id="l-in" accept=".xlsx,.xls,.csv" class="hidden-input" />
          <select id="l-dept">
            <option value="ALL">全部部门 (${state.depts.length})</option>
            ${state.depts.map(d => `<option value="${U.escHtml(d)}" ${d === state.deptFilter ? 'selected' : ''}>${U.escHtml(d)}</option>`).join('')}
          </select>
          <span style="flex:1"></span>
          <button class="btn btn-success" id="l-copy" ${!filtered.length ? 'disabled' : ''}>📋 复制当前汇总</button>
          <button class="btn" id="l-exp" ${!filtered.length ? 'disabled' : ''}>💾 导出纯劳保汇总 (.xlsx)</button>
        </div>
      </div>
      <div class="panel"><div id="l-table-box"></div></div>
    `;

    const inp = root.querySelector('#l-in');
    root.querySelector('#l-up').onclick = () => inp.click();
    inp.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadLaobaoFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('劳保表导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };
    root.querySelector('#l-dept').onchange = e => { state.deptFilter = e.target.value; state.page = 1; renderModule(root); };
    root.querySelector('#l-copy').onclick = async () => {
      await U.copyAsTSV(['部门/车间', '领用人', '劳保物资', '累计发放数量', '领取次数', '状态/备注'], filtered, true);
      U.toast('已复制纯劳保汇总数据', 'success');
    };
    root.querySelector('#l-exp').onclick = () => {
      U.exportWorkbook([{ name: '劳保发放汇总', headers: ['部门/车间', '领用人', '劳保物资', '累计发放数量', '领取次数', '状态/备注'], rows: filtered, numCols: [3, 4] }], '劳保物资发放汇总.xlsx');
      U.toast('已导出劳保物资发放汇总.xlsx', 'success');
    };

    U.renderPagedTable(root.querySelector('#l-table-box'), {
      headers: ['部门/车间', '领用人', '劳保物资', '累计发放数量', '领取次数', '状态/备注'],
      rows: filtered,
      page: state.page,
      pageSize: 100,
      onPageChange: pg => { state.page = pg; renderModule(root); }
    });
  }

  WB.register({
    id: 'mod_laobao',
    icon: '🦺',
    title: '劳保物资统计',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      if (files[0]) await loadLaobaoFile(files[0]);
      if (this._root) renderModule(this._root);
    }
  });
})();
