// Signal Desk — the app lock.
//
// One owner, one password. When APP_PASSWORD is set on the server, nothing but the sign-in page
// answers until the visitor has signed in: no pages, no data files, no /api. When it is not set,
// the lock is off and every function here says "allow" — the app behaves exactly as before.
//
// Used in three places, which is why it is one small module with no imports:
//   middleware.js     (Vercel, in front of every request — pages, files and /api)
//   api/_gate.js      (inside each /api function as a second check, and for sign-in)
//   tools/devserver.mjs (so the same decisions can be tested locally)
//
// SESSION  a signed token in an HttpOnly cookie:  <expiry>.<random>.<HMAC-SHA256 signature>
//          The signing key is derived from the password, so nothing extra has to be configured —
//          and changing the password signs every device out.
// MACHINES the scheduled jobs (alerts, nightly data, health) and the server's calls to its own
//          endpoints present the owner key instead:  Authorization: Bearer <RUN_KEY>.
//
// Web Crypto only, so it runs unchanged in the edge runtime, in Node and in tests.

export const SESSION_COOKIE = '__Host-sd_session';
export const MARKER_COOKIE = 'sd_lock';            // not secret: tells the page a "Sign out" button is worth showing
export const SESSION_DAYS = 30;
const DAY_S = 86400;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Is the lock switched on for this deployment? */
export const lockOn = (env = {}) => typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD.length > 0;

