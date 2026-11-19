import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSync, newCode, formatCode, normalizeCode, vaultId, deriveKey, encrypt, decrypt, SYNC_KEYS, VAULT_KEY } from '../sync.js';
import handler from '../api/vault.js';

// A device = its own storage. The "server" is the real /api/vault handler over an in-memory store.
const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m }; };
function server() {
  const docs = new Map(), seen = [];
  const s = { read: async (id) => docs.get(id) || null, write: async (id, d) => { docs.set(id, d); }, remove: async (id) => { docs.delete(id); } };
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url, 'http://x'); const body = opts.body ? JSON.parse(opts.body) : undefined;
    seen.push({ url: u.pathname + u.search, body: opts.body || '' });
    let status = 200, out = null;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json(o) { out = o; } };
    await handler({ method: opts.method || 'GET', query: Object.fromEntries(u.searchParams), body, headers: { 'x-forwarded-for': `10.0.0.${seen.length % 200}` } }, res, s);
    return { ok: status >= 200 && status < 300, status, json: async () => out };
  };
  return { fetchFn, docs, seen };
}
const device = (srv) => { const storage = memory(); return { storage, sync: createSync({ storage, fetchFn: srv.fetchFn }) }; };
const PASS = 'test-passphrase-one';

test('codes are 20 unambiguous symbols; the id and key depend on the code and never equal it', async () => {
  const c = newCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){4}$/);
  assert.equal(formatCode(c.toLowerCase().replace(/-/g, ' ')), c);
  const id = await vaultId(c);
  assert.match(id, /^[a-f0-9]{64}$/); assert.ok(!id.toUpperCase().includes(normalizeCode(c)));
  assert.notEqual(await deriveKey(c, PASS), await deriveKey(c, PASS + 'x'));
  assert.notEqual(await deriveKey(c, PASS), await deriveKey(newCode(), PASS));
});

test('encryption round-trips, and the wrong key fails loudly rather than returning rubbish', async () => {
  const c = newCode(), k = await deriveKey(c, PASS), box = await encrypt(k, { a: 'DIS 8 sh' });
  assert.deepEqual(await decrypt(k, box), { a: 'DIS 8 sh' });
  await assert.rejects(decrypt(await deriveKey(c, 'another-passphrase'), box), /Wrong passphrase/);
});

test('set up on one device, join on another: the data arrives, and the server never saw it', async () => {
  const srv = server(), A = device(srv), B = device(srv);
  A.storage.setItem('sd-portfolio-v1', JSON.stringify([{ id: 'DIS-1', ticker: 'DIS', qty: 8, buyPrice: 121.52 }]));
  A.storage.setItem('sd-capital', '10000'); A.storage.setItem('sd-theme', 'dark');
  await assert.rejects(A.sync.setup('short'), /at least 8/);
  const { code } = await A.sync.setup(PASS);
  const wire = JSON.stringify(srv.seen) + JSON.stringify([...srv.docs.values()]);
  for (const secret of ['DIS', '121.52', PASS, normalizeCode(code), code]) assert.ok(!wire.includes(secret), `"${secret}" must not reach the server`);

  await assert.rejects(B.sync.join(code, 'wrong-passphrase-here'), /Wrong passphrase/);
  await assert.rejects(B.sync.join('AAAA-AAAA-AAAA-AAAA-AAAA', PASS), /No cloud copy/);
  const look = await B.sync.join(code, PASS);
  assert.equal(look.status, 'ready'); assert.equal(B.storage.getItem('sd-portfolio-v1'), null, 'looking does not change the device');
  assert.equal((await B.sync.join(code, PASS, { replace: true })).status, 'pulled');
  assert.equal(JSON.parse(B.storage.getItem('sd-portfolio-v1'))[0].ticker, 'DIS');
  assert.equal(B.storage.getItem('sd-theme'), null, 'theme is per device'); assert.ok(!SYNC_KEYS.includes(VAULT_KEY));
});

