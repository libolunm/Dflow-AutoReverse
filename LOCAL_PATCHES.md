# 本地改动记录（相对上游 oldiron-666/Dflow）

上游：https://github.com/oldiron-666/Dflow  ·  基线 commit `bbe3bcb`（v0.1.0，2026-09-26）
升级方式：重新 clone 上游后，把下面的改动逐个重放。除本文件外，本项目未改上游任何逻辑。
本文件是维护者笔记：机器专属的 id、盘符与路径一律写成占位符，真实值留在不进版本库的
`配置.bat` 里。

## 1. 启动方式：只绑本机（新增文件，非改动）

`启动.bat` 是本地新增的，不是上游文件。它设置 `HOST=127.0.0.1` 后再 `node server.js`。

原因：上游默认 `HOST=0.0.0.0` 监听所有网卡，而 `/api/state` 无鉴权，会吐
`dflow-state.json` 全文（内含 Danbooru API Key、Pixiv Cookie、四家翻译引擎密钥）。
绑 127.0.0.1 后只有本机能访问。要局域网用手机刷图时，改回 `set HOST=0.0.0.0`，
但必须先加访问口令再暴露。

## 2. server.js：图片代理的 User-Agent（必改）

文件：`server.js`，`app.get("/api/image", ...)` 内。

上游用 Chrome 120 的 UA 抓图。实测 2026-09 起 `cdn.donmai.us` 走 Cloudflare Bot
Management：**浏览器式 UA 会收到 403 "Just a moment..." 挑战页**，而工具类 UA
（`DFlow/0.1 ...`、`Aaalice-Nodes/1.0`）直接 200 放行。现象是 Danbooru 瀑布流
全部空图，Pixiv 正常。

改为：

```js
const headers = { "User-Agent": "DFlow/0.1 (local image proxy)" };
```

`i.pximg.net` 对同一 UA 实测同样 200，所以 Pixiv 不受影响。注意 `scheduleCache()`
里的 `DFlow/0.1 (local reverse cache)` 本来就是工具 UA，无需改动。

## 3. public/mobile-adapter.js：加原生壳守卫（必改）

上游 `index.html` **无条件**引入 `mobile-adapter.js`，而这个文件会 monkey-patch
`window.fetch`，把所有 `/api/*` 请求改写成直连 `danbooru.donmai.us`（它是给 APK
单机模式写的）。在桌面浏览器里打开时，这些直连请求全部被 CORS 拦死，瀑布流永远
加载不出来，界面显示「加载失败：Failed to fetch」或 JS 的
「Cannot read properties of null (reading 'id')」（取决于哪个接口先炸）。

改为只在 Capacitor 原生壳里激活，浏览器访问本地服务端时直接退出：

```js
const nativeShell = Boolean(window.Capacitor) || location.protocol === 'capacitor:' ||
  (location.protocol === 'https:' && ['localhost','127.0.0.1'].includes(location.hostname));
if (!nativeShell) return;
```

同时把 `index.html` 里的引用改成 `./mobile-adapter.js?v=20260927-01`，让缓存过旧
文件的浏览器强制重新拉取（否则用户刷新后仍跑旧代码）。

诊断手法备查：`msedge --headless=new --enable-logging=stderr --log-level=0`
加 `--screenshot`，stderr 里能直接看到 `[Dflow] 纯手机端单机直连引擎已激活` 和
随后的 CORS 报错。

## 4. scripts/queue-originals.mjs（新增文件，非改动）

批量把「原始收藏」里的卡片移入「待反推」并等待高清原图缓存就绪，输出队列 JSON。
目的是省掉逐卡点 `AI` 按钮这一步，让「只点收藏 → 交给 agent」成为可能。

## 未改但必须知道的坑

- `/api/posts` 裸 `order:score` 会被 Danbooru 判 `ActiveRecord::QueryCanceled` 返回 500
  （已实测）。前端的聚合榜都带 `age:<1month` 前缀，所以实际用没问题；服务端那条
  `status:active` 降级重试对裸 `order:score` 无效。
