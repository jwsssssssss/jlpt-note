// Hub page (jws-lab): works offline.
// Handles only the hub's own files; each app folder has its own sw.js (narrower scope wins there).
// Only deletes its own caches (prefix apps-hub-), never the apps' caches.
const C = 'apps-hub-v6';
// 처음 설치할 때 저장: 메인 파일 + 메인 카드에 보이는 앱 아이콘 (첫 방문 직후 오프라인이어도 카드 그림이 보이게)
// 새 앱을 메인에 카드로 넣으면 그 앱의 './<폴더>/icons/icon-192.png'도 여기에 넣고 C 숫자를 올려요.
const CORE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png',
  './jlpt/icons/icon-192.png'];

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
      if (res.ok && !res.redirected) { const cp = res.clone(); caches.open(C).then(c => c.put('./', cp)); }
      return res;
    }).catch(() => caches.match('./')));
    return;
  }
  // hub files + each app's card icon (so the hub looks right offline)
  // 저장해 둔 것을 바로 보여 주고, 뒤에서 새로 받아 바꿔 둠 → 아이콘을 바꾸면 다음 방문부터 새 그림 (캐시 이름을 안 올려도)
  if (rel === 'manifest.webmanifest' || rel.startsWith('icons/') || /^[^/]+\/icons\/icon-192\.png$/.test(rel)) {
    e.respondWith(caches.open(C).then(c => c.match(r).then(m => {
      const net = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; });
      if (m) { e.waitUntil(net.catch(() => {})); return m; }
      return net;
    })));
  }
});
