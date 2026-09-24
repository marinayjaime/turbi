// Network-first para los archivos propios (así las actualizaciones llegan al momento),
// con la caché como respaldo sin conexión. Las APIs externas no pasan por aquí.
const CACHE = 'turbi-v11';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.json',
  'js/app.js', 'js/ui.js', 'js/route.js', 'js/time.js', 'js/weather.js', 'js/turbulence.js',
  'js/flight.js', 'js/airports.js', 'js/places.js', 'js/schedule.js',
  'js/altitude.js', 'js/turbi-index.js', 'js/models.js', 'js/confidence.js', 'js/summary.js', 'js/forecast.js',
  'js/ui-forecast.js', 'js/storage.js', 'js/aviation-weather.js', 'js/map.js', 'js/speech.js', 'js/punctuality.js', 'js/ui-punctuality.js', 'js/plain.js', 'data/icao.json',
  'data/airports.json', 'img/sky.jpg', 'icons/icon-32.png', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
