@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   6合1 实验工作台 - 独立跨设备同步
echo   (仅同步 workbench_lab，绝不触碰核心记忆)
echo ==========================================
echo.

echo [1/3] 拉取远端最新实验代码与 LAB_MEMORY.md ...
git pull --rebase origin main
if errorlevel 1 (
    echo [警告] 拉取时遇到冲突或网络异常，请检查上方提示！
    pause
    exit /b 1
)

echo.
echo [2/3] 检查本地实验改动 ...
git add -A
git diff --cached --quiet
if errorlevel 1 (
    for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH:mm"') do set NOW=%%i
    git commit -m "lab sync %NOW%"
) else (
    echo 本地无新改动，跳过提交。
)

echo.
echo [3/3] 推送到独立私有仓库 workbench-lab ...
git push -u origin main
if errorlevel 1 (
    echo [错误] 推送失败，请检查网络或 GitHub 登录状态。
    pause
    exit /b 1
)

echo.
echo [完成] 实验代码与 LAB_MEMORY.md 已同步至云端！
pause
