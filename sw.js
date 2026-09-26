// Network-first para los archivos propios (así las actualizaciones llegan al momento),
// con la caché como respaldo sin conexión. Las APIs externas no pasan por aquí.
const CACHE = 'turbi-v61';
const SHELL = [
  './', 'index.html', 'css/style.css?v=2026-09-26.9', 'manifest.json',
  'js/app.js?v=2026-09-26.9', 'js/ui.js', 'js/route.js', 'js/time.js', 'js/weather.js', 'js/turbulence.js',
  'js/flight.js', 'js/airports.js', 'js/places.js', 'js/schedule.js', 'js/radar.js', 'js/radar-gate.js', 'js/radar-distance.js', 'js/physical-flight.js', 'js/status-refresh.js', 'js/eta.js', 'js/airline-photos.js',
  'js/altitude.js', 'js/turbi-index.js', 'js/models.js', 'js/confidence.js', 'js/summary.js', 'js/forecast.js',
  'js/ui-forecast.js', 'js/storage.js', 'js/aviation-weather.js', 'js/map.js', 'js/speech.js', 'js/config.js', 'js/punctuality.js', 'js/ui-punctuality.js', 'js/plain.js', 'data/icao.json',
  'data/airports.json', 'img/sky.jpg', 'img/turbi-logo.png', 'icons/icon-32.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' → la copia sin conexión es la recién publicada, no la que el navegador tenga guardada (GitHub: 10 min).
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: con red, siempre se pregunta al servidor si hay versión nueva (si no la hay, responde 304 y no se descarga).
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
