@echo off
rem ============================================================
rem  复制本文件为 配置.bat（放在同一目录），按需修改。
rem  配置.bat 已写进 .gitignore，不会被提交，也不会盖掉别人的设置。
rem  整个文件都是可选的：不建它 watcher 照样能跑，
rem  只是新会话会落在 dsh 默认工作区、并且不带任何 agent 预设。
rem ============================================================

rem 每张就绪的卡片新开哪个 dsh 工作区的会话；workspaceId 在
rem ~/.dsh/storages/workspace.json 里找。--spawn-preset 填你的 agent
rem 预设名（它决定世界书和规则注入），没有就给空。
set "DFLOW_WATCH_ARGS=--workspace <你的 workspaceId> --spawn-preset <你的预设名>"

rem 其它可以加进上面那一行的参数（全都可省略）：
rem   --spawn-cwd "<绝对路径>"      用目录代替 workspaceId（两者不能同时给）
rem   --max-live 3                   同时最多几个反推会话在跑
rem   --interval 15                  轮询间隔秒数
rem   --cooldown 0                   投递一张之后停 N 分钟
rem   --sender "<...session.mjs>"    dsh-cross-session 的 session.mjs 路径
rem                                  （自动探测失败时才需要手动指定）
