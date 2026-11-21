/* Cullinon service worker: offline shell + Web Push. Cache name is stamped at build time. */
const CACHE = 'cullinon-__BUILD_ID__';
const SHELL = [
  './', './index.html', './config.js', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/util.js', './js/api.js', './js/demo.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-64.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('cullinon-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Only our own static files. API calls (cross-origin) are never cached or intercepted.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('/config.js');
  if (networkFirst) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'کالینون', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(String(d.title || 'کالینون').slice(0, 120), {
      body: String(d.body || '').slice(0, 300),
      tag: d.tag || undefined,
      icon: './icons/icon-192.png',
      dir: 'rtl',
      lang: 'fa',
      data: { url: typeof d.url === 'string' ? d.url : './' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const mine = list.find((c) => c.url.startsWith(self.registration.scope));
      if (mine) return mine.focus();
      return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
