// Mapa sencillo con Leaflet + OpenStreetMap. Se carga después del resultado y es prescindible:
// si falla, la app sigue igual (la timeline es la visualización principal).

import { esc } from './ui.js';
import { icon } from './icons.js';
import { flightPhase } from './card-model.js';
import { MATCH } from './ui-advanced.js';

const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const SRI = {
  js: 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==',
  css: 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==',
};
const COLORS = ['#8e8e93', '#e6b800', '#ff9f0a', '#ff3b30'];
// Ruta prevista (círculo máximo o coloreada por turbulencias): siempre tenue y discontinua, para que la estela real
// (trayectoria medida por Flightradar24, color de acento) se lea encima como lo que de verdad ha hecho el avión.
const ROUTE_STYLE = { weight: 4, opacity: 0.5, dashArray: '6 8' };
const TRACK_STYLE = { color: '#1A6FE0', weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false };

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

// Tarjeta del mapa, independiente del pronóstico. #map-facts nace vacío (lo rellena repintado de la ficha con
// mapFactsHtml); el botón de cerrar solo se ve ampliada (CSS) y ocupa el sitio del de ampliar.
export const mapTitle = phase => TITLES[phase] ?? TITLES.programado;

// Identificación debajo del mapa (§5.8): «Directa» si el radar lo encontró por su indicativo; por ruta o por
// transpondedor, el mismo texto que en Detalles avanzados. Otro valor (o ninguno): sin fila.
const IDENTIFICATION = { ...MATCH, indicativo: 'Directa' };

