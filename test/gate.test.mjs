import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockOn, issueSession, verifySession, decide, cookieOf, safeNext, isPublic, sessionCookies, clearCookies, lockedFor, recordFailure, recordSuccess, ATTEMPTS, SESSION_COOKIE, SESSION_DAYS } from '../gate.js';
import { gated, authOp, isOwnUrl, ownFetch } from '../api/_gate.js';

const PW = 'unit-test-password-not-real';
const ENV = { APP_PASSWORD: PW, RUN_KEY: 'unit-test-owner-key' };
const cookieFor = async (pw = PW, opts) => `${SESSION_COOKIE}=${await issueSession(pw, opts)}`;
const DAY = 864e5;

test('with no APP_PASSWORD the lock is off and everything is allowed', async () => {
  assert.equal(lockOn({}), false);
  assert.equal(lockOn({ APP_PASSWORD: '' }), false);
  for (const path of ['/', '/swing', '/api/quotes', '/data/screen.json', '/api/vault'])
    assert.deepEqual(await decide({ path, env: {} }), { allow: true, via: 'off' });
});

test('a session token verifies only with the password that signed it, and only until it expires', async () => {
  const now = Date.UTC(2026, 0, 1);
  const t = await issueSession(PW, { now });
  assert.match(t, /^\d{10}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  const v = await verifySession(PW, t, now + DAY);
  assert.equal(v.ok, true);
  assert.equal(v.exp, Math.floor(now / 1000) + SESSION_DAYS * 86400);
  assert.equal((await verifySession('another-password', t, now)).ok, false, 'changing the password signs every device out');
  assert.deepEqual(await verifySession(PW, t, now + (SESSION_DAYS + 1) * DAY), { ok: false, expired: true });
});

test('a tampered token is refused: later expiry, swapped signature, junk', async () => {
  const now = Date.UTC(2026, 0, 1);
  const [exp, nonce, sig] = (await issueSession(PW, { now })).split('.');
  assert.equal((await verifySession(PW, `${+exp + 86400 * 365}.${nonce}.${sig}`, now)).ok, false, 'extending the expiry breaks the signature');
  assert.equal((await verifySession(PW, `${exp}.${nonce}.${sig.slice(0, -2)}AA`, now)).ok, false);
  const other = (await issueSession(PW, { now })).split('.');
  assert.equal((await verifySession(PW, `${exp}.${nonce}.${other[2]}`, now)).ok, false, 'a signature from another token does not transfer');
  for (const junk of ['', 'x', null, undefined, 42, `${exp}.${nonce}`, 'a.b.c', 'x'.repeat(5000)]) assert.equal((await verifySession(PW, junk, now)).ok, false);
});

test('locked: pages go to sign-in, data calls get a plain refusal, the sign-in page stays open', async () => {
  assert.deepEqual(await decide({ path: '/swing', env: ENV }), { allow: false, respond: 'redirect', location: '/login?next=%2Fswing' });
  assert.deepEqual(await decide({ path: '/', env: ENV }), { allow: false, respond: 'redirect', location: '/login' });
  assert.equal((await decide({ path: '/research', search: '?t=AAPL', env: ENV })).location, '/login?next=%2Fresearch%3Ft%3DAAPL');
  for (const path of ['/api/quotes', '/api/vault', '/api/notify', '/data/screen.json', '/data/earnings.json', '/alerts.js', '/strategies.js'])
    assert.deepEqual(await decide({ path, env: ENV }), { allow: false, respond: 'deny' }, path);
  assert.deepEqual(await decide({ path: '/swing', method: 'POST', env: ENV }), { allow: false, respond: 'deny' });
  for (const path of ['/login', '/login.html', '/apple.css', '/icon-192.png', '/manifest.webmanifest', '/sw.js', '/privacy', '/terms', '/robots.txt'])
    assert.equal((await decide({ path, env: ENV })).via, 'public', path);
});

test('only the three sign-in operations of /api/notify are open; every other one is locked', () => {
  for (const op of ['login', 'logout', 'session', 'LOGIN']) assert.equal(isPublic('/api/notify', `?op=${op}`), true, op);
  for (const op of ['run', 'sync', 'status', 'test', 'broker', 'broker-set', 'subscribe', 'pushkey', '']) assert.equal(isPublic('/api/notify', `?op=${op}`), false, op);
  assert.equal(isPublic('/api/vault', '?op=login'), false, 'the op only counts on the notify router');
  assert.equal(isPublic('/icon-192.png/../api/quotes'), false);
});

test('a signed-in browser gets through; a stale, foreign or missing cookie does not', async () => {
  const now = Date.UTC(2026, 0, 1);
  const good = await cookieFor(PW, { now });
  const d = await decide({ path: '/api/quotes', cookie: `theme=dark; ${good}; other=1`, env: ENV, now });
  assert.equal(d.allow, true); assert.equal(d.via, 'session');
  assert.equal((await decide({ path: '/api/quotes', cookie: good, env: ENV, now: now + 31 * DAY })).allow, false);
  assert.equal((await decide({ path: '/api/quotes', cookie: await cookieFor('guess', { now }), env: ENV, now })).allow, false);
  assert.equal((await decide({ path: '/api/quotes', cookie: 'sd_lock=1', env: ENV, now })).allow, false, 'the marker cookie is not a credential');
});

test("the owner's machines get through with the owner key in a header, and only with the right one", async () => {
  assert.equal((await decide({ path: '/api/notify', search: '?op=run', authorization: 'Bearer unit-test-owner-key', env: ENV })).via, 'machine');
  assert.equal((await decide({ path: '/data/screen.json', authorization: 'bearer unit-test-owner-key', env: ENV })).via, 'machine');
  assert.equal((await decide({ path: '/api/quotes', authorization: 'Bearer wrong', env: ENV })).allow, false);
  assert.equal((await decide({ path: '/api/quotes', authorization: 'unit-test-owner-key', env: ENV })).allow, false, 'must be a Bearer header');
  assert.equal((await decide({ path: '/api/quotes', authorization: 'Bearer ', env: { APP_PASSWORD: PW } })).allow, false, 'no owner key on the server: no machine access');
  assert.equal((await decide({ path: '/api/quotes', authorization: 'Bearer undefined', env: { APP_PASSWORD: PW } })).allow, false);
});

test('after sign-in you are only ever sent to a page on this site', () => {
  assert.equal(safeNext('/swing'), '/swing');
  assert.equal(safeNext('/research?t=AAPL'), '/research?t=AAPL');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '', null, '/login', '/login?next=/login', '/a b', '/x\n', `/${'a'.repeat(400)}`]) assert.equal(safeNext(bad), '/', String(bad));
});

