/*
 * Livynq service worker: shows Web Push notifications and opens the app when one is tapped.
 * No offline caching on purpose — the hub is on the local network and the UI must match it.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Livynq';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || data.id,
      renotify: Boolean(data.tag),
      requireInteraction: data.kind === 'confirmation',
      icon: '/icon-192.png',
      badge: '/badge-72.png',
      timestamp: data.ts || Date.now(),
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === target.origin);
      if (open) {
        await open.focus();
        if (target.hash && 'navigate' in open) return open.navigate(target.href).catch(() => {});
        return;
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
