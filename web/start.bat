@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Chua cai Node.js. Tai tai https://nodejs.org & pause & exit /b 1)
rem Chay tren may: tat lich tu dong de khong goi LGSP trung voi VPS (cung khoa LGSP).
set SCHEDULER_ENABLED=false
set BACKUP_ENABLED=false
start "" http://localhost:3000
node server.js
pause
