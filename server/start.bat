@echo off
cd /d %~dp0
echo ================================================
echo  Local media server  http://127.0.0.1:17321
echo  Close this window or press Ctrl+C to stop.
echo ================================================
node --no-warnings --experimental-sqlite server.js
pause
