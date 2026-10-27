// Mapa del vuelo: MapLibre GL JS (copia local en js/vendor/maplibre, sin CDN ni clave) con el estilo claro «positron»
// de OpenFreeMap, aligerado (lightStyle). Solo en el aire o ya aterrizado (js/app.js); se carga después de la ficha y es
// prescindible: si MapLibre, WebGL o la red fallan, la ficha sigue igual (el hueco del mapa no ocupa sitio). Sin
// conexión, con MapLibre en la caché pero sin el estilo, se pinta sobre un fondo liso (FALLBACK_STYLE): ruta, estela y
// avión siguen siendo los mismos datos.

import { esc } from './ui.js';
import { icon } from './icons.js';
import { LIVE_INTERVAL_MS } from './live-tracker.js';

export const MAPLIBRE_VERSION = '6.11.2';
// Relativa a este módulo: MapLibre carga su worker junto a sí mismo (maplibre-gl-worker.mjs).
const MAPLIBRE = './vendor/maplibre/maplibre-gl.mjs';
export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_TIMEOUT_MS = 8000;
const LOAD_MS = 15000;

// ---- Colores del mapa: un solo significado para cada uno ----
// Estela = ALTITUD (la escala de Flightradar24); avión = posición actual, amarillo fijo (el de .plane-marker en el CSS,
// que no cambia con la altitud); ruta prevista = geometría, gris. Las turbulencias y los SIGMET no se pintan en el mapa:
// su rojo se confundiría con el de las altitudes altas (siguen en la tarjeta Turbulencias y en sus avisos de texto).
export const PLANE_COLOR = '#FFD400';
const ROUTE_COLOR = '#8a94a3';
// Sin altitud (punto sin `alt` válido o estela guardada antes de conservarla): gris azulado neutro, nunca un color de la
// escala.
export const NEUTRAL_TRACK = '#7d8fa3';
// Escala OFICIAL de Flightradar24 («Why does the aircraft's trail change colour?», support.fr24.com, artículo
// 3000115027, consultado el 27/10/2026): por debajo de 100 m, blanco; desde cada altitud de la tabla (en metros), su
// color. Entre dos valores de la tabla, Turbi interpola linealmente (FR24 publica los valores, no cómo los une); por
// encima de 13 000 m, el rojo del último.
export const ALTITUDE_STOPS_M = [
  [100, 'rgb(255, 224, 98)'], [200, 'rgb(255, 234, 0)'], [300, 'rgb(240, 255, 0)'], [400, 'rgb(204, 255, 0)'],
  [600, 'rgb(66, 255, 0)'], [800, 'rgb(30, 255, 0)'], [1000, 'rgb(0, 255, 12)'], [1200, 'rgb(0, 255, 54)'],
  [1500, 'rgb(0, 255, 114)'], [2000, 'rgb(0, 255, 156)'], [2500, 'rgb(0, 255, 210)'], [3000, 'rgb(0, 255, 228)'],
  [3500, 'rgb(0, 234, 255)'], [4000, 'rgb(0, 192, 255)'], [4500, 'rgb(0, 168, 255)'], [5000, 'rgb(0, 150, 255)'],
  [5500, 'rgb(0, 120, 255)'], [6000, 'rgb(0, 84, 255)'], [6500, 'rgb(0, 48, 255)'], [7000, 'rgb(0, 30, 255)'],
  [7500, 'rgb(0, 0, 255)'], [8000, 'rgb(18, 0, 255)'], [8500, 'rgb(36, 0, 255)'], [9000, 'rgb(54, 0, 255)'],
  [9500, 'rgb(78, 0, 255)'], [10000, 'rgb(96, 0, 255)'], [10500, 'rgb(120, 0, 255)'], [11000, 'rgb(150, 0, 255)'],
  [11500, 'rgb(174, 0, 255)'], [12000, 'rgb(216, 0, 255)'], [12500, 'rgb(255, 0, 228)'], [13000, 'rgb(255, 0, 0)'],
];
const BELOW_M = 99.9; // hasta aquí, blanco («below 100 m»)
const FT_TO_M = 0.3048;
// La misma escala en JavaScript (para las pruebas y para quien la necesite fuera de MapLibre): altitud en pies → color.
export function altitudeColor(ft) {
  if (typeof ft !== 'number' || !Number.isFinite(ft)) return NEUTRAL_TRACK;
  const m = ft * FT_TO_M;
  const stops = [[BELOW_M, 'rgb(255, 255, 255)'], ...ALTITUDE_STOPS_M];
  if (m <= stops[0][0]) return stops[0][1];
  if (m >= stops.at(-1)[0]) return stops.at(-1)[1];
  const i = stops.findIndex(([at]) => at >= m);
  const [m0, c0] = stops[i - 1], [m1, c1] = stops[i];
  const rgb = c => c.match(/\d+/g).map(Number);
  const f = (m - m0) / (m1 - m0);
  return `rgb(${rgb(c0).map((v, k) => Math.round(v + (rgb(c1)[k] - v) * f)).join(', ')})`;
}
// La misma escala como expresión de MapLibre: cada segmento lleva `alt` (pies) o nada.
const TRACK_COLOR = ['case', ['==', ['typeof', ['get', 'alt']], 'number'],
  ['interpolate', ['linear'], ['*', ['get', 'alt'], FT_TO_M], BELOW_M, 'rgb(255, 255, 255)', ...ALTITUDE_STOPS_M.flat()],
  NEUTRAL_TRACK];

