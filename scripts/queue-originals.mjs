// Move original favorites into the reverse queue and wait until their hi-res originals are cached.
// Usage:
//   node scripts/queue-originals.mjs            # queue every card still sitting in "original"
//   node scripts/queue-originals.mjs 123 456    # queue only these ids
// Prints the resulting queue as JSON so an agent can drive it with reverse-cli.mjs.
const base = process.env.DFLOW_URL || 'http://127.0.0.1:4173';
const only = process.argv.slice(2).map(String);

const get = async route => {
  const res = await fetch(new URL(route, base));
  if (!res.ok) throw Error(`${route} -> HTTP ${res.status}`);
  return res.json();
};
const patch = async (route, body) => {
  const res = await fetch(new URL(route, base), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw Error(`${route} -> HTTP ${res.status}: ${data.error || ''}`);
  return data;
};

const state = await get('/api/state');
const targets = state.favorites.filter(item =>
  item.folder === 'original' && (only.length === 0 || only.includes(String(item.id)))
);

if (!targets.length) {
  console.log(JSON.stringify({ queued: 0, note: only.length ? 'no matching original favorites' : 'nothing in original' }, null, 2));
} else {
  for (const item of targets) {
    await patch(`/api/favorites/${item.id}`, { folder: 'pending' });
  }
  console.log(`queued ${targets.length} card(s), waiting for hi-res cache...`);

  const deadline = Date.now() + 10 * 60 * 1000;
  let ready = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const now = await get('/api/state');
    const pending = now.favorites.filter(f => targets.some(t => String(t.id) === String(f.id)));
    ready = pending.filter(f => f.cacheStatus === 'ready').length;
    const settled = pending.filter(f => f.cacheStatus === 'ready' || f.cacheStatus === 'error').length;
    if (settled === pending.length) break;
  }

  const queue = await get('/api/reverse/queue');
  console.log(JSON.stringify({ queued: targets.length, cacheReady: ready, queue }, null, 2));
}
