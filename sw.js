const CACHE = 'ender-slicer-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'loader.js', 'slicer.js', 'worker.js', 'manifest.webmanifest',
  'lib/clipper.js', 'lib/fflate.js', 'lib/three.module.min.js', 'lib/OrbitControls.js',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Netzwerk zuerst (damit Updates ankommen), Cache als Rückfall (offline). Fremde Hosts (Drucker) nie anfassen.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then((m) => m || caches.match('index.html')))
  );
});
