@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
set HOST=127.0.0.1
set PORT=4173
start "" cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:4173"
node server.js
