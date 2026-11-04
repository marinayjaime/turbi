// Modo 3D del mapa del vuelo (opcional; js/map.js lo importa SOLO al pulsar «3D»). Una capa WebGL propia dentro de
// MapLibre (sin otra librería): el avión con volumen (js/aircraft3d.js) en su posición y altitud, la estela real a su
// altura (cinta con el color de la altitud de FR24 y una cortina tenue hasta el suelo) y una cámara que gira alrededor
// del avión. Todo sale de lo que el mapa 2D ya tiene: ninguna consulta de seguimiento nueva.
//
// Fidelidad:
// - Posición y altitud: las reales recibidas; entre dos lecturas, el mismo recorrido del 2D (js/map.js, una lectura por
//   detrás y nunca más allá de la última), con la altitud interpolada entre las dos. Sin datos nuevos, quieto; pasados
//   180 s, fuera (como en 2D).
// - Altitud: la barométrica estándar (1013,25 hPa) que dan FR24 (`alt`) y adsb.lol (`alt_baro`), en pies. El mapa no
//   tiene relieve: el avión se sitúa sobre un suelo plano a nivel del mar a esa altitud (diferencia típica con la real:
//   cientos de metros, invisible a esta escala; en tierra queda a 0).
// - Orientación: la dirección de desplazamiento (`track`, o el rumbo entre dos posiciones reales). Alas y morro, siempre
//   nivelados: no se recibe la actitud y no se inventa.
// - Encima del mapa no hay texto: el modelo y la operadora están en la ficha (y aquí, solo para lectores de pantalla).
//
// Un solo bucle por fotograma (loop): primero la posición del avión (advance, de js/map.js), luego su giro y por último la
// cámara. Avión y cámara se calculan juntos y la cámara solo se recoloca sola cuando nadie toca el mapa.
import { altitudeColor, PLACE_NAME } from './map.js';
import { loadCatalogIndex, loadModel, loadLivery, resolveAircraft, buildAircraftGeometry, paintLivery, TEXTURE_SIZE,
  NEUTRAL_PAINT, GENERIC_PAINT, GENERIC_SPEC } from './aircraft3d.js';

const FT_TO_M = 0.3048;
const PLANE_PX = 70; // largo aproximado del avión en pantalla (px CSS) cuando hay que ampliarlo
const RIBBON_PX = 2.2; // media anchura de la cinta de la estela (px CSS en el centro de la vista)
// Suavizado de la dirección (solo presentación; la medida no cambia): el avión gira en ~1 s y la cámara, algo más despacio.
const PLANE_TURN_TAU_MS = 900, CAMERA_TURN_TAU_MS = 1800;
// Transiciones de la cámara (ms): cambio de perspectiva, volver a seguir, botones y entrada en 3D.
const VIEW_MS = 900, RESUME_MS = 1000, BUTTON_MS = 260, ENTER_MS = 1200;
// 90°: la cámara a la altura del avión (vista lateral de verdad). MapLibre 6 admite hasta 180°, pero por encima de 90°
// se mira el avión desde abajo con el suelo cortado por arriba: no aporta y no se ofrece.
const MAX_PITCH = 90;
const TILT_STEP = 10;
export const VIEWS = {
  behind: { label: 'Detrás', offset: 0, pitch: 78 },
  side: { label: 'Lado', offset: 90, pitch: 90 },
  diagonal: { label: 'Diagonal', offset: 40, pitch: 66 },
  top: { label: 'Arriba', offset: 0, pitch: 0 },
};
const HAZE_CSS = '#e3edf6', HAZE_RGB = [0xe3 / 255, 0xed / 255, 0xf6 / 255];
// Cielo del modo 3D: degradado hasta una neblina clara, con el suelo lejano fundido en ella (sin una línea blanca dura).
const SKY = { 'sky-color': '#9fc6ea', 'horizon-color': HAZE_CSS, 'fog-color': HAZE_CSS, 'sky-horizon-blend': 0.75,
  'horizon-fog-blend': 0.9, 'fog-ground-blend': 0.55, 'atmosphere-blend': 0 };
// La niebla de MapLibre no tiñe un suelo plano: sin más, el terreno acaba en una línea dura contra el cielo. La capa pinta una
// banda de neblina del color del horizonte, encima del suelo y debajo del avión: esta fracción del alto de la vista.
const HAZE_BAND = 0.2;
// Tierra y agua del 3D: más contraste que el 2D para leer la costa desde la altitud de crucero, sin ser un mapa oscuro.
const GROUND_COLOR = '#ebeadf', WATER_COLOR = '#b3cde0';
const EARTH_M = 40075016.686;
const RAD = Math.PI / 180;
// Encuadre de cada vista: el avión completo ocupa como mucho esta fracción del hueco libre (dejando ver el terreno).
const FILL = 0.68;
// La cortina de la estela llega a su opacidad a esta fracción de la distancia cámara-avión, detrás de él. Lo que tiñe la pantalla
// es la parte que pasa junto a la cámara (a cientos de metros): medido en altitud, desaparecería entera.
const CURTAIN_FADE_CAMERA = 0.3;

