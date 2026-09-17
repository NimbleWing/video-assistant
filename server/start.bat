@echo off
chcp 65001 >nul
cd /d %~dp0
echo ================================================
echo  本地媒体库服务  http://127.0.0.1:17321
echo  关闭本窗口或按 Ctrl+C 停止
echo ================================================
node --no-warnings --experimental-sqlite server.js
pause