test('cookies: the session is HttpOnly, Secure and host-bound; signing out clears both', () => {
  const [session, marker] = sessionCookies('TOKEN');
  assert.match(session, /^__Host-sd_session=TOKEN; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(marker, /^sd_lock=1; /); assert.doesNotMatch(marker, /HttpOnly/);
  for (const c of clearCookies()) assert.match(c, /Max-Age=0/);
  assert.equal(cookieOf('a=1; __Host-sd_session=abc.def; b=2', SESSION_COOKIE), 'abc.def');
  assert.equal(cookieOf('x__Host-sd_session=nope', SESSION_COOKIE), null);
  assert.equal(cookieOf('', SESSION_COOKIE), null);
});

test('wrong guesses: four are free, the fifth locks that address for 15 minutes, each further one doubles it', () => {
  const t0 = 1_000_000_000_000; let s = {};
  for (let i = 0; i < ATTEMPTS.free; i++) { s = recordFailure(s, 'a', t0 + i); assert.equal(lockedFor(s, 'a', t0 + i), 0); }
  s = recordFailure(s, 'a', t0 + 10);
  assert.equal(lockedFor(s, 'a', t0 + 10), 15 * 60e3);
  assert.equal(lockedFor(s, 'b', t0 + 10), 0, 'another address is not affected');
  assert.equal(lockedFor(s, 'a', t0 + 10 + 15 * 60e3), 0, 'the lock ends');
  s = recordFailure(s, 'a', t0 + 20 * 60e3);
  assert.equal(lockedFor(s, 'a', t0 + 20 * 60e3), 30 * 60e3);
  for (let i = 0; i < 12; i++) s = recordFailure(s, 'a', t0 + 21 * 60e3 + i);
  assert.ok(lockedFor(s, 'a', t0 + 22 * 60e3) <= ATTEMPTS.maxMs, 'capped at a day');
  s = recordSuccess(s, 'a');
  assert.equal(s.ips.a, undefined);
});

test('wrong guesses spread over many addresses still trip the overall pause; quiet addresses are forgotten', () => {
  const t0 = 1_000_000_000_000; let s = {};
  for (let i = 0; i < ATTEMPTS.globalMax; i++) s = recordFailure(s, `ip${i}`, t0 + i);
  assert.equal(lockedFor(s, 'fresh', t0 + 100), 0);
  s = recordFailure(s, 'one-more', t0 + 200);
  assert.ok(lockedFor(s, 'fresh', t0 + 300) > 14 * 60e3, 'everyone waits, including an address that never guessed');
  assert.equal(lockedFor(s, 'fresh', t0 + 200 + ATTEMPTS.globalLockMs), 0);
  const later = recordFailure(s, 'z', t0 + 2 * DAY);
  assert.deepEqual(Object.keys(later.ips), ['z'], 'day-old entries are dropped');
  assert.equal(later.global.n, 1, 'and the hourly count starts again');
});

// ── the server half ──────────────────────────────────────────────────────────
function call(fn, { method = 'GET', url = '/api/x', headers = {}, body } = {}) {
  const out = { status: 200, headers: {}, body: null };
  const res = { setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; }, status(c) { out.status = c; return this; }, json(o) { out.body = o; } };
  return Promise.resolve(fn({ method, url, headers, body, query: Object.fromEntries(new URL(url, 'http://x').searchParams) }, res)).then(() => out);
}
const withEnv = async (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('every /api function refuses on its own when locked, and runs untouched when not', async () => {
  let ran = 0; const fn = gated(async (req, res) => { ran++; res.status(200).json({ ok: true }); });
  await withEnv({ APP_PASSWORD: null }, async () => { assert.equal((await call(fn)).status, 200); });
  assert.equal(ran, 1);
  await withEnv(ENV, async () => {
    const no = await call(fn, { url: '/api/quotes?tickers=SPY' });
    assert.equal(no.status, 401); assert.equal(no.headers['x-sd-auth'], 'required'); assert.equal(no.headers['cache-control'], 'no-store');
    assert.equal(ran, 1, 'the handler never ran');
    assert.equal((await call(fn, { url: '/api/quotes', headers: { cookie: await cookieFor() } })).status, 200);
    assert.equal((await call(fn, { url: '/api/quotes', headers: { authorization: 'Bearer unit-test-owner-key' } })).status, 200);
  });
  assert.equal(ran, 3);
});

test('sign-in: the right password sets the session; wrong ones are counted, then paused — even for the right one', async () => {
  let saved = {}; const store = { load: async () => saved, save: async (s) => { saved = s; } };
  const opts = { store, env: ENV, pause: async () => {} };
  const login = (password, ip = '203.0.113.9') => call((req, res) => authOp('login', req, res, opts), { method: 'POST', url: '/api/notify?op=login', headers: { 'x-forwarded-for': ip }, body: { password } });

  const ok = await login(PW);
  assert.equal(ok.status, 200);
  const token = /__Host-sd_session=([^;]+)/.exec(ok.headers['set-cookie'][0])[1];
  assert.equal((await verifySession(PW, token)).ok, true);

  for (let i = 0; i < 4; i++) assert.equal((await login('nope')).status, 401);
  const fifth = await login('nope');
  assert.equal(fifth.status, 401); assert.match(fifth.body.error, /paused for 15 minutes/);
  const locked = await login(PW);
  assert.equal(locked.status, 429, 'the right password is refused while paused');
  assert.equal(locked.headers['set-cookie'], undefined);
  assert.ok(+locked.headers['retry-after'] > 800);
  assert.equal((await login(PW, '198.51.100.7')).status, 200, 'another address can still sign in');
  assert.doesNotMatch(JSON.stringify(saved), /203\.0\.113\.9/, 'addresses are stored hashed');
  for (const bad of [undefined, 12345, { $ne: '' }, 'x'.repeat(300)]) assert.equal((await login(bad, '192.0.2.1')).status, 401);
});

test('session status, sign-out, and a deployment with no lock', async () => {
  const opts = { env: ENV };
  const session = (cookie) => call((req, res) => authOp('session', req, res, opts), { url: '/api/notify?op=session', headers: cookie ? { cookie } : {} });
  assert.deepEqual((await session()).body, { ok: true, lock: true, signedIn: false });
  const fresh = await session(await cookieFor());
  assert.deepEqual(fresh.body, { ok: true, lock: true, signedIn: true });
  assert.equal(fresh.headers['set-cookie'], undefined, 'a fresh session is left alone');
  const old = await session(await cookieFor(PW, { now: Date.now() - 20 * DAY }));
  assert.equal(old.body.signedIn, true);
  assert.match(old.headers['set-cookie'][0], /Max-Age=2592000/, 'past half-life it is renewed');
  const out = await call((req, res) => authOp('logout', req, res, opts), { method: 'POST' });
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await call((req, res) => authOp('logout', req, res, opts))).status, 405, 'a link cannot sign you out');
  assert.deepEqual((await call((req, res) => authOp('session', req, res, { env: {} }))).body, { ok: true, lock: false, signedIn: true });
  assert.equal(await authOp('run', {}, {}, opts), false, 'other operations are not handled here');
});

