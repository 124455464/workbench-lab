# 实验工作台（新模块测试专窗交接单）

> **隔离铁律**：本窗口**仅负责** `local_only/workbench_lab/` 内的 6 合 1 实验工作台测试与单模块迭代。
> **严禁修改**生产目录 `core/code/`、`core/memory/`、`core/handoff/`、正式 HJF Gist、现有 Gemini 正式窗口，以及任何 Windows 电源/巡检配置。测试全部跑通后，由用户切回「核心记忆与巡检」主窗口统一合并回归。

## 1. 运行入口与隔离环境
- **实验目录**：`c:\Users\lenovo\Desktop\ws\gemini-core-hub\local_only\workbench_lab\`（已在 `.gitignore` 中完全隔离）
- **本地预览服务**：`http://127.0.0.1:8895/`（由 `lab_server.py` 提供，同时持久化至 `lab_data/<modId>.json`）
- **独立测试 Gist**：`e0bcb71c5149d8d7b4467022047c2367`（与正式环境物理隔离，支持公司电脑零落地实时同步回本机）
- **独立跨设备仓库 & 实验记忆**：本目录独立托管于私有仓库 `124455464/workbench-lab`（与主库 `gemini-core-hub` 完全分开），专属实验记忆记录在 `LAB_MEMORY.md`（严禁写入核心记忆），换设备前后双击 `同步实验区.bat` 即可同步代码与实验记忆。

## 2. 模块清单（改哪修哪，互不牵连）
| Tab | 模块文件 | 核心功能与实验口径 |
|---|---|---|
| 壳层 & 公共工具 | `index.html`、`core_utils.js`、`lab_server.py` | 6-Tab 导航、全局拖拽路由、防沙盒存储、100 行分页渲染、前导 0 `@` 文本导出、Gist 同步 |
| 1. HJF 14列核算 | `modules/mod_hjf_embed.js` + `hjf_lab_embed.html` | `iframe` 物理沙盒隔离运行 HJF v3.2 多表工具（已修复 2541 行 `escapeHtml` 引号语法错误） |
| 2. 16列精简 & 黄单 | `modules/mod_16col_yellow.js` | 74→16 列精简 + 自取物资双表 + 手机扫描 PDF 提取（PDF.js + Tesseract OCR）+ **顶部 3B 未回收快捷填报条**（原行序 100% 锁定，原位回填 N 列，支持一键 TSV 复制） |
| 3. 照片核对 | `modules/mod_photo_check.js` | 左右分屏看图/PDF + 按空行拆票卡片（自动剔除含丁烷气罐在内的全部气体） |
| 4. 呆滞品核扣 | `modules/mod_stagnant.js` | 分页展示、基数三级回溯、同编码优先扣减前轮活动行、红字退库冲减 |
| 5. OST 每日 & P9 | `modules/mod_ost.js` | 双子页：① 每日自然日筛选 + 追加 3 列 + 综合仓置顶/P3·P7·P9 沉底；② P9 现存量核对（兼容 HTML 伪装 `.xls`） |
| 6. 劳保发放统计 | `modules/mod_laobao.js` | **实验专属口径**：纯劳保物资统计，自动剔除全部纸巾类（`纸巾/抽纸/卷纸/卫生纸/面巾纸/擦手纸/餐巾纸`） |

## 3. 测试与验收原则
- 结论前置、精简干练；表格处理必须核对源单与输出行数一致；严禁用系统时间猜测业务日期。
- 发现某个模块有细节问题，仅修改对应 `modules/mod_*.js` 文件并刷新 `http://127.0.0.1:8895/` 验证。
- 待 6 个模块全部用真实表格/PDF 跑通后，用户将切回「核心记忆与巡检」主窗口，统一执行转正回归（含顺手修复生产版 `core/code/hjf_web_tool/hjf_outbound_tool.html` 第 2541 行同款引号 bug）。