/** Constant-time string equality (both sides hashed first, so lengths never leak). */
export async function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const h = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(x)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const keyFor = (password) => crypto.subtle.importKey('raw', enc.encode(`signal-desk session v1\n${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** A new session token, valid for `days`. */
export async function issueSession(password, { now = Date.now(), days = SESSION_DAYS } = {}) {
  const exp = Math.floor(now / 1000) + Math.round(days * DAY_S);
  const nonce = b64u(crypto.getRandomValues(new Uint8Array(12)));
  const sig = await crypto.subtle.sign('HMAC', await keyFor(password), enc.encode(`${exp}.${nonce}`));
  return `${exp}.${nonce}.${b64u(sig)}`;
}

/** Check a token: signed with this password and not expired. → { ok, exp (seconds) } */
export async function verifySession(password, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return { ok: false };
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{40,50})$/.exec(token);
  if (!m) return { ok: false };
  const exp = +m[1];
  if (exp * 1000 <= now) return { ok: false, expired: true };
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await keyFor(password), unb64u(m[3]), enc.encode(`${m[1]}.${m[2]}`)); } catch { ok = false; }
  return ok ? { ok: true, exp } : { ok: false };
}

/** One cookie's value out of a Cookie header. */
export function cookieOf(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Set-Cookie values for signing in (session + marker) and for signing out. */
export function sessionCookies(token, { days = SESSION_DAYS } = {}) {
  const age = Math.round(days * DAY_S);
  return [
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`,
    `${MARKER_COOKIE}=1; Path=/; Max-Age=${age}; Secure; SameSite=Lax`,
  ];
}
export const clearCookies = () => [
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  `${MARKER_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
];

/** Where to send someone after sign-in: a path on this site, never another site. */
export function safeNext(next) {
  const s = String(next || '');
  if (!/^\/[A-Za-z0-9\-._~/?=&%#]{0,300}$/.test(s) || s.startsWith('//') || /^\/login(\.html)?([?#/]|$)/.test(s)) return '/';
  return s;
}

// What stays reachable without signing in: the sign-in page and what it needs to draw itself,
// the installable-app files a phone fetches on its own, the two legal pages, and the three
// sign-in operations. Everything else is the owner's.
const PUBLIC_FILES = new Set(['/login', '/login.html', '/apple.css', '/favicon.svg', '/favicon.ico', '/manifest.webmanifest', '/sw.js', '/robots.txt', '/privacy', '/privacy.html', '/terms', '/terms.html']);
const PUBLIC_OPS = new Set(['login', 'logout', 'session']);
export function isPublic(path, search = '') {
  if (PUBLIC_FILES.has(path) || /^\/icon-[a-z0-9-]+\.png$/.test(path)) return true;
  if (path === '/api/notify') {
    const op = String(new URLSearchParams(search).get('op') || '').toLowerCase();
    return PUBLIC_OPS.has(op);
  }
  return false;
}

const bearerOf = (authorization) => { const m = /^Bearer\s+(\S+)$/i.exec(String(authorization || '')); return m ? m[1] : null; };

/**
 * The one decision. → { allow: true, via } or { allow: false, respond: 'redirect' | 'deny', location? }
 *   via: 'off' (lock not set up) · 'public' · 'machine' (owner key) · 'session' (+ exp)
 * A page request without a session is redirected to sign-in; anything else gets a plain 401.
 */
export async function decide({ path = '/', search = '', method = 'GET', cookie = '', authorization = '', env = {}, now = Date.now() } = {}) {
  if (!lockOn(env)) return { allow: true, via: 'off' };
  if (isPublic(path, search)) return { allow: true, via: 'public' };
  const key = bearerOf(authorization);
  if (key && env.RUN_KEY && (await sameText(key, env.RUN_KEY))) return { allow: true, via: 'machine' };
  const s = await verifySession(env.APP_PASSWORD, cookieOf(cookie, SESSION_COOKIE), now);
  if (s.ok) return { allow: true, via: 'session', exp: s.exp };
  const isPage = (method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && (!/\.[A-Za-z0-9]+$/.test(path) || path.endsWith('.html'));
  if (isPage) return { allow: false, respond: 'redirect', location: `/login${path === '/' ? '' : `?next=${encodeURIComponent(safeNext(path + search))}`}` };
  return { allow: false, respond: 'deny' };
}

// ── Sign-in attempts ─────────────────────────────────────────────────────────
// A password can be guessed at, so wrong guesses are counted — per address, and overall.
//   per address: the 5th wrong guess locks that address out for 15 minutes, and each one after
//                doubles it (to a day at most). Forgotten after a quiet day, or on success.
//   overall:     more than 30 wrong guesses inside an hour, from anywhere, pauses sign-in for
//                15 minutes — the backstop against guessing from many addresses at once.
// While locked, even the right password is refused; otherwise the lock would not slow anyone.
// Devices already signed in are never affected. Pure functions over a plain object, so the
// caller decides where it is kept (a private blob in production, memory in development).
export const ATTEMPTS = { free: 4, baseMs: 15 * 60e3, maxMs: 24 * 3600e3, forgetMs: 24 * 3600e3, globalMax: 30, globalWindowMs: 3600e3, globalLockMs: 15 * 60e3 };

/** Milliseconds this address must still wait (0 = may try). */
export function lockedFor(state, who, now = Date.now()) {
  const a = state?.ips?.[who], g = state?.global;
  return Math.max(0, (a?.until || 0) - now, (g?.until || 0) - now);
}
/** A wrong guess from `who`. Returns the new state (the old one is not changed). */
export function recordFailure(state, who, now = Date.now()) {
  const ips = {};
  for (const [k, v] of Object.entries(state?.ips || {})) if (now - (v.t || 0) < ATTEMPTS.forgetMs) ips[k] = v;      // drop the stale
  const a = ips[who] || { n: 0 };
  const n = a.n + 1;
  ips[who] = { n, t: now, until: n > ATTEMPTS.free ? now + Math.min(ATTEMPTS.baseMs * 2 ** (n - ATTEMPTS.free - 1), ATTEMPTS.maxMs) : 0 };
  const keys = Object.keys(ips);
  if (keys.length > 500) for (const k of keys.sort((x, y) => ips[x].t - ips[y].t).slice(0, keys.length - 500)) delete ips[k];
  const g0 = state?.global && now - (state.global.t || 0) < ATTEMPTS.globalWindowMs ? state.global : { n: 0, t: now, until: 0 };
  const g = { n: g0.n + 1, t: g0.t, until: g0.until || 0 };
  if (g.n > ATTEMPTS.globalMax) g.until = now + ATTEMPTS.globalLockMs;
  return { ips, global: g };
}
/** A correct sign-in from `who`: its count is cleared. */
export function recordSuccess(state, who) {
  const ips = { ...(state?.ips || {}) }; delete ips[who];
  return { ips, global: state?.global || { n: 0, t: 0, until: 0 } };
}

/** "3 minutes" / "2 hours" for a wait. */
export function waitText(ms) {
  const m = Math.ceil(ms / 60e3);
  return m >= 120 ? `${Math.ceil(m / 60)} hours` : m > 1 ? `${m} minutes` : 'a minute';
}
