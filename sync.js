// Signal Desk — sync across devices, end-to-end encrypted.
//
// The app keeps everything in this browser's localStorage. This module lets a second device (or
// the home-screen copy of the app, which has its own storage) share that data without accounts:
//
//   device A   "Set up sync" → the app makes a SYNC CODE and you choose a PASSPHRASE
//   device B   "I have a code" → enter both → it gets A's data, and from then on both stay in step
//
// What the server (/api/vault) sees: an id that is a hash of the code, and ciphertext. The code
// and the passphrase never leave the browser, so the stored copy cannot be read by the server,
// its host, or anyone who obtains it. Losing the passphrase means losing the cloud copy — there
// is nobody who can reset it. The data on each device is unaffected.
//
// Conflicts: if two devices changed things since they last agreed, nothing is overwritten
// silently — sync stops and asks which copy to keep.

const te = new TextEncoder(), td = new TextDecoder();
export const VAULT_KEY = 'sd-vault-v1';                 // this device's link to the cloud copy (never synced)
/** What travels. Per-device things (theme, alert de-duplication, alert history) stay put. */
export const SYNC_KEYS = [
  'sd-portfolio-v1', 'sd-journal-v1', 'sd-capital',
  'sd-swing-capital', 'sd-swing-risk', 'sd-swing-fractional', 'sd-swing-watch-v1', 'sd-swing-book-v1', 'sd-swing-journal-v1',
  'sd-alerts-watch-v1', 'sd-alerts-settings-v1', 'sd-sync-key-v1',
  'sd-sims-v1', 'sd-research-recent',
];
const PBKDF2_ITERATIONS = 310_000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I: the code is read aloud and typed

const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha = async (text) => crypto.subtle.digest('SHA-256', te.encode(text));

export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (code) => normalizeCode(code).replace(/(.{4})(?=.)/g, '$1-');
export function newCode() {
  const r = crypto.getRandomValues(new Uint8Array(20));
  return formatCode([...r].map((x) => ALPHABET[x % 32]).join(''));       // 20 symbols × 5 bits = 100 bits
}
export const vaultId = async (code) => hex(await sha('sd-vault-id:' + normalizeCode(code)));
/** The AES key, as raw bytes in base64 so this device can keep it and sync without asking again. */
export async function deriveKey(code, passphrase) {
  const salt = await sha('sd-vault-salt:' + normalizeCode(code));
  const base = await crypto.subtle.importKey('raw', te.encode(String(passphrase)), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, base, 256));
}
const aes = (keyB64) => crypto.subtle.importKey('raw', unb64(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
export async function encrypt(keyB64, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), ct: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aes(keyB64), te.encode(JSON.stringify(obj)))) };
}
export async function decrypt(keyB64, { iv, ct }) {
  try { return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aes(keyB64), unb64(ct)))); }
  catch { throw new Error('Wrong passphrase for this code, or the cloud copy is damaged.'); }
}

/**
 * The sync engine over any storage and fetch (the browser's by default; the tests pass their own).
 * Every method returns a plain result; nothing here touches the page.
 */