- 前端 `/api/favorites` 是 PUT 全量替换语义，别用它做单条修改，单条改走 PATCH。
- PowerShell 的 `Invoke-WebRequest` 发中文/长 body 会让服务端收到空 prompt，
  写库操作一律用 node 发请求。

## 5. public/app.js：收藏即入队（必改，行为改动）

`toggleFavorite()` 里原本把新收藏写进 `original`（要先点 ♥ 再点 AI 才进反推队列）。
现在点 ♥ 直接把 `folder` 设成 `pending`、`autoEnabled=true`、`reverseStatus='idle'`，
一次点击就完成收藏加排队。取消收藏时整条移除，等于同时出队。
`index.html` 里 app.js 的版本参数同步改成 `?v=20260927-02` 以强制刷新。

## 6. scripts/watch-reverse.mjs + 启动-自动反推.bat（新增文件，非改动）

队列就绪时的自动唤醒器，补上「点收藏 → 自动反推」闭环里缺的一环：
前端只负责把卡片推入队列，真正触发 agent 的是这个常驻进程。它每 15 秒轮询
`/api/reverse/queue`，发现 `cacheStatus=ready && reverseStatus=idle` 且尚未通知过的
卡片，就通过 `dsh-cross-session/scripts/session.mjs send` 往 dsh 会话投递一条
带完整执行流程的 prompt，把 agent 唤醒去跑反推。

### 6.1 投递模式：pool（一张卡一个新会话，默认）与 pinned（旧）

**pool 模式（2026-10-04 改成「一张卡一个新会话」）**：`--workspace <workspaceId>`
指定新会话落在哪个工作区，id 在 `~/.dsh/storages/workspace.json` 里查；不传就落在
dsh 默认工作区（旧写法 `--spawn-cwd <绝对路径>` 仍然可用；两者不能同时给，dsh 会报
`session.create accepts workspaceId or cwd, not both`）。

1. 每发现一张新的就绪卡片，就用 `session.mjs create --workspace <id> --preset <preset>`
   **新建一个一次性会话**，只把这**一张**卡投进去，然后这个会话就专属这一张卡；
2. 同时运行的会话数由 `--max-live`（默认 3）限制，超出的卡片本轮 defer，下一轮再看；
3. 只有 watcher 自己开出来的会话算进并发（记账在 `data/watch-reverse-state.json`
   的 `sessions` 字段；见过 RUN 又变回 idle 就释放名额，创建后 15 分钟没跑起来也释放），
   所以你在同一个工作区里自己开的会话不会挡住反推队列。

改这个的起因有两条。最早的 pinned 模式投给「用户当前在用的会话」，反推会插进用户
手头的活里（日志里连着一串 `session busy, deferring`）。2026-09-27 改成 pool 后隔离了
主会话，但池子是**复用**的：一个会话处理完一张卡还空着，下一张继续塞进去，于是第二张
的上下文里躺着第一张的描述，措辞互相渗透，提示词被污染。现在一张卡一个新会话，
任何一张卡的提示词都看不到别的卡。

**pinned 模式（旧行为，仍保留）**：`--session <id>` 钉死目标会话；
`--session auto --cwd <工作区名>` 每次投递前重新解析（取列表中第一个 RUN 的会话），
这样换会话不用重启 watcher。只在「我就是要反推打断当前会话」时才用。
pinned 模式仍然是一批一起投。

启动参数不再写死在脚本里，而是由同目录的配置批处理提供（`_start_dflow.bat` 与
`启动-自动反推.bat` 都会先 call 它，再把 `%DFLOW_WATCH_ARGS%` 原样传给 watcher；
模板见 `配置.example.bat`，真实文件 `配置.bat` / `config.local.bat` 都在 .gitignore 里）：

```
set "DFLOW_WATCH_ARGS=--workspace <workspaceId> --spawn-preset <预设名>"
```