// ---- Matrices 4×4 (columnas, como WebGL) ----
const mat = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mult(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const translate = (x, y, z) => { const m = mat(); m[12] = x; m[13] = y; m[14] = z; return m; };
const scale = (x, y, z) => { const m = mat(); m[0] = x; m[5] = y; m[10] = z; return m; };
const rotZ = a => { const m = mat(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
const wrap = d => ((((d + 180) % 360) + 360) % 360) - 180;
// Pasos puros de la cámara (exportados para las pruebas).
export function smoothAngle(cur, target, dtMs, tauMs) {
  const d = wrap(target - cur);
  if (Math.abs(d) < 0.02) return target;
  return cur + d * (1 - Math.exp(-dtMs / tauMs));
}
const smootherstep = k => k * k * k * (k * (k * 6 - 15) + 10);
// Un punto de la transición de la cámara, de `from` a `to`: la inclinación y el zoom en línea recta; el rumbo, por el
// camino corto (nunca una vuelta de 360°).
export function blendCamera(from, to, k) {
  const e = smootherstep(k), mix = (a, b) => a + (b - a) * e;
  const out = {
    center: [mix(from.center[0], to.center[0]), mix(from.center[1], to.center[1])], elevation: mix(from.elevation, to.elevation),
    zoom: mix(from.zoom, to.zoom), pitch: mix(from.pitch, to.pitch), bearing: from.bearing + wrap(to.bearing - from.bearing) * e,
  };
  if (from.padding && to.padding) out.padding = { top: mix(from.padding.top, to.padding.top), bottom: mix(from.padding.bottom, to.padding.bottom), left: 0, right: 0 };
  return out;
}

// ---- Contexto geográfico del 3D ----
// La cámara está a unos 100 m del avión y el suelo a unos 11 km: desde el suelo, todo lo que MapLibre mide en píxeles del
// plano del avión se ve ~100 veces más pequeño. Por eso el 3D no usa las líneas y etiquetas del estilo 2D, sino estas:
// - Líneas: el ancho que se quiere ver en el suelo (px), compensado con esa escala. Sale del zoom con una función exponencial
//   (crece ×2 por nivel desde zc, donde la cámara está tan lejos del centro como el suelo), sin recalcular nada por fotograma.
// - Etiquetas: MapLibre las dibuja a la mitad de su tamaño a esta distancia (su factor de perspectiva tiende a 0,5), de ahí
//   el doble de tamaño de cerca. El filtro con ['zoom'] mira el nivel de la tesela: solo quita lo que traen las de nivel muy bajo
//   (el corte por distancia, labelCutoff, es quien decide lo lejano; un filtro más alto dejaría sin nombre poblaciones cercanas
//   en las vistas casi horizontales, donde las teselas son de nivel bajo).
export function groundWidthStops(px, zc) {
  if (!Number.isFinite(zc)) return px;
  const z = Math.min(23, Math.max(1, zc));
  return ['interpolate', ['exponential', 2], ['zoom'], 0, px, z, px * 2, 24, px * (1 + 2 ** (24 - z))];
}
const labelSize = base => ['interpolate', ['linear'], ['zoom'], 9, base, 14, base * 1.15, 17, base * 1.75, 19, base * 2];
const LINE_STYLES = {
  'map3d-river': { px: 1, color: '#aecbe0', layer: 'waterway', filter: ['in', ['get', 'class'], ['literal', ['river', 'canal']]] },
  'map3d-runway': { px: 1.4, color: '#a9adb3', layer: 'aeroway', filter: ['==', ['get', 'class'], 'runway'] },
  // Autopistas, autovías y carreteras principales, sin sus ramales (a esta escala solo son ruido en los enlaces).
  'map3d-road-major': { px: 1.7, color: '#c4a56e', layer: 'transportation', filter: ['all', ['in', ['get', 'class'], ['literal', ['trunk', 'primary']]], ['!=', ['get', 'ramp'], 1]] },
  'map3d-road-motorway': { px: 3, color: '#b67f3f', layer: 'transportation', filter: ['all', ['==', ['get', 'class'], 'motorway'], ['!=', ['get', 'ramp'], 1]] },
  'map3d-border-region': { px: 0.8, color: '#a39bb0', layer: 'boundary', dash: [3, 2], filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]] },
  'map3d-border-country': { px: 1.6, color: '#75688a', layer: 'boundary', dash: [4, 2], filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]] },
};
const label = (id, layer, filter, base, font, extra = {}, color = '#1d2733') => ({
  id, type: 'symbol', source: 'openmaptiles', 'source-layer': layer, filter,
  layout: { 'text-field': PLACE_NAME, 'text-font': [font], 'text-size': labelSize(base), 'text-max-width': 8, 'text-padding': 6, ...extra },
  paint: { 'text-color': color, 'text-halo-color': 'rgba(255, 255, 255, 0.92)', 'text-halo-width': 1.6 },
});
const placeIs = (cls, minTileZoom, capital = null) => ['all', ['==', ['get', 'class'], cls], ['>=', ['zoom'], minTileZoom],
  ...(capital === null ? [] : [[capital ? '==' : '!=', ['get', 'capital'], 2]])];
// Las capas del 3D, de abajo arriba. under: bajo el agua del estilo; over: sobre ella. overlap: sin colisión (ver
// keepDistantLabels). De arriba abajo de importancia: lo que se coloca primero gana el sitio.
export function contextLayers({ zc = NaN, overlap = false } = {}) {
  const force = overlap ? { 'text-allow-overlap': true } : {};
  const under = [
    { id: 'map3d-green', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass']]], paint: { 'fill-color': '#cfdcbd', 'fill-opacity': 0.55 } },
    { id: 'map3d-urban', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'industrial', 'commercial']]], paint: { 'fill-color': '#d6d3cc' } },
  ];
  const over = [
    ...Object.entries(LINE_STYLES).map(([id, l]) => ({ id, type: 'line', source: 'openmaptiles', 'source-layer': l.layer, filter: l.filter,
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': l.color, 'line-width': groundWidthStops(l.px, zc), ...(l.dash ? { 'line-dasharray': l.dash } : {}) } })),
    // De menos a más importante: lo último se coloca primero y se queda el sitio. Lo que dice por dónde se pasa, por delante.
    label('map3d-water-name', 'water_name', ['all', ['==', ['geometry-type'], 'Point'], ['>=', ['zoom'], 4]], 13, 'Noto Sans Italic', {}, '#45708f'),
    label('map3d-country', 'place', ['all', ['==', ['get', 'class'], 'country'], ['>=', ['zoom'], 4]], 14, 'Noto Sans Bold', { 'text-transform': 'uppercase', 'text-letter-spacing': 0.12 }, '#5b5468'),
    label('map3d-town', 'place', placeIs('town', 7), 13, 'Noto Sans Regular'),
    // Aeropuertos: solo con código IATA (los aeródromos se llaman a menudo como su pueblo: «Yecla» salía dos veces, a 3 km) y solo
    // el código: «MAD» cabe junto a «Madrid», y el nombre completo perdía la colisión contra su ciudad. Por delante de las
    // poblaciones, por detrás de las ciudades, y a un lado o a otro de su punto si hace falta: conviven, sin forzar solapes (forzarlos
    // se saltaría también labelCutoff). Sin filtro de nivel alto: a 40-60 km su tesela es de nivel 9.
    label('map3d-airport', 'aerodrome_label', ['all', ['>=', ['zoom'], 7], ['has', 'iata'], ['!=', ['get', 'iata'], '']], 13.5, 'Noto Sans Bold',
      { 'text-field': ['get', 'iata'], 'text-letter-spacing': 0.04, 'text-padding': 2, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.4 }, '#2c5f8f'),
    label('map3d-city', 'place', placeIs('city', 5, false), 16, 'Noto Sans Bold', force),
    label('map3d-capital', 'place', placeIs('city', 4, true), 18, 'Noto Sans Bold', force),
  ];
  return { under, over };
}
// MapLibre descarta toda etiqueta con 0,5 + 0,5·(distancia cámara-centro / distancia cámara-etiqueta) < 0,6
// (CollisionIndex.perspectiveRatioCutoff): con la cámara a 100 m del avión y el suelo a 11 km, todas. Da igual su maxzoom o
// el sitio libre. Mientras dure el 3D, el corte lo da cutoff() (no hay otra forma pública; MapLibre va en una copia fija,
// js/vendor/maplibre). Devuelve cómo quitarlo, o null si esta versión ya no lo tiene: entonces las ciudades se fuerzan.
export function keepDistantLabels(map, cutoff = () => 0) {
  const index = map.style?.placement?.collisionIndex;
  if (!index || !('perspectiveRatioCutoff' in index)) return null;
  const proto = Object.getPrototypeOf(index);
  Object.defineProperty(proto, 'perspectiveRatioCutoff', { configurable: true, get: cutoff, set() {} });
  return () => { delete proto.perspectiveRatioCutoff; };
}
// El mismo corte, usado como distancia: una etiqueta a más de maxM de la cámara no se coloca. Interesa lo que hay cerca del
// avión: desde 11 km se ve hasta ~370 km, pero Lisboa o Rabat en el horizonte de Alicante no dicen por dónde se pasa. Se
// adapta a la altitud (lo que se distingue a simple vista) entre 60 y 140 km. Al alejar la cámara (mapa visto de lejos)
// nunca es más estricto que el de MapLibre, que equivale a 5 veces su distancia al centro.
export function labelCutoff({ zoom, lat, height, elevation }) {
  const cameraM = (1.5 * height * EARTH_M * Math.cos(lat * RAD)) / (512 * 2 ** zoom);
  const maxM = Math.max(Math.min(140000, Math.max(60000, elevation * 12)), cameraM * 5);
  return 0.5 + 0.5 * (cameraM / maxM);
}
// Dónde cae el horizonte de un suelo plano, en coordenadas de recorte (+1 arriba, −1 abajo). fov: el vertical de la cámara
// (grados); centerY: el centro de la vista con el hueco del encuadre. > 1: por encima de la vista, sin banda.
export function horizonClipY(pitchDeg, fovDeg, centerY = 0) {
  const a = (90 - pitchDeg) * RAD;
  return a <= 1e-3 ? centerY : centerY + Math.tan(a) / Math.tan(fovDeg * RAD / 2);
}
const rgba = (css, a) => { const [r, g, b] = (css.match(/\d+/g) ?? [125, 143, 163]).map(Number); return [r / 255 * a, g / 255 * a, b / 255 * a, a]; };

// ---- Sombreadores ----
const MESH_VS = `#version 300 es
in vec3 a_pos; in vec3 a_nor; in vec2 a_uv;
uniform mat4 u_matrix; out vec3 v_nor; out vec2 v_uv;
void main() { v_nor = a_nor; v_uv = a_uv; gl_Position = u_matrix * vec4(a_pos, 1.0); }`;
const MESH_FS = `#version 300 es
precision mediump float;
in vec3 v_nor; in vec2 v_uv; uniform sampler2D u_tex; uniform vec3 u_light; uniform float u_dim; out vec4 color;
void main() {
  vec3 base = texture(u_tex, v_uv).rgb;
  float l = 0.58 + 0.5 * max(dot(normalize(v_nor), u_light), 0.0);
  vec3 c = base * l;
  c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))) * 0.85 + 0.12, u_dim);
  color = vec4(c, 1.0);
}`;
const LINE_VS = `#version 300 es
in vec3 a_pos; in vec2 a_off; in vec4 a_col;
uniform mat4 u_matrix; uniform float u_half; out vec4 v_col; out vec2 v_xy;
void main() { v_col = a_col; v_xy = a_pos.xy; gl_Position = u_matrix * vec4(a_pos.xy + a_off * u_half, a_pos.z, 1.0); }`;
const LINE_FS = `#version 300 es
precision highp float; in vec4 v_col; in vec2 v_xy; uniform float u_fade; uniform vec2 u_tip; uniform float u_tipFade; out vec4 color;
// u_tipFade > 0: transparente en el avión (u_tip) y plena a esa distancia: la cortina no acaba en una pared bajo el avión.
void main() { float k = u_tipFade > 0.0 ? smoothstep(0.0, 1.0, distance(v_xy, u_tip) / u_tipFade) : 1.0; color = v_col * u_fade * k; }`;

const HAZE_VS = `#version 300 es
out float v_y; void main() { vec2 p = vec2(float((gl_VertexID & 1) * 4 - 1), float((gl_VertexID & 2) * 2 - 1)); v_y = p.y; gl_Position = vec4(p, 0.0, 1.0); }`;
const HAZE_FS = `#version 300 es
precision mediump float; in float v_y; uniform float u_horizon; uniform float u_band; uniform vec3 u_color; out vec4 color;
// Sube en un tercio de la banda por encima del horizonte, se mantiene y baja: sin bordes (el suelo de MapLibre acaba algo por
// debajo del horizonte geométrico, y esa línea queda dentro de la zona plena).
void main() { float d = (u_horizon - v_y) / u_band; float a = (d < 0.0 ? smoothstep(-0.35, 0.0, d) : 1.0 - smoothstep(0.3, 1.0, d)) * 0.95; color = vec4(u_color * a, a); }`;

function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'sombreador');
    return s;
  };
  const p = gl.createProgram();
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
  gl.deleteShader(v); gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'programa');
  return p;
}

