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
      try { const r = await ch.send(m.title, m.text, m.prio); if (r.ok) sent++; else { failed++; lastDetail = redact(r.detail); } }
      catch (e) { failed++; lastDetail = redact(e.message); }
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
// The runner fetches the app's own API; the base is fixed, never taken from request headers.
const APP_URL = (process.env.APP_URL || 'https://signal-desk-virid.vercel.app').replace(/\/$/, '');
const mask = (s) => (s ? `…${String(s).slice(-4)}` : null);
/** Constant-time string equality (both sides hashed so lengths never leak). */
async function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const h = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const bearer = (req) => { const m = /^Bearer\s+(\S+)$/i.exec(req.headers?.authorization || ''); return m ? m[1] : null; };
/** Channel configs are validated server-side: shape, not just presence. */
const CHANNEL_SHAPES = {
  telegram: (c) => c && /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/.test(String(c.token || '')) && /^-?\d{4,16}$/.test(String(c.chatId || '')) ? { token: String(c.token), chatId: String(c.chatId) } : null,
  callmebot: (c) => c && /^\+?\d{8,15}$/.test(String(c.phone || '')) && /^\d{4,12}$/.test(String(c.apikey || '')) ? { phone: String(c.phone), apikey: String(c.apikey) } : null,
  ntfy: (c) => c && /^[A-Za-z0-9_-]{3,64}$/.test(String(c.topic || '')) ? { topic: String(c.topic) } : null,
};
const TICKER_RE = /^[A-Z][A-Z0-9.\-^=]{0,11}$/;
/** Positions as the runner needs them — no free-text fields travel to the server. */
const cleanPosition = (p) => {
  if (!p || typeof p !== 'object' || !TICKER_RE.test(String(p.ticker || '').toUpperCase())) return null;
  const n = (x) => (typeof x === 'number' && isFinite(x) ? x : (x != null && isFinite(+x) ? +x : undefined));
  const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : undefined);
  const out = { id: String(p.id || '').slice(0, 64), ticker: String(p.ticker).toUpperCase(), qty: n(p.qty), buyPrice: n(p.buyPrice), buyDate: d(p.buyDate), stop: n(p.stop), planStop: n(p.planStop), initialStop: n(p.initialStop), target: n(p.target), planTarget: n(p.planTarget), timeStopDays: n(p.timeStopDays), multiplier: n(p.multiplier), strike: n(p.strike), expiration: d(p.expiration) };
  if (['stock', 'metal', 'crypto', 'option'].includes(p.assetClass)) out.assetClass = p.assetClass;
  if (p.isOption) out.isOption = true;
  if (p.underlying && TICKER_RE.test(String(p.underlying).toUpperCase())) out.underlying = String(p.underlying).toUpperCase();
  if (p.optionType === 'CALL' || p.optionType === 'PUT') out.optionType = p.optionType;
  if (typeof p.label === 'string') out.label = p.label.slice(0, 60);
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out.qty > 0 && out.buyPrice > 0 ? out : null;
};
/** Provider error bodies can echo keys or phone numbers; keep a status word, not the body. */
const redact = (detail) => { const t = String(detail || ''); return /unauthor|401|403/i.test(t) ? 'rejected (check token / key)' : /404/.test(t) ? 'not found (check chat id / topic)' : /429|rate/i.test(t) ? 'rate limited' : /timeout|ETIMEDOUT|ECONN/i.test(t) ? 'network' : t ? 'provider error' : ''; };

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
    if (state.syncKey) {
      if (!(await same(body.syncKey, state.syncKey))) { res.status(403).json({ ok: false, error: 'syncKey mismatch — this server already belongs to another device. Use that device, or clear the blob.' }); return; }
    } else {
      // Claiming an empty store is the one privileged step: it needs the owner's RUN_KEY
      // (from Vercel), typed once into the Alerts tab. Otherwise anyone who found the URL
      // first could own the store and use it as a message relay.
      if (!process.env.RUN_KEY) { res.status(200).json({ ok: false, error: 'RUN_KEY is not set on the server; set it in Vercel before the first sync.' }); return; }
      if (!(await same(body.setupKey, process.env.RUN_KEY))) { res.status(403).json({ ok: false, error: 'first sync needs the owner key', needsSetupKey: true }); return; }
    }
    const syncKey = state.syncKey || rnd();
    const next = { ...state, syncKey, syncedAt: Date.now() };
    if (Array.isArray(body.watch)) next.watch = body.watch.map((t) => String(t || '').toUpperCase().trim()).filter((t) => TICKER_RE.test(t)).slice(0, 30);
    if (Array.isArray(body.portfolio)) next.portfolio = body.portfolio.map(cleanPosition).filter(Boolean).slice(0, 100);
    if (body.settings && typeof body.settings === 'object') {
      const en = {}; for (const key of Object.keys(DEFAULT_SETTINGS.enabled)) en[key] = key in (body.settings.enabled || {}) ? !!body.settings.enabled[key] : DEFAULT_SETTINGS.enabled[key];
      next.settings = { ...DEFAULT_SETTINGS, enabled: en, ...(typeof body.settings.minSeverity === 'string' ? { minSeverity: body.settings.minSeverity.slice(0, 10) } : {}) };
    }
    if (body.channels && typeof body.channels === 'object') {
      next.channels = next.channels || {};
      for (const k of ['callmebot', 'ntfy', 'telegram']) if (k in body.channels) {
        const v = body.channels[k];
        if (!v) { next.channels[k] = null; continue; }
        const clean = CHANNEL_SHAPES[k](v);
        if (!clean) { res.status(400).json({ ok: false, error: `${k} details do not look right — check the format` }); return; }
        next.channels[k] = clean;
      }
    }
    await saveState(next);
    res.status(200).json({ ok: true, syncKey, watch: (next.watch || []).length, positions: (next.portfolio || []).length, channels: Object.keys(next.channels || {}).filter((k) => next.channels[k]) });
    return;
  }

  if (op === 'status') {
    const state = await loadState();
    if (state.syncKey && !(await same(req.query.syncKey, state.syncKey))) { res.status(403).json({ ok: false, error: 'syncKey mismatch' }); return; }
    const c = state.channels || {};
    res.status(200).json({ ok: true, storage: 'connected', synced: !!state.syncKey, syncedAt: state.syncedAt || null, watch: (state.watch || []).length, positions: (state.portfolio || []).length,
      channels: { whatsapp: c.callmebot?.phone ? { phone: mask(c.callmebot.phone), apikey: !!c.callmebot.apikey } : null, ntfy: c.ntfy?.topic ? { topic: c.ntfy.topic } : null, telegram: c.telegram?.chatId ? { chatId: mask(c.telegram.chatId), token: !!c.telegram.token } : null },
      lastRun: state.lastRun || null, runnerConfigured: !!process.env.RUN_KEY });
    return;
  }

  if (op === 'test' && req.method === 'POST') {
    const body = await readBody(req);
    const state = await loadState();
    if (!state.syncKey || !(await same(body.syncKey, state.syncKey))) { res.status(403).json({ ok: false, error: 'sync first' }); return; }
    const chans = channelsOf(state);
    if (!chans.length) { res.status(200).json({ ok: false, error: 'no channel configured' }); return; }
    const out = {};
    for (const ch of chans) { try { const r = await ch.send('✅ Signal Desk test', 'If you can read this on your phone, alerts will arrive here.\n— Signal Desk', 'high'); out[ch.name] = { ok: !!r.ok, ...(r.ok ? {} : { detail: redact(r.detail) }) }; } catch (e) { out[ch.name] = { ok: false, detail: redact(e.message) }; } }
    res.status(200).json({ ok: Object.values(out).some((r) => r.ok), results: out });
    return;
  }

  if (op === 'run') {
    // Runner auth: Authorization: Bearer <RUN_KEY>. Never in the URL — query strings land in access logs.
    if (!process.env.RUN_KEY || !(await same(bearer(req), process.env.RUN_KEY))) { res.status(403).json({ ok: false, error: 'bad key' }); return; }
    const t0 = Date.now();
    const state = await loadState();
    const watch = state.watch || [];
    const pf = state.portfolio || [];
    if (!state.syncKey) { res.status(200).json({ ok: false, error: 'nothing synced yet' }); return; }
    // Run the engine against the server-side copy of the same keys the browser uses
    const mem = memoryStore(state.engine || {});
    useStore(mem);
    const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), enabled: { ...DEFAULT_SETTINGS.enabled, ...(state.settings?.enabled || {}) } };
    const base = APP_URL;
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
    // A sync may have landed while this run was fetching (up to 60 s). Re-read and write
    // only the runner's own fields so the user's watchlist / channels are never reverted.
    const fresh = await loadState();
    fresh.engine = mem.data;
    if (slow) { fresh.slow = state.slow; fresh.slowAt = state.slowAt; }
    fresh.lastRun = { at: Date.now(), ms: Date.now() - t0, watch: watch.length, positions: pf.length, fired: fired.length, delivered: report, sourcesDown: data?.failed || 0 };
    await saveState(fresh);
    // Alert text stays out of the response by default: the scheduler's log is public.
    res.status(200).json({ ok: true, ...fresh.lastRun, ...(req.query.verbose === '1' ? { alerts: fired.map((a) => `${a.type}:${a.ticker}`) } : {}) });
    return;
  }

  res.status(400).json({ error: 'Pass ?op=sync (POST) | run (GET, bearer RUN_KEY) | test (POST) | status (GET)' });
}
