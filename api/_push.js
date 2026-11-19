// Web Push for the alert runner (used by api/notify.js). The underscore keeps Vercel from routing
// this as a function of its own.
//
// A browser that has the app installed (on iPhone: added to the Home Screen) hands us a
// "subscription": an endpoint at its vendor's push service plus two keys. Sending means posting an
// encrypted message to that endpoint, signed with this server's VAPID key pair. The key pair is
// generated once and kept in the same private store as the rest of the alert state; no account
// with any push vendor is needed.

import * as webpush from 'web-push';

// The only hosts a subscription endpoint may point at. Without this, "subscribe" would let a
// caller make the server POST to any URL.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /\.notify\.windows\.com$/];
const B64U = /^[A-Za-z0-9_-]+$/;
export const MAX_DEVICES = 6;

/** A subscription as the browser's toJSON() gives it, validated; null when it is not one. */
export function cleanSubscription(s) {
  try {
    const u = new URL(String(s?.endpoint || ''));
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(u.hostname)) || u.href.length > 1200) return null;
    const p = String(s.keys?.p256dh || ''), a = String(s.keys?.auth || '');
    if (!B64U.test(p) || !B64U.test(a) || p.length < 60 || p.length > 120 || a.length < 16 || a.length > 40) return null;
    return { endpoint: u.href, keys: { p256dh: p, auth: a }, addedAt: Date.now() };
  } catch { return null; }
}
export function addDevice(list, sub) { return [...(list || []).filter((x) => x.endpoint !== sub.endpoint), sub].slice(-MAX_DEVICES); }
export function removeDevice(list, endpoint) { return (list || []).filter((x) => x.endpoint !== endpoint); }

/** This server's VAPID keys, made on first use. Returns [keys, created]. */
export function vapidKeys(state) {
  if (state.vapid?.publicKey && state.vapid?.privateKey) return [state.vapid, false];
  const k = webpush.generateVAPIDKeys();
  return [{ publicKey: k.publicKey, privateKey: k.privateKey, createdAt: Date.now() }, true];
}

/** What the service worker receives. Kept short: push payloads are limited to about 4 KB. */
export function payloadFor(title, body, url) {
  return JSON.stringify({ title: String(title || 'Signal Desk').slice(0, 120), body: String(body || '').slice(0, 600), url: typeof url === 'string' && url.startsWith('/') ? url : '/alerts' });
}

/**
 * Send one message to every device. Returns { ok, sent, failed, dead } where `dead` lists endpoints
 * the push service says no longer exist (app removed, permission withdrawn) so the caller can drop them.
 * `send` is injectable for tests.
 */
export async function pushAll(devices, vapid, subject, { title, body, url, urgent = false }, send = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts)) {
  const dead = []; let sent = 0, failed = 0;
  const payload = payloadFor(title, body, url);
  for (const d of devices || []) {
    try {
      await send({ endpoint: d.endpoint, keys: d.keys }, payload, { TTL: 6 * 3600, urgency: urgent ? 'high' : 'normal', vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } });
      sent++;
    } catch (e) { failed++; if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(d.endpoint); }
  }
  return { ok: sent > 0, sent, failed, dead };
}