`--spawn-preset` 建议别省：agent 预设决定世界书注入，反推的「体态描述铁律」
和 krea2 任务路由都在那份世界书里。
- 已通知的 id 记在 `data/watch-reverse-state.json`；卡片离开队列后该记录清除，
  重新入队能再次触发。
- `--cooldown` 默认 0。每卡独立投递后不再需要「批量窗口」，限流交给 `--max-live`；
  给个 N 分钟就是投递一张后停 N 分钟。
- 反推会话写临时提示词的位置固定成 `dflow\data\reverse-tmp\_prompt_<id>.txt`，
  不再往工作区根目录丢 `_prompt_*.txt`。
- 依赖 dsh web 在跑（凭证从 `~/.dsh/dsh-web-<port>.state.json` 现取）。
  投递失败会打 `WAKE FAILED` 且不记账，下一轮自动重试。
- **pinned 模式投递前先看目标会话是否 RUN**（判忙用 `session.mjs list` 的行首 RUN 标记），
  忙就只打一行 `session busy, deferring ...`，不投递也不记账，下一轮再看。不加这道闸
  会出现重复唤醒：卡片已经被 agent 顺手处理掉了，那条排队的 prompt 过一会儿才送达，
  白烧一轮。pool 模式不需要这道闸——每个会话都是新的，不存在「上一批还没跑完」。
- `--max-jobs`（会话跑满 N 批退休）随复用逻辑一起删掉了。

## 7. 待反推卡片的布局与状态文案（必改，体验改动）

原布局下竖图卡片是「正方形卡片里左侧一条窄图片 + 右侧一竖列控件」：卡片
`aspect-ratio: 1`，竖图的 `.reverse-picture` 被设成 `height:100%; width:auto`，
于是图片只占左边缘一条，五样控件（复制提示词、状态灯、队列按钮、预设下拉、
额外要求输入框）全挤在右边一列，看起来像一块飘在卡片外面的碎片。

改动（全部限定在 `.reverse-card.pending-card` 选择器内，有词区/已完成栏不受影响）：

- 卡片改 `aspect-ratio: 3/4` + `flex-direction: column`；图片区 `width:100%; flex:1`；
  控件条固定在图片下方横排。app.js 里 pending 分支不再写入 picture 的内联宽高。
- 图片用 `object-fit: contain` 而不是 `cover`——待反推是要确认「我收的是这张」，
  看全比填满重要。
- 状态文案从笼统的「等待」改成实际阶段：`正在缓存原图…` / `AI 反推中…` /
  `排队第 N 位` / `出错，点此重试`。
- **控件折叠**：卡片默认只露一行（状态灯 + 文案 + 齿轮按钮），队列位次、预设下拉、
  额外要求输入框都收进 `.reverse-advanced`，点齿轮才展开（`.hidden` 类切换）。
  同时 `createPromptControl` 的复制气泡在 `!post.prompt` 时隐藏——待反推卡片本来
  没有提示词，之前那里只显示一个禁用的灰按钮。折叠后面板从三行降到一行。

核对方式：`msedge --headless=new --screenshot`，并在 index.html 临时注入一段
自动切到「本地收藏 → 待反推」的脚本，截完立刻移除。

## 8. 待反推进度在刷图页不可见（未改，遗留）

反推进度目前只在「本地收藏 → 待反推」栏可见，刷图页的卡片上只有实心心形，
看不出这张是排队中、反推中还是已完成。若要改，需在刷图页卡片上叠加一个状态点，
数据源是 `readFavorites()` 里的 `reverseStatus`。

## 9. 机器专属配置外置 + watcher 去硬编码（必改，分享给别人的前提）

原本两个启动批处理把 workspaceId 和预设名硬编码在命令行里，`watch-reverse.mjs`
也把发送器路径、工作区过滤词写成了本机盘符下的固定值。要把这份改动给别人用，这些
都得先从代码里拿出去。