// ---- Estilo base ----
// Positron sin lo que compite con el vuelo: edificios, parques y usos del suelo, caminos y carreteras menores, el borde
// gris de las principales (su relleno blanco apenas se ve), sus nombres y escudos, ferrocarril, muelles, túneles y las etiquetas de pueblos y lugares menores. Agua azul grisácea
// suave y tierra casi blanca. Se quedan fronteras, autopistas tenues, aeropuertos y ciudades, con su nombre en español
// (o el latino): un solo nombre por lugar, sin pedir las tipografías de otros alfabetos.
const DROP = /^(building|park|landuse_|landcover_wood|highway_path|highway_minor|highway_\w*casing|highway-name|highway-shield|road_shield|road_area_pier|road_pier|railway|tunnel_|waterway_line_label|label_village|label_other|aeroway-taxiway)/;
const PAINT = {
  background: { 'background-color': '#f4f5f2' },
  water: { 'fill-color': '#cbd9e4' },
  waterway: { 'line-color': '#cbd9e4' },
};
const NAME = ['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']];
export function lightStyle(style) {
  if (!Array.isArray(style?.layers) || !style.layers.length) return null;
  const layers = style.layers.filter(l => !DROP.test(l.id)).map(l => {
    const out = PAINT[l.id] ? { ...l, paint: { ...l.paint, ...PAINT[l.id] } } : l;
    return out.type === 'symbol' && out.layout?.['text-field'] ? { ...out, layout: { ...out.layout, 'text-field': NAME } } : out;
  });
  return { ...style, layers };
}
// Sin el estilo (sin conexión, OpenFreeMap caído): fondo liso. Nada remoto que esperar.
export const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eef2f6' } }] };

let styleLoading = null;
function loadStyle() {
  styleLoading ??= fetch(STYLE_URL, { signal: AbortSignal.timeout(STYLE_TIMEOUT_MS) })
    .then(r => (r.ok ? r.json() : null)).then(lightStyle).catch(() => null)
    .then(s => { if (!s) styleLoading = null; return s ?? FALLBACK_STYLE; }); // sin estilo, se reintenta en el siguiente mapa
  return styleLoading;
}

let loading = null;
function loadMapLibre() {
  if (globalThis.maplibregl) return Promise.resolve(globalThis.maplibregl);
  loading ??= (async () => {
    if (globalThis.document && !document.querySelector('link[data-maplibre]')) {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL('./vendor/maplibre/maplibre-gl.css', import.meta.url).href });
      css.dataset.maplibre = MAPLIBRE_VERSION;
      document.head.append(css);
    }
    return import(MAPLIBRE);
  })().catch(err => { loading = null; throw err; });
  return loading;
}

