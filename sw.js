// Service worker: מאפשר לפתוח את האתר גם ללא רשת. הנתונים עצמם לא נשמרים כאן.
const CACHE = 'ar-shell-v1';
const SHELL = ['./', 'index.html', 'assets/css/app.css', 'assets/css/receipt.css', 'assets/css/fonts.css', 'assets/img/logo.jpg', 'assets/img/signature.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/data/')) return;
  // רשת קודם — כדי שעדכונים יגיעו מיד; מטמון רק כגיבוי
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
