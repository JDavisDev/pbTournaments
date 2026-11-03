// Courtside's service worker: makes the site installable to the Home Screen
// and shows match alerts. It caches nothing, so pages are always current.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Sent by web/src/server/push.ts: { title, body, url, tag }.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Courtside', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      // A new match call replacing an old one in the tray still buzzes.
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

// Tapping an alert opens its link, reusing a Courtside window when one is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // Focus first, while the tap still counts; a window this worker doesn't
      // control can't be navigated, so then a new one opens.
      return open
        .focus()
        .then((w) => w.navigate(url))
        .catch(() => self.clients.openWindow(url));
    }),
  );
});
