// The app lock, server side (see ../gate.js for the rules).
//
//   gated(handler)   wraps every /api function. middleware.js already stands in front of them; this
//                    is the second check, so a routing mistake cannot expose an endpoint on its own.
//   authOp(req,res)  the three sign-in operations, served through /api/notify (the deployment is at
//                    its function limit, so they share that router):
//                      session GET   → { lock, signedIn }
//                      login   POST  { password } → sets the session cookie
//                      logout  POST  → clears it
//   ownFetch(url)    for the server calling its OWN endpoints (the alert runner, the health check):
//                    adds the owner key, and only ever to this app's own address.

import { put, get } from '@vercel/blob';
import { decide, lockOn, sameText, issueSession, verifySession, cookieOf, sessionCookies, clearCookies, lockedFor, recordFailure, recordSuccess, waitText, SESSION_COOKIE, SESSION_DAYS } from '../gate.js';

const pathOf = (req) => { const u = String(req.url || ''); const i = u.indexOf('?'); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };

export function gated(handler) {
  return async function gatedHandler(req, res, ...rest) {
    const env = process.env;
    if (!lockOn(env)) return handler(req, res, ...rest);
    const [path, search] = pathOf(req);
    const d = await decide({ path, search, method: req.method, cookie: req.headers?.cookie, authorization: req.headers?.authorization, env });
    if (!d.allow) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-SD-Auth', 'required');
      res.status(401).json({ error: 'Sign in to use Signal Desk.', signIn: '/login' });
      return;
    }
    return handler(req, res, ...rest);
  };
}

// ── own-origin calls ─────────────────────────────────────────────────────────
const DEFAULT_APP = 'https://signal-desk-virid.vercel.app';
/** The addresses that are this app. The owner key is never attached to anything else. */
export function ownOrigins(env = process.env) {
  const out = new Set([String(env.APP_URL || DEFAULT_APP).replace(/\/$/, '')]);
  for (const k of ['VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) if (env[k]) out.add(`https://${env[k]}`);
  return out;
}
export function isOwnUrl(url, env = process.env) {
  let u; try { u = new URL(url); } catch { return false; }
  if (ownOrigins(env).has(u.origin)) return true;
  return !env.VERCEL && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');   // local development only
}
export function ownFetch(url, init = {}, env = process.env) {
  if (!env.RUN_KEY || !lockOn(env) || !isOwnUrl(url, env)) return fetch(url, init);
  return fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${env.RUN_KEY}` } });
}

// ── sign-in attempts: where the counts are kept ──────────────────────────────
const BLOB_PATH = 'signal-desk/auth-attempts.json';
const hasBlob = () => !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
let memory = {};                                   // development, or a deployment without storage: per instance
const attempts = {
  async load() {
    if (!hasBlob()) return memory;
    try {
      const r = await get(BLOB_PATH, { access: 'private' });
      if (!r || r.statusCode === 404 || !r.stream) return {};
      return JSON.parse((await new Response(r.stream).text()) || '{}');
    } catch { return {}; }
  },
  async save(state) {
    if (!hasBlob()) { memory = state; return; }
    await put(BLOB_PATH, JSON.stringify(state), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  },
};
/** Addresses are kept as a short hash, never as written. */
async function whoIs(req) {
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sd-attempt:${ip}`)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 4096) return {}; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** Handles op=session|login|logout. Returns false when `op` is not one of them. */
export async function authOp(op, req, res, { store = attempts, env = process.env, now = Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (op !== 'session' && op !== 'login' && op !== 'logout') return false;
  res.setHeader('Cache-Control', 'no-store');
  const on = lockOn(env);

  if (op === 'session') {
    const s = on ? await verifySession(env.APP_PASSWORD, cookieOf(req.headers?.cookie, SESSION_COOKIE), now) : { ok: true };
    // Keep a device that is in regular use signed in: past half-life, hand it a fresh 30 days.
    // (Done here, on an answer that is never cached, rather than on the data endpoints.)
    if (on && s.ok && s.exp * 1000 - now < (SESSION_DAYS / 2) * 864e5) res.setHeader('Set-Cookie', sessionCookies(await issueSession(env.APP_PASSWORD, { now })));
    res.status(200).json({ ok: true, lock: on, signedIn: s.ok });
    return true;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return true; }
  if (op === 'logout') { res.setHeader('Set-Cookie', clearCookies()); res.status(200).json({ ok: true }); return true; }

  // login
  if (!on) { res.status(200).json({ ok: true, lock: false }); return true; }
  const who = await whoIs(req);
  let state = await store.load();
  const wait = lockedFor(state, who, now);
  if (wait > 0) { res.setHeader('Retry-After', String(Math.ceil(wait / 1000))); res.status(429).json({ ok: false, locked: true, error: `Too many wrong tries. Sign-in is paused for ${waitText(wait)}.` }); return true; }
  const body = await readBody(req);
  const good = typeof body.password === 'string' && body.password.length <= 256 && (await sameText(body.password, env.APP_PASSWORD));
  if (!good) {
    state = recordFailure(state, who, now);
    try { await store.save(state); } catch { /* counting failed; the answer is still no */ }
    await pause(400);
    const w = lockedFor(state, who, now);
    res.status(401).json({ ok: false, error: w > 0 ? `Wrong password. Sign-in is now paused for ${waitText(w)}.` : 'Wrong password.' });
    return true;
  }
  if (state?.ips?.[who]) { try { await store.save(recordSuccess(state, who)); } catch { /* harmless */ } }
  res.setHeader('Set-Cookie', sessionCookies(await issueSession(env.APP_PASSWORD, { now })));
  res.status(200).json({ ok: true });
  return true;
}