// Geometría de la estela para la capa: puntos [lat, lon, pies | null] → cinta (a su altura) + cortina (hasta el suelo),
// relativas a `origin` (coordenadas Mercator). Un tramo solo se pinta en 3D si sus DOS puntos tienen altitud: sin ella
// no se sabe a qué altura iba (el 2D lo sigue pintando en el suelo, en neutro). origin: el de otra parte de la estela.
export function trailGeometry(pts, project, origin = null) {
  const ribbon = [], curtain = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (!Number.isFinite(a[2]) || !Number.isFinite(b[2])) continue;
    const pa = project(a[1], a[0], Math.max(0, a[2] * FT_TO_M)), pb = project(b[1], b[0], Math.max(0, b[2] * FT_TO_M));
    origin ??= [pa.x, pa.y];
    const A = [pa.x - origin[0], pa.y - origin[1], pa.z], B = [pb.x - origin[0], pb.y - origin[1], pb.z];
    const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const nx = -dy / len, ny = dx / len;
    const col = rgba(altitudeColor(b[2]), 1);
    // Cortina atmosférica: la cámara va a pocos metros de ella y, si no, cubre media vista con un velo de un solo color. Lo que
    // se dibuja junto al avión, además, se desvanece (drawLines, u_tipFade): la cinta es la protagonista.
    const top = rgba(altitudeColor(b[2]), 0.055), low = rgba(altitudeColor(b[2]), 0.015);
    const v = (p, ox, oy, c) => [p[0], p[1], p[2], ox, oy, ...c];
    ribbon.push(...v(A, nx, ny, col), ...v(A, -nx, -ny, col), ...v(B, -nx, -ny, col), ...v(A, nx, ny, col), ...v(B, -nx, -ny, col), ...v(B, nx, ny, col));
    const A0 = [A[0], A[1], 0], B0 = [B[0], B[1], 0];
    curtain.push(...v(A, 0, 0, top), ...v(A0, 0, 0, low), ...v(B0, 0, 0, low), ...v(A, 0, 0, top), ...v(B0, 0, 0, low), ...v(B, 0, 0, top));
  }
  return { origin, ribbon: new Float32Array(ribbon), curtain: new Float32Array(curtain) };
}

// Texto de la etiqueta del avión (qué se ve y con qué grado de certeza).
export function aircraftLabel(res, ident, modelName) {
  const from = ident?.modelSource === 'horario' ? ' (previsto en el horario)' : '';
  if (res.level === 'generic') return res.why === 'modelo-sin-recurso' ? `Avión genérico: ${ident.model} aún sin modelo 3D` : 'Avión genérico: modelo no disponible';
  if (res.level === 'exact') return `${modelName}${from} · colores de ${res.operator}, simplificados`;
  const why = { 'operadora-sin-confirmar': 'operadora sin confirmar', 'operadora-desconocida': 'operadora desconocida',
    'operadora-sin-decoracion': 'sin decoración de esta operadora', 'decoracion-no-hecha-para-el-modelo': `sin decoración de ${res.operator} para este modelo` }[res.why] ?? '';
  return `${modelName}${from} · colores neutros${why ? ` (${why})` : ''}`;
}

