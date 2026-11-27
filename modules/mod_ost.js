/**
 * 模块 4：OST 电厂双核工具（📅 OST 每日物资筛选输出 + ⚡ OST P9 领料现存量核对）
 * 规则：
 * 1. OST 每日物资筛选：自然日切片 + 追加「子项号 / 用途编码 / 货位编码」+ 综合仓置顶 & P3/P7/P9 沉底排序
 * 2. OST P9 核对：兼容 ERP 导出的 HTML 伪装 .xls，自动清洗 &nbsp; 与强保前导 0，输出 10 列现存量核对表
 */
(function () {
  'use strict';
  const U = WB.Utils;

  const AUDIT_HEADERS = ['行号', '编码', '名称', '规格', '单位', '申领数量', '现存量总计', 'P9(2105)货位', '全部仓库货位', '核对状态'];

  let state = {
    subTab: 'daily',     // 'daily' | 'p9'
    stockMap: new Map(), // code -> [{ name, spec, wh, loc, qty }]
    stockCount: 0,
    // OST 每日物资筛选态
    dailySheets: {},     // { sheetName: { headers, rows, availDates } }
    dailySheetNames: [],
    dailyActiveSheet: '',
    dailyRawHeaders: [],
    dailyRawRows: [],
    dailyFilteredHeaders: [],
    dailyFilteredRows: [],
    dailyTargetDate: '',
    dailyAvailDates: [],
    dailyFileName: '',
    dailyPage: 1,
    // OST P9 核对态（含箱件清单原表回填 + 10列现存量核对双视图）
    p9ViewMode: 'backfill', // 'backfill' | 'audit'
    p9FileName: '',
    p9SheetName: '',
    p9BackfillHeaders: [],
    p9BackfillRows: [],
    p9InAccCol: -1,
    p9Stats: { total: 0, hasAcc: 0, manual: 0, skipped: 0 },
    auditRows: [],
    p9Page: 1
  };

  function persistState() {
    WB.Store.save('mod_ost', {
      subTab: state.subTab,
      stockEntries: Array.from(state.stockMap.entries()),
      stockCount: state.stockCount,
      dailySheets: state.dailySheets,
      dailySheetNames: state.dailySheetNames,
      dailyActiveSheet: state.dailyActiveSheet,
      dailyRawHeaders: state.dailyRawHeaders,
      dailyRawRows: state.dailyRawRows,
      dailyTargetDate: state.dailyTargetDate,
      dailyAvailDates: state.dailyAvailDates,
      dailyFileName: state.dailyFileName,
      p9ViewMode: state.p9ViewMode,
      p9FileName: state.p9FileName,
      p9SheetName: state.p9SheetName,
      p9BackfillHeaders: state.p9BackfillHeaders,
      p9BackfillRows: state.p9BackfillRows,
      p9InAccCol: state.p9InAccCol,
      p9Stats: state.p9Stats,
      auditRows: state.auditRows
    });
  }

  async function hydrateState() {
    const saved = await WB.Store.load('mod_ost');
    if (saved) {
      state.subTab = saved.subTab || 'daily';
      state.stockMap = new Map(saved.stockEntries || []);
      state.stockCount = saved.stockCount || 0;
      state.dailySheets = saved.dailySheets || {};
      state.dailySheetNames = saved.dailySheetNames || [];
      state.dailyActiveSheet = saved.dailyActiveSheet || state.dailySheetNames[state.dailySheetNames.length - 1] || '';
      state.dailyRawHeaders = saved.dailyRawHeaders || [];
      state.dailyRawRows = saved.dailyRawRows || [];
      state.dailyTargetDate = saved.dailyTargetDate || '';
      state.dailyAvailDates = saved.dailyAvailDates || [];
      state.dailyFileName = saved.dailyFileName || '';
      state.p9ViewMode = saved.p9ViewMode || 'backfill';
      state.p9FileName = saved.p9FileName || '';
      state.p9SheetName = saved.p9SheetName || '';
      state.p9BackfillHeaders = saved.p9BackfillHeaders || [];
      state.p9BackfillRows = saved.p9BackfillRows || [];
      state.p9InAccCol = typeof saved.p9InAccCol === 'number' ? saved.p9InAccCol : -1;
      state.p9Stats = saved.p9Stats || { total: 0, hasAcc: 0, manual: 0, skipped: 0 };
      state.auditRows = saved.auditRows || [];
      if (state.dailyRawRows.length) rebuildDailyOutput();
    }
  }

  function findExactOrMatch(headers, exactList, includeList, excludeRe) {
    for (const ex of exactList) {
      const idx = headers.findIndex(h => h === ex);
      if (idx >= 0) return idx;
    }
    for (const inc of includeList) {
      const idx = headers.findIndex(h => h.includes(inc) && (!excludeRe || !excludeRe.test(h)));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  async function loadStockFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const map = new Map();
    let count = 0;

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = 0;
      for (let i = 0; i < Math.min(8, aoa.length); i++) {
        const line = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/存货编码|物资编码|物料编码/.test(line)) { hdrIdx = i; break; }
      }
      const h = aoa[hdrIdx].map(v => U.cleanStr(v));
      const iCode = findExactOrMatch(h, ['存货编码', '物料编码', '物资编码'], ['存货编码', '物料编码', '物资编码']);
      if (iCode < 0) return;
      const iName = findExactOrMatch(h, ['存货名称', '物料名称', '物资名称'], ['存货名', '物料名', '物资名', '名称'], /仓库|分类|货位|库位|组织|部门/);
      const iSpec = findExactOrMatch(h, ['规格型号', '规格'], ['规格']);
      const iWh = findExactOrMatch(h, ['仓库名称', '仓库'], ['仓库'], /编码|代码/);
      const iLoc = findExactOrMatch(h, ['货位编码', '库位编码', '货位代码'], ['货位编码', '库位编码', '货位'], /名称/);
      const iLocName = findExactOrMatch(h, ['货位名称', '库位名称'], ['货位名', '库位名'], /编码|代码/);
      const iCatCode = findExactOrMatch(h, ['存货分类编码', '物料分类编码', '分类编码'], ['分类编码', '大类编码']);
      const iCatName = findExactOrMatch(h, ['存货分类名称', '物料分类名称', '分类名称'], ['分类名', '大类名']);
      const iQty = findExactOrMatch(h, ['现存数量', '现存量', '可用数量', '结存主数量', '结存数量'], ['现存', '可用', '结存']);

      for (let i = hdrIdx + 1; i < aoa.length; i++) {
        const r = aoa[i];
        const code = U.formatCode(r[iCode]);
        if (!code || /合计|总计|编码/.test(code)) continue;
        count++;
        const rec = {
          code,
          name: iName >= 0 ? U.cleanStr(r[iName]) : '',
          spec: iSpec >= 0 ? U.cleanStr(r[iSpec]) : '',
          wh: iWh >= 0 ? U.cleanStr(r[iWh]) : sn,
          loc: iLoc >= 0 ? U.cleanStr(r[iLoc]) : '',
          locName: iLocName >= 0 ? U.cleanStr(r[iLocName]) : '',
          catCode: iCatCode >= 0 ? U.cleanStr(r[iCatCode]) : '',
          catName: iCatName >= 0 ? U.cleanStr(r[iCatName]) : '',
          qty: iQty >= 0 ? U.parseNum(r[iQty]) : 0
        };
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(rec);
      }
    });

    state.stockMap = map;
    state.stockCount = count;
    if (state.dailyRawRows.length) rebuildDailyOutput();
    persistState();
    U.toast(`现存量索引构建完成：${count} 条记录（${map.size} 个唯一编码，货位编码与货位名称已分离索引）`, 'success');
  }

  function activateDailySheet(sn) {
    const sh = state.dailySheets[sn];
    if (!sh) return;
    state.dailyActiveSheet = sn;
    state.dailyRawHeaders = sh.headers;
    state.dailyRawRows = sh.rows;
    state.dailyAvailDates = sh.availDates;
    // 默认自动定位表内最新自然日（无需每次手动下拉挑选，仍可随时切换为其他日期或全部）
    state.dailyTargetDate = sh.availDates && sh.availDates.length ? sh.availDates[0] : '';
    state.dailyPage = 1;
    rebuildDailyOutput();
  }

  function isMaterialCodeLike(s) {
    const c = U.formatCode(s);
    if (!c) return false;
    if (state.stockMap.has(c)) return true;
    return /^(?:1001P\d+|100P\d+|0[1-9]\d{5,10}|[A-Z]\d{5,}|9\d{5,})$/i.test(c);
  }

  function isWarehouseLike(s) {
    const t = U.cleanStr(s);
    if (!t || isMaterialCodeLike(t)) return false;
    return /^(?:综合仓?|工程物资仓?|通用仓?|配件仓?|辅料仓?|五金仓?|电厂仓?|设备仓?|化工仓?|劳保仓?|气瓶间?|物资仓|OST|P\d.*)$/i.test(t) || /仓$/.test(t);
  }

  async function loadDailyFile(file) {
    const parsed = await U.readSpreadsheet(file);
    const sheets = {};
    const validNames = [];

    parsed.sheetNames.forEach(sn => {
      const aoa = parsed.sheets[sn] || [];
      if (aoa.length < 2) return;
      let hdrIdx = -1;
      for (let i = 0; i < Math.min(8, aoa.length); i++) {
        const txt = aoa[i].map(v => U.cleanStr(v)).join(' ');
        if (/编码|物料|物资|存货名称/.test(txt) && /名称|数量|日期/.test(txt)) { hdrIdx = i; break; }
      }
      if (hdrIdx < 0) return;

      // 裁掉尾部全空列，避免出现多余空表头
      const rawH = aoa[hdrIdx].map(v => U.cleanStr(v));
      let lastNonEmptyCol = rawH.length - 1;
      while (lastNonEmptyCol >= 0 && !rawH[lastNonEmptyCol]) lastNonEmptyCol--;
      const headers = rawH.slice(0, lastNonEmptyCol + 1);

      const iDate = headers.findIndex(h => h.includes('日期'));
      const iPerson = headers.findIndex(h => /领料人|领用人|申请人|姓名/.test(h));
      const dates = new Set();
      const rows = [];

      // 逐行扫描并自动向下继承同一批次省略的「申报日期」与「领料人」（遇完全空行即断开）
      // 同时自动屏蔽历史行中误填的 =TODAY() / =NOW() 动态公式日期（防止旧记录每天跟着变当天日期混入筛选）
      const rawWs = parsed.wb && parsed.wb.Sheets ? parsed.wb.Sheets[sn] : null;
      const wsRange = rawWs && rawWs['!ref'] ? XLSX.utils.decode_range(rawWs['!ref']) : { s: { r: 0, c: 0 } };
      let volatileSkipped = 0;
      let lastDate = '';
      let lastPerson = '';
      for (let i = hdrIdx + 1; i < aoa.length; i++) {
        const sliced = aoa[i].slice(0, headers.length).map(v => U.cleanStr(v));
        if (sliced.every(v => v === '')) {
          lastDate = '';
          lastPerson = '';
          continue;
        }
        // 过滤明显非物料的纯备注/汇总行（如整行只有尾部1个非业务单元格）
        const nonEmptyCount = sliced.filter(v => v !== '').length;
        if (nonEmptyCount <= 1 && iDate >= 0 && !sliced[iDate]) continue;

        if (iDate >= 0) {
          let isVolatileDate = false;
          if (rawWs && typeof XLSX !== 'undefined' && XLSX.utils && XLSX.utils.encode_cell) {
            const cellAddr = XLSX.utils.encode_cell({ r: wsRange.s.r + i, c: wsRange.s.c + iDate });
            const rawCell = rawWs[cellAddr];
            if (rawCell && rawCell.f && /\b(?:TODAY|NOW)\s*\(/i.test(String(rawCell.f))) {
              isVolatileDate = true;
              volatileSkipped++;
            }
          }

          if (isVolatileDate) {
            // 误写 =TODAY() 的历史行改归入其上一行真实日期（若无则清空日期），不再污染当天筛选
            sliced[iDate] = lastDate || '';
          } else {
            const d = U.formatDate(sliced[iDate]);
            if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
              sliced[iDate] = d;
              lastDate = d;
              lastPerson = iPerson >= 0 ? sliced[iPerson] : '';
              dates.add(d);
            } else if (!sliced[iDate] && lastDate) {
              sliced[iDate] = lastDate;
              if (iPerson >= 0 && !sliced[iPerson] && lastPerson) {
                sliced[iPerson] = lastPerson;
              }
            }
          }
        }
        rows.push(sliced);
      }

      if (!rows.length) return;
      validNames.push(sn);
      sheets[sn] = { headers, rows, availDates: Array.from(dates).sort().reverse(), volatileSkipped };
    });

    if (!validNames.length) throw new Error('OST 申报表无有效数据工作表');

    // 多月份分表（如 26.01 ~ 26.11）：默认优先定位到最后一个有效表（最新月份）
    let defaultSn = validNames[validNames.length - 1];
    const mFile = file.name.match(/(\d{2,4})[.\-_](\d{1,2})[.\-_](\d{1,2})/);
    if (mFile) {
      const yy = mFile[1].slice(-2);
      const mm = mFile[2].padStart(2, '0');
      const matched = validNames.find(n => n.includes(`${yy}.${mm}`) || n.includes(`${yy}-${mm}`));
      if (matched) defaultSn = matched;
    }

    state.dailySheets = sheets;
    state.dailySheetNames = validNames;
    state.dailyFileName = file.name;
    activateDailySheet(defaultSn);
    persistState();
    const dateTip = state.dailyTargetDate ? `，已自动筛选最新日期 ${state.dailyTargetDate}（${state.dailyFilteredRows.length} 行）` : `（${state.dailyRawRows.length} 行）`;
    const volCnt = (sheets[defaultSn] && sheets[defaultSn].volatileSkipped) || 0;
    const volTip = volCnt > 0 ? `；已自动排除 ${volCnt} 行含 =TODAY() 公式的历史旧行` : '';
    U.toast(`OST 申报表载入成功：表 [${defaultSn}]${dateTip}${volTip}`, 'success');
  }

  const DAILY_STD_HEADERS = [
    '日期', '领料人', '仓库类型', '物资编码', '存货名称', '规格型号',
    '计量单位', '领用数量', '备注：', '货位编码', '货位名称', '项目大类', '使用位置'
  ];

  /** 自动判定使用位置编码：办公用品 -> SC015 | 劳保用品 -> SC013 | 其他物资 -> SC016 */
  function classifyUsagePos(code, name, stockHits) {
    const c = U.formatCode(code);
    const n = U.cleanStr(name);
    const catCodes = (stockHits || []).map(h => U.cleanStr(h.catCode)).filter(Boolean);
    const catNames = (stockHits || []).map(h => U.cleanStr(h.catName)).filter(Boolean).join(' ');

    // 1. 优先按 ERP 现存量存货分类与编码前缀精准判定（0803 劳保用品 / 0804 办公用具）
    if (c.startsWith('0803') || catCodes.some(k => k.startsWith('0803')) || /劳保|防护用品|worker\s*protective/i.test(catNames)) {
      return 'SC013';
    }
    if (c.startsWith('0804') || catCodes.some(k => k.startsWith('0804')) || /办公|office\s*appliances/i.test(catNames)) {
      return 'SC015';
    }
    // 2. 若已在现存量命中明确其他大类（如 1001P204 / 0806 / 0501），直接归为其他物资 SC016（如油漆记号笔 1001P20401437 -> SC016）
    if (catCodes.length > 0 || /^(?:1001P|100P|05|06|07|0806)/i.test(c)) {
      // 仅对明确劳保品名（如跨大类劳保手套/安全帽/防尘面具）做兜底
      if (/劳保|防尘面具|防毒面具|安全帽|劳保鞋|安全鞋|焊工手套|电工手套|防尘口罩|过滤棉/.test(n)) return 'SC013';
      return 'SC016';
    }
    // 3. 未入库编码按品名关键词兜底
    if (/劳保|防尘面具|防毒面具|口罩|手套|安全帽|安全鞋|护目镜|耳塞|耳罩|安全带|防护服|过滤棉/.test(n)) return 'SC013';
    if (/打印纸|A4|中性笔|圆珠笔|白板笔|订书|笔记本|文件夹|档案盒|计算器|回形针|墨水|硒鼓|碳粉|便利贴|纸巾|抽纸/.test(n)) return 'SC015';
    return 'SC016';
  }

  function rebuildDailyOutput() {
    const rawH = [...state.dailyRawHeaders];
    const iDate = rawH.findIndex(h => h.includes('日期'));
    const iPerson = rawH.findIndex(h => /领料人|领用人|申请人|姓名/.test(h));
    const iCode = rawH.findIndex(h => h.includes('编码') && !h.includes('货位') && !h.includes('用途'));
    const iName = rawH.findIndex(h => /存货名|物料名|物资名|名称/.test(h) && !/仓库|货位/.test(h));
    const iSpec = rawH.findIndex(h => /规格|型号/.test(h));
    const iUnit = rawH.findIndex(h => /单位/.test(h));
    const iQty = rawH.findIndex(h => /数量/.test(h));
    const iWh = rawH.findIndex(h => h.includes('仓库'));
    const iRem = rawH.findIndex(h => /备注|用途|说明/.test(h));
    const iRawLoc = rawH.findIndex(h => h.includes('货位') && !h.includes('名称'));

    const target = state.dailyTargetDate.trim();
    const out = [];

    let runDate = '';
    let runPerson = '';
    for (const rawRow of state.dailyRawRows) {
      const row = rawH.map((_, idx) => (idx < rawRow.length ? U.cleanStr(rawRow[idx]) : ''));
      if (iDate >= 0) {
        const normD = U.formatDate(row[iDate]);
        if (/^\d{4}-\d{2}-\d{2}$/.test(normD)) {
          row[iDate] = normD;
          runDate = normD;
          runPerson = iPerson >= 0 ? row[iPerson] : '';
        } else if (!row[iDate] && runDate) {
          row[iDate] = runDate;
          if (iPerson >= 0 && !row[iPerson] && runPerson) row[iPerson] = runPerson;
        }
        if (target && !(row[iDate] || '').includes(target)) continue;
      }

      // 自动回正「仓库插队进编码列导致编码/名称/规格/单位/数量整体右移 1 列」的错列行
      if (iCode >= 0 && iCode + 5 < rawRow.length) {
        const cellAtCode = row[iCode];
        const cellNext = row[iCode + 1];
        if (isWarehouseLike(cellAtCode) && isMaterialCodeLike(cellNext)) {
          const whVal = cellAtCode;
          const codeVal = U.formatCode(cellNext);
          const nameVal = row[iCode + 2] || '';
          const specVal = row[iCode + 3] || '';
          const unitVal = row[iCode + 4] || '';
          const qtyVal = row[iCode + 5] || '';
          row[iCode] = codeVal;
          if (iName >= 0) row[iName] = nameVal;
          if (iSpec >= 0) row[iSpec] = specVal;
          if (iUnit >= 0) row[iUnit] = unitVal;
          if (iQty >= 0) row[iQty] = qtyVal;
          if (iWh >= 0) row[iWh] = whVal;
        }
      }

      // 提取存货编码（含兜底横向扫描）
      let lookupCode = '';
      if (iCode >= 0) {
        const c0 = U.formatCode(row[iCode]);
        if (c0 && state.stockMap.has(c0)) {
          row[iCode] = c0;
          lookupCode = c0;
        } else {
          for (let k = 0; k < rawRow.length; k++) {
            const cand = U.formatCode(rawRow[k]);
            if (cand && /^(?:1001P\d+|100P\d+|0[1-9]\d{5,10})$/i.test(cand) && state.stockMap.has(cand)) {
              lookupCode = cand;
              break;
            }
          }
          if (!lookupCode && c0) row[iCode] = c0;
        }
      }

      // 从现存量补全全部有效货位（优先取正库存货位，严格分离「货位编码」与「货位名称」）
      let stockWhHint = '';
      let locCodeStr = iRawLoc >= 0 ? (row[iRawLoc] || '') : '';
      let locNameStr = '';
      let stockHits = [];
      if (lookupCode && state.stockMap.has(lookupCode)) {
        const allHits = state.stockMap.get(lookupCode) || [];
        const posHits = allHits.filter(h => h.qty > 0);
        stockHits = posHits.length ? posHits : allHits;
        stockWhHint = stockHits.map(h => U.cleanStr(h.wh)).filter(Boolean).join(' ');

        const seenPairs = new Set();
        const locCodes = [];
        const locNames = [];
        stockHits.forEach(h => {
          const lc = U.cleanStr(h.loc);
          const ln = U.cleanStr(h.locName);
          if (!lc && !ln) return;
          const pk = `${lc}||${ln}`;
          if (seenPairs.has(pk)) return;
          seenPairs.add(pk);
          if (lc) locCodes.push(lc);
          if (ln) locNames.push(ln);
        });
        if (locCodes.length) locCodeStr = locCodes.join(' / ');
        if (locNames.length) locNameStr = locNames.join(' / ');
      }

      const dateVal = iDate >= 0 ? (row[iDate] || '') : '';
      const personVal = iPerson >= 0 ? (row[iPerson] || '') : '';
      let whVal = iWh >= 0 ? (row[iWh] || '') : '';
      if (!whVal && stockHits.length && stockHits[0].wh) whVal = stockHits[0].wh;
      const codeVal = lookupCode || (iCode >= 0 ? U.formatCode(row[iCode]) : '');
      const nameVal = iName >= 0 ? (row[iName] || '') : '';
      const specVal = iSpec >= 0 ? (row[iSpec] || '') : '';
      const unitVal = iUnit >= 0 ? (row[iUnit] || '') : '';
      const qtyVal = iQty >= 0 ? (row[iQty] || '') : '';
      const remVal = iRem >= 0 ? (row[iRem] || '') : '';
      const projCat = '00';
      const usagePos = classifyUsagePos(codeVal, nameVal, stockHits);

      const stdRow = [
        dateVal, personVal, whVal, codeVal, nameVal, specVal,
        unitVal, qtyVal, remVal, locCodeStr, locNameStr, projCat, usagePos
      ];
      out.push({ row: stdRow, stockWhHint });
    }

    // 综合仓置顶 (0) -> 其他仓居中 (1) -> P3/P7/P9/110105/110110/2105 沉底 (2)
    function getBucket(item) {
      const row = item.row;
      const whTxt = `${row[2] || ''} ${item.stockWhHint || ''}`;
      const locTxt = `${row[9] || ''} ${row[10] || ''} ${whTxt}`.toUpperCase();
      if (/P3|P7|P9|110105|110110|2105/.test(locTxt)) return 2;
      if (whTxt.includes('综合仓')) return 0;
      return 1;
    }

    const indexed = out.map((item, idx) => ({ r: item.row, idx, b: getBucket(item) }));
    indexed.sort((a, b) => (a.b - b.b) || (a.idx - b.idx));

    state.dailyFilteredHeaders = DAILY_STD_HEADERS;
    state.dailyFilteredRows = indexed.map(x => x.r);
  }

  async function auditRequisitionFile(file) {
    if (state.stockMap.size === 0) {
      U.toast('请先导入【OST 现存量表】', 'warn');
      return;
    }
    const parsed = await U.readSpreadsheet(file);
    const sn = parsed.sheetNames.includes('横版')
      ? '横版'
      : (parsed.sheetNames.find(n => /箱件|清单|P9/i.test(n)) || parsed.sheetNames[0]);
    const aoa = parsed.sheets[sn] || [];
    let hdrIdx = 0;
    for (let i = 0; i < Math.min(35, aoa.length); i++) {
      const txt = aoa[i].map(v => U.cleanStr(v)).join(' ');
      if (txt.includes('编码') && txt.includes('名称')) { hdrIdx = i; break; }
    }

    // 保留原表完整表头（裁去尾部纯空列）
    const rawH = (aoa[hdrIdx] || []).map(v => U.cleanStr(v));
    let lastCol = rawH.length - 1;
    while (lastCol >= 0 && !rawH[lastCol]) lastCol--;
    const baseHeaders = rawH.slice(0, lastCol + 1);

    const iCode = baseHeaders.findIndex(x => /编码|kode/i.test(x) && !/货位|用途/.test(x));
    const iName = baseHeaders.findIndex(x => /名称|material/i.test(x));
    const iSpec = baseHeaders.findIndex(x => /规格|spesifikasi/i.test(x));
    const iUnit = baseHeaders.findIndex(x => /单位|unit/i.test(x));
    const iQty = baseHeaders.findIndex(x => /数量|qty/i.test(x));
    const iRem = baseHeaders.findIndex(x => /备注|komentar/i.test(x));
    let iInAcc = baseHeaders.findIndex(x => /是否在账|在账|akun\s*apakah/i.test(x));

    // 若原表暂无「是否在账」列，则在「备注」列前插入（严禁改动备注列）
    const outHeaders = [...baseHeaders];
    let insertedInAcc = false;
    if (iInAcc < 0) {
      insertedInAcc = true;
      if (iRem >= 0) {
        iInAcc = iRem;
        outHeaders.splice(iInAcc, 0, '是否在账');
      } else {
        iInAcc = outHeaders.length;
        outHeaders.push('是否在账');
      }
    }

    const backfillRows = [];
    const auditOut = [];
    let hasAccCnt = 0;
    let manualCnt = 0;
    let skippedCnt = 0;

    // 保留表头后的全部有效行（原行序 100% 锁定，备注列 100% 不改）
    let dataSlice = aoa.slice(hdrIdx + 1);
    while (dataSlice.length > 0 && dataSlice[dataSlice.length - 1].every(v => !U.cleanStr(v))) {
      dataSlice.pop();
    }

    for (let idx = 0; idx < dataSlice.length; idx++) {
      const r = dataSlice[idx];
      const rowCopy = baseHeaders.map((_, c) => (c < r.length ? U.cleanStr(r[c]) : ''));
      if (insertedInAcc) rowCopy.splice(iInAcc, 0, '');

      const codeRaw = iCode >= 0 ? U.formatCode(r[iCode]) : '';
      const name = iName >= 0 ? U.cleanStr(r[iName]) : '';
      const firstCell = U.cleanStr(r[0]);
      const lineJoined = r.map(v => U.cleanStr(v)).join(' ');
      const isRepeatedHeader = (lineJoined.includes('编码') && lineJoined.includes('名称')) || /^序号/i.test(firstCell);
      const isBannerOrSign = /^(箱件清单|附清单|开单员|领料人|领料单位|仓管员|仓储主管|编号)/.test(firstCell) ||
        /^(箱件清单|附清单|开单员|领料人|领料单位|仓管员|仓储主管)/.test(name);
      const isNonDataRow = isRepeatedHeader || isBannerOrSign || (!codeRaw && (
        !name ||
        /^(空白|合计|总计|小计|制单|审核|审批|主管|领料人)/.test(name) ||
        /^(空白|合计|总计|小计|制单|审核|审批|主管|领料人)/.test(firstCell)
      ));

      // 保持编码列文本格式与前导 0（排除表头文字行）
      const outCodeCol = insertedInAcc && iCode >= iInAcc ? iCode + 1 : iCode;
      if (!isNonDataRow && outCodeCol >= 0 && codeRaw) rowCopy[outCodeCol] = codeRaw;

      if (isNonDataRow) {
        // 空白/表尾行原样保留，不修改是否在账与备注
        backfillRows.push(rowCopy);
        continue;
      }

      const reqQty = iQty >= 0 ? U.parseNum(r[iQty]) : 0;

      if (!codeRaw) {
        // 铁律：没有写编码就跳过处理（是否在账不填，备注不改）
        skippedCnt++;
        backfillRows.push(rowCopy);
        auditOut.push([
          hdrIdx + 2 + idx, '', name,
          iSpec >= 0 ? U.cleanStr(r[iSpec]) : '',
          iUnit >= 0 ? U.cleanStr(r[iUnit]) : '',
          reqQty, '', '', '', '⏭️ 无编码跳过'
        ]);
        continue;
      }

      const matches = state.stockMap.get(codeRaw) || [];
      const totalStock = matches.reduce((s, m) => s + m.qty, 0);
      const p9Locs = matches.filter(m => m.wh.includes('P9') || m.loc.includes('2105')).map(m => `${m.loc}(${U.fmtNum(m.qty)})`).join('; ');
      const allLocs = matches.map(m => `${m.wh}:${m.loc || '无货位'}(${U.fmtNum(m.qty)})`).join(' | ');

      // 铁律：有对应编码就写「有」，无就写「未入库开手工单」，备注严禁改动
      if (matches.length > 0) {
        rowCopy[iInAcc] = '有';
        hasAccCnt++;
      } else {
        rowCopy[iInAcc] = '未入库开手工单';
        manualCnt++;
      }
      backfillRows.push(rowCopy);

      let status = '✅ 有（库存充足）';
      if (matches.length === 0) status = '❌ 未入库开手工单';
      else if (totalStock < reqQty) status = `⚠️ 有（库存不足，缺${U.fmtNum(reqQty - totalStock)}）`;

      auditOut.push([
        hdrIdx + 2 + idx, codeRaw, name,
        iSpec >= 0 ? U.cleanStr(r[iSpec]) : '',
        iUnit >= 0 ? U.cleanStr(r[iUnit]) : '',
        reqQty, U.fmtNum(totalStock), p9Locs, allLocs, status
      ]);
    }

    state.p9FileName = file.name;
    state.p9SheetName = sn;
    state.p9BackfillHeaders = outHeaders;
    state.p9BackfillRows = backfillRows;
    state.p9InAccCol = iInAcc;
    state.p9Stats = { total: auditOut.length, hasAcc: hasAccCnt, manual: manualCnt, skipped: skippedCnt };
    state.auditRows = auditOut;
    state.p9Page = 1;
    persistState();
    U.toast(`P9 核对完成：有 ${hasAccCnt} 条 | 未入库开手工单 ${manualCnt} 条 | 无编码跳过 ${skippedCnt} 条（备注零改动）`, 'success');
  }

  function renderModule(root) {
    const st = state.p9Stats || { total: 0, hasAcc: 0, manual: 0, skipped: 0 };

    root.innerHTML = `
      <div class="panel">
        <div class="panel-title">
          <span>⚡ OST 电厂物资工作台（每日物资筛选输出 & P9 现存量核对）</span>
          <div style="display:flex;gap:6px;">
            <button class="btn ${state.subTab === 'daily' ? 'btn-primary' : ''}" id="ost-sub-daily">📅 OST 每日物资筛选输出</button>
            <button class="btn ${state.subTab === 'p9' ? 'btn-primary' : ''}" id="ost-sub-p9">🔍 OST P9 领料核对</button>
          </div>
        </div>
        <div class="toolbar" style="margin-bottom:0;">
          <button class="btn" id="o-up-stock">📚 导入/更新 OST 现存量表 (.xls/.xlsx)</button>
          <input type="file" id="o-in-stock" accept=".xls,.xlsx,.csv" class="hidden-input" />
          <span class="pill ${state.stockMap.size ? 'pill-green' : 'pill-orange'}">
            ${state.stockMap.size ? `已载入现存量：${state.stockCount} 条 / ${state.stockMap.size} 唯一编码` : '尚未导入现存量（P9 核对必选，每日筛选可选自动补货位）'}
          </span>
        </div>
      </div>

      ${state.subTab === 'daily' ? `
        <div class="panel">
          <div class="panel-title">
            <span>📅 OST 每日物资筛选输出（标准 13 列：货位编码/名称 · 项目大类 00 · 使用位置 SC015/SC016/SC013 · 综合仓置顶 / P系沉底）</span>
            <span class="pill pill-blue">${state.dailyFileName || '待导入 OST 领料申报表'}</span>
          </div>
          <div class="toolbar">
            <button class="btn btn-primary" id="o-up-daily">📂 导入 OST 申报单 (.xlsx)</button>
            <input type="file" id="o-in-daily" accept=".xls,.xlsx,.csv" class="hidden-input" />
            ${state.dailySheetNames.length > 1 ? `
              <select id="o-daily-sheet" title="切换工作表/月份">
                ${state.dailySheetNames.map(sn => `<option value="${U.escHtml(sn)}" ${sn === state.dailyActiveSheet ? 'selected' : ''}>工作表：${U.escHtml(sn)}</option>`).join('')}
              </select>
            ` : ''}
            <select id="o-daily-date">
              <option value="">全部自然日 (${state.dailyRawRows.length} 行)</option>
              ${state.dailyAvailDates.map(d => `<option value="${d}" ${d === state.dailyTargetDate ? 'selected' : ''}>仅筛选：${d}</option>`).join('')}
            </select>
            <span style="flex:1"></span>
            <button class="btn btn-success" id="o-daily-copy" ${!state.dailyFilteredRows.length ? 'disabled' : ''}>📋 一键复制筛选结果</button>
            <button class="btn" id="o-daily-exp" ${!state.dailyFilteredRows.length ? 'disabled' : ''}>💾 导出 OST 每日输出 (.xlsx)</button>
          </div>
          <div id="o-daily-table"></div>
        </div>
      ` : `
        <div class="panel">
          <div class="panel-title">
            <span>🔍 OST P9 箱件清单核对（规则：有编码在账写「有」· 无写「未入库开手工单」· 无编码跳过 · 备注严禁改动）</span>
            <span class="pill pill-blue">${state.p9FileName || '待导入箱件清单 / P9 领料单'}</span>
          </div>
          <div class="kpi-grid">
            <div class="kpi-card blue"><div class="kpi-label">现存量记录数</div><div class="kpi-val">${state.stockCount}</div></div>
            <div class="kpi-card green"><div class="kpi-label">在账（写「有」）</div><div class="kpi-val">${st.hasAcc}</div></div>
            <div class="kpi-card ${st.manual ? 'red' : 'green'}"><div class="kpi-label">未入库开手工单</div><div class="kpi-val">${st.manual}</div></div>
            <div class="kpi-card orange"><div class="kpi-label">无编码（已跳过）</div><div class="kpi-val">${st.skipped}</div></div>
          </div>
          <div class="toolbar">
            <button class="btn btn-warning" id="o-up-req">📋 导入 P9 箱件清单 / 领料单</button>
            <input type="file" id="o-in-req" accept=".xls,.xlsx" class="hidden-input" />
            <button class="btn ${state.p9ViewMode === 'backfill' ? 'btn-primary' : ''}" id="o-p9-v-backfill">📄 原表回填视图（含备注）</button>
            <button class="btn ${state.p9ViewMode === 'audit' ? 'btn-primary' : ''}" id="o-p9-v-audit">🔍 10列现存量详单</button>
            <span style="flex:1"></span>
            <button class="btn" id="o-p9-copy-col" ${!state.p9BackfillRows.length ? 'disabled' : ''} title="仅复制「是否在账」单列，按原行序 1:1 直接贴回原 Excel，0 破坏原表格式与备注">📋 仅复制「是否在账」列</button>
            <button class="btn btn-success" id="o-exp" ${!state.p9BackfillRows.length && !state.auditRows.length ? 'disabled' : ''}>💾 导出回填+核对双表 (.xlsx)</button>
          </div>
          <div id="o-p9-table"></div>
        </div>
      `}
    `;

    root.querySelector('#ost-sub-daily').onclick = () => { state.subTab = 'daily'; renderModule(root); };
    root.querySelector('#ost-sub-p9').onclick = () => { state.subTab = 'p9'; renderModule(root); };

    const inStock = root.querySelector('#o-in-stock');
    root.querySelector('#o-up-stock').onclick = () => inStock.click();
    inStock.onchange = async e => {
      if (e.target.files[0]) {
        try { await loadStockFile(e.target.files[0]); renderModule(root); }
        catch (err) { U.toast('现存量导入失败：' + err.message, 'error'); }
      }
      e.target.value = '';
    };

    if (state.subTab === 'daily') {
      const inDaily = root.querySelector('#o-in-daily');
      root.querySelector('#o-up-daily').onclick = () => inDaily.click();
      inDaily.onchange = async e => {
        if (e.target.files[0]) {
          try { await loadDailyFile(e.target.files[0]); renderModule(root); }
          catch (err) { U.toast('申报单导入失败：' + err.message, 'error'); }
        }
        e.target.value = '';
      };
      const selSheet = root.querySelector('#o-daily-sheet');
      if (selSheet) {
        selSheet.onchange = e => {
          activateDailySheet(e.target.value);
          persistState();
          renderModule(root);
        };
      }
      root.querySelector('#o-daily-date').onchange = e => {
        state.dailyTargetDate = e.target.value;
        state.dailyPage = 1;
        rebuildDailyOutput();
        renderModule(root);
      };
      root.querySelector('#o-daily-copy').onclick = async () => {
        await U.copyAsTSV(state.dailyFilteredHeaders, state.dailyFilteredRows, false);
        U.toast(`已复制 ${state.dailyFilteredRows.length} 行 OST 每日筛选数据`, 'success');
      };
      root.querySelector('#o-daily-exp').onclick = () => {
        const iCode = state.dailyFilteredHeaders.indexOf('物资编码');
        const iLoc = state.dailyFilteredHeaders.indexOf('货位编码');
        const iProjCat = state.dailyFilteredHeaders.indexOf('项目大类');
        const tag = state.dailyTargetDate || '全量';
        U.exportWorkbook([{
          name: 'OST每日物资输出',
          headers: state.dailyFilteredHeaders,
          rows: state.dailyFilteredRows,
          textCols: [iCode, iLoc, iProjCat].filter(i => i >= 0)
        }], `OST每日物资输出_${tag}.xlsx`);
        U.toast(`已导出 OST每日物资输出_${tag}.xlsx`, 'success');
      };
      if (state.dailyFilteredHeaders.length) {
        const iLoc = state.dailyFilteredHeaders.indexOf('货位编码');
        const iLocName = state.dailyFilteredHeaders.indexOf('货位名称');
        U.renderPagedTable(root.querySelector('#o-daily-table'), {
          headers: state.dailyFilteredHeaders,
          rows: state.dailyFilteredRows,
          page: state.dailyPage,
          pageSize: 100,
          rowClassFn: r => (/P3|P7|P9|110105|110110|2105/i.test(`${r[iLoc] || ''} ${r[iLocName] || ''}`) ? 'row-warn' : ''),
          onPageChange: pg => { state.dailyPage = pg; renderModule(root); }
        });
      } else {
        root.querySelector('#o-daily-table').innerHTML = `<div class="empty-cell">请导入 OST 申报单（自动追加子项号/用途编码/货位编码，综合仓置顶、P3/P7/P9 沉底）</div>`;
      }
    } else {
      const inReq = root.querySelector('#o-in-req');
      root.querySelector('#o-up-req').onclick = () => inReq.click();
      inReq.onchange = async e => {
        if (e.target.files[0]) {
          try { await auditRequisitionFile(e.target.files[0]); renderModule(root); }
          catch (err) { U.toast('P9 领料单核对失败：' + err.message, 'error'); }
        }
        e.target.value = '';
      };
      root.querySelector('#o-p9-v-backfill').onclick = () => { state.p9ViewMode = 'backfill'; state.p9Page = 1; renderModule(root); };
      root.querySelector('#o-p9-v-audit').onclick = () => { state.p9ViewMode = 'audit'; state.p9Page = 1; renderModule(root); };
      root.querySelector('#o-p9-copy-col').onclick = async () => {
        const colIdx = state.p9InAccCol;
        if (colIdx < 0 || !state.p9BackfillRows.length) return;
        const lines = state.p9BackfillRows.map(r => String(r[colIdx] ?? '').replace(/[\t\r\n]+/g, ' '));
        await U.copyText(lines.join('\n'));
        U.toast(`已复制「是否在账」列（共 ${lines.length} 行，1:1 对齐原表行序，可直接粘贴回原表格）`, 'success');
      };
      root.querySelector('#o-exp').onclick = () => {
        const sheets = [];
        if (state.p9BackfillHeaders.length && state.p9BackfillRows.length) {
          const iCode = state.p9BackfillHeaders.findIndex(x => /编码|kode/i.test(x) && !/货位|用途/.test(x));
          sheets.push({
            name: state.p9SheetName || '箱件清单',
            headers: state.p9BackfillHeaders,
            rows: state.p9BackfillRows,
            textCols: iCode >= 0 ? [iCode] : []
          });
        }
        sheets.push({
          name: '现存量核对',
          headers: AUDIT_HEADERS,
          rows: state.auditRows,
          textCols: [1],
          numCols: [5, 6]
        });
        U.exportWorkbook(sheets, 'OST_P9_箱件清单核对结果.xlsx');
        U.toast('已导出 OST_P9_箱件清单核对结果.xlsx（含原表回填 + 现存量核对双表）', 'success');
      };

      if (state.p9ViewMode === 'backfill' && state.p9BackfillHeaders.length) {
        const colIdx = state.p9InAccCol;
        U.renderPagedTable(root.querySelector('#o-p9-table'), {
          headers: state.p9BackfillHeaders,
          rows: state.p9BackfillRows,
          page: state.p9Page,
          pageSize: 100,
          rowClassFn: r => {
            const v = colIdx >= 0 ? (r[colIdx] || '') : '';
            if (v === '有') return 'row-ok';
            if (v === '未入库开手工单') return 'row-err';
            return '';
          },
          onPageChange: pg => { state.p9Page = pg; renderModule(root); }
        });
      } else {
        U.renderPagedTable(root.querySelector('#o-p9-table'), {
          headers: AUDIT_HEADERS,
          rows: state.auditRows,
          page: state.p9Page,
          pageSize: 100,
          rowClassFn: r => r[9].startsWith('❌') ? 'row-err' : (r[9].startsWith('⚠️') ? 'row-warn' : (r[9].startsWith('✅') ? 'row-ok' : '')),
          onPageChange: pg => { state.p9Page = pg; renderModule(root); }
        });
      }
    }
  }

  WB.register({
    id: 'mod_ost',
    icon: '⚡',
    title: 'OST 每日筛选与P9',
    async mount(container) {
      this._root = container;
      renderModule(container);
      await hydrateState();
      renderModule(container);
    },
    async handleIncomingFiles(files) {
      for (const f of files) {
        if (/现存量/i.test(f.name)) await loadStockFile(f);
        else if (/P9|横版|箱件|清单/i.test(f.name)) { state.subTab = 'p9'; await auditRequisitionFile(f); }
        else { state.subTab = 'daily'; await loadDailyFile(f); }
      }
      if (this._root) renderModule(this._root);
    }
  });
})();
