@echo off
cd /d "%~dp0"
if exist "%~dp0配置.bat" call "%~dp0配置.bat"
if not defined DFLOW_WATCH_ARGS if exist "%~dp0config.local.bat" call "%~dp0config.local.bat"
if not exist node_modules call npm install
set HOST=127.0.0.1
set PORT=4173
start "dflow-server" /min cmd /c "node server.js"
timeout /t 3 >nul
start "" "http://127.0.0.1:4173"
echo Dflow 服务已在 127.0.0.1:4173 启动，队列监听已开启。
echo 页面上点心形图标收藏，图片自动进入反推队列；
echo watcher 会为每一张就绪的卡片新开一个独立会话做反推，
echo 既不打断你当前对话，也不会让上一张的提示词污染下一张。
node scripts\watch-reverse.mjs %DFLOW_WATCH_ARGS%