// Inclinación: un ojo a la altura de una línea de horizonte (de lado) y mirando hacia abajo a ella (desde arriba).
const svg = d => `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TILT_SIDE = svg('<path d="M3 16h18"/><path d="M12 12V4"/><path d="M8.5 8.5 12 12l3.5-3.5"/>');
const TILT_TOP = svg('<path d="M3 16h18"/><path d="M12 4v8"/><path d="M8.5 7.5 12 4l3.5 3.5"/>');
const FOLLOW = svg('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>');
const RESET = svg('<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4.5v4.2h4.2"/>');
const MORE = svg('<path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/><path d="m16.5 3.5 4 .5-.5 4"/><path d="M12 8v4l3 2"/>');
const CONTROLS = `<div class="map3d-ui">
  <p class="sr-only map3d-model"></p>
  <div class="map3d-side">
    <button type="button" class="map-btn" data-cam="in" aria-label="Acercar" title="Acercar">+</button>
    <button type="button" class="map-btn" data-cam="out" aria-label="Alejar" title="Alejar">−</button>
    <button type="button" class="map-btn" data-cam="more" aria-label="Girar e inclinar" title="Girar e inclinar" aria-expanded="false">${MORE}</button>
    <div class="map3d-more" hidden>
      <button type="button" class="map-btn" data-cam="left" aria-label="Girar la cámara a la izquierda" title="Girar a la izquierda">⟲</button>
      <button type="button" class="map-btn" data-cam="right" aria-label="Girar la cámara a la derecha" title="Girar a la derecha">⟳</button>
      <button type="button" class="map-btn" data-cam="tilt-side" aria-label="Inclinar: ver más de lado" title="Ver más de lado">${TILT_SIDE}</button>
      <button type="button" class="map-btn" data-cam="tilt-top" aria-label="Inclinar: ver más desde arriba" title="Ver más desde arriba">${TILT_TOP}</button>
    </div>
  </div>
  <div class="map3d-bar">
    <div class="map3d-views" role="group" aria-label="Perspectiva">${Object.entries(VIEWS).map(([k, v]) => `<button type="button" data-view="${k}">${v.label}</button>`).join('')}</div>
    <button type="button" class="map3d-icon map3d-follow" data-cam="follow" aria-pressed="true" aria-label="Seguir avión" title="Seguir avión">${FOLLOW}</button>
    <button type="button" class="map3d-icon map3d-reset" data-cam="reset" aria-label="Restablecer vista" title="Restablecer vista">${RESET}</button>
  </div>
