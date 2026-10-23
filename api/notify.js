// Vercel serverless: /api/notify?op=sync|run|test|status
//
// Phone delivery for the Alerts engine. Until now every alert was computed in
// the browser and could only reach a phone while a tab was open. This runs
// the SAME engine (alerts.js + exits.js, unchanged) on the server, on a
// schedule, and sends what fires to WhatsApp / ntfy / Telegram.
//
//   sync    POST  the browser's watchlist, positions, alert settings and
//                 channel details. Stored server-side. First sync mints a
//                 syncKey the browser keeps; later syncs must present it.
//   run     GET   ?key=RUN_KEY — the scheduler's entry point. Loads state,
//                 fetches data from this deployment's own API, evaluates, sends,
//                 persists dedup state. Idempotent: nothing is sent twice.
//   test    POST  { syncKey } — sends a test message to every configured channel.
//   status  GET   ?syncKey= — what is configured, when it last ran, what it sent.
//
// STORAGE: Vercel Blob (private). One JSON document holds everything. If the
// store is not connected yet (no BLOB_READ_WRITE_TOKEN), every op says so
// plainly instead of pretending.
//
// CHANNELS — whichever has details set:
//   WhatsApp via CallMeBot   phone + apikey (free, unofficial gateway; the user
//                            activates it by messaging the bot once)
//   ntfy.sh                  topic name (free, no account; install the ntfy app)
//   Telegram                 bot token + chat id (free, official)
//
// SECRETS the user types (CallMeBot key, Telegram token) live only in the
// private blob; they are never echoed back by status.

import { put, get } from '@vercel/blob';
import { evaluate, evaluatePositions, fetchAlertData, fetchPositionContext, useStore, memoryStore, TYPES, DEFAULT_SETTINGS } from '../alerts.js';

const BLOB_PATH = 'signal-desk/alerts-state.json';
const MAX_PER_RUN = 6;                 // per channel per run; the rest are summarised
const SLOW_MS = 30 * 60 * 1000;        // filings sources every 30 min, like the page

export const config = { maxDuration: 60 };

// ── storage ────────────────────────────────────────────────────────────────
// Two ways Vercel Blob authenticates: the classic BLOB_READ_WRITE_TOKEN, or
// (newer store connections) BLOB_STORE_ID plus the runtime OIDC token the SDK
// exchanges itself. The first deployed version gated on the token alone and
// reported "not connected" against a store that was connected — caught in
// the user's first run.
const hasBlob = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
async function loadState() {
  try {
    const r = await get(BLOB_PATH, { access: 'private' });
    if (!r || r.statusCode === 404 || !r.stream) return {};
    const text = await new Response(r.stream).text();
    return JSON.parse(text || '{}');
  } catch (e) {
    if (String(e?.message || '').includes('not found') || e?.status === 404) return {};
    return {};
  }
}
async function saveState(state) {
  await put(BLOB_PATH, JSON.stringify(state), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
}

// ── senders ────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (compatible; SignalDesk/1.0)';
async function sendCallMeBot(ch, text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(ch.phone)}&apikey=${encodeURIComponent(ch.apikey)}&text=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const body = await r.text();
  // CallMeBot answers 200 with an HTML page; "queued" is success, anything
  // mentioning the apikey or phone is a configuration error worth surfacing.
  const ok = r.ok && /queued|sent/i.test(body);
  return { ok, detail: ok ? 'queued' : body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) };
}
async function sendNtfy(ch, title, text, priority = 'default') {
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(ch.topic)}`, { method: 'POST', headers: { 'User-Agent': UA, Title: title, Priority: priority, Tags: 'chart_with_upwards_trend' }, body: text });
  return { ok: r.ok, detail: r.ok ? 'published' : `http ${r.status}` };
}
async function sendTelegram(ch, text) {
  const r = await fetch(`https://api.telegram.org/bot${ch.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: ch.chatId, text, disable_web_page_preview: true }) });
  const d = await r.json().catch(() => ({}));
  return { ok: !!d.ok, detail: d.ok ? 'sent' : (d.description || `http ${r.status}`) };
}
function channelsOf(state) {
  const c = state.channels || {};
  const out = [];
  if (c.callmebot?.phone && c.callmebot?.apikey) out.push({ name: 'whatsapp', send: (title, text, prio) => sendCallMeBot(c.callmebot, `${title}\n${text}`) });
  if (c.ntfy?.topic) out.push({ name: 'ntfy', send: (title, text, prio) => sendNtfy(c.ntfy, title, text, prio) });
  if (c.telegram?.token && c.telegram?.chatId) out.push({ name: 'telegram', send: (title, text) => sendTelegram(c.telegram, `${title}\n${text}`) });
  return out;
}
const fmtAlert = (a) => ({
  title: `${TYPES[a.type]?.icon || '•'} ${a.title}`,
  text: `${a.body}${a.link ? `\n${a.link.startsWith('/') ? 'https://signal-desk-virid.vercel.app' + a.link : a.link}` : ''}\n— Signal Desk`,
  prio: a.severity === 'high' ? 'high' : 'default',
});

