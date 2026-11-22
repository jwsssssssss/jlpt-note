// Hub page (jws-lab): works offline.
// Handles only the hub's own files; each app folder has its own sw.js (narrower scope wins there).
// Only deletes its own caches (prefix apps-hub-), never the apps' caches.
const C = 'apps-hub-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('apps-hub-') && k !== C).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin) return;
  const base = new URL('./', self.location).pathname;
  if (!u.pathname.startsWith(base)) return;
  const rel = u.pathname.slice(base.length);
  if (rel === '' || rel === 'index.html') {
    e.respondWith(fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put('./index.html', cp)); }
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // hub files + each app's card icon (so the hub looks right offline)
  if (rel === 'manifest.webmanifest' || rel.startsWith('icons/') || /^[^/]+\/icons\/icon-192\.png$/.test(rel)) {
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(C).then(c => c.put(r, cp)); }
      return res;
    })));
  }
});
