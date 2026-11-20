// Vercel serverless: /api/vault?op=get|put|delete
//
// Storage for "Sync across devices" (sync.js). This endpoint is deliberately dumb: it stores and
// returns an opaque encrypted blob under an id. Everything that matters happens in the browser:
//
//   • the id is a SHA-256 of the user's sync code — the code itself never reaches the server;
//   • the blob is AES-GCM ciphertext under a key derived from the user's passphrase — the server
//     holds neither, so it cannot read what it stores, and nor can anyone with access to it.
//
//   get     GET  ?id=<64 hex>                → { found, rev, updatedAt, iv, ct }
//   put     POST { id, rev, iv, ct }         → { ok, rev }  (rev = the revision the client last saw;
//                                               409 { conflict, rev } when another device wrote first)
//   delete  POST { id }                      → { ok }       (the user removing their cloud copy)
//
// No accounts and no email. Knowing the id is the credential, and it is unguessable (derived from
// 100 random bits). When the app lock is on (../gate.js) the caller must also be signed in. STORAGE: Vercel Blob (private), one object per id. For local
// development, set SD_VAULT_DIR to a folder and objects are kept there as files instead.

import { put, get, del } from '@vercel/blob';
import fs from 'node:fs';
import path from 'node:path';

import { gated } from './_gate.js';
const MAX_CT = 900_000;                           // ~650 KB of data once base64 is undone; far above any real book
const ID = /^[a-f0-9]{64}$/;
const B64 = /^[A-Za-z0-9+/=]+$/;
const blobPath = (id) => `signal-desk/vault/${id}.json`;
const devDir = () => process.env.SD_VAULT_DIR || '';
const hasStore = () => !!(devDir() || process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

export const store = {
  async read(id) {
    if (devDir()) { try { return JSON.parse(fs.readFileSync(path.join(devDir(), `${id}.json`), 'utf8')); } catch { return null; } }
    try {
      const r = await get(blobPath(id), { access: 'private' });
      if (!r || r.statusCode === 404 || !r.stream) return null;
      return JSON.parse((await new Response(r.stream).text()) || 'null');
    } catch { return null; }
  },
  async write(id, doc) {
    if (devDir()) { fs.mkdirSync(devDir(), { recursive: true }); fs.writeFileSync(path.join(devDir(), `${id}.json`), JSON.stringify(doc)); return; }
    await put(blobPath(id), JSON.stringify(doc), { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  },
  async remove(id) {
    if (devDir()) { try { fs.unlinkSync(path.join(devDir(), `${id}.json`)); } catch { /* already gone */ } return; }
    try { await del(blobPath(id)); } catch { /* already gone */ }
  },
};

// A small brake on anyone hammering the endpoint from one address. Per instance, so it is a
// speed bump rather than a wall; the size cap and the unguessable ids are the real limits.
const hits = new Map();
function limited(req) {
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const now = Date.now(), w = hits.get(ip) || { t: now, n: 0 };
  if (now - w.t > 60_000) { w.t = now; w.n = 0; }
  w.n++; hits.set(ip, w);
  if (hits.size > 5000) hits.clear();
  return w.n > 40;
}

async function handler(req, res, s = store) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStore() && s === store) { res.status(503).json({ error: 'Storage is not connected on this deployment, so sync is unavailable.' }); return; }
  if (limited(req)) { res.status(429).json({ error: 'Too many requests. Try again in a minute.' }); return; }
  const op = String((req.query && req.query.op) || '').toLowerCase();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const id = String(op === 'get' ? (req.query && req.query.id) || '' : body.id || '');
  if (!ID.test(id)) { res.status(400).json({ error: 'Bad id.' }); return; }

  if (op === 'get' && req.method === 'GET') {
    const doc = await s.read(id);
    res.status(200).json(doc ? { found: true, rev: doc.rev, updatedAt: doc.updatedAt, iv: doc.iv, ct: doc.ct } : { found: false });
    return;
  }
  if (op === 'put' && req.method === 'POST') {
    const { iv, ct } = body, rev = Number(body.rev) || 0;
    if (typeof iv !== 'string' || typeof ct !== 'string' || !B64.test(iv) || !B64.test(ct) || iv.length > 64) { res.status(400).json({ error: 'Bad payload.' }); return; }
    if (ct.length > MAX_CT) { res.status(413).json({ error: 'Too large to sync.' }); return; }
    const cur = await s.read(id);
    if ((cur ? cur.rev : 0) !== rev) { res.status(409).json({ conflict: true, rev: cur ? cur.rev : 0 }); return; }
    const doc = { v: 1, rev: rev + 1, updatedAt: new Date().toISOString(), iv, ct };
    await s.write(id, doc);
    res.status(200).json({ ok: true, rev: doc.rev, updatedAt: doc.updatedAt });
    return;
  }
  if (op === 'delete' && req.method === 'POST') { await s.remove(id); res.status(200).json({ ok: true }); return; }
  res.status(400).json({ error: 'Pass ?op=get|put|delete' });
}

// Behind the app lock when one is set (see ../gate.js).
export default gated(handler);
