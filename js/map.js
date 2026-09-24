// Mapa sencillo con Leaflet + OpenStreetMap. Se carga después del resultado y es prescindible:
// si falla, la app sigue igual (la timeline es la visualización principal).

import { esc } from './ui.js';

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

export async function renderMap(el, view) {
  const L = await loadLeaflet();
  el.hidden = false;
  const map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  for (const l of routeLines(view.route)) L.polyline(l.coords, { color: COLORS[l.level], weight: 5, opacity: 0.9 }).addTo(map);
  const ends = [view.route[0], view.route.at(-1)];
  ends.forEach((p, i) => L.circleMarker([p.lat, p.lon], { radius: 6, color: '#007aff', fillOpacity: 1 })
    .bindTooltip(esc(i ? view.destinationIata : view.originIata), { permanent: true, direction: 'top' }).addTo(map));
  for (const s of view.aviation?.sigmets ?? []) {
    L.polygon(s.coords.map(c => [c.lat, c.lon]), { color: '#ff3b30', weight: 1, dashArray: '4 4', fillOpacity: 0.08 }).bindTooltip(esc(s.label)).addTo(map);
  }
  for (const p of view.aviation?.pireps ?? []) {
    L.circleMarker([p.lat, p.lon], { radius: 5, color: '#5856d6', fillOpacity: 0.8 }).bindTooltip(`Informe de piloto: ${esc(p.label)}`).addTo(map);
  }
  map.fitBounds(L.latLngBounds(view.route.map(p => [p.lat, p.lon])).pad(0.15));
  return map;
}