async function deliver(state, alerts) {
  const chans = channelsOf(state);
  const report = {};
  if (!chans.length || !alerts.length) return report;
  // Highest severity first; cap per run so an unusually busy minute does not flood a phone
  const order = { high: 0, medium: 1, low: 2 };
  const sorted = [...alerts].sort((x, y) => (order[x.severity] ?? 3) - (order[y.severity] ?? 3));
  const head = sorted.slice(0, MAX_PER_RUN), rest = sorted.length - head.length;
  for (const ch of chans) {
    let sent = 0, failed = 0, lastDetail = '';
    for (const a of head) {
      const m = fmtAlert(a);
      try { const r = await ch.send(m.title, m.text, m.prio); if (r.ok) sent++; else { failed++; lastDetail = r.detail; } }
      catch (e) { failed++; lastDetail = e.message; }
      await new Promise((r) => setTimeout(r, ch.name === 'whatsapp' ? 1500 : 200));   // CallMeBot is rate-limited
    }
    if (rest > 0) { try { await ch.send(`+${rest} more alert${rest > 1 ? 's' : ''}`, 'See the Alerts tab for the rest.\nhttps://signal-desk-virid.vercel.app/alerts'); } catch {} }
    report[ch.name] = { sent, failed, ...(lastDetail ? { lastDetail } : {}) };
  }
  return report;
}

// ── helpers ────────────────────────────────────────────────────────────────
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}
const rnd = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');
const originOf = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
const mask = (s) => (s ? `…${String(s).slice(-4)}` : null);