// Estela en segmentos: cada uno, de un punto real al siguiente, con la altitud real de su punto final (pies, o null si no
// la tiene: color neutro). Puntos [lat, lon, alt]. Nada se interpola: un segmento sin altitud se queda sin ella.
export function trackSegments(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const alt = pts[i][2];
    out.push({ type: 'Feature', properties: Number.isFinite(alt) ? { alt } : {},
      geometry: { type: 'LineString', coordinates: [[pts[i - 1][1], pts[i - 1][0]], [pts[i][1], pts[i][0]]] } });
  }
  return { type: 'FeatureCollection', features: out };
}

// ---- Bloque del mapa en la ficha ----
// Título según la fase de la ficha (la misma agrupación de card-model.js): en vuelo, el radar; ya aterrizado, la ruta
// realizada. Antes de volar o cancelado no hay mapa (mapPhase, js/card-model.js).
const TITLES = { programado: 'Ruta prevista', cancelado: 'Ruta prevista', 'en-curso': 'Radar', finalizado: 'Ruta realizada' };
export const mapTitle = phase => TITLES[phase] ?? TITLES.programado;

// Créditos del mapa (OpenFreeMap, OpenMapTiles y OpenStreetMap): una línea pequeña y siempre visible en lugar del
// control de MapLibre, que en el móvil ocuparía el pie del mapa.
const ATTRIBUTION = ['<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>',
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>'].join(' ');

// El mapa protagonista: sin tarjeta, a todo el ancho, con el título como etiqueta discreta y el botón de ampliar en su
// esquina. Lo coloca js/app.js en el hueco #map-slot de la ficha y lo conserva entre repintados.
export function mapHeroHtml(phase) {
  return `<section class="map-hero" id="map-card" aria-label="Mapa del vuelo">
  <div id="map" class="map"></div>
  <span class="map-label card-title">${esc(mapTitle(phase))}</span>
  <p class="map-attrib">${ATTRIBUTION}</p>
  <button type="button" class="map-btn" data-map="expand" aria-label="Ampliar el mapa">${icon('expand')}</button>
  <button type="button" class="map-btn map-close" data-map="close" aria-label="Cerrar el mapa ampliado">${icon('close')}</button>
</section>`;
}

// Ampliar / cerrar: el mapa pasa a pantalla completa (.expanded); routeMap.expanded encuadra la ruta entera al ampliar y
// vuelve a la vista de antes al cerrar. onExpand: al ampliar (p. ej. pedir la ruta realizada de un vuelo histórico).
export function wireMapCard(card, routeMap, onExpand = null) {
  const toggle = on => { card.classList.toggle('expanded', on); routeMap?.expanded?.(on); };
  card.querySelector('[data-map="expand"]')?.addEventListener('click', () => { toggle(true); onExpand?.(); });
  card.querySelector('[data-map="close"]')?.addEventListener('click', () => toggle(false));
}

// ---- Movimiento del avión ENTRE POSICIONES REALES (solo presentación) ----
// Continuo y nunca por delante de lo medido: con A en pantalla y B recibida, el avión recorre A → B durante el intervalo
// del seguimiento en vivo (PLANE_GLIDE_MS = LIVE_INTERVAL_MS), justo hasta cuando debería llegar C; con C, sigue B → C.
// Va una lectura por detrás de la posición real y nunca pasa de la última recibida: si C tarda, se queda en B. Si C
// llega antes de acabar A → B, el recorrido sigue por B (nunca recorta hacia C). Suavizado ligero (glide: velocidad
// casi constante, un 15 % más suave en los extremos), sin acelerar y frenar en cada tramo.
// Orientación: el icono (SVG) apunta al ESTE, así que la rotación es rumbo − 90. Rumbo = el `track` medido de la lectura
// (Flightradar24, 0 = norte); sin él, con dos posiciones reales, el rumbo entre ellas; con una sola y sin track, el
// icono no se gira. Cada giro va por el camino corto (transición CSS): nunca una vuelta de 360°.
export const PLANE_GLIDE_MS = LIVE_INTERVAL_MS;
const glide = k => 0.85 * k + 0.15 * k * k * (3 - 2 * k);
const RAD = Math.PI / 180;
function bearing(a, b) {
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return Math.atan2(y, x) / RAD; // 0 = norte, 90 = este
}
// Distancia plana aproximada (solo para repartir el tiempo entre tramos de pocos km).
const flatKm = (a, b) => Math.hypot((b.lat - a.lat) * 111, (b.lon - a.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * RAD));
// Ángulo equivalente a deg en [-180, 180).
const wrap = deg => ((((deg + 180) % 360) + 360) % 360) - 180;
const FRAME_MS = 50; // ~20 fotogramas por segundo bastan para un avión que se mueve unos píxeles por segundo
const defaultClock = {
  raf: cb => globalThis.requestAnimationFrame?.(cb) ?? setTimeout(() => cb(Date.now()), 16),
  caf: id => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id)),
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  reducedMotion: () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
};