export function createSync({ storage = globalThis.localStorage, fetchFn = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  const getState = () => { try { return JSON.parse(storage.getItem(VAULT_KEY) || 'null'); } catch { return null; } };
  const setState = (s) => { if (s) storage.setItem(VAULT_KEY, JSON.stringify(s)); else storage.removeItem(VAULT_KEY); };
  const collect = () => { const o = {}; for (const k of SYNC_KEYS) { const v = storage.getItem(k); if (v != null) o[k] = v; } return o; };
  const digest = async (o) => hex(await sha(JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))));
  const apply = (o) => { for (const k of SYNC_KEYS) { if (k in o) storage.setItem(k, o[k]); else storage.removeItem(k); } };
  const hasLocalData = () => SYNC_KEYS.some((k) => { const v = storage.getItem(k); return v != null && v !== '[]' && v !== '{}' && k !== 'sd-capital'; });
  const api = async (op, { id, body } = {}) => {
    const r = op === 'get'
      ? await fetchFn(`${base}/api/vault?op=get&id=${id}`, { cache: 'no-store' })
      : await fetchFn(`${base}/api/vault?op=${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) throw new Error(d.error || `Sync server answered ${r.status}.`);
    return d;
  };
  const push = async (st, data, rev) => {
    const d = await api('put', { body: { id: st.id, rev, ...(await encrypt(st.key, data)) } });
    if (d.conflict) return { status: 'conflict-remote', rev: d.rev };
    setState({ ...st, rev: d.rev, hash: await digest(data), at: d.updatedAt });
    return { status: 'pushed', rev: d.rev };
  };

  return {
    state: getState, collect, hasLocalData,
    /** First device: make a code, encrypt what is here, store it. Returns the code to show the user. */
    async setup(passphrase) {
      if (String(passphrase || '').length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      const code = newCode(), st = { code, id: await vaultId(code), key: await deriveKey(code, passphrase), rev: 0 };
      const r = await push(st, collect(), 0);
      if (r.status !== 'pushed') throw new Error('Could not create the cloud copy. Try again.');
      return { code };
    },
    /** Another device: fetch and decrypt. With `replace` it also adopts the data and links this device. */
    async join(code, passphrase, { replace = false } = {}) {
      const c = formatCode(code);
      if (normalizeCode(c).length !== 20) throw new Error('A sync code has 20 letters and digits.');
      const id = await vaultId(c), remote = await api('get', { id });
      if (!remote.found) throw new Error('No cloud copy exists for that code. Check it against the first device.');
      const key = await deriveKey(c, passphrase), data = await decrypt(key, remote);
      if (!replace) return { status: 'ready', items: Object.keys(data).length, updatedAt: remote.updatedAt, wouldReplace: hasLocalData() };
      apply(data);
      setState({ code: c, id, key, rev: remote.rev, hash: await digest(data), at: remote.updatedAt });
      return { status: 'pulled', updatedAt: remote.updatedAt };
    },
    /**
     * Bring this device and the cloud copy into step.
     *   'off' not set up · 'up-to-date' · 'pushed' · 'pulled' (the page should reload) ·
     *   'conflict' both changed (call resolve) · 'gone' the cloud copy was deleted elsewhere
     */
    async syncNow() {
      const st = getState();
      if (!st) return { status: 'off' };
      const local = collect(), localChanged = (await digest(local)) !== st.hash;
      const remote = await api('get', { id: st.id });
      if (!remote.found) return st.rev ? { status: 'gone' } : push(st, local, 0);
      if (remote.rev === st.rev) return localChanged ? push(st, local, st.rev) : { status: 'up-to-date', at: st.at };
      if (localChanged) return { status: 'conflict', remoteAt: remote.updatedAt };
      const data = await decrypt(st.key, remote);
      apply(data);
      setState({ ...st, rev: remote.rev, hash: await digest(data), at: remote.updatedAt });
      return { status: 'pulled', at: remote.updatedAt };
    },
    /** Settle a conflict: 'mine' overwrites the cloud copy with this device, 'theirs' takes the cloud copy. */
    async resolve(keep) {
      const st = getState();
      if (!st) return { status: 'off' };
      const remote = await api('get', { id: st.id });
      if (keep === 'mine') return push(st, collect(), remote.found ? remote.rev : 0);
      if (!remote.found) return { status: 'gone' };
      const data = await decrypt(st.key, remote);
      apply(data);
      setState({ ...st, rev: remote.rev, hash: await digest(data), at: remote.updatedAt });
      return { status: 'pulled', at: remote.updatedAt };
    },
    /** Has anything syncable changed here since the last agreement? Cheap; used before leaving a page. */
    async dirty() { const st = getState(); return !!st && (await digest(collect())) !== st.hash; },
    /** Stop syncing on this device; with wipe, also delete the cloud copy for every device. Local data stays. */
    async disconnect({ wipe = false } = {}) {
      const st = getState();
      if (st && wipe) await api('delete', { body: { id: st.id } });
      setState(null);
      return { status: 'off' };
    },
  };
}

// ── In the page ─────────────────────────────────────────────────────────
// Every page loads this module. If the device is linked, it syncs on load (reloading once when
// newer data arrived), pushes changes while the page is open, and shows a small bar on conflict.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const sync = createSync();
  window.sdSync = sync;
  const RELOADED = 'sd-vault-reloaded';
  const bar = (text, action) => {
    let el = document.getElementById('sd-sync-bar');
    if (!el) { el = document.createElement('div'); el.id = 'sd-sync-bar'; el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:1200;max-width:min(560px,92vw);background:var(--ink,#1d1d1f);color:var(--ground,#fff);border-radius:14px;padding:12px 16px;font:14px/1.4 var(--sans,system-ui);box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;gap:12px;align-items:center'; document.body.appendChild(el); }
    el.textContent = text;
    if (action) { const a = document.createElement('a'); a.href = action.href; a.textContent = action.label; a.style.cssText = 'color:inherit;font-weight:600;white-space:nowrap'; el.appendChild(a); }
  };
  const run = async (reason) => {
    if (!sync.state()) return;
    try {
      const r = await sync.syncNow();
      window.dispatchEvent(new CustomEvent('sd-sync', { detail: { ...r, reason } }));
      if (r.status === 'pulled') {
        if (sessionStorage.getItem(RELOADED) !== String(sync.state()?.rev)) { sessionStorage.setItem(RELOADED, String(sync.state()?.rev)); location.reload(); }
      } else if (r.status === 'conflict' || r.status === 'conflict-remote') bar('This device and another both changed since the last sync.', { href: '/dashboard#sync', label: 'Choose which to keep' });
      else if (r.status === 'gone') bar('The cloud copy was deleted from another device. Sync is paused here.', { href: '/dashboard#sync', label: 'Open sync' });
    } catch (e) { window.dispatchEvent(new CustomEvent('sd-sync', { detail: { status: 'error', error: e.message, reason } })); }
  };
  run('load');
  setInterval(async () => { if (!document.hidden && (await sync.dirty().catch(() => false))) run('change'); }, 45_000);
  document.addEventListener('visibilitychange', async () => { if (document.hidden) { if (await sync.dirty().catch(() => false)) run('leave'); } else run('return'); });
}