// Datos bajo el mapa (§5.8), solo en el aire con el radar «volando»: Indicativo (radar.callsign), Avión (modelo) e
// Identificación. Cada dato solo si existe; en cualquier otro caso, vacío (#map-facts se oculta con :empty).
export function mapFactsHtml(card) {
  const r = card?.radar;
  if (!card || r?.state !== 'volando' || flightPhase(card) !== 'en-curso') return '';
  const facts = [
    r.callsign && ['Indicativo', r.callsign],
    card.aircraft && ['Avión', card.aircraft],
    IDENTIFICATION[r.match] && ['Identificación', IDENTIFICATION[r.match]],
  ].filter(Boolean);
  return facts.map(([k, v]) => `<div class="kv"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('');
}

export function mapCardHtml(phase) {
  const title = mapTitle(phase);
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

// Movimiento del avión ENTRE POSICIONES REALES (solo presentación): de la posición que se ve a la nueva lectura en
// PLANE_GLIDE_MS, con suavizado; nunca más allá de la última posición recibida ni hacia donde «irá».
// Orientación: el icono (SVG) apunta al ESTE, así que la rotación es rumbo − 90. Rumbo = el `track` medido de la lectura
// (Flightradar24, 0 = norte); sin él, con A y B reales, el rumbo aproximado A → B; con una sola posición y sin track, el
// icono no se gira (no se inventa una orientación). Cada giro va por el camino corto desde el anterior (la rotación tiene
// transición CSS): nunca una vuelta de 360° ni de 180° por un salto de −180 a 180.
export const PLANE_GLIDE_MS = 2500;
const ease = x => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
const RAD = Math.PI / 180;
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.atan2(y, x) / RAD; // 0 = norte, 90 = este
}
// Ángulo equivalente a deg en [-180, 180).
const wrap = deg => ((((deg + 180) % 360) + 360) % 360) - 180;
const defaultClock = {
  raf: cb => globalThis.requestAnimationFrame?.(cb) ?? setTimeout(() => cb(Date.now()), 16),
  caf: id => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id)),
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  reducedMotion: () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
};

// Crea el mapa con la ruta inicial (sin meteorología) y los aeropuertos. Rechaza si Leaflet no carga: el mapa es
// prescindible y quien llama lo envuelve en safely. El avión y el pronóstico se añaden después con setPlane/setForecast.
// clock: requestAnimationFrame, reloj y prefers-reduced-motion (inyectables en los tests).
export async function createRouteMap(el, { origin, destination, route }, clock = defaultClock) {
  const L = await loadLeaflet();
  el.hidden = false;
  const map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 12, className: 'tiles-soft', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const lineLayers = [];
  const forecastLayers = [];
  let plane = null;
  let shown = null; // posición que se está pintando ahora mismo ({ lat, lon })
  let target = null; // última posición real recibida
  let identity = null; // avión y vuelo físico de esa posición
  let frame = null;
  let angle = null; // rotación aplicada al icono (grados CSS), null si aún no se ha orientado
  // Estela real: puntos reales recibidos (setTrack + extendTrack) de UNA identidad (trackId, la misma que el avión).
  let trackLine = null, trackPts = [], trackId = null;
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  // Lo que se dibuja: los puntos reales y, si el avión de la misma identidad está en el mapa, su posición mostrada como
  // último vértice. Mientras se anima hacia B (ya recibido como punto), B aún no se dibuja: la estela acaba en el avión.
  const drawTrack = () => {
    if (!trackLine) return;
    const pts = trackPts.slice();
    if (plane && shown && identity === trackId) {
      if (frame !== null && target && same(pts.at(-1), [target.lat, target.lon])) pts.pop();
      if (!same(pts.at(-1), [shown.lat, shown.lon])) pts.push([shown.lat, shown.lon]);
    }
    trackLine.setLatLngs?.(pts);
  };
  const stop = () => { if (frame !== null) clock.caf(frame); frame = null; };
  const put = p => { shown = p; plane.setLatLng([p.lat, p.lon]); drawTrack(); };
  const rotEl = () => plane?.getElement?.()?.querySelector?.('.plane-rot');
  // Gira el icono a `heading` (rumbo, 0 = norte) por el camino corto; la primera vez, en [-180, 180).
  const turn = heading => {
    if (!Number.isFinite(heading)) return;
    const target = heading - 90;
    angle = angle === null ? wrap(target) : angle + wrap(target - angle);
    const r = rotEl();
    if (r) r.style.transform = `rotate(${angle}deg)`;
  };
  // Atenuado (.plane-old): falta la lectura esperada y lo que se ve es solo la última posición conocida.
  const age = dimmed => rotEl()?.classList?.toggle?.('plane-old', dimmed === true);
  const drawRoute = r => {
    lineLayers.splice(0).forEach(l => l.remove());
    for (const l of routeLines(r)) lineLayers.push(L.polyline(l.coords, { color: COLORS[l.level], ...ROUTE_STYLE }).addTo(map));
    trackLine?.bringToFront?.(); // la estela, siempre encima de la ruta prevista
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
    // Recibe planeOnMap(): { lat, lon, heading, fresh } (posición real de 180 s o menos) o null; identity: avión y vuelo
    // físico de esa lectura. Con null no hay marcador: se cancela cualquier movimiento. La primera posición, la que llega
    // tras perderla y la de otro avión o vuelo se colocan directamente; una lectura FRESCA nueva del mismo avión se
    // desplaza desde lo que se ve hasta ella (sin pasarse ni seguir después), o directa con prefers-reduced-motion. Una
    // lectura vieja (fresh: false, la última posición conocida) nunca anima: se coloca o se queda quieta y, salvo
    // dim: false (el seguimiento en vivo va al día y la lectura siguiente está al llegar), atenuada (.plane-old). El rumbo real (heading) se aplica en cada lectura, también si la posición no cambia. Nunca recentra
    // ni cambia el zoom.
    setPlane(pos, { identity: id = null } = {}) {
      if (!pos) { stop(); plane?.remove(); plane = null; shown = target = identity = null; angle = null; drawTrack(); return; }
      const next = { lat: pos.lat, lon: pos.lon };
      const fresh = pos.fresh !== false;
      // dim (lo decide quien llama): con fresh: false, si se atenúa; por defecto, siempre que no sea fresca.
      const dim = typeof pos.dim === 'boolean' ? pos.dim : !fresh;
      const heading = Number.isFinite(pos.heading) ? pos.heading : null;
      if (plane && id === identity && target && next.lat === target.lat && next.lon === target.lon) { // misma lectura
        turn(heading);
        age(dim);
        return;
      }
      if (!plane) {
        plane = L.marker([next.lat, next.lon], {
          icon: L.divIcon({ className: 'plane-marker', html: `<span class="plane-rot">${icon('plane', { size: 26 })}</span>`,
            iconSize: [26, 26], iconAnchor: [13, 13] }),
          interactive: false, keyboard: false,
        }).addTo(map);
        shown = target = next;
        identity = id;
        angle = null;
        turn(heading);
        age(dim);
        drawTrack();
        return;
      }
      stop();
      const sameAircraft = id === identity;
      identity = id;
      target = next;
      // Otro avión u otro vuelo físico: su orientación empieza de cero (sin track, sin rotar; nunca la del anterior).
      if (!sameAircraft) { angle = null; const r = rotEl(); if (r) r.style.transform = ''; }
      age(dim);
      if (!sameAircraft || !fresh || clock.reducedMotion()) { turn(heading); put(next); return; }
      const from = shown;
      turn(heading ?? bearing(from, next));
      const t0 = clock.now();
      // Siempre el reloj de clock.now (no la marca de requestAnimationFrame): un solo reloj para t0 y cada fotograma.
      const step = () => {
        const k = Math.min(1, Math.max(0, (clock.now() - t0) / PLANE_GLIDE_MS));
        const e = ease(k);
        put(k >= 1 ? next : { lat: from.lat + (next.lat - from.lat) * e, lon: from.lon + (next.lon - from.lon) * e });
        frame = k >= 1 ? null : clock.raf(step);
      };
      frame = clock.raf(step);
      drawTrack();
    },
    // Estela real del vuelo (Flight Tracks de FR24, solo posiciones medidas): sustituye la anterior. identity: la del
    // avión (vuelo físico + fr24Id); extendTrack solo acepta puntos de esa misma identidad. Nunca recentra ni cambia el zoom.
    setTrack(points, { identity: id = null } = {}) {
      trackLine?.remove();
      trackPts = (points ?? []).filter(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])).map(p => [p[0], p[1]]);
      trackId = id;
      trackLine = L.polyline(trackPts, TRACK_STYLE).addTo(map);
      trackLine.bringToFront?.();
      drawTrack();
    },
    // Una posición real FRESCA nueva del mismo avión (planeOnMap): la estela se prolonga hasta ella (sin duplicar el
    // último). Una posición vieja (fresh: false) nunca la prolonga.
    extendTrack(point, { identity: id = null, fresh = true } = {}) {
      if (!trackLine || id !== trackId || fresh === false || !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) return;
      if (!same(trackPts.at(-1), point)) trackPts.push([point[0], point[1]]);
      drawTrack();
    },
    clearTrack() { trackLine?.remove(); trackLine = null; trackPts = []; trackId = null; },
    // El avión en pantalla: si está, si se está desplazando hacia la última lectura y de qué identidad es.
    planeState: () => ({ shown: Boolean(plane), moving: frame !== null, identity }),
    trackIdentity: () => (trackLine ? trackId : null),
    // Quita lo que puso setForecast: la ruta inicial sin colorear (círculo máximo), sin SIGMET ni PIREP, como recién
    // creado. No toca la vista (ni centro ni zoom) ni el avión.
    clearForecast() {
      forecastLayers.splice(0).forEach(l => l.remove());
      drawRoute(route);
    },
    invalidate() { map.invalidateSize(); },
    destroy() { stop(); map.remove(); },
  };
}
