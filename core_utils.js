/**
 * HJF/OST 仓储可视化工作台 - 公共核心工具库 + 跨电脑实时运输存储引擎 (v1.1 实验隔离版)
 * 职责：
 * 1. Excel解析/强保前导0导出、分页防卡死表格渲染、一键TSV复制到动态表格
 * 2. 三层防丢实时运输引擎 (WB.Store)：
 *    - IndexedDB 浏览器大容库（刷新/重开/改代码永不丢）
 *    - 本机个人电脑硬盘 /api/state/<modId> 实时落盘
 *    - 私有独立实验 Gist (e0bcb71c5149d8d7b4467022047c2367) 分模块实时云运输（工作电脑 -> 云端 -> 自动回传落盘个人电脑）
 */
(function (global) {
  'use strict';

  const DEFAULT_LAB_GIST_ID = 'e0bcb71c5149d8d7b4467022047c2367';
  const IDB_NAME = 'wb_lab_exp_idb_v1';
  const IDB_STORE = 'modules';
  const CFG_KEY = 'wb_lab_exp_cloud_cfg';

  // --- IndexedDB 轻量封装 ---
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openIDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  async function idbSet(key, val) {
    try {
      const db = await openIDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) { console.warn('[IDB] save failed', e); }
  }

  // --- 沙箱安全内存兜底（公司电脑禁用 localStorage/IndexedDB 时也 0 报错运行） ---
  let memCloudCfg = { gistId: DEFAULT_LAB_GIST_ID, token: '' };

  function getCloudCfg() {
    try {
      const raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        memCloudCfg = {
          gistId: parsed.gistId || DEFAULT_LAB_GIST_ID,
          token: parsed.token || ''
        };
      }
    } catch { /* 公司沙箱禁用 localStorage 时自动使用内存态 */ }
    return { ...memCloudCfg };
  }

  function saveCloudCfg(cfg) {
    memCloudCfg = {
      gistId: (cfg.gistId || DEFAULT_LAB_GIST_ID).trim(),
      token: (cfg.token || '').trim()
    };
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(memCloudCfg));
    } catch { /* 沙箱无痕模式：仅保留在当前会话内存，不写公司磁盘 */ }
  }

  async function clearBrowserTraces() {
    try { localStorage.removeItem(CFG_KEY); } catch {}
    try { localStorage.removeItem('wb_lab_exp_active_tab'); } catch {}
    try {
      const db = await openIDB();
      await new Promise(resolve => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {}
    memCloudCfg = { gistId: DEFAULT_LAB_GIST_ID, token: '' };
  }

  function setSyncPill(text, tone = 'ok') {
    const el = document.getElementById('wb-sync-pill');
    if (!el) return;
    const colors = {
      ok: 'background:#166534;color:#dcfce7;',
      syncing: 'background:#b45309;color:#fef3c7;',
      local: 'background:#1e40af;color:#dbeafe;',
      err: 'background:#991b1b;color:#fee2e2;'
    };
    el.setAttribute('style', `cursor:pointer;padding:4px 10px;border-radius:999px;font-size:11.5px;font-weight:600;${colors[tone] || colors.local}`);
    el.textContent = text;
  }

  const pushTimers = {};
  const isLocalHost = location.hostname === '127.0.0.1' || location.hostname === 'localhost';

  const Store = {
    getCloudCfg,
    saveCloudCfg,
    clearBrowserTraces,

    /** 保存单个模块状态：沙箱安全（不依赖公司磁盘）+ 个人电脑硬盘落盘 + 实时直推私有实验 Gist */
    async save(modId, payload) {
      const wrapped = { ...payload, _updatedAt: Date.now() };
      // 仅在非强沙箱环境尝试写 IndexedDB，失败完全静默忽略，不阻塞云端运输
      await idbSet(modId, wrapped);
      setSyncPill('🟡 正在实时运输至私有云库...', 'syncing');

      // 1. 若在个人电脑本地服务运行，直接落盘 lab_data/<modId>.json（服务端自动后台同步至 Gist）
      if (isLocalHost) {
        try {
          const r = await fetch(`/api/state/${modId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(wrapped)
          });
          if (r.ok) {
            const t = new Date().toTimeString().slice(0, 8);
            setSyncPill(`🟢 已落盘本机并同步云端 ${t}`, 'ok');
            return;
          }
        } catch { /* fallback to direct Gist */ }
      }

      // 2. 若在公司工作电脑打开（无本机服务），只要配置了 Token，1.2 秒防抖实时直推私有实验 Gist
      const { gistId, token } = getCloudCfg();
      if (gistId && token) {
        clearTimeout(pushTimers[modId]);
        pushTimers[modId] = setTimeout(async () => {
          try {
            const payloadStr = JSON.stringify(wrapped);
            // 单模块超过 1.5MB（如 8000+ 条大现存量表）跳过云 Gist 防卡顿/422，保留本机 IndexedDB 缓存
            if (payloadStr.length > 1500000) {
              const t = new Date().toTimeString().slice(0, 8);
              setSyncPill(`🔵 大表已存本机缓存 ${t}（跳过云端防卡顿）`, 'local');
              return;
            }
            const res = await fetch(`https://api.github.com/gists/${gistId}`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                files: { [`${modId}.json`]: { content: payloadStr } }
              })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const t = new Date().toTimeString().slice(0, 8);
            setSyncPill(`🟢 已实时运输至私有云库 ${t}`, 'ok');
          } catch (e) {
            setSyncPill('🔴 云运输失败（已存本机缓存）', 'err');
            console.warn('[Gist Push]', e);
          }
        }, 1200);
      } else {
        const t = new Date().toTimeString().slice(0, 8);
        setSyncPill(`🔵 已存本机浏览器 ${t}（点此绑定云运输）`, 'local');
      }
    },

    /** 加载单个模块状态：自动比对 IndexedDB、本机硬盘与云端 Gist，永远取最新版本 */
    async load(modId) {
      let best = await idbGet(modId);

      // 1. 尝试从本机个人电脑硬盘拉取
      if (isLocalHost) {
        try {
          const r = await fetch(`/api/state/${modId}`);
          if (r.ok) {
            const j = await r.json();
            if (j.ok && j.data && (!best || (j.data._updatedAt || 0) > (best._updatedAt || 0))) {
              best = j.data;
              await idbSet(modId, best);
            }
          }
        } catch { /* ignore */ }
      }

      // 2. 若在工作电脑配置了 Token，则自动从私有实验 Gist 拉取最新快照
      const { gistId, token } = getCloudCfg();
      if (!isLocalHost && gistId && token) {
        try {
          const r = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
          });
          if (r.ok) {
            const gist = await r.json();
            const f = gist.files && gist.files[`${modId}.json`];
            if (f) {
              const txt = f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content;
              const remote = JSON.parse(txt);
              if (!best || (remote._updatedAt || 0) > (best._updatedAt || 0)) {
                best = remote;
                await idbSet(modId, best);
              }
            }
          }
        } catch { /* ignore */ }
      }
      return best;
    },

    /** 手动一键从云端拉取全部最新模块数据 */
    async pullAllFromCloud() {
      setSyncPill('🟡 正在从云端拉取最新数据...', 'syncing');
      if (isLocalHost) {
        const r = await fetch('/api/sync/pull', { method: 'POST' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        setSyncPill(`🟢 已同步云端至本机硬盘 (${(j.updated || []).length}项更新)`, 'ok');
        return j.updated || [];
      }
      const { gistId, token } = getCloudCfg();
      if (!gistId || !token) throw new Error('请先填写 GitHub Token');
      const r = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const gist = await r.json();
      const updated = [];
      for (const [fname, f] of Object.entries(gist.files || {})) {
        if (!/^mod_[a-z0-9_]+\.json$/.test(fname)) continue;
        const modId = fname.replace(/\.json$/, '');
        const txt = f.truncated && f.raw_url ? await (await fetch(f.raw_url)).text() : f.content;
        await idbSet(modId, JSON.parse(txt));
        updated.push(modId);
      }
      setSyncPill(`🟢 已从私有云库拉取 ${updated.length} 个模块`, 'ok');
      return updated;
    }
  };

  const Utils = {
    cleanStr(val) {
      if (val === null || val === undefined) return '';
      const s = String(val).replace(/\u00a0/g, ' ').trim();
      return s.toLowerCase() === 'nan' ? '' : s;
    },

    formatCode(val, force11 = false) {
      let s = Utils.cleanStr(val).replace(/[\r\n\s]+/g, '').replace(/^'+/, '').replace(/\.0$/, '');
      if (/^\d+$/.test(s)) {
        if (force11 && s.length < 11) {
          s = s.padStart(11, '0');
        } else if (s.length === 10 && '356789'.includes(s[0])) {
          s = '0' + s;
        }
      }
      return s;
    },

    formatDate(val) {
      if (val === null || val === undefined || val === '') return '';
      if (typeof val === 'number' && val > 20000 && val < 80000) {
        const d = new Date(Math.round((val - 25569) * 86400 * 1000));
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
      const s = Utils.cleanStr(val)
        .replace(/年|月/g, '-')
        .replace(/日/g, '')
        .replace(/[\/.]/g, '-');
      // YYYY-M-D
      const m1 = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m1) {
        return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
      }
      // SheetJS raw:false 美式短日期 M-D-YY 或 M-D-YYYY
      const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})(?:\s|$)/);
      if (m2) {
        const yr = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
        return `${yr}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
      }
      return s;
    },

    parseNum(val) {
      if (typeof val === 'number') return isNaN(val) ? 0 : val;
      const s = Utils.cleanStr(val).replace(/,/g, '');
      const n = parseFloat(s);
      return isNaN(n) ? 0 : n;
    },

    fmtNum(val) {
      const n = Math.round(Utils.parseNum(val) * 1e6) / 1e6;
      if (Math.abs(n) < 1e-9) return '0';
      return String(n);
    },

    escHtml(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    async readSpreadsheet(file) {
      const buf = await file.arrayBuffer();
      const headText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf.slice(0, 2048))).toLowerCase();
      if (headText.includes('<html') || headText.includes('<table')) {
        let fullText = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buf));
        // 兼容 ERP 导出的 GBK/GB18030 编码 HTML 伪装 .xls
        if ((fullText.match(/\uFFFD/g) || []).length >= 3) {
          try {
            fullText = new TextDecoder('gb18030', { fatal: false }).decode(new Uint8Array(buf));
          } catch { /* fallback to utf-8 */ }
        }
        const doc = new DOMParser().parseFromString(fullText, 'text/html');
        const tables = Array.from(doc.querySelectorAll('table'));
        const sheets = {};
        const sheetNames = [];
        tables.forEach((tbl, idx) => {
          const name = `HTML表_${idx + 1}`;
          const rows = Array.from(tbl.querySelectorAll('tr')).map(tr =>
            Array.from(tr.querySelectorAll('th,td')).map(td => Utils.cleanStr(td.textContent))
          );
          if (rows.length > 0) {
            sheetNames.push(name);
            sheets[name] = rows;
          }
        });
        return { sheetNames, sheets, fileName: file.name };
      }

      const wb = XLSX.read(buf, { type: 'array', raw: false, cellDates: false, cellStyles: true });
      const sheets = {};
      wb.SheetNames.forEach(name => {
        const ws = wb.Sheets[name];
        sheets[name] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      });
      return { sheetNames: wb.SheetNames, sheets, fileName: file.name, wb };
    },

    exportWorkbook(sheetConfigs, fileName) {
      const wb = XLSX.utils.book_new();
      const fmt = Format.get(global.WB && global.WB.activeModId);
      const borderObj = fmt && fmt.border ? {
        top: { style: 'thin', color: { rgb: 'BFBFBF' } },
        bottom: { style: 'thin', color: { rgb: 'BFBFBF' } },
        left: { style: 'thin', color: { rgb: 'BFBFBF' } },
        right: { style: 'thin', color: { rgb: 'BFBFBF' } }
      } : undefined;

      sheetConfigs.forEach(cfg => {
        const aoa = [cfg.headers, ...cfg.rows];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        const textCols = new Set(cfg.textCols || []);
        const numCols = new Set(cfg.numCols || []);
        for (let r = 0; r < aoa.length; r++) {
          for (let c = 0; c < cfg.headers.length; c++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr];
            if (!cell) continue;
            if (r > 0) {
              if (textCols.has(c)) {
                cell.t = 's';
                cell.v = String(cell.v ?? '');
                cell.z = '@';
              } else if (numCols.has(c) && cell.v !== '' && !isNaN(Number(cell.v))) {
                cell.t = 'n';
                cell.v = Number(cell.v);
              }
            }
            if (fmt && fmt.enabled) {
              const isHeader = r === 0;
              cell.s = {
                font: {
                  name: fmt.fontName || '宋体',
                  sz: Number(fmt.fontSize) || 11,
                  bold: isHeader ? true : !!fmt.bold,
                  color: fmt.color ? { rgb: fmt.color.replace('#', '') } : undefined
                },
                alignment: {
                  horizontal: isHeader ? 'center' : (fmt.align || 'left'),
                  vertical: 'center'
                },
                border: borderObj
              };
              if (isHeader) {
                cell.s.fill = { fgColor: { rgb: 'F1F5F9' } };
              }
              if (r > 0 && textCols.has(c)) {
                cell.s.numFmt = '@';
              }
            }
          }
        }
        if (cfg.colWidths) ws['!cols'] = cfg.colWidths.map(w => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, cfg.name.slice(0, 31));
      });
      XLSX.writeFile(wb, fileName);
    },

    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      }
    },

    async copyAsTSV(headers, rows, includeHeader = false) {
      const lines = [];
      if (includeHeader && headers) {
        lines.push(headers.map(h => String(h ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'));
      }
      for (const row of rows) {
        lines.push(row.map(v => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'));
      }
      const plainText = lines.join('\n');

      // 若当前板块吸取并启用了独立格式，则同时写入带完整样式的 HTML 表格剪贴板（Excel/WPS 直接带字体/字号/边框粘贴）
      const fmt = Format.get(global.WB && global.WB.activeModId);
      if (fmt && fmt.enabled && typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
        try {
          const tdStyle = [
            `font-family:'${fmt.fontName || '宋体'}',sans-serif`,
            `font-size:${Number(fmt.fontSize) || 11}pt`,
            fmt.bold ? 'font-weight:bold' : 'font-weight:normal',
            `text-align:${fmt.align || 'left'}`,
            'vertical-align:middle',
            fmt.color ? `color:${fmt.color}` : '',
            fmt.border ? 'border:0.5pt solid #8c8c8c' : '',
            'padding:2px 4px'
          ].filter(Boolean).join(';');

          const parts = ['<html><head><meta charset="utf-8"></head><body><table style="border-collapse:collapse;">'];
          if (includeHeader && headers) {
            parts.push('<tr>' + headers.map(h => `<th style="${tdStyle};font-weight:bold;background:#f1f5f9;">${Utils.escHtml(h)}</th>`).join('') + '</tr>');
          }
          for (const row of rows) {
            parts.push('<tr>' + row.map(v => {
              const s = String(v ?? '');
              // 强保前导 0（如 05000... / 日期）不被 Excel 吞掉
              const forceText = (/^0\d{5,}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) ? ';mso-number-format:"\\@"' : '';
              return `<td style="${tdStyle}${forceText}">${Utils.escHtml(s)}</td>`;
            }).join('') + '</tr>');
          }
          parts.push('</table></body></html>');
          const htmlBlob = new Blob([parts.join('')], { type: 'text/html' });
          const textBlob = new Blob([plainText], { type: 'text/plain' });
          await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })]);
          return true;
        } catch (e) {
          console.warn('[RichCopy fallback to plain]', e);
        }
      }
      return Utils.copyText(plainText);
    },

    renderPagedTable(container, { headers, rows, page = 1, pageSize = 100, rowClassFn, cellRenderFn, onPageChange }) {
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const curPage = Math.min(Math.max(1, page), totalPages);
      const start = (curPage - 1) * pageSize;
      const slice = rows.slice(start, start + pageSize);

      let html = `<div class="table-wrap"><table class="data-table"><thead><tr><th class="col-idx">#</th>`;
      headers.forEach(h => { html += `<th>${Utils.escHtml(h)}</th>`; });
      html += `</tr></thead><tbody>`;

      if (slice.length === 0) {
        html += `<tr><td colspan="${headers.length + 1}" class="empty-cell">暂无数据</td></tr>`;
      } else {
        slice.forEach((row, i) => {
          const absIdx = start + i;
          const cls = rowClassFn ? rowClassFn(row, absIdx) : '';
          html += `<tr class="${cls}"><td class="col-idx">${absIdx + 1}</td>`;
          headers.forEach((_, cIdx) => {
            const val = row[cIdx] ?? '';
            const rendered = cellRenderFn ? cellRenderFn(val, row, absIdx, cIdx) : Utils.escHtml(val);
            html += `<td>${rendered}</td>`;
          });
          html += `</tr>`;
        });
      }
      html += `</tbody></table></div>`;

      html += `<div class="pager-bar">
        <span class="pager-info">共 <b>${total}</b> 行（内存全量保留，当前仅渲染第 ${total ? start + 1 : 0}–${Math.min(start + pageSize, total)} 行防卡顿）</span>
        <div class="pager-btns">
          <button class="btn-sm" data-pg="1" ${curPage <= 1 ? 'disabled' : ''}>首页</button>
          <button class="btn-sm" data-pg="${curPage - 1}" ${curPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="pager-cur">第 ${curPage} / ${totalPages} 页</span>
          <button class="btn-sm" data-pg="${curPage + 1}" ${curPage >= totalPages ? 'disabled' : ''}>下一页</button>
          <button class="btn-sm" data-pg="${totalPages}" ${curPage >= totalPages ? 'disabled' : ''}>末页</button>
        </div>
      </div>`;

      container.innerHTML = html;
      container.querySelectorAll('.pager-btns button[data-pg]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (onPageChange) onPageChange(Number(btn.dataset.pg));
        });
      });
    },

    toast(msg, type = 'info') {
      const box = document.getElementById('wb-toast-box');
      if (!box) return;
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.textContent = msg;
      box.appendChild(el);
      setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 300);
      }, 3200);
    }
  };

  // --- 分板块独立格式刷引擎（支持 Ctrl+V 粘贴单元格自动吸取字体/字号/对齐/框线，按模块独立生效） ---
  const memFmt = {};
  const FONT_ALIAS = {
    'simsun': '宋体',
    'nsimsun': '新宋体',
    'microsoft yahei': '微软雅黑',
    'microsoft yahei ui': '微软雅黑',
    'dengxian': '等线',
    'simhei': '黑体',
    'kaiti': '楷体',
    'fangsong': '仿宋',
    'pingfang sc': '微软雅黑'
  };

  function rgbToHex(rgb) {
    const m = String(rgb || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return '';
    const hex = [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('').toUpperCase();
    return (hex === '000000' || hex === '0F172A') ? '' : `#${hex}`;
  }

  function cleanFontName(raw) {
    if (!raw) return '宋体';
    const first = String(raw).split(',')[0].replace(/['"]/g, '').trim();
    return FONT_ALIAS[first.toLowerCase()] || first || '宋体';
  }

  const Format = {
    get(modId) {
      if (!modId) return null;
      if (memFmt[modId] !== undefined) return memFmt[modId];
      try {
        const raw = localStorage.getItem(`wb_lab_fmt_${modId}`);
        if (raw) {
          memFmt[modId] = JSON.parse(raw);
          return memFmt[modId];
        }
      } catch {}
      return null;
    },
    save(modId, cfg) {
      if (!modId) return;
      memFmt[modId] = cfg;
      try {
        if (cfg) localStorage.setItem(`wb_lab_fmt_${modId}`, JSON.stringify(cfg));
        else localStorage.removeItem(`wb_lab_fmt_${modId}`);
      } catch {}
    },
    clear(modId) {
      this.save(modId, null);
    },
    /** 从 Excel/WPS/在线表格复制的 HTML 片段中自动吸取字体、字号、加粗、对齐、框线与颜色 */
    parseFromHtml(html) {
      if (!html || !document.body) return null;
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:-99999px;visibility:hidden;';
      host.innerHTML = html;
      document.body.appendChild(host);
      try {
        // 优先取首个非空 <td>，其次 <th>，最后任意元素
        const cells = Array.from(host.querySelectorAll('td,th'));
        const target = cells.find(el => (el.textContent || '').trim() !== '') || cells[0] || host.firstElementChild;
        if (!target) return null;

        const cs = getComputedStyle(target);
        const fontName = cleanFontName(target.style.fontFamily || cs.fontFamily);
        let fontSize = 11;
        const rawSz = target.style.fontSize || cs.fontSize || '';
        if (/pt$/i.test(rawSz)) {
          fontSize = Math.round(parseFloat(rawSz) * 2) / 2;
        } else if (/px$/i.test(rawSz)) {
          fontSize = Math.round((parseFloat(rawSz) * 0.75) * 2) / 2;
        }
        if (!fontSize || fontSize < 6 || fontSize > 48) fontSize = 11;

        const fw = target.style.fontWeight || cs.fontWeight || '';
        const bold = fw === 'bold' || Number(fw) >= 600;
        const ta = (target.style.textAlign || cs.textAlign || 'left').toLowerCase();
        const align = ta.includes('center') ? 'center' : (ta.includes('right') ? 'right' : 'left');
        const hasBorder = ['borderTopStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderRightStyle']
          .some(k => cs[k] && cs[k] !== 'none' && cs[k] !== 'hidden');
        const color = rgbToHex(cs.color);

        return { enabled: true, fontName, fontSize, bold, align, border: hasBorder, color };
      } finally {
        document.body.removeChild(host);
      }
    }
  };

  global.WB = {
    Utils,
    Store,
    Format,
    activeModId: '',
    modules: {},
    register(mod) {
      this.modules[mod.id] = mod;
    }
  };
})(window);
