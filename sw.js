const V = 'kickoff-v5';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Crests and photos: cache first (they rarely change)
  if (url.hostname.endsWith('espncdn.com')) {
    e.respondWith(caches.open(V + '-img').then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }).catch(() => fetch(e.request)));
    return;
  }
  // Scores and news: network first, last copy when offline
  if (url.hostname.includes('espn.com')) {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(V + '-data').then(c => c.put(e.request.url, copy));
      return r;
    }).catch(() => caches.match(e.request.url)));
    return;
  }
  // App files: network first so updates show up, cache when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(V).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)));
  }
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