// ── ops ────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const op = String((req.query && req.query.op) || '').toLowerCase();
  if (!hasBlob()) {
    res.status(200).json({ ok: false, storage: 'not-connected', error: 'Server storage is not connected yet. In Vercel: Storage → Create → Blob → Connect Project → signal-desk, then redeploy.' });
    return;
  }

  if (op === 'sync' && req.method === 'POST') {
    const body = await readBody(req);
    const state = await loadState();
    if (state.syncKey && body.syncKey !== state.syncKey) { res.status(403).json({ ok: false, error: 'syncKey mismatch — this server already belongs to another device. Use that device, or clear the blob.' }); return; }
    const syncKey = state.syncKey || rnd();
    const next = { ...state, syncKey, syncedAt: Date.now() };
    if (Array.isArray(body.watch)) next.watch = body.watch.slice(0, 30);
    if (Array.isArray(body.portfolio)) next.portfolio = body.portfolio.slice(0, 100);
    if (body.settings && typeof body.settings === 'object') next.settings = { ...DEFAULT_SETTINGS, ...body.settings, enabled: { ...DEFAULT_SETTINGS.enabled, ...(body.settings.enabled || {}) } };
    if (body.channels && typeof body.channels === 'object') {
      next.channels = next.channels || {};
      for (const k of ['callmebot', 'ntfy', 'telegram']) if (k in body.channels) next.channels[k] = body.channels[k] || null;
    }
    await saveState(next);
    res.status(200).json({ ok: true, syncKey, watch: (next.watch || []).length, positions: (next.portfolio || []).length, channels: Object.keys(next.channels || {}).filter((k) => next.channels[k]) });
    return;
  }

  if (op === 'status') {
    const state = await loadState();
    if (state.syncKey && req.query.syncKey !== state.syncKey) { res.status(403).json({ ok: false, error: 'syncKey mismatch' }); return; }
    const c = state.channels || {};
    res.status(200).json({ ok: true, storage: 'connected', synced: !!state.syncKey, syncedAt: state.syncedAt || null, watch: (state.watch || []).length, positions: (state.portfolio || []).length,
      channels: { whatsapp: c.callmebot?.phone ? { phone: mask(c.callmebot.phone), apikey: !!c.callmebot.apikey } : null, ntfy: c.ntfy?.topic ? { topic: c.ntfy.topic } : null, telegram: c.telegram?.chatId ? { chatId: mask(c.telegram.chatId), token: !!c.telegram.token } : null },
      lastRun: state.lastRun || null, runnerConfigured: !!process.env.RUN_KEY });
    return;
  }

  if (op === 'test' && req.method === 'POST') {
    const body = await readBody(req);
    const state = await loadState();
    if (!state.syncKey || body.syncKey !== state.syncKey) { res.status(403).json({ ok: false, error: 'sync first' }); return; }
    const chans = channelsOf(state);
    if (!chans.length) { res.status(200).json({ ok: false, error: 'no channel configured' }); return; }
    const out = {};
    for (const ch of chans) { try { out[ch.name] = await ch.send('✅ Signal Desk test', 'If you can read this on your phone, alerts will arrive here.\n— Signal Desk', 'high'); } catch (e) { out[ch.name] = { ok: false, detail: e.message }; } }
    res.status(200).json({ ok: Object.values(out).some((r) => r.ok), results: out });
    return;
  }

  if (op === 'run') {
    if (!process.env.RUN_KEY || req.query.key !== process.env.RUN_KEY) { res.status(403).json({ ok: false, error: 'bad key' }); return; }
    const t0 = Date.now();
    const state = await loadState();
    const watch = state.watch || [];
    const pf = state.portfolio || [];
    if (!state.syncKey) { res.status(200).json({ ok: false, error: 'nothing synced yet' }); return; }
    // Run the engine against the server-side copy of the same keys the browser uses
    const mem = memoryStore(state.engine || {});
    useStore(mem);
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), enabled: { ...DEFAULT_SETTINGS.enabled, ...(state.settings?.enabled || {}) } };
    const base = originOf(req);
    const slow = Date.now() - (state.slowAt || 0) > SLOW_MS;
    const fired = [];
    let data = null;
    if (watch.length) {
      data = await fetchAlertData(watch, { base, slow });
      if (slow) { state.slow = { earnings: data.earnings || {}, analyst: data.analyst || {}, insider: data.insider || {} }; state.slowAt = Date.now(); }
      const s = state.slow || {};
      fired.push(...evaluate(watch, { scan: data.scan, news: data.news, earnings: s.earnings || {}, analyst: s.analyst || {}, insider: s.insider || {} }, settings));
    }
    if (pf.length) {
      const ctx = await fetchPositionContext(pf, { base });
      fired.push(...evaluatePositions(pf, ctx, settings));
    }
    const report = await deliver(state, fired);
    state.engine = mem.data;
    state.lastRun = { at: Date.now(), ms: Date.now() - t0, watch: watch.length, positions: pf.length, fired: fired.length, delivered: report, baseline: !!fired.baseline, sourcesDown: data?.failed || 0 };
    await saveState(state);
    res.status(200).json({ ok: true, ...state.lastRun, alerts: fired.map((a) => `${a.type}:${a.ticker}:${a.title}`) });
    return;
  }

  res.status(400).json({ error: 'Pass ?op=sync (POST) | run (GET, key) | test (POST) | status (GET)' });
}
