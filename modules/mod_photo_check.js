/**
 * 模块 2：当天出库照片/扫描PDF 左图右单同屏核对
 * 铁律：按空行切分独立单据，自动剔除全部气体（含丁烷气罐）。
 */
(function () {
  'use strict';
  const U = WB.Utils;
  const GAS_KEYWORDS = ['氧气', '乙炔', '二氧化碳', '氩气', '氮气', '丙烷', '液化气', '混合气', '丁烷气', '丁烷'];

  let state = {
    tickets: [],        // [{ id, date, dept, rec, wh, tag, items: [{code,name,qty,unit}], checked: false }]
    availDates: [],
    targetDate: '',
    sheetName: '',
    mediaUrls: [],      // [{ name, url }]
    activeMediaIdx: 0,
    hideChecked: false
  };

  function persistState() {
    WB.Store.save('mod_photo_check', {
      tickets: state.tickets,
      availDates: state.availDates,
      targetDate: state.targetDate,
      sheetName: state.sheetName,
      hideChecked: state.hideChecked
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_photo_check');
    if (saved) {
      state.tickets = saved.tickets || [];
      state.availDates = saved.availDates || [];
      state.targetDate = saved.targetDate || '';
      state.sheetName = saved.sheetName || '';
      state.hideChecked = !!saved.hideChecked;
    }
  }

  async function loadTicketsFile(file) {
    const parsed = await U.readSpreadsheet(file);
    // 若存在多工作表（如 HJF标准14列 + 历史出库底表总账），自动优先选取非空行数最多的有效工作表
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
    const firstCleaned = (aoa[0] || []).map(v => U.cleanStr(v));
    const hasHeader = /^(日期|车间|部门|领料部门)$/.test(firstCleaned[0] || '') ||
      (firstCleaned.includes('车间') && firstCleaned.includes('仓库'));

    // 自动检测第 0 列是否为「日期」列（如 历史出库底表总账），动态偏移列索引
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
        if (GAS_KEYWORDS.some(g => name.includes(g))) continue; // 强制剔除气体含丁烷气罐
        items.push({ code, name, qty, unit });
      }
      if (items.length > 0) {
        tickets.push({ id: bIdx + 1, date: dateStr, dept, rec, wh, tag, items, checked: false });
      }
    });

    state.tickets = tickets;
    state.availDates = Array.from(dateSet).sort().reverse();
    state.targetDate = '';
    state.sheetName = bestSn;
    persistState();
    U.toast(`从 [${bestSn}] 按空行切分出 ${tickets.length} 张非气体独立单据（已自动剔除全部气体）`, 'success');
  }

  async function loadMediaFiles(files) {
    for (const f of files) {
      if (/\.pdf$/i.test(f.name) && window.pdfjsLib) {
        const buf = await f.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const vp = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width;
          canvas.height = vp.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          state.mediaUrls.push({ name: `${f.name} 第${p}页`, url: canvas.toDataURL('image/jpeg', 0.85) });
        }
      } else if (/\.(png|jpe?g|webp|bmp)$/i.test(f.name)) {
        state.mediaUrls.push({ name: f.name, url: URL.createObjectURL(f) });
      }
    }
    U.toast(`已载入 ${state.mediaUrls.length} 页照片/PDF 预览`, 'success');
  }

  function renderModule(root) {
    const scopedTickets = state.targetDate
      ? state.tickets.filter(t => t.date === state.targetDate)
      : state.tickets;
    const total = scopedTickets.length;
    const done = scopedTickets.filter(t => t.checked).length;
    const missing = scopedTickets.filter(t => !t.checked);
    const listToShow = state.hideChecked ? missing : scopedTickets;
    const curMedia = state.mediaUrls[state.activeMediaIdx];

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>📸 当天出库照片 / 扫描PDF 同屏核对（自动剔除含丁烷气罐在内的全部气体）</span>
          <span class="pill ${missing.length ? 'pill-red' : 'pill-green'}">待核对缺单：${missing.length} / ${total}${state.sheetName ? ` · 表:${state.sheetName}` : ''}</span>
        </div>
        <div class="toolbar">
          <button class="btn btn-primary" id="p-up-csv">📂 1. 导入当天出库清单 (CSV/XLSX)</button>
          <input type="file" id="p-in-csv" accept=".csv,.xlsx,.xls" class="hidden-input" />
          <button class="btn btn-warning" id="p-up-media">🖼️ 2. 导入现场照片 / 扫描PDF</button>
          <input type="file" id="p-in-media" accept="image/*,.pdf" multiple class="hidden-input" />
          ${state.availDates.length > 0 ? `
            <select id="p-date-sel" title="按表格内自然日筛选">
              <option value="">全部日期 (${state.tickets.length} 单)</option>
              ${state.availDates.map(d => `<option value="${d}" ${d === state.targetDate ? 'selected' : ''}>仅看：${d}</option>`).join('')}
            </select>
          ` : ''}
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" id="p-hide-done" ${state.hideChecked ? 'checked' : ''} /> 隐藏已核对单据
          </label>
          <span style="flex:1"></span>
          <button class="btn btn-success" id="p-copy-missing" ${!missing.length ? 'disabled' : ''}>📋 一键复制缺单催办清单 (${missing.length})</button>
        </div>
      </div>

      <div class="split-grid">
        <div class="panel">
          <div class="panel-title">
            <span>🖼️ 左侧：照片 / PDF 实发凭证 (${state.mediaUrls.length ? `${state.activeMediaIdx + 1}/${state.mediaUrls.length}` : '0'})</span>
            <div style="display:flex;gap:6px;">
              <button class="btn-sm" id="m-prev" ${state.activeMediaIdx <= 0 ? 'disabled' : ''}>⬅ 上一张</button>
              <button class="btn-sm" id="m-next" ${state.activeMediaIdx >= state.mediaUrls.length - 1 ? 'disabled' : ''}>下一张 ➡</button>
            </div>
          </div>
          ${curMedia ? `
            <div style="font-size:12px;color:#64748b;margin-bottom:6px;">${U.escHtml(curMedia.name)}</div>
            <div style="max-height:560px;overflow:auto;text-align:center;background:#0f172a;border-radius:8px;padding:6px;">
              <img src="${curMedia.url}" style="max-width:100%;border-radius:4px;" />
            </div>
          ` : `<div class="dropzone" id="p-media-drop">把当天拍照的物资照片或手机扫描 PDF 拖到这里即可同屏看图核对</div>`}
        </div>

        <div class="panel">
          <div class="panel-title">
            <span>📑 右侧：按空行独立单据卡片（点击卡片即打勾核销）</span>
            <span style="font-size:12px;color:#16a34a;">已核对 ${done} 张</span>
          </div>
          <div style="max-height:580px;overflow-y:auto;">
            ${listToShow.length === 0 ? `<div class="empty-cell">请先导入当天 14 列 HJF 出库表（CSV/XLSX）</div>` :
              listToShow.map(t => `
                <div class="photo-card ${t.checked ? 'checked' : 'missing'}" data-tid="${t.id}">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <b>${t.checked ? '✅' : '🔴'} #${t.id} ${U.escHtml(t.dept)} ｜ ${U.escHtml(t.tag)}</b>
                    <span style="font-size:11.5px;color:#64748b;">${U.escHtml(t.rec)}</span>
                  </div>
                  <div style="font-size:12px;color:#334155;line-height:1.5;">
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
      await loadTicketsFile(e.target.files[0]);
      renderModule(root);
      e.target.value = '';
    };

    const inMedia = root.querySelector('#p-in-media');
    root.querySelector('#p-up-media').onclick = () => inMedia.click();
    const drop = root.querySelector('#p-media-drop');
    if (drop) {
      drop.onclick = () => inMedia.click();
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('dragover'); };
      drop.ondragleave = () => drop.classList.remove('dragover');
      drop.ondrop = async e => {
        e.preventDefault();
        drop.classList.remove('dragover');
        await loadMediaFiles(Array.from(e.dataTransfer.files || []));
        renderModule(root);
      };
    }
    inMedia.onchange = async e => {
      await loadMediaFiles(Array.from(e.target.files || []));
      renderModule(root);
      e.target.value = '';
    };

    const selDate = root.querySelector('#p-date-sel');
    if (selDate) {
      selDate.onchange = e => {
        state.targetDate = e.target.value;
        persistState();
        renderModule(root);
      };
    }
    root.querySelector('#p-hide-done').onchange = e => {
      state.hideChecked = e.target.checked;
      renderModule(root);
    };
    root.querySelector('#m-prev').onclick = () => { state.activeMediaIdx = Math.max(0, state.activeMediaIdx - 1); renderModule(root); };
    root.querySelector('#m-next').onclick = () => { state.activeMediaIdx = Math.min(state.mediaUrls.length - 1, state.activeMediaIdx + 1); renderModule(root); };

    root.querySelectorAll('.photo-card').forEach(card => {
      card.onclick = () => {
        const tid = Number(card.dataset.tid);
        const t = state.tickets.find(x => x.id === tid);
        if (t) { t.checked = !t.checked; persistState(); renderModule(root); }
      };
    });

    root.querySelector('#p-copy-missing').onclick = async () => {
      const lines = missing.map(t => `${t.dept} | ${t.tag} | ` + t.items.map(i => `${i.name}(${i.qty}${i.unit})`).join('、'));
      const ok = await U.copyText(lines.join('\n'));
      U.toast(ok ? `已复制 ${lines.length} 条缺照片单据明细` : '复制失败，请检查剪贴板权限', ok ? 'success' : 'error');
    };
  }

  WB.register({
    id: 'mod_photo_check',
    icon: '📸',
    title: '出库照片核对',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      const excels = files.filter(f => /\.(xlsx?|csv)$/i.test(f.name));
      const medias = files.filter(f => /\.(png|jpe?g|webp|bmp|pdf)$/i.test(f.name));
      if (excels.length) await loadTicketsFile(excels[0]);
      if (medias.length) await loadMediaFiles(medias);
      if (this._root) renderModule(this._root);
    }
  });
})();
