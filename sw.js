// Signal Desk service worker.
//
// Deliberately minimal: it exists so notifications can be shown through
// ServiceWorkerRegistration.showNotification (which works while any Signal
// Desk tab is open, including in the background) and so a tap on one opens
// the Alerts page. It does not cache pages — the desk is live data, and a
// stale cached page would show stale prices as if they were current.
//
// It has no `push` handler on purpose. Real push (browser closed) needs a
// server holding subscriptions, which this app does not have yet.

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
