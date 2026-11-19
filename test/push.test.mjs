import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSubscription, addDevice, removeDevice, vapidKeys, payloadFor, pushAll, MAX_DEVICES } from '../api/_push.js';

const KEYS = { p256dh: 'B' + 'a'.repeat(86), auth: 'c'.repeat(22) };
const sub = (endpoint) => ({ endpoint, keys: KEYS });

test('only real push-service endpoints are accepted, so "subscribe" cannot aim the server at another host', () => {
  assert.ok(cleanSubscription(sub('https://web.push.apple.com/QOabc')));
  assert.ok(cleanSubscription(sub('https://fcm.googleapis.com/fcm/send/abc')));
  assert.ok(cleanSubscription(sub('https://updates.push.services.mozilla.com/wpush/v2/abc')));
  for (const bad of ['https://evil.example/hook', 'http://web.push.apple.com/x', 'https://push.apple.com.evil.example/x', 'https://169.254.169.254/latest', 'not a url'])
    assert.equal(cleanSubscription(sub(bad)), null, bad);
  assert.equal(cleanSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: '<script>', auth: 'x' } }), null);
  assert.equal(cleanSubscription(null), null);
});

test('devices: the same phone subscribing twice is one device, the list is capped, removal is by endpoint', () => {
  let list = [];
  for (let i = 0; i < MAX_DEVICES + 2; i++) list = addDevice(list, cleanSubscription(sub(`https://web.push.apple.com/d${i}`)));
  assert.equal(list.length, MAX_DEVICES);
  list = addDevice(list, cleanSubscription(sub('https://web.push.apple.com/d7')));
  assert.equal(list.length, MAX_DEVICES, 're-subscribing does not duplicate');
  assert.equal(removeDevice(list, 'https://web.push.apple.com/d7').length, MAX_DEVICES - 1);
});

test('the key pair is made once and reused', () => {
  const [k, created] = vapidKeys({});
  assert.equal(created, true); assert.ok(k.publicKey.length > 80 && k.privateKey.length > 40);
  assert.deepEqual(vapidKeys({ vapid: k }), [k, false]);
});

test('the payload carries a title, the alert text and an in-app link only', () => {
  assert.deepEqual(JSON.parse(payloadFor('🟢 Buy signal: KMI', 'Entry near $34.43', '/swing')), { title: '🟢 Buy signal: KMI', body: 'Entry near $34.43', url: '/swing' });
  assert.equal(JSON.parse(payloadFor('t', 'b', 'https://evil.example')).url, '/alerts', 'no off-site links');
  assert.ok(payloadFor('t', 'x'.repeat(5000)).length < 1000);
});

test('sending: one failure does not stop the rest, and devices the service reports gone are returned for removal', async () => {
  const devices = ['a', 'b', 'c'].map((x) => cleanSubscription(sub(`https://web.push.apple.com/${x}`)));
  const calls = [];
  const send = async (s, payload, opts) => {
    calls.push({ endpoint: s.endpoint, urgency: opts.urgency, subject: opts.vapidDetails.subject, payload });
    if (s.endpoint.endsWith('/b')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    if (s.endpoint.endsWith('/c')) throw Object.assign(new Error('busy'), { statusCode: 503 });
  };
  const [vapid] = vapidKeys({});
  const r = await pushAll(devices, vapid, 'https://example.test', { title: 'T', body: 'B', url: '/swing', urgent: true }, send);
  assert.deepEqual({ ok: r.ok, sent: r.sent, failed: r.failed, dead: r.dead }, { ok: true, sent: 1, failed: 2, dead: ['https://web.push.apple.com/b'] });
  assert.equal(calls.length, 3); assert.equal(calls[0].urgency, 'high'); assert.equal(JSON.parse(calls[0].payload).url, '/swing');
  assert.equal((await pushAll([], vapid, 'https://example.test', { title: 'T' }, send)).ok, false);
});
