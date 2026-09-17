@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rouvideo.media" /f >nul 2>&1
del "%~dp0com.rouvideo.media.json" >nul 2>&1
echo Native messaging host uninstalled.
pause