- 两个启动批处理（`_start_dflow.bat`、`启动-自动反推.bat`）现在都先
  `call 配置.bat`（不存在则 `call config.local.bat`），再把 `%DFLOW_WATCH_ARGS%`
  原样传给 watcher。模板是 `配置.example.bat`，两个真实配置文件都进了 .gitignore，
  所以工作区 id 之类的机器专属值不会进版本库。
- `watch-reverse.mjs` 的 `--sender` 不再指向固定盘符，改成三级取值：显式
  `--sender` 参数 → 环境变量 `DFLOW_SENDER` → 按约定位置自动探测
  （`../deployed-skills/dsh-cross-session/scripts/session.mjs`、
  `../dsh-cross-session/scripts/session.mjs`、`vendor/` 下、`~/.dsh/skills/` 下、
  `~/.dsh/deployed-skills/` 下）。全都找不到就打印候选路径并以退出码 1 结束，
  不再默默失败。
- workspace / spawn-cwd / preset / cwd 过滤的默认值全部清空，改为参数或同名环境变量
  （`DFLOW_WORKSPACE`、`DFLOW_SPAWN_CWD`、`DFLOW_SPAWN_PRESET`、`DFLOW_CWD_FILTER`）。
  一个都不给时：新会话落在 dsh 默认工作区、且不带任何 agent 预设，启动日志会把这
  两件事明写出来，避免"以为配好了其实没生效"。
- `.gitattributes` 里加了 `* -text`：批处理是 GBK 编码，git 不能对它做行尾或编码
  转换，否则含中文路径的行会被整行搞坏。
- `.gitignore` 加 `配置.bat` 与 `config.local.bat`。

## 10. bat 编码实测：结论「存 GBK」，但它取决于谁启动

配置外置之后，启动批处理里就出现了中文文件名（`配置.bat`），于是必须先确定 cmd
到底按什么编码读 bat。同一台机器上实测出两个完全相反的结果：

- **explorer 双击启动**（用户的实际用法）：GBK 编码的 bat 里
  `if exist "%~dp0配置.bat"` 判定 EXISTS、`call` 成功、变量正常注入。
  同一内容的 UTF-8 版本反而不写日志、不生效。
- **从 PowerShell 7 启动 `cmd /c xxx.bat`**：结果反过来——UTF-8 版打 EXISTS，
  GBK 版报 `'D:\...\????.bat' is not recognized`。

根因是控制台代码页继承：pwsh 7 把 `[Console]::OutputEncoding` 设成 UTF-8(65001)，
子进程 cmd 就按 UTF-8 解释 bat 内容；explorer 双击时环境是系统默认，本机
ACP 与 OEMCP 都是 936，于是按 GBK 解释。注册表 `Nls\CodePage` 的 ACP 一直是 936，
**它并不能代表"cmd 实际用什么读 bat"**，别拿它下结论。

据此定的方案：

- bat 一律存 **GBK、无 BOM、CRLF**（`配置.example.bat`、`_start_dflow.bat`、
  `启动-自动反推.bat`）。
- 加载配置写成两行兜底：先试中文名 `配置.bat`，没拿到再试纯 ASCII 名
  `config.local.bat`。纯 ASCII 那一行在两种代码页下都能命中，所以从 UTF-8 控制台
  启动也不会静默丢掉配置。
- **非 ASCII 字符不许出现在 bat 的路径、文件名或命令里**，只允许留在 `rem` 与
  `echo` 中——这样即使代码页判断错了，最坏也只是提示文字乱码，不会让整条命令失效。
- `.gitattributes` 的 `* -text` 保证 git 不对这些字节做行尾或编码转换。

排查手法备查：用 Unicode 码点在 PowerShell 里构造文件名（`[char]0x914D + [char]0x7F6E`），
不要在命令里写中文字面量。否则很容易把**已经是 GBK 的文件再按 UTF-8 读一遍**，
中文会被替换成 U+FFFD 永久损坏——本次就踩了这个，一度得出现场被污染的假结论。

