// Watch the Dflow reverse queue and wake an agent session the moment a card is ready.
//
// Flow: you click the heart in the browser -> the card lands in 待反推 -> the server
// downloads the hi-res original -> this watcher sees it become eligible and posts a prompt
// into a brand-new dsh session, which does the reverse prompting for that one card.
//
// One card = one brand-new session. Reusing a single session let the later cards inherit
// the earlier cards' wording through the conversation context, and that bled into the
// prompts; a throwaway session per card keeps every reverse prompt clean. New sessions are
// created inside their own workspace (pass --workspace, or the legacy --spawn-cwd) so the
// reverse work never touches the conversation you are using.
//
// Delivery modes:
//   pool (default): one brand-new session per card, created in --workspace (or --spawn-cwd
//     for the legacy path form). --max-live caps how many of them run at once; the cards
//     above the cap simply wait for a later poll.
//   pinned (legacy): --session <id> or --session auto, which delivers into whichever
//     conversation is currently RUNning under --cwd.
//
// Usage:
//   node scripts/watch-reverse.mjs
//   node scripts/watch-reverse.mjs --workspace <workspaceId> --spawn-preset <preset>
//   node scripts/watch-reverse.mjs --spawn-cwd "<abs path>"   (cwd instead of workspaceId)
//   node scripts/watch-reverse.mjs --session <dshSessionId>
//
// Options: --interval <sec> (default 15) | --cooldown <min> (default 0)
//          --max-live <n> (default 3)  | --sender <path to dsh-cross-session/scripts/session.mjs>
//
// Environment equivalents: DFLOW_URL | DFLOW_SENDER | DFLOW_WORKSPACE | DFLOW_SPAWN_CWD |
//                          DFLOW_SPAWN_PRESET | DFLOW_CWD_FILTER
//
// --sender is the one real requirement: this watcher reaches dsh through the
// dsh-cross-session skill, so it needs that skill's scripts/session.mjs. Pass --sender (or
// set DFLOW_SENDER) unless the skill sits in one of the auto-detected locations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; };

const BASE = process.env.DFLOW_URL || 'http://127.0.0.1:4173';
const INTERVAL_MS = Math.max(5, Number(arg('--interval', 15))) * 1000;
const COOLDOWN_MS = Math.max(0, Number(arg('--cooldown', 0))) * 60 * 1000;
const CWD_FILTER = arg('--cwd', process.env.DFLOW_CWD_FILTER || '');
const STATE_FILE = path.join(root, 'data', 'watch-reverse-state.json');
const TMP_DIR = path.join(root, 'data', 'reverse-tmp');
const CLI = path.join(root, 'scripts', 'reverse-cli.mjs');

// dsh-cross-session/scripts/session.mjs is the bridge to the live dsh instance. Nothing
// machine-specific is baked in: --sender wins, then $DFLOW_SENDER, then a few conventional
// locations next to this checkout and under the user profile.
const SENDER_CANDIDATES = [
  path.join(root, '..', 'deployed-skills', 'dsh-cross-session', 'scripts', 'session.mjs'),
  path.join(root, '..', 'dsh-cross-session', 'scripts', 'session.mjs'),
  path.join(root, '..', 'skills', 'dsh-cross-session', 'scripts', 'session.mjs'),
  path.join(root, 'vendor', 'dsh-cross-session', 'scripts', 'session.mjs'),
  path.join(os.homedir(), '.dsh', 'skills', 'dsh-cross-session', 'scripts', 'session.mjs'),
  path.join(os.homedir(), '.dsh', 'deployed-skills', 'dsh-cross-session', 'scripts', 'session.mjs')
];
function resolveSender() {
  const explicit = arg('--sender', process.env.DFLOW_SENDER || '');
  if (explicit) return path.resolve(explicit);
  for (const candidate of SENDER_CANDIDATES) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return '';
}
const SENDER = resolveSender();

// Pool mode: new sessions are born in their own workspace instead of your conversation.
// Point it at a throwaway workspace with --workspace <workspaceId> (the id lives in
// ~/.dsh/storages/workspace.json) or the legacy --spawn-cwd <abs path>. With neither, dsh
// falls back to its default workspace: the reverse turn still runs in a brand-new session,
// it just shares your default directory.
const SPAWN_WORKSPACE = arg('--workspace', process.env.DFLOW_WORKSPACE || '');
const SPAWN_CWD = arg('--spawn-cwd', process.env.DFLOW_SPAWN_CWD || '');
const SPAWN_PRESET = arg('--spawn-preset', process.env.DFLOW_SPAWN_PRESET || '');
const MAX_LIVE = Math.max(1, Number(arg('--max-live', 3)));
// A session that is never seen RUNning still has to give its --max-live slot back once in
// a while: either it finished faster than a poll interval, or the wake never landed at all.
const GIVEUP_MS = 3 * 60 * 1000;

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const targetSession = arg('--session', process.env.DFLOW_WAKE_SESSION || '');
// An explicit --session means the legacy pinned mode; otherwise every card gets a fresh one.
const POOL_MODE = !targetSession;