test("the owner key is attached only to this app's own address", async () => {
  const env = { ...ENV, VERCEL: '1', VERCEL_URL: 'signal-desk-abc123.vercel.app' };
  assert.equal(isOwnUrl('https://signal-desk-virid.vercel.app/api/scan?tickers=AAPL', env), true);
  assert.equal(isOwnUrl('https://signal-desk-abc123.vercel.app/data/earnings.json', env), true);
  for (const u of ['https://signal-desk-virid.vercel.app.evil.example/api/scan', 'https://evil.example/?https://signal-desk-virid.vercel.app', 'http://signal-desk-virid.vercel.app/api/scan', 'http://localhost:3000/api/scan', 'https://api.nasdaq.com/x', 'nonsense'])
    assert.equal(isOwnUrl(u, env), false, u);
  assert.equal(isOwnUrl('http://localhost:3000/api/scan', ENV), true, 'local development');

  const seen = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { seen.push({ url, auth: init.headers?.Authorization }); return { ok: true }; };
  try {
    await ownFetch('https://signal-desk-virid.vercel.app/api/scan', { headers: { Accept: 'x' } }, env);
    await ownFetch('https://api.nasdaq.com/api/quote', {}, env);
    await ownFetch('https://signal-desk-virid.vercel.app/api/scan', {}, { RUN_KEY: 'k', VERCEL: '1' });
  } finally { globalThis.fetch = real; }
  assert.deepEqual(seen.map((s) => s.auth), ['Bearer unit-test-owner-key', undefined, undefined], 'own address signed · another site not · lock off: no key sent at all');
});
