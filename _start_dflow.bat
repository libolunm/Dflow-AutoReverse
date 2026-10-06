@echo off
rem Dflow server + reverse-queue watcher (launched together with your image stack).
rem Local overrides (workspace id, agent preset, sender path) go in a config file next to
rem this script -- copy ÅäÖÃ.example.bat to ÅäÖÃ.bat, or on a non-Chinese Windows create
rem config.local.bat with the same syntax. Both are git-ignored.
cd /d "%~dp0"
if exist "%~dp0ÅäÖÃ.bat" call "%~dp0ÅäÖÃ.bat"
if not defined DFLOW_WATCH_ARGS if exist "%~dp0config.local.bat" call "%~dp0config.local.bat"
if not exist node_modules call npm install

rem Bind to loopback only: /api/state has no auth and dumps dflow-state.json,
rem which holds your Danbooru key, Pixiv cookie and translation secrets.
set HOST=127.0.0.1
set PORT=4173

start "DflowServer" /min cmd /c "node server.js 1> data\server.log 2>&1"
timeout /t 3 >nul
start "DflowWatch" /min cmd /c "node scripts\watch-reverse.mjs %DFLOW_WATCH_ARGS% 1> data\watch.log 2>&1"
start "" "http://127.0.0.1:4173"
