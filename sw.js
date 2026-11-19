// Signal Desk service worker.
//
// Deliberately minimal: it exists so notifications can be shown through
// ServiceWorkerRegistration.showNotification (which works while any Signal
// Desk tab is open, including in the background) and so a tap on one opens
// the Alerts page. It does not cache pages — the desk is live data, and a
// stale cached page would show stale prices as if they were current.
//
// The `push` handler below shows alerts sent by the server runner (api/notify.js via Web Push)
// when no Signal Desk page is open: the payload is { title, body, url }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/alerts';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname === url && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  const url = typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/alerts';
  e.waitUntil(self.registration.showNotification(d.title || 'Signal Desk', { body: d.body || '', data: { url }, icon: '/icon-192.png', badge: '/icon-192.png' }));
});
