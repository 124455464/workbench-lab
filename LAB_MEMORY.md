# 实验工作台专属记忆（LAB_MEMORY）

> **严格隔离声明（必读）**：
> - 本文件是 **6 合 1 实验工作台（`workbench_lab`）的专属跨设备记忆**，与生产库核心记忆（`gemini-core-hub/core/memory/MASTER_MEMORY.md`、`core/handoff/CURRENT_CONTEXT.md`）**物理完全隔离、互不污染**。
> - 任何在本实验窗口产生的测试反馈、模块改动、临时口径，**只记在本文件**，**绝不写入核心记忆**，**绝不修改生产目录 `core/`**。
> - 本目录拥有**独立的 GitHub 私有仓库**（`124455464/workbench-lab`），与主库 `gemini-core-hub` 完全分开，可在家/公司两台设备自由同步，零影响主库。

---

## 1. 跨设备切换标准流程（30 秒无缝衔接）

### 离开当前电脑前
1. 双击本目录的 `同步实验区.bat`（自动将最新代码 + `LAB_BRIEF.md` + `LAB_MEMORY.md` 推送到独立私有仓库 `workbench-lab`）。
2. 网页测试业务数据由 `lab_server.py` 自动通过独立实验 Gist (`e0bcb71c5149d8d7b4467022047c2367`) 同步，无需手动操作。

### 换到另一台电脑后
- **首次使用**：
  ```powershell
  git clone https://github.com/124455464/workbench-lab.git "c:\Users\lenovo\Desktop\ws\gemini-core-hub\local_only\workbench_lab"
  ```
  （若另一台电脑工作区路径不同，放进对应 `gemini-core-hub\local_only\workbench_lab` 或任意独立文件夹均可）
- **日常使用**：
  1. 双击 `同步实验区.bat` 拉取最新实验代码与本记忆文件。
  2. 双击 `启动实验工作台.bat` 启动本地服务 `http://127.0.0.1:8895/`。
  3. 在 Antigravity 中新开一个实验专窗，直接发送以下开场白：
     > 本窗口专用于测试与迭代 6 合 1 实验工作台。请先阅读 `workbench_lab/LAB_BRIEF.md` 和 `workbench_lab/LAB_MEMORY.md`，严格遵守隔离铁律（只改 `workbench_lab/`，绝不动核心记忆和生产库；每次改完同步更新 `LAB_MEMORY.md`）。读完回复“已就位”。

---

## 2. 独立三路同步架构（与生产环境 100% 区分）

| 维度 | 生产环境（核心） | 实验工作台（本区，完全隔离） |
|---|---|---|
| Git 仓库 | `124455464/gemini-core-hub` | `124455464/workbench-lab`（独立私有库） |
| 记忆文件 | `core/memory/MASTER_MEMORY.md` | `workbench_lab/LAB_MEMORY.md` |
| 云端数据 Gist | 正式 HJF Gist | 独立测试 Gist `e0bcb71c5149d8d7b4467022047c2367` |
| 本地端口 | 正式端口 | `http://127.0.0.1:8895/` |

---

## 3. 六大模块当前测试与验收状态

| Tab | 模块 | 文件 | 当前状态 | 备注 / 已知问题 |
|---|---|---|---|---|
| 0 | 壳层 & 公共工具 | `index.html`、`core_utils.js`、`lab_server.py` | 待实测 | 6-Tab 导航、100 行分页、前导 0 文本导出、Gist 镜像 |
| 1 | HJF 14列核算 | `modules/mod_hjf_embed.js` + `hjf_lab_embed.html` | 待实测 | 已修 2541 行 `escapeHtml` 引号语法错误 |
| 2 | 16列精简 & 黄单 | `modules/mod_16col_yellow.js` | 待实测 | 74→16 列 + 自取物资 + PDF/OCR + 顶部 3B 快捷填报条 |
| 3 | 照片核对 | `modules/mod_photo_check.js` | 待实测 | 左右分屏看图/PDF + 按空行拆票（剔除全部气体含丁烷气罐） |
| 4 | 呆滞品核扣 | `modules/mod_stagnant.js` | 待实测 | 分页展示 + 基数三级回溯 + 红字退库冲减 |
| 5 | OST 每日 & P9 | `modules/mod_ost.js` | 待实测 | 双子页：每日切片/排序 + P9 现存量核对（兼容伪装 `.xls`） |
| 6 | 劳保发放统计 | `modules/mod_laobao.js` | 待实测 | 实验专属口径：纯劳保，自动剔除全部纸巾类 |

---

## 4. 迭代日志（每次改完追加，跨设备直接续上）

- **初始建仓**：建立独立私有仓库 `124455464/workbench-lab` 与本实验专属记忆 `LAB_MEMORY.md`，新增 `同步实验区.bat` 与 `启动实验工作台.bat`，实现跨设备代码 + 实验记忆 + Gist 业务数据三路互通，零污染生产核心记忆。