// ---- dsh session helpers (all via dsh-cross-session/scripts/session.mjs) ----

function runSender(args) {
  const r = spawnSync(process.execPath, [SENDER, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout;
}

function listSessions() {
  const args = ['list'];
  if (CWD_FILTER) args.push('--cwd', CWD_FILTER);
  args.push('--limit', '10');
  const stdout = runSender(args);
  if (stdout === null) return null;
  return stdout.split(/\r?\n/);
}

function resolveSession() {
  const lines = listSessions();
  if (!lines) throw Error('session list failed');
  const running = lines.find(line => /^\s*RUN/.test(line));
  const match = (running || lines.join('\n')).match(/session-[0-9a-f-]+/);
  if (!match) throw Error('no dsh session matched');
  return match[0];
}

function getSession() {
  if (targetSession && targetSession !== 'auto') return targetSession;
  return resolveSession();
}

// Waking a session that is mid-turn only queues a duplicate wake-up: by the time it
// is delivered the card is usually already handled, and it burns a whole extra turn.
function sessionIsBusy(session) {
  const lines = listSessions();
  if (!lines) return false;
  const line = lines.find(l => l.includes(session));
  return Boolean(line && /^\s*RUN/.test(line));
}

// ---- pool mode: one card, one brand-new session ----

function createReverseSession() {
  const args = ['create'];
  if (SPAWN_PRESET) args.push('--preset', SPAWN_PRESET);
  if (SPAWN_WORKSPACE) args.push('--workspace', SPAWN_WORKSPACE); // dsh rejects workspaceId + cwd together
  else if (SPAWN_CWD) args.push('--cwd', SPAWN_CWD);
  const stdout = runSender(args);
  if (!stdout) return null;
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const m = line.match(/"sessionId"\s*:\s*"(session-[0-9a-f-]+)"/);
    if (m) return m[1];
  }
  return null;
}

// Refresh the live count. Only sessions this watcher created are counted, so sessions you
// run yourself in the same workspace never block the reverse queue. A session stops
// occupying a slot once it has been seen RUNning and is idle again (= it finished its turn).
function refreshPool() {
  const stdout = runSender(['list', '--limit', '60']);
  if (stdout === null) return null;
  const lines = stdout.split(/\r?\n/);
  const now = Date.now();
  for (const [sid, rec] of Object.entries(sessions)) {
    const line = lines.find(l => l.includes(sid));
    if (line && /^\s*RUN/.test(line)) { rec.seenRun = true; continue; }
    if (rec.seenRun) { delete sessions[sid]; continue; }
    if (now - rec.at > GIVEUP_MS) { delete sessions[sid]; continue; }
  }
  return Object.keys(sessions);
}

function wake(ids, session) {
  const text = [
    `Dflow 反推队列有 ${ids.length} 张新卡片就绪（本条由 watch-reverse.mjs 自动投递，无需向我确认来源）。`,
    ``,
    `本次只处理这一张：${ids.join(', ')}`,
    ``,
    `执行流程：`,
    `1. node "${CLI}" next 领任务（领到的那张 id 就是上面这张）。`,
    `2. 用 read_image 打开返回的 imagePath（服务端已缓存的高清原图）。`,
    `3. 同时读 GET ${BASE}/api/reverse/queue，用该 id 带的信息交叉校准视觉判断（Danbooru 卡片带官方 tag，比纯看图准）。`,
    `4. 按 krea2-prompt-suite 的反推规范写英文提示词到 ${path.join(TMP_DIR, `_prompt_<id>.txt`)}。`,
    `5. node "${CLI}" complete <id> <提示词文件> <preset> 回写（preset 必须与队列里的 preset 一致）。`,
    `6. 完成后 PATCH ${BASE}/api/favorites/<id> {"folder":"completed"} 归档。`,
    ``,
    `说明：这是为上面那一张卡片单独开的一次性会话（与用户主会话隔离）。处理完这一张就结束，不要去做流程之外的事，也不用等下一张——watcher 会给下一张另开一个新会话。`
  ].join('\n');
  const r = spawnSync(process.execPath, [SENDER, 'send', session, '--text', text], { encoding: 'utf8' });
  if (r.status !== 0) return `send failed: ${(r.stderr || r.stdout || r.status).toString().trim().slice(0, 300)}`;
  return null;
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const writeState = state => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

const state = readState();
const notified = new Set(state.notified || []);
let coolingUntil = state.coolingUntil || 0;
const sessions = { ...(state.sessions || {}) };

try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch { /* best effort */ }

if (!SENDER) {
  console.error([
    'watch-reverse: cannot locate dsh-cross-session/scripts/session.mjs, which is what this',
    'watcher uses to talk to dsh. Pass it explicitly:',
    '  node scripts/watch-reverse.mjs --sender "<path to dsh-cross-session/scripts/session.mjs>"',
    'or set DFLOW_SENDER. Locations already tried:',
    ...SENDER_CANDIDATES.map(c => `  ${c}`)
  ].join('\n'));
  process.exit(1);
}

const spawnWhere = SPAWN_WORKSPACE ? `workspace ${SPAWN_WORKSPACE}`
  : SPAWN_CWD ? `cwd ${SPAWN_CWD}`
    : 'dsh default workspace';
const where = POOL_MODE
  ? `new session per card in ${spawnWhere} preset=${SPAWN_PRESET || '(default)'} maxLive=${MAX_LIVE}`
  : `pinned session=${getSession()}`;
try {
  log(`queue watcher up | api=${BASE} | ${where} | every ${INTERVAL_MS / 1000}s | cooldown ${COOLDOWN_MS / 60000}min | already notified=${notified.size}`);
  if (SPAWN_WORKSPACE && SPAWN_CWD) log(`note: --workspace wins over --spawn-cwd (dsh rejects both together), ignoring ${SPAWN_CWD}`);
  if (POOL_MODE && !SPAWN_WORKSPACE && !SPAWN_CWD) log('note: no --workspace/--spawn-cwd given, new sessions land in the dsh default workspace');
  if (POOL_MODE && !SPAWN_PRESET) log('note: no --spawn-preset given; if your reverse rules live in an agent preset, pass it or the sessions start with no preset');
} catch (error) {
  log(`initial session lookup failed (${error.message}); will retry on first card`);
}

for (;;) {
  let failed = false;
  try {
    // Settle --max-live slots every poll (not only when a card is waiting), so the books in
    // data/watch-reverse-state.json stay current instead of hoarding finished sessions.
    if (POOL_MODE) refreshPool();
    const queue = await (await fetch(`${BASE}/api/reverse/queue`)).json();
    const items = queue.items || [];
    const eligible = items.filter(i => i.autoEnabled !== false && i.cacheStatus === 'ready' && i.reverseStatus === 'idle');
    const live = new Set(items.map(i => String(i.id)));
    // A card that left the queue can be queued again later and should notify again.
    for (const id of [...notified]) if (!live.has(id)) notified.delete(id);

    const fresh = eligible.filter(i => !notified.has(String(i.id)));
    if (fresh.length && Date.now() >= coolingUntil) {
      let session = '';
      let deferReason = '';

      if (POOL_MODE) {
        const active = Object.keys(sessions); // refreshPool() already settled them this round
        if (active.length >= MAX_LIVE) deferReason = `${active.length} reverse session(s) live, --max-live ${MAX_LIVE}`;
        else {
          session = createReverseSession();
          if (!session) log('pool error: session create failed');
          else log(`opened a fresh session for the next card (${active.length + 1}/${MAX_LIVE} live)`);
        }
      } else {
        try {
          session = getSession();
        } catch (err) {
          log(`session lookup failed: ${err.message}`);
        }
        if (session && sessionIsBusy(session)) {
          deferReason = 'session busy';
          session = '';
        }
      }

      if (deferReason) {
        log(`${deferReason}, deferring ${fresh.length} card(s), next is ${fresh[0].id}`);
      } else if (!session) {
        // nothing usable this round; retry next poll without recording the ids
      } else {
        // One card per session: the whole point is that no prompt sees another card's wording.
        const ids = POOL_MODE ? [String(fresh[0].id)] : fresh.map(i => String(i.id));
        const error = wake(ids, session);
        if (error) {
          log(`WAKE FAILED for ${ids.join(', ')} -> ${error}`);
        } else {
          for (const id of ids) notified.add(id);
          if (POOL_MODE) sessions[session] = { at: Date.now(), seenRun: false, card: ids[0] };
          coolingUntil = Date.now() + COOLDOWN_MS;
          log(`woke ${session} for ${ids.join(', ')}${COOLDOWN_MS ? ` -> cooldown ${COOLDOWN_MS / 60000}min` : ''}`);
        }
      }
    }
  } catch (error) {
    log(`poll failed: ${error.message}`);
    failed = true;
  }
  if (!failed) writeState({ notified: [...notified], coolingUntil, sessions });
  await new Promise(r => setTimeout(r, INTERVAL_MS));
}