// ---- Cámara ----
// En vuelo, al recibir la primera posición: el avión, lo que le queda (hasta el destino) y un poco de lo ya volado
// (BEHIND_KM hacia el origen, o el origen si está más cerca), sin acercarse más que LIVE_MAX_ZOOM. Aterrizado: la ruta realizada entera al llegar la estela. Antes de eso, la ruta prevista entera. Nunca
// se sigue al avión ni se recentra con cada lectura, y nada de eso si el usuario ya ha movido el mapa. Ampliado: la
// ruta entera (prevista, realizada y avión); al cerrar, la vista de antes.
const LIVE_MAX_ZOOM = 7;
const BEHIND_KM = 400;
// Arriba, la etiqueta y el botón de ampliar; abajo, el código del aeropuerto y los créditos.
const PAD = { top: 64, bottom: 56, left: 36, right: 36 };
const lngLat = ([lat, lon]) => [lon, lat];
function boundsOf(points) {
  const ok = points.filter(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
  if (!ok.length) return null;
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const [lat, lon] of ok) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
  return [[w, s], [e, n]];
}

const lineFeature = coords => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords.map(lngLat) } });
const EMPTY = { type: 'FeatureCollection', features: [] };

// Crea el mapa con la ruta prevista (sin meteorología) y los aeropuertos. Rechaza si MapLibre no carga o no hay WebGL:
// quien llama lo envuelve (el mapa es prescindible). El avión y la estela se añaden después con setPlane/setTrack.
// clock: requestAnimationFrame, reloj y prefers-reduced-motion (inyectables en los tests).
export async function createRouteMap(el, { origin, destination, route }, clock = defaultClock) {
  const [ml, style] = await Promise.all([loadMapLibre(), loadStyle()]);
  el.hidden = false;
  const routeBounds = boundsOf(route.map(p => [p.lat, p.lon]));
  const map = new ml.Map({
    container: el, style, bounds: routeBounds, fitBoundsOptions: { padding: PAD }, attributionControl: false,
    dragRotate: false, pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, cooperativeGestures: true,
    locale: {
      'CooperativeGesturesHandler.WindowsHelpText': 'Usa Ctrl + rueda para acercar o alejar el mapa',
      'CooperativeGesturesHandler.MacHelpText': 'Usa ⌘ + rueda para acercar o alejar el mapa',
      'CooperativeGesturesHandler.MobileHelpText': 'Usa dos dedos para mover el mapa',
    },
  });
  map.touchZoomRotate?.disableRotation?.();
  // Una tesela que falla no impide el mapa (se ve sin ella); solo un mapa que no llega a cargarse en LOAD_MS.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Mapa no disponible')), LOAD_MS);
    map.once('load', () => { clearTimeout(timer); resolve(); });
  }).catch(err => { map.remove(); throw err; });

  // Fuentes y capas (de abajo arriba): ruta prevista (gris, fina, tenue y discontinua) y la estela real: un contorno
  // oscuro, fino y neutro (separa del mapa claro los tramos blancos y amarillos sin teñirlos) y encima la línea con el
  // color de la altitud de cada segmento (una sola capa, color por segmento con TRACK_COLOR).
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round' },
    paint: { 'line-color': ROUTE_COLOR, 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } });
  map.addSource('track', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'track-halo', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': 'rgba(20, 30, 45, 0.45)', 'line-width': 5.5 } });
  map.addLayer({ id: 'track', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': TRACK_COLOR, 'line-width': 3.5 } });

  // Aeropuertos: marcadores HTML (no dependen de las fuentes tipográficas del estilo).
  for (const a of [origin, destination]) {
    const node = document.createElement('div');
    node.className = 'map-airport';
    node.innerHTML = `<span class="map-airport-dot"></span><span class="map-airport-code">${esc(a.iata)}</span>`;
    new ml.Marker({ element: node, anchor: 'center' }).setLngLat([a.lon, a.lat]).addTo(map);
  }

  let userMoved = false;
  const moved = e => { if (e?.originalEvent) userMoved = true; };
  map.on('dragstart', moved);
  map.on('zoomstart', moved);
  let framedPlane = false, framedTrack = false, savedView = null, isExpanded = false;
  // maxZoom solo si lo hay: MapLibre toma un `maxZoom: undefined` explícito como valor y el encuadre da NaN (y falla).
  const fit = (points, maxZoom) => {
    const b = boundsOf(points);
    if (b) map.fitBounds(b, { padding: PAD, animate: false, ...(Number.isFinite(maxZoom) ? { maxZoom } : {}) });
  };

  map.getSource('route')?.setData(lineFeature(route.map(p => [p.lat, p.lon])));

  let plane = null, rotEl = null;
  let shown = null; // posición que se está pintando ahora mismo ({ lat, lon })
  let target = null; // última posición real recibida
  let identity = null; // avión y vuelo físico de esa posición
  let anim = null; // { pts: [desde, …objetivos], cum: [km acumulados], total, t0, dur }
  let pending = []; // posiciones reales recibidas a las que el avión aún no ha llegado
  let frame = null, lastFrame = -Infinity, lastTrackDraw = -Infinity;
  let angle = null; // rotación aplicada al icono (grados CSS), null si aún no se ha orientado
  // Estela real: puntos reales recibidos (setTrack + extendTrack), [lat, lon, alt (pies) | null], de UNA identidad
  // (trackId, la misma que el avión).
  let trackPts = [], trackId = null, trackOn = false;
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  const isPending = p => pending.some(q => q.lat === p[0] && q.lon === p[1]);
  // Lo que se dibuja: los puntos reales y, si el avión de la misma identidad está en el mapa, su posición mostrada como
  // último vértice. Los puntos ya recibidos a los que el avión aún no ha llegado no se dibujan: la estela acaba en él, y
  // ese último segmento (hasta el avión) lleva la altitud real del punto al que se dirige (el más cercano de los
  // quitados), no una intermedia inventada.
  const drawTrack = () => {
    if (!trackOn) { map.getSource('track')?.setData(EMPTY); return; }
    const pts = trackPts.slice();
    if (plane && shown && identity === trackId) {
      let ahead = null;
      while (pts.length && isPending(pts.at(-1))) ahead = pts.pop();
      if (!same(pts.at(-1), [shown.lat, shown.lon])) pts.push([shown.lat, shown.lon, ahead ? ahead[2] : null]);
    }
    map.getSource('track')?.setData(pts.length >= 2 ? trackSegments(pts) : EMPTY);
  };
  const stop = () => { if (frame !== null) clock.caf(frame); frame = null; anim = null; pending = []; };
  const put = (p, { track = true } = {}) => { shown = p; plane.setLngLat([p.lon, p.lat]); if (track) drawTrack(); };
  // Gira el icono a `heading` (rumbo, 0 = norte) por el camino corto; la primera vez, en [-180, 180).
  const turn = heading => {
    if (!Number.isFinite(heading)) return;
    const goal = heading - 90;
    angle = angle === null ? wrap(goal) : angle + wrap(goal - angle);
    if (rotEl) rotEl.style.transform = `rotate(${angle}deg)`;
  };
  // Atenuado (.plane-old): falta la lectura esperada y lo que se ve es solo la última posición conocida.
  const age = dimmed => rotEl?.classList.toggle('plane-old', dimmed === true);

  // Un fotograma del recorrido: dónde está el avión a esta hora, sin pasar nunca del último punto real.
  const step = () => {
    frame = null;
    if (!anim) return;
    const t = clock.now();
    const k = Math.min(1, Math.max(0, (t - anim.t0) / anim.dur));
    if (k < 1 && t - lastFrame < FRAME_MS) { frame = clock.raf(step); return; }
    lastFrame = t;
    const d = glide(k) * anim.total;
    let i = 1;
    while (i < anim.pts.length - 1 && anim.cum[i] < d) i++;
    const a = anim.pts[i - 1], b = anim.pts[i];
    const seg = anim.cum[i] - anim.cum[i - 1];
    const f = k >= 1 ? 1 : seg > 0 ? Math.min(1, (d - anim.cum[i - 1]) / seg) : 1;
    pending = k >= 1 ? [] : anim.pts.slice(f >= 1 ? i + 1 : i);
    const pos = k >= 1 ? anim.pts.at(-1) : { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    // La estela, como mucho ~5 veces por segundo (y siempre al terminar): crece detrás del avión.
    const track = k >= 1 || t - lastTrackDraw >= 200;
    if (track) lastTrackDraw = t;
    put(pos, { track });
    if (k >= 1) anim = null;
    else frame = clock.raf(step);
  };
  // De lo que se ve hasta `next` pasando por lo que aún queda por recorrer (sin recortar), en PLANE_GLIDE_MS.
  const glideTo = next => {
    const pts = [shown, ...pending, next];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + flatKm(pts[i - 1], pts[i]));
    if (frame !== null) clock.caf(frame);
    frame = null;
    const total = cum.at(-1);
    if (!(total > 0)) { anim = null; pending = []; put(next); return; }
    anim = { pts, cum, total, t0: clock.now(), dur: PLANE_GLIDE_MS };
    pending = pts.slice(1);
    lastFrame = -Infinity;
    frame = clock.raf(step);
    drawTrack();
  };

  const self = {
    // Recibe planeOnMap(): { lat, lon, heading, fresh, dim? } (posición real de 180 s o menos) o null; identity: avión y
    // vuelo físico de esa lectura. Con null no hay marcador. La primera posición, la que llega tras perderla y la de otro
    // avión o vuelo se colocan directamente; una lectura FRESCA nueva del mismo avión se recorre desde lo que se ve
    // (glideTo), o directa con prefers-reduced-motion. Una lectura vieja (fresh: false) nunca anima y, salvo dim: false,
    // se atenúa (.plane-old). El rumbo real se aplica en cada lectura. Solo la primera posición encuadra la vista.
    setPlane(pos, { identity: id = null } = {}) {
      if (!pos) {
        stop(); plane?.remove(); plane = rotEl = null; shown = target = identity = null; angle = null; drawTrack(); return;
      }
      const next = { lat: pos.lat, lon: pos.lon };
      const fresh = pos.fresh !== false;
      const dim = typeof pos.dim === 'boolean' ? pos.dim : !fresh;
      const heading = Number.isFinite(pos.heading) ? pos.heading : null;
      if (plane && id === identity && target && next.lat === target.lat && next.lon === target.lon) { // misma lectura
        turn(heading);
        age(dim);
        return;
      }
      if (!plane) {
        const node = document.createElement('div');
        node.className = 'plane-marker';
        node.style.setProperty('--plane', PLANE_COLOR); // amarillo fijo: igual a cualquier altitud
        node.innerHTML = `<span class="plane-rot">${icon('plane', { size: 28 })}</span>`;
        rotEl = node.querySelector('.plane-rot');
        plane = new ml.Marker({ element: node, anchor: 'center' }).setLngLat([next.lon, next.lat]).addTo(map);
        shown = target = next;
        identity = id;
        angle = null;
        turn(heading);
        age(dim);
        drawTrack();
        if (!framedPlane && !userMoved && !isExpanded) {
          framedPlane = true;
          const d = flatKm(origin, next), f = d > BEHIND_KM ? 1 - BEHIND_KM / d : 0;
          const behind = [origin.lat + (next.lat - origin.lat) * f, origin.lon + (next.lon - origin.lon) * f];
          fit([[next.lat, next.lon], [destination.lat, destination.lon], behind], LIVE_MAX_ZOOM);
        }
        return;
      }
      const sameAircraft = id === identity;
      identity = id;
      target = next;
      // Otro avión u otro vuelo físico: su orientación empieza de cero (sin track, sin rotar; nunca la del anterior).
      if (!sameAircraft) { angle = null; if (rotEl) rotEl.style.transform = ''; }
      age(dim);
      if (!sameAircraft || !fresh || clock.reducedMotion()) { stop(); turn(heading); put(next); return; }
      turn(heading ?? bearing(pending.at(-1) ?? shown, next));
      glideTo(next);
    },
    // Estela real del vuelo (Flight Tracks de FR24, solo posiciones medidas): sustituye la anterior. Puntos [lat, lon] o
    // [lat, lon, altitud en pies]; sin altitud válida, null (color neutro). identity: la del avión (vuelo físico + fr24Id);
    // extendTrack solo acepta puntos de esa misma identidad. Sin avión en el mapa (aterrizado), la primera estela
    // encuadra la ruta realizada entera.
    setTrack(points, { identity: id = null } = {}) {
      trackPts = (points ?? []).filter(p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1])).map(p => [p[0], p[1], Number.isFinite(p[2]) ? p[2] : null]);
      trackId = id;
      trackOn = true;
      drawTrack();
      if (!plane && !framedTrack && !userMoved && !isExpanded && trackPts.length >= 2) {
        framedTrack = true;
        fit([...trackPts, [origin.lat, origin.lon], [destination.lat, destination.lon]]);
      }
    },
    // Una posición real FRESCA nueva del mismo avión (planeOnMap): la estela se prolonga hasta ella (sin duplicar el
    // último), con SU altitud ([lat, lon, pies]; sin ella, null: segmento neutro, nunca la de la lectura anterior). Una
    // posición vieja (fresh: false) nunca la prolonga.
    extendTrack(point, { identity: id = null, fresh = true } = {}) {
      if (!trackOn || id !== trackId || fresh === false || !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) return;
      if (!same(trackPts.at(-1), point)) trackPts.push([point[0], point[1], Number.isFinite(point[2]) ? point[2] : null]);
      drawTrack();
    },
    clearTrack() { trackOn = false; trackPts = []; trackId = null; drawTrack(); },
    // El avión en pantalla: si está, si se está desplazando hacia la última lectura y de qué identidad es.
    planeState: () => ({ shown: Boolean(plane), moving: anim !== null, identity }),
    trackIdentity: () => (trackOn ? trackId : null),
    // Ampliado: la ruta entera (prevista, realizada y avión) y gestos normales; al cerrar, la vista y los gestos de antes.
    expanded(on) {
      map.resize();
      if (on === isExpanded) return;
      isExpanded = on;
      if (on) {
        savedView = { center: map.getCenter(), zoom: map.getZoom() };
        map.cooperativeGestures?.disable?.();
        fit([...route.map(p => [p.lat, p.lon]), ...trackPts, ...(shown ? [[shown.lat, shown.lon]] : [])]);
      } else {
        map.cooperativeGestures?.enable?.();
        if (savedView) map.jumpTo(savedView);
        savedView = null;
      }
    },
    invalidate() { map.resize(); },
    destroy() { stop(); map.remove(); },
  };
  return self;
}