test('a change on one device reaches the other; with nothing changed nothing is written', async () => {
  const srv = server(), A = device(srv), B = device(srv);
  A.storage.setItem('sd-journal-v1', '[]');
  const { code } = await A.sync.setup(PASS); await B.sync.join(code, PASS, { replace: true });
  assert.equal((await B.sync.syncNow()).status, 'up-to-date');
  B.storage.setItem('sd-swing-watch-v1', '["KMI"]');
  assert.equal(await B.sync.dirty(), true);
  assert.equal((await B.sync.syncNow()).status, 'pushed'); assert.equal(await B.sync.dirty(), false);
  assert.equal((await A.sync.syncNow()).status, 'pulled'); assert.equal(A.storage.getItem('sd-swing-watch-v1'), '["KMI"]');
  B.storage.removeItem('sd-swing-watch-v1'); await B.sync.syncNow(); await A.sync.syncNow();
  assert.equal(A.storage.getItem('sd-swing-watch-v1'), null, 'a deletion travels too');
});

test('both devices changed: sync stops and asks; either answer leaves the two in step', async () => {
  const srv = server(), A = device(srv), B = device(srv);
  const { code } = await A.sync.setup(PASS); await B.sync.join(code, PASS, { replace: true });
  A.storage.setItem('sd-capital', '5000'); await A.sync.syncNow();
  B.storage.setItem('sd-capital', '9000');
  assert.equal((await B.sync.syncNow()).status, 'conflict'); assert.equal(B.storage.getItem('sd-capital'), '9000', 'nothing overwritten yet');
  assert.equal((await B.sync.resolve('theirs')).status, 'pulled'); assert.equal(B.storage.getItem('sd-capital'), '5000');
  A.storage.setItem('sd-capital', '6000'); await A.sync.syncNow(); B.storage.setItem('sd-capital', '7000');
  assert.equal((await B.sync.syncNow()).status, 'conflict');
  assert.equal((await B.sync.resolve('mine')).status, 'pushed');
  assert.equal((await A.sync.syncNow()).status, 'pulled'); assert.equal(A.storage.getItem('sd-capital'), '7000');
});

test('turning sync off keeps the device\'s data; deleting the cloud copy pauses the other device', async () => {
  const srv = server(), A = device(srv), B = device(srv);
  A.storage.setItem('sd-capital', '10000');
  const { code } = await A.sync.setup(PASS); await B.sync.join(code, PASS, { replace: true });
  await A.sync.disconnect({ wipe: true });
  assert.equal(A.sync.state(), null); assert.equal(A.storage.getItem('sd-capital'), '10000'); assert.equal(srv.docs.size, 0);
  assert.equal((await A.sync.syncNow()).status, 'off');
  assert.equal((await B.sync.syncNow()).status, 'gone'); assert.equal(B.storage.getItem('sd-capital'), '10000');
});

test('the server refuses malformed ids, oversized blobs and stale revisions', async () => {
  const srv = server(), call = async (url, body) => { const r = await srv.fetchFn(url, body ? { method: 'POST', body: JSON.stringify(body) } : {}); return { status: r.status, ...(await r.json()) }; };
  const id = 'a'.repeat(64);
  assert.equal((await call('/api/vault?op=get&id=../../etc')).status, 400);
  assert.equal((await call('/api/vault?op=put', { id, rev: 0, iv: 'AAAA', ct: 'A'.repeat(900_001) })).status, 413);
  assert.equal((await call('/api/vault?op=put', { id, rev: 0, iv: 'AAAA', ct: '<script>' })).status, 400);
  assert.equal((await call('/api/vault?op=put', { id, rev: 0, iv: 'AAAA', ct: 'QUJD' })).rev, 1);
  assert.equal((await call('/api/vault?op=put', { id, rev: 0, iv: 'AAAA', ct: 'QUJD' })).status, 409, 'someone else wrote first');
  assert.equal((await call(`/api/vault?op=get&id=${id}`)).ct, 'QUJD');
});
