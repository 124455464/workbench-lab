@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动 6合1 实验工作台本地服务 (http://127.0.0.1:8895/) ...
start "" "http://127.0.0.1:8895/"
python lab_server.py
pause