</div>`;

// map, ml: el mapa y MapLibre; hero: el #map-card; state(): lo que pinta el 2D (ver createRouteMap.state3d).
// Rechaza si no hay WebGL 2 o la capa no se puede crear: quien llama vuelve al 2D.
// advance(): lleva el avión de js/map.js a su posición de este fotograma.
export async function enable3d({ map, ml, hero, state, advance = null, clock = { raf: cb => requestAnimationFrame(cb), caf: id => cancelAnimationFrame(id) } }) {
  const gl0 = map.painter?.context?.gl ?? map.getCanvas?.()?.getContext?.('webgl2');
  if (!(globalThis.WebGL2RenderingContext && gl0 instanceof WebGL2RenderingContext)) throw new Error('3D no disponible');
  const reduced = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const project = (lon, lat, m) => ml.MercatorCoordinate.fromLngLat([lon, lat], m);

  // ---- Recursos del avión (catálogo bajo demanda) ----
  let res = null, spec = null, paint = null, geometryDirty = false, identKey = null, loadToken = 0;
  async function loadAircraft(ident) {
    const token = ++loadToken;
    const index = await loadCatalogIndex();
    const r = index ? resolveAircraft(index, ident) : { modelId: 'generic', liveryId: null, level: 'generic', operator: null, why: 'catalogo-no-disponible' };
    const [s, l] = await Promise.all([r.modelId === 'generic' ? GENERIC_SPEC : loadModel(r.modelId), r.liveryId ? loadLivery(r.liveryId) : null]);
    if (token !== loadToken) return;
    // Si falta el archivo del modelo, el genérico; si falta el de la decoración, la neutra (nunca otra).
    if (!s) { res = { modelId: 'generic', liveryId: null, level: 'generic', operator: null, why: 'modelo-sin-recurso' }; spec = GENERIC_SPEC; }
    else { res = l || r.level !== 'exact' ? r : { ...r, liveryId: null, level: 'neutral', why: 'operadora-sin-decoracion' }; spec = s; }
    paint = res.level === 'generic' ? GENERIC_PAINT : res.level === 'exact' ? l.paint : NEUTRAL_PAINT;
    geometryDirty = true;
    info(ident);
    if (autoFrame && follow && state().plane) { frameGoal(view); transition(VIEW_MS / 2); } // el encuadre, con las medidas del modelo real
    map.triggerRepaint();
  }

  // ---- Capa WebGL ----
  let gl = null, meshProg = null, lineProg = null, hazeProg = null, mesh = null, tex = null, ribbonBuf = null, curtainBuf = null, dropBuf = null;
  let tipRibbonBuf = null, tipCurtainBuf = null;
  let trail = { origin: null, ribbonN: 0, curtainN: 0, last: null }, trailDirty = true, failed = false;
  const del = () => {
    if (!gl) return;
    for (const b of [mesh?.pos, mesh?.nor, mesh?.uv, mesh?.idx, ribbonBuf, curtainBuf, dropBuf, tipRibbonBuf, tipCurtainBuf]) if (b) gl.deleteBuffer(b);
    if (mesh?.vao) gl.deleteVertexArray(mesh.vao);
    if (tex) gl.deleteTexture(tex);
    if (meshProg) gl.deleteProgram(meshProg);
    if (lineProg) gl.deleteProgram(lineProg);
    if (hazeProg) gl.deleteProgram(hazeProg);
    mesh = tex = ribbonBuf = curtainBuf = dropBuf = tipRibbonBuf = tipCurtainBuf = meshProg = lineProg = hazeProg = null;
  };
  function uploadAircraft() {
    geometryDirty = false;
    if (mesh) { for (const b of [mesh.pos, mesh.nor, mesh.uv, mesh.idx]) gl.deleteBuffer(b); gl.deleteVertexArray(mesh.vao); mesh = null; }
    if (!spec) return;
    const g = buildAircraftGeometry(spec);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const attr = (name, data, size) => {
      const b = gl.createBuffer(), loc = gl.getAttribLocation(meshProg, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return b;
    };
    const pos = attr('a_pos', g.positions, 3), nor = attr('a_nor', g.normals, 3), uv = attr('a_uv', g.uvs, 2);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    mesh = { vao, pos, nor, uv, idx, count: g.indices.length, type: g.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, length: g.length };
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = TEXTURE_SIZE;
    paintLivery(canvas.getContext('2d'), paint, TEXTURE_SIZE, { length: spec.length, width: spec.width });
    if (!tex) tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  // La estela real (puntos recibidos) se sube cuando cambia; el último tramo, del último punto real al avión en pantalla
  // (posición y altitud interpoladas), en cada fotograma: de cerca, el avión recorre su propio largo en 200 ms.
  function uploadTrail(s) {
    trailDirty = false;
    const pts = s.planeAtEnd && s.plane ? s.track.slice(0, -1) : s.track;
    const t = trailGeometry(pts, project);
    ribbonBuf ??= gl.createBuffer(); curtainBuf ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ribbonBuf); gl.bufferData(gl.ARRAY_BUFFER, t.ribbon, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, curtainBuf); gl.bufferData(gl.ARRAY_BUFFER, t.curtain, gl.DYNAMIC_DRAW);
    trail = { origin: t.origin, ribbonN: t.ribbon.length / 9, curtainN: t.curtain.length / 9, last: s.planeAtEnd && s.plane ? pts.at(-1) ?? null : null };
  }
  function tipTrail(s) {
    if (!trail.last || !s.plane || !s.planeAtEnd) return null;
    const p = s.plane, last = trail.last;
    const origin = trail.origin ?? (() => { const c = project(last[1], last[0], 0); return [c.x, c.y]; })();
    const t = trailGeometry([last, [p.lat, p.lon, p.alt]], project, origin);
    if (!t.ribbon.length) return null;
    tipRibbonBuf ??= gl.createBuffer(); tipCurtainBuf ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tipRibbonBuf); gl.bufferData(gl.ARRAY_BUFFER, t.ribbon, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, tipCurtainBuf); gl.bufferData(gl.ARRAY_BUFFER, t.curtain, gl.DYNAMIC_DRAW);
    return { origin, n: t.ribbon.length / 9 };
  }
  const drawLines = (buf, n, mode, matrix, half, fade = 1, tip = null, tipFade = 0) => {
    gl.useProgram(lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const at = (name, size, off) => { const l = gl.getAttribLocation(lineProg, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 36, off); return l; };
    const ls = [at('a_pos', 3, 0), at('a_off', 2, 12), at('a_col', 4, 20)];
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'u_matrix'), false, Float32Array.from(matrix));
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_half'), half);
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_fade'), fade);
    gl.uniform2f(gl.getUniformLocation(lineProg, 'u_tip'), tip?.[0] ?? 0, tip?.[1] ?? 0);
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_tipFade'), tip ? tipFade : 0);
    gl.drawArrays(mode, 0, n);
    for (const l of ls) gl.disableVertexAttribArray(l);
  };
  // La banda de neblina, de arriba abajo desde el horizonte, sin tocar la profundidad: el avión y la estela van delante.
  function drawHaze() {
    const H = map.getContainer().clientHeight || 1, pad = map.getPadding?.() ?? { top: 0, bottom: 0 };
    const y = horizonClipY(map.getPitch(), map.getVerticalFieldOfView?.() ?? 36.87, (pad.bottom - pad.top) / H);
    if (y > 1 + HAZE_BAND * 2) return;
    gl.useProgram(hazeProg);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    gl.uniform1f(gl.getUniformLocation(hazeProg, 'u_horizon'), y);
    gl.uniform1f(gl.getUniformLocation(hazeProg, 'u_band'), HAZE_BAND * 2);
    gl.uniform3fv(gl.getUniformLocation(hazeProg, 'u_color'), HAZE_RGB);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  let lastScale = 1;
  // Mirando casi en horizontal, la cortina de la estela taparía media vista: se atenúa (la cinta, a su altura, se queda).
  const curtainFade = () => { const p = map.getPitch(); return p <= 65 ? 1 : Math.max(0.4, 1 - ((p - 65) / 25) * 0.6); };
  const layer = {
    id: 'aircraft-3d', type: 'custom', renderingMode: '3d',
    onAdd(_map, g) {
      gl = g;
      try { meshProg = program(gl, MESH_VS, MESH_FS); lineProg = program(gl, LINE_VS, LINE_FS); hazeProg = program(gl, HAZE_VS, HAZE_FS); } catch { failed = true; }
    },
    render(g, args) {
      if (failed || !meshProg) return;
      gl = g;
      gl.bindVertexArray(null);
      const s = state();
      const main = args.defaultProjectionData?.mainMatrix ?? args.modelViewProjectionMatrix;
      const worldPx = 512 * 2 ** map.getZoom();
      if (geometryDirty) uploadAircraft();
      if (trailDirty) uploadTrail(s);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawHaze();
      const tip = tipTrail(s);
      // La cortina se desvanece junto al avión: sin una pared que acabe de golpe bajo él.
      const near = s.plane ? project(s.plane.lon, s.plane.lat, 0) : null;
      const nearM = near ? CURTAIN_FADE_CAMERA * ((1.5 * (map.getContainer().clientHeight || 400)) / worldPx) : 0;
      const nearOf = o => (near ? [near.x - o[0], near.y - o[1]] : null);
      if (trail.origin) {
        const m = mult(main, translate(trail.origin[0], trail.origin[1], 0));
        gl.depthMask(false);
        if (trail.curtainN) drawLines(curtainBuf, trail.curtainN, gl.TRIANGLES, m, 0, curtainFade(), nearOf(trail.origin), nearM);
        gl.depthMask(true);
        if (trail.ribbonN) drawLines(ribbonBuf, trail.ribbonN, gl.TRIANGLES, m, RIBBON_PX / worldPx);
      }
      if (tip) {
        const m = mult(main, translate(tip.origin[0], tip.origin[1], 0));
        gl.depthMask(false);
        drawLines(tipCurtainBuf, tip.n, gl.TRIANGLES, m, 0, curtainFade(), nearOf(tip.origin), nearM);
        gl.depthMask(true);
        drawLines(tipRibbonBuf, tip.n, gl.TRIANGLES, m, RIBBON_PX / worldPx);
      }
      const p = s.plane;
      if (p && mesh) {
        const altM = Number.isFinite(p.alt) ? Math.max(0, p.alt * FT_TO_M) : 0;
        const c = project(p.lon, p.lat, altM);
        const unit = c.meterInMercatorCoordinateUnits();
        lastScale = Math.max(1, (PLANE_PX / worldPx) / (mesh.length * unit));
        const k = unit * lastScale;
        const h = shownHeading ?? 0;
        // Vertical del avión al suelo: ayuda a leer la altura (un trazo fino, del color neutro del 2D).
        dropBuf ??= gl.createBuffer();
        const col = rgba('rgb(30, 40, 55)', 0.2);
        gl.bindBuffer(gl.ARRAY_BUFFER, dropBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, c.z, 0, 0, ...col, 0, 0, 0, 0, 0, ...col]), gl.DYNAMIC_DRAW);
        drawLines(dropBuf, 2, gl.LINES, mult(main, translate(c.x, c.y, 0)), 0);
        const model = mult(mult(mult(main, translate(c.x, c.y, c.z)), scale(k, -k, k)), rotZ(-h * Math.PI / 180));
        // Luz fija del cielo (arriba, algo al noroeste), llevada al sistema del avión.
        const L = [-0.35, 0.45, 0.82], a = h * Math.PI / 180;
        const light = [L[0] * Math.cos(a) - L[1] * Math.sin(a), L[0] * Math.sin(a) + L[1] * Math.cos(a), L[2]];
        gl.useProgram(meshProg);
        gl.uniformMatrix4fv(gl.getUniformLocation(meshProg, 'u_matrix'), false, Float32Array.from(model));
        gl.uniform3fv(gl.getUniformLocation(meshProg, 'u_light'), light);
        gl.uniform1f(gl.getUniformLocation(meshProg, 'u_dim'), p.dim ? 0.6 : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(gl.getUniformLocation(meshProg, 'u_tex'), 0);
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, mesh.type, 0);
        gl.bindVertexArray(null);
      }
    },
    onRemove() { del(); gl = null; },
  };

  // ---- Cámara ----
  const saved = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing?.() ?? 0, pitch: map.getPitch?.() ?? 0 };
  let view = 'diagonal', follow = true, frameId = null, lastT = null, autoFrame = true;
  // shownHeading: el rumbo del avión en pantalla; camHeading: el que sigue la cámara (más despacio, para no dar bandazos).
  let shownHeading = null, camHeading = null;
  // Gestos del 3D (los del 2D más giro e inclinación), también dentro de la ficha sin ampliar: un dedo mueve el mapa
  // (y deja de seguir al avión); pellizcar o la rueda acercan y alejan sobre el centro (el avión, si se sigue); dos dedos
  // giran e inclinan sin dejar de seguir. La página se desplaza arrastrando fuera del mapa. Mientras se toca, el mapa
  // responde al gesto sin suavizado.
  const prevSky = map.getSky?.();
  map.setMaxPitch?.(MAX_PITCH);
  map.dragRotate?.enable?.(); map.touchPitch?.enable?.();
  map.touchZoomRotate?.enable?.({ around: 'center' }); map.touchZoomRotate?.enableRotation?.();
  map.scrollZoom?.enable?.({ around: 'center' });
  map.setCenterClampedToGround?.(false);
  try { map.setSky?.(SKY); } catch { /* sin cielo: se ve el fondo del mapa */ }
  // La capa «background» del estilo calcula su propia cobertura de teselas sin tope (MapLibre 6.11.2): con la cámara a
  // la altura del avión y zoom alto pedía teselas de nivel 26 («z=26 outside of bounds», medido a ~90° y zoom ≈ 19,7).
  // En 3D queda transparente y la tierra la pinta un polígono mundial en una fuente GeoJSON (acotada abajo como las demás).
  // Las líneas y etiquetas del estilo se apagan y entran las de contextLayers, de las MISMAS teselas (ninguna fuente nueva).
  // Al volver a 2D, todo como estaba.
  const styleLayers = map.getStyle?.()?.layers ?? [];
  const backgrounds = styleLayers.filter(l => l.type === 'background').map(l => ({ id: l.id, opacity: map.getPaintProperty?.(l.id, 'background-opacity') }));
  const firstLayer = styleLayers.find(l => l.type !== 'background')?.id;
  let cutoffNow = 0;
  const removeLabelPatch = keepDistantLabels(map, () => cutoffNow);
  const hasBase = Boolean(map.getSource?.('openmaptiles'));
  // Solo el agua y el hielo siguen con el estilo: son rellenos y no dependen de la escala.
  const hidden = hasBase ? styleLayers.filter(l => l.source === 'openmaptiles' && (l.type === 'line' || l.type === 'symbol' || l.type === 'fill') && !/^(water$|landcover_(ice|glacier))/.test(l.id))
    .map(l => ({ id: l.id, visibility: map.getLayoutProperty?.(l.id, 'visibility') })) : [];
  const waterColor = hasBase && map.getLayer?.('water') ? map.getPaintProperty?.('water', 'fill-color') : undefined;
  const context = hasBase ? contextLayers({ overlap: !removeLabelPatch }) : { under: [], over: [] };
  try {
    map.addSource('map3d-ground', { type: 'geojson', maxzoom: 4,
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
    map.addLayer({ id: 'map3d-ground', type: 'fill', source: 'map3d-ground', paint: { 'fill-color': GROUND_COLOR } }, firstLayer);
    for (const b of backgrounds) map.setPaintProperty(b.id, 'background-opacity', 0);
    for (const l of hidden) map.setLayoutProperty(l.id, 'visibility', 'none');
    if (waterColor !== undefined) map.setPaintProperty('water', 'fill-color', WATER_COLOR);
    for (const l of context.under) map.addLayer(l, firstLayer);
    const above = map.getLayer?.('route') ? 'route' : undefined;
    for (const l of context.over) map.addLayer(l, above);
  } catch { /* sin suelo propio o sin contexto: se queda lo que haya */ }
  // Detalle de las teselas con la cámara a la altura del avión: la función de MapLibre (la de setSourceTileLodParams, con
  // sus valores por defecto 9,314 y 3) no tiene tope cuando una tesela queda justo bajo la cámara elevada, y en las fuentes
  // vectoriales ese valor pasa a ser el nivel de la tesela: «z=26 outside of bounds» y desbordamiento de pila (medido a
  // 75–90° y zoom 18–21). Se acota al zoom máximo del mapa mientras dure el 3D.
  const lodSources = [];
  for (const id of Object.keys(map.getStyle?.()?.sources ?? {})) {
    const src = map.getSource?.(id);
    if (!src || !map.setSourceTileLodParams) continue;
    try { map.setSourceTileLodParams(9.314, 3, id); } catch { continue; }
    const lod = src.calculateTileZoom;
    if (typeof lod !== 'function') continue;
    const maxZ = map.getMaxZoom?.() ?? 22;
    src.calculateTileZoom = (...args) => { const z = lod(...args); return Number.isFinite(z) ? Math.min(maxZ, z) : maxZ; };
    lodSources.push(src);
  }
  const savedPadding = map.getPadding?.() ?? null;
  const restoreGestures = () => {
    if (savedPadding) map.setPadding?.(savedPadding);
    map.setCenterClampedToGround?.(true);
    map.dragRotate?.disable?.(); map.touchPitch?.disable?.(); map.touchZoomRotate?.disableRotation?.();
    map.touchZoomRotate?.enable?.(); map.scrollZoom?.enable?.();
    try { map.setSky?.(prevSky); } catch { /* ya sin cielo */ }
    for (const src of lodSources) src.calculateTileZoom = undefined; // la de MapLibre por defecto
    try {
      for (const l of [...context.over, ...context.under]) if (map.getLayer?.(l.id)) map.removeLayer(l.id);
      for (const l of hidden) map.setLayoutProperty(l.id, 'visibility', l.visibility);
      if (waterColor !== undefined) map.setPaintProperty('water', 'fill-color', waterColor);
      for (const b of backgrounds) map.setPaintProperty(b.id, 'background-opacity', b.opacity);
      if (map.getLayer?.('map3d-ground')) map.removeLayer('map3d-ground');
      if (map.getSource?.('map3d-ground')) map.removeSource('map3d-ground');
    } catch { /* el mapa ya no existe */ }
    map.setMaxPitch?.(60);
  };
  try { map.addLayer(layer); } catch { failed = true; }
  if (failed) { teardown(); restoreGestures(); throw new Error('3D no disponible'); }

  const ui = document.createElement('div');
  ui.innerHTML = CONTROLS;
  const panel = ui.firstElementChild;
  hero.append(panel);
  hero.classList.add('is-3d');
  const $ = sel => panel.querySelector(sel);

  const planeCamera = p => ({ center: [p.lon, p.lat], elevation: Number.isFinite(p.alt) ? Math.max(0, p.alt * FT_TO_M) : 0 });
  function setFollow(on) {
    follow = on && Boolean(state().plane);
    $('[data-cam="follow"]').setAttribute('aria-pressed', String(follow));
  }
  // Hueco libre para el avión: entre los botones de arriba (2D/3D) y la barra de perspectivas. El centro de la cámara va
  // al medio de ese hueco (padding de MapLibre).
  function framePadding() {
    const mr = map.getContainer().getBoundingClientRect();
    const top = Math.max(0, (hero.querySelector('.map-mode')?.getBoundingClientRect().bottom ?? mr.top) - mr.top);
    const bottom = Math.max(0, mr.bottom - $('.map3d-bar').getBoundingClientRect().top);
    const free = mr.height - top - bottom;
    return free >= 80 ? { top, bottom, left: 0, right: 0, width: mr.width, height: free } : { top: 0, bottom: 0, left: 0, right: 0, width: mr.width, height: mr.height };
  }
  // Zoom para que el avión entero (largo, envergadura y alto reales del modelo) quepa en ese hueco desde esa vista:
  // anchura en pantalla = largo·|sen a| + envergadura·|cos a| (a: ángulo entre la vista y el eje del avión); altura =
  // profundidad·cos(inclinación) + alto·sen(inclinación). La escala en el centro de la vista (donde está el avión) es la
  // del zoom: metros por píxel = circunferencia · cos(lat) / (512 · 2^zoom).
  function fitZoom(key, p, pad) {
    const sp = spec ?? GENERIC_SPEC;
    const L = sp.length, S = sp.span, H = sp.width + sp.fin.height + (sp.engines?.kind === 'underwing' ? sp.engines.diameter * 0.6 : 0);
    const a = VIEWS[key].offset * RAD, pr = VIEWS[key].pitch * RAD;
    const across = L * Math.abs(Math.sin(a)) + S * Math.abs(Math.cos(a));
    const depth = L * Math.abs(Math.cos(a)) + S * Math.abs(Math.sin(a));
    const tall = depth * Math.cos(pr) + H * Math.sin(pr);
    const mpp = Math.max(across / ((pad.width - 24) * FILL), tall / (pad.height * FILL));
    return Math.min(21, Math.max(3, Math.log2((EARTH_M * Math.cos(p.lat * RAD)) / (512 * mpp))));
  }
  // ---- Cámara: destino y transición ----
  // goal: el encuadre pedido (zoom, inclinación, hueco y, siguiendo, el giro respecto al avión; sin seguir, el rumbo).
  // Siguiendo, el centro va pegado al avión: a tamaño real recorre de 700 a 1 800 px/s, así que un retraso de la cámara de 0,3 s lo
  // sacaría del encuadre; lo suave son la dirección (camHeading) y cada transición. La transición mezcla el punto de partida
  // con el destino VIVO: el avión sigue moviéndose durante ella y la cámara llega donde está, sin saltos.
  const goal = { zoom: map.getZoom(), pitch: map.getPitch?.() ?? 0, offset: VIEWS.diagonal.offset, bearing: map.getBearing?.() ?? 0, padding: null };
  let moving = null;
  const nowCam = () => {
    const c = map.getCenter(), pad = map.getPadding?.();
    return { center: [c.lng, c.lat], elevation: map.getCenterElevation?.() ?? 0, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(),
      padding: pad ? { top: pad.top, bottom: pad.bottom, left: 0, right: 0 } : null };
  };
  const transition = dur => { moving = reduced ? null : { from: nowCam(), dur, t0: null }; };
  function cameraTarget(p) {
    const c = map.getCenter();
    return { ...(follow && p ? planeCamera(p) : { center: [c.lng, c.lat], elevation: map.getCenterElevation?.() ?? 0 }),
      zoom: goal.zoom, pitch: goal.pitch, bearing: follow && p ? (camHeading ?? 0) + goal.offset : goal.bearing, ...(goal.padding ? { padding: goal.padding } : {}) };
  }
  function frameGoal(key) {
    const p = state().plane, pad = framePadding();
    goal.pitch = VIEWS[key].pitch; goal.offset = VIEWS[key].offset; goal.padding = { top: pad.top, bottom: pad.bottom, left: 0, right: 0 };
    if (p) goal.zoom = fitZoom(key, p, pad);
    else goal.bearing = map.getBearing();
  }
  function applyView(key, { animate = true } = {}) {
    view = key; autoFrame = true;
    for (const b of panel.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === key));
    setFollow(true);
    frameGoal(key);
    if (animate) transition(VIEW_MS); else moving = null;
  }
  // Fin de un gesto: el encuadre elegido pasa a ser ese (si no ha cambiado nada, era un toque y no se pierde la vista).
  function adoptGesture() {
    const was = nowCam();
    if (Math.abs(was.zoom - goal.zoom) > 0.01 || Math.abs(was.pitch - goal.pitch) > 0.1 || Math.abs(wrap(was.bearing - (follow ? (camHeading ?? 0) + goal.offset : goal.bearing))) > 0.1) autoFrame = false;
    goal.zoom = was.zoom; goal.pitch = was.pitch; goal.bearing = was.bearing;
    if (camHeading !== null) goal.offset = wrap(was.bearing - camHeading);
  }
  // Un gesto en curso: desde que un dedo toca el mapa hasta que acaba su inercia. map.jumpTo aquí sería cortarlo: llama a
  // stop() y reinicia los manejadores de gestos de MapLibre (por eso el mapa «peleaba» con el dedo). Solo se lleva el
  // centro con el avión, directo sobre la transformación y sin tocar ni el giro, ni la inclinación, ni el zoom del usuario.
  const pointers = new Set();
  let wasManual = false;
  const manualNow = () => pointers.size > 0 || Boolean(map.isMoving?.());
  function trackDirect(p) {
    const tr = map._camera?.transform; // privado en MapLibre 6 (js/vendor/maplibre, copia fija); sin él, adoptGesture lo arregla
    if (!tr?.setCenter || !tr.setElevation) return;
    const c = planeCamera(p);
    tr.setCenter(new ml.LngLat(c.center[0], c.center[1]));
    tr.setElevation(c.elevation);
  }
  function cameraStep(t, p) {
    if (manualNow()) {
      wasManual = true; moving = null;
      if (follow && p) { trackDirect(p); map.triggerRepaint(); }
      return;
    }
    // Al acabar, la vuelta al avión (si hiciera falta) siempre con transición: nunca un salto.
    if (wasManual) { wasManual = false; adoptGesture(); transition(RESUME_MS); }
    const to = cameraTarget(p);
    if (moving) {
      // Lo que se mezcla es el desvío respecto al destino, no el punto de partida: el avión sigue volando (a tamaño real,
      // cientos de píxeles en una transición) y, si ya se le seguía, no debe moverse en pantalla.
      if (moving.t0 === null) { moving.t0 = t; moving.gap = [moving.from.center[0] - to.center[0], moving.from.center[1] - to.center[1], moving.from.elevation - to.elevation]; }
      const k = Math.min(1, (t - moving.t0) / moving.dur), { gap } = moving;
      map.jumpTo(k >= 1 ? to : blendCamera({ ...moving.from, center: [to.center[0] + gap[0], to.center[1] + gap[1]], elevation: to.elevation + gap[2] }, to, k));
      if (k >= 1) moving = null;
      return;
    }
    const c = map.getCenter();
    if (c.lng === to.center[0] && c.lat === to.center[1] && map.getZoom() === to.zoom && map.getPitch() === to.pitch && Math.abs(wrap(map.getBearing() - to.bearing)) < 1e-3) return;
    map.jumpTo(to);
  }
  // Un dedo o el ratón arrastran el mapa fuera del avión: deja de seguir y se queda donde lo dejen.
  const onDrag = e => { const oe = e?.originalEvent; if (oe && !(oe.touches?.length > 1)) setFollow(false); };
  map.on('dragstart', onDrag);

  // Un dedo con la vista casi horizontal (80° o más, p. ej. «Lado»): MapLibre arrastra sobre el plano del centro de la
  // cámara, que aquí es la altura del avión y se ve de canto: no movería nada (medido a 90°). Se mueve la cámara aquí, a
  // la escala del centro de la vista, y también deja de seguir. Por debajo de 80°, el arrastre de MapLibre.
  const HIGH_PITCH = 80;
  const box = map.getCanvasContainer?.() ?? null;
  const prevTouch = box?.style.touchAction ?? '';
  if (box) box.style.touchAction = 'none'; // un dedo es del mapa, también con el arrastre propio
  const syncPan = () => { if (map.getPitch() >= HIGH_PITCH) map.dragPan?.disable?.(); else map.dragPan?.enable?.(); };
  map.on('pitch', syncPan);
  syncPan();
  let pan = null;
  const onDown = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.add(e.pointerId);
    pan = pointers.size === 1 && map.getPitch() >= HIGH_PITCH ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false } : null;
  };
  const onMove = e => {
    if (!pan || e.pointerId !== pan.id || pointers.size > 1) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!dx && !dy) return;
    pan.x = e.clientX; pan.y = e.clientY;
    if (!pan.moved) { pan.moved = true; setFollow(false); }
    const c = map.getCenter(), b = map.getBearing() * RAD;
    const mpp = (EARTH_M * Math.cos(c.lat * RAD)) / (512 * 2 ** map.getZoom());
    // El contenido sigue al dedo: el centro va al lado contrario (derecha de la vista: (cos b, −sen b); delante: (sen b, cos b)).
    const east = (-dx * Math.cos(b) + dy * Math.sin(b)) * mpp, north = (dx * Math.sin(b) + dy * Math.cos(b)) * mpp;
    map.jumpTo({ center: [c.lng + east / (111320 * Math.cos(c.lat * RAD)), c.lat + north / 110540] });
  };
  const onUp = e => { pointers.delete(e.pointerId); if (pan?.id === e.pointerId) pan = null; };
  box?.addEventListener('pointerdown', onDown);
  box?.addEventListener('pointermove', onMove);
  // En la ventana: un dedo o el ratón que se sueltan fuera del mapa también acaban el gesto.
  for (const ev of ['pointerup', 'pointercancel']) globalThis.addEventListener?.(ev, onUp);

  // Un control pulsado manda sobre el gesto anterior, aunque siga su inercia o aún no se haya dado por acabado: se para (stop()
  // cierra la inercia y los manejadores de MapLibre) y el encuadre del gesto se recoge AHORA, antes de aplicar el control; si se
  // recogiera en el siguiente fotograma, pisaría el destino recién pedido. Sin esperas.
  function endGesture() {
    map.stop?.();
    pointers.clear();
    pan = null;
    if (wasManual) { wasManual = false; adoptGesture(); }
  }
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const cam = b.dataset.cam;
    if (cam !== 'more') endGesture();
    if (b.dataset.view) applyView(b.dataset.view);
    else if (cam === 'reset') applyView(view);
    else if (cam === 'more') {
      const more = $('.map3d-more');
      more.hidden = !more.hidden;
      b.setAttribute('aria-expanded', String(!more.hidden));
    } else if (cam === 'follow') {
      if (follow) setFollow(false);
      else { setFollow(true); if (autoFrame) frameGoal(view); transition(RESUME_MS); } // con el encuadre que tuviera
    } else {
      // Pulsaciones seguidas: cada una parte del destino de la anterior (no de un punto a mitad de transición).
      if (cam === 'in' || cam === 'out') { autoFrame = false; goal.zoom = Math.min(22, Math.max(2, goal.zoom + (cam === 'in' ? 1 : -1))); }
      else if (cam === 'tilt-side' || cam === 'tilt-top') { autoFrame = false; goal.pitch = Math.min(MAX_PITCH, Math.max(0, goal.pitch + (cam === 'tilt-side' ? TILT_STEP : -TILT_STEP))); }
      else if (cam === 'left' || cam === 'right') { const d = cam === 'left' ? -30 : 30; goal.offset = wrap(goal.offset + d); goal.bearing += d; }
      else return;
      transition(BUTTON_MS);
    }
  });

  // ---- El bucle: avión, giro y cámara, en este orden y en el mismo fotograma ----
  let lastDrawn = null;
  function loop(t) {
    frameId = clock.raf(loop);
    const dt = lastT === null ? 16 : Math.min(100, t - lastT);
    lastT = t;
    advance?.();
    const p = state().plane;
    if (!p && follow) setFollow(false);
    const h = p && Number.isFinite(p.heading) ? p.heading : null;
    if (h === null) shownHeading = camHeading = null;
    else if (shownHeading === null || reduced) shownHeading = camHeading = h;
    else {
      shownHeading = smoothAngle(shownHeading, h, dt, PLANE_TURN_TAU_MS);
      camHeading = smoothAngle(camHeading, h, dt, CAMERA_TURN_TAU_MS);
    }
    cameraStep(t, p);
    syncLineWidths(p);
    cutoffNow = labelCutoff({ zoom: map.getZoom(), lat: map.getCenter().lat, height: map.getContainer().clientHeight || 400, elevation: map.getCenterElevation?.() ?? 0 });
    // Sin nada que se mueva, MapLibre no vuelve a dibujar (ahorra batería).
    const key = p ? `${p.lat},${p.lon},${p.alt},${shownHeading}` : 'none';
    if (key !== lastDrawn) { lastDrawn = key; map.triggerRepaint(); }
  }
  // Ancho de las líneas del suelo: depende de a qué altura está la cámara y del alto del mapa. Se recalcula solo cuando
  // esa referencia cambia de verdad (un 15 %): subir y bajar es lento y no hace falta en cada fotograma.
  let widthAlt = null, widthH = null;
  function syncLineWidths(p) {
    if (!context.over.length) return;
    const elevation = map.getCenterElevation?.() ?? (p ? planeCamera(p).elevation : 0), H = map.getContainer().clientHeight || 400;
    const alt = Math.max(1, elevation);
    if (widthAlt !== null && widthH === H && Math.abs(alt - widthAlt) / widthAlt < 0.15) return;
    widthAlt = alt; widthH = H;
    // zc: el zoom con el que la cámara está tan lejos del centro como el centro del suelo (mirando en ~35° de media).
    const lat = (p?.lat ?? map.getCenter().lat) * RAD;
    const zc = alt < 50 ? NaN : Math.log2((1.5 * H * EARTH_M * Math.cos(lat)) / (512 * alt * 1.25));
    for (const [id, l] of Object.entries(LINE_STYLES)) if (map.getLayer?.(id)) map.setPaintProperty(id, 'line-width', groundWidthStops(l.px, zc));
  }

  function info(ident = lastIdent) {
    if (!res) return;
    $('.map3d-model').textContent = aircraftLabel(res, ident, spec?.name ?? '');
    hero.dataset.aircraft3d = res.level;
  }

  let lastIdent = null;
  // Datos nuevos desde js/map.js (una lectura, la estela o el avión identificado); el movimiento lo lleva el bucle.
  function update({ trail: trailChanged = false } = {}) {
    const s = state();
    const key = JSON.stringify(s.aircraft ?? null);
    if (key !== identKey) { identKey = key; lastIdent = s.aircraft; loadAircraft(s.aircraft).catch(() => {}); }
    if (trailChanged) trailDirty = true;
    map.triggerRepaint();
  }

  function teardown() {
    try { if (map.getLayer?.('aircraft-3d')) map.removeLayer('aircraft-3d'); } catch { /* el mapa ya no existe */ }
    del();
  }
  // Primera vista: diagonal siguiendo al avión; sin avión (aterrizado), la estela inclinada donde estaba la vista.
  update({ trail: true });
  if (state().plane) { applyView('diagonal'); if (moving) moving.dur = ENTER_MS; }
  else {
    setFollow(false);
    for (const b of panel.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', 'false');
    goal.pitch = 60;
    transition(ENTER_MS / 2);
  }
  frameId = clock.raf(loop);

  return {
    update,
    // El mapa se amplía o vuelve a la ficha: gestos de la página y encuadre del hueco nuevo.
    setExpanded() {
      if (autoFrame && follow) { applyView(view, { animate: false }); return; }
      const { top, bottom } = framePadding();
      goal.padding = { top, bottom, left: 0, right: 0 };
      map.setPadding?.(goal.padding);
    },
    // Vuelta al 2D: fuera la capa, los recursos de WebGL, los controles y los gestos de giro; la vista 2D de antes.
    destroy({ restore = true } = {}) {
      loadToken++;
      if (frameId !== null) clock.caf(frameId);
      frameId = null;
      removeLabelPatch?.();
      map.off?.('dragstart', onDrag); map.off?.('pitch', syncPan);
      box?.removeEventListener('pointerdown', onDown);
      box?.removeEventListener('pointermove', onMove);
      for (const ev of ['pointerup', 'pointercancel']) globalThis.removeEventListener?.(ev, onUp);
      if (box) box.style.touchAction = prevTouch;
      map.dragPan?.enable?.();
      teardown();
      panel.remove();
      hero.classList.remove('is-3d');
      delete hero.dataset.aircraft3d;
      if (!restore) return;
      map.jumpTo({ ...saved, elevation: 0 });
      restoreGestures();
    },
  };
}
