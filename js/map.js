// Mapa sencillo con Leaflet + OpenStreetMap. Se carga después del resultado y es prescindible:
// si falla, la app sigue igual (la timeline es la visualización principal).

import { esc } from './ui.js';
import { icon } from './icons.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const SRI = {
  js: 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==',
  css: 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==',
};
const COLORS = ['#8e8e93', '#e6b800', '#ff9f0a', '#ff3b30'];

// Tramos consecutivos del mismo nivel (un punto sin datos continúa el tramo anterior).
export function routeLines(route) {
  const lines = [];
  let prev = null;
  for (const p of route) {
    const level = p.level ?? prev?.level ?? 0;
    const pt = [p.lat, p.lon];
    if (!prev || prev.level !== level) {
      if (prev) prev.coords.push(pt); // el tramo anterior llega hasta aquí
      prev = { level, coords: [] };
      lines.push(prev);
    }
    prev.coords.push(pt);
  }
  return lines;
}

let loading = null;
function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  loading ??= new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${LEAFLET}leaflet.min.css`, integrity: SRI.css, crossOrigin: 'anonymous' });
    const js = Object.assign(document.createElement('script'), { src: `${LEAFLET}leaflet.min.js`, integrity: SRI.js, crossOrigin: 'anonymous' });
    js.onload = () => resolve(globalThis.L);
    js.onerror = () => { loading = null; reject(new Error('Leaflet no disponible')); };
    document.head.append(css, js);
  });
  return loading;
}

// Título de la tarjeta según la fase de la ficha (la misma agrupación de card-model.js): antes de volar y si se
// cancela, la ruta prevista; en vuelo, el radar; ya aterrizado, la ruta realizada.
const TITLES = { programado: 'Ruta prevista', cancelado: 'Ruta prevista', 'en-curso': 'Radar', finalizado: 'Ruta realizada' };

// Tarjeta del mapa, independiente del pronóstico. #map-facts nace vacío (lo rellena la integración si hay datos);
// el botón de cerrar solo se ve ampliada (CSS) y ocupa el sitio del de ampliar.
export function mapCardHtml(phase) {
  const title = TITLES[phase] ?? TITLES.programado;
  return `<section class="card map-card" id="map-card">
  <h3 class="card-head"><span class="card-title">${esc(title)}</span>
    <button type="button" class="map-btn" data-map="expand" aria-label="Ampliar el mapa">${icon('expand')}</button>
    <button type="button" class="map-btn map-close" data-map="close" aria-label="Cerrar el mapa ampliado">${icon('close')}</button>
  </h3>
  <div id="map" class="map"></div>
  <div id="map-facts"></div>
</section>`;
}

// Ampliar / cerrar: la tarjeta pasa a pantalla completa (.expanded) y Leaflet recalcula el tamaño al terminar.
export function wireMapCard(card, routeMap) {
  const toggle = on => { card.classList.toggle('expanded', on); routeMap?.invalidate(); };
  card.querySelector('[data-map="expand"]')?.addEventListener('click', () => toggle(true));
  card.querySelector('[data-map="close"]')?.addEventListener('click', () => toggle(false));
}

// Crea el mapa con la ruta inicial (sin meteorología) y los aeropuertos. Rechaza si Leaflet no carga: el mapa es
// prescindible y quien llama lo envuelve en safely. El avión y el pronóstico se añaden después con setPlane/setForecast.
export async function createRouteMap(el, { origin, destination, route }) {
  const L = await loadLeaflet();
  el.hidden = false;
  const map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, className: 'tiles-soft', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const lineLayers = [];
  const forecastLayers = [];
  let plane = null;
  const drawRoute = r => {
    lineLayers.splice(0).forEach(l => l.remove());
    for (const l of routeLines(r)) lineLayers.push(L.polyline(l.coords, { color: COLORS[l.level], weight: 5, opacity: 0.9 }).addTo(map));
  };
  drawRoute(route);
  for (const a of [origin, destination]) {
    L.circleMarker([a.lat, a.lon], { radius: 6, color: '#007aff', fillOpacity: 1 })
      .bindTooltip(esc(a.iata), { permanent: true, direction: 'top' }).addTo(map);
  }
  map.fitBounds(L.latLngBounds(route.map(p => [p.lat, p.lon])).pad(0.15));
  return {
    // Colorea la ruta por nivel y añade SIGMET y PIREP; se puede llamar de nuevo y sustituye lo anterior.
    setForecast(view) {
      forecastLayers.splice(0).forEach(l => l.remove());
      if (view.route) drawRoute(view.route);
      for (const s of view.aviation?.sigmets ?? []) {
        forecastLayers.push(L.polygon(s.coords.map(c => [c.lat, c.lon]), { color: '#ff3b30', weight: 1, dashArray: '4 4', fillOpacity: 0.08 }).bindTooltip(esc(s.label)).addTo(map));
      }
      for (const p of view.aviation?.pireps ?? []) {
        forecastLayers.push(L.circleMarker([p.lat, p.lon], { radius: 5, color: '#5856d6', fillOpacity: 0.8 }).bindTooltip(`Informe de piloto: ${esc(p.label)}`).addTo(map));
      }
    },
    // Recibe planeOnMap(): { lat, lon } con posición de menos de 60 s, o null. Con null no hay marcador (ni "última
    // posición", ni hueco, ni interpolación). El radar no da rumbo, así que el icono no se rota.
    setPlane(pos) {
      if (!pos) { plane?.remove(); plane = null; return; }
      if (plane) { plane.setLatLng([pos.lat, pos.lon]); return; }
      plane = L.marker([pos.lat, pos.lon], {
        icon: L.divIcon({ className: 'plane-marker', html: icon('plane', { size: 26 }), iconSize: [26, 26], iconAnchor: [13, 13] }),
        interactive: false, keyboard: false,
      }).addTo(map);
    },
    invalidate() { map.invalidateSize(); },
    destroy() { map.remove(); },
  };
}

// Compatibilidad hasta la Tarea 8 (app.js la llama): mapa de la vista con su pronóstico, sin avión.
export async function renderMap(el, view) {
  const route = view.route;
  const rm = await createRouteMap(el, {
    origin: { iata: view.originIata, lat: route[0].lat, lon: route[0].lon },
    destination: { iata: view.destinationIata, lat: route.at(-1).lat, lon: route.at(-1).lon },
    route,
  });
  rm.setForecast(view);
  return rm;
}
