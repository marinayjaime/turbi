// Modo 3D del mapa del vuelo (opcional; js/map.js lo importa SOLO al pulsar «3D»). Una capa WebGL propia dentro de
// MapLibre (sin otra librería): el avión con volumen (js/aircraft3d.js) en su posición y altitud, la estela real a su
// altura (cinta con el color de la altitud de FR24 y una cortina tenue hasta el suelo) y una cámara que gira alrededor
// del avión. Todo sale de lo que el mapa 2D ya tiene: ninguna consulta de seguimiento nueva.
//
// Fidelidad (lo que se ve y lo que se dice):
// - Posición y altitud: las reales recibidas; entre dos lecturas, el mismo recorrido del 2D (js/map.js, una lectura por
//   detrás y nunca más allá de la última), con la altitud interpolada entre las dos. Sin datos nuevos, quieto; pasados
//   180 s, fuera (como en 2D). La antigüedad de la última posición real se ve siempre.
// - Altitud: la barométrica estándar (1013,25 hPa) que dan FR24 (`alt`) y adsb.lol (`alt_baro`), en pies. El mapa no
//   tiene relieve: el avión se sitúa sobre un suelo plano a nivel del mar a esa altitud (diferencia típica con la real:
//   cientos de metros, invisible a esta escala; en tierra queda a 0).
// - Orientación: la dirección de desplazamiento (`track`, o el rumbo entre dos posiciones reales). No se recibe el rumbo
//   del morro: se dice. Alas y morro, siempre nivelados: no se recibe la actitud y no se inventa.
// - Tamaño: el avión se amplía para que se vea (×N, siempre indicado); la altitud y las posiciones no se exageran.
import { altitudeColor } from './map.js';
import { monoNow } from './card-model.js';
import { esc } from './ui.js';
import { loadCatalogIndex, loadModel, loadLivery, resolveAircraft, buildAircraftGeometry, paintLivery, TEXTURE_SIZE,
  NEUTRAL_PAINT, GENERIC_PAINT, GENERIC_SPEC } from './aircraft3d.js';

const FT_TO_M = 0.3048;
const PLANE_PX = 70; // largo aproximado del avión en pantalla (px CSS) cuando hay que ampliarlo
const RIBBON_PX = 2.2; // media anchura de la cinta de la estela (px CSS en el centro de la vista)
const TURN_DEG_S = 90; // giro del avión y de la cámara hacia una dirección nueva (grados por segundo)
// 90°: la cámara a la altura del avión (vista lateral de verdad). MapLibre 6 admite hasta 180°, pero por encima de 90°
// se mira el avión desde abajo con el suelo cortado por arriba: no aporta y no se ofrece.
const MAX_PITCH = 90;
const TILT_STEP = 10;
const ORBIT_DEG_PX = 0.35; // giro de la cámara por píxel arrastrado con un dedo
export const VIEWS = {
  behind: { label: 'Detrás', offset: 0, pitch: 78 },
  side: { label: 'Lado', offset: 90, pitch: 90 },
  diagonal: { label: 'Diagonal', offset: 40, pitch: 66 },
  top: { label: 'Arriba', offset: 0, pitch: 0 },
};
// Cielo del modo 3D: sin él, al mirar cerca del horizonte queda una franja vacía por encima del suelo. La niebla,
// del color del fondo del mapa, funde el borde lejano del suelo (MapLibre deja de dibujar teselas a cierta distancia).
const SKY = { 'sky-color': '#a9cdee', 'horizon-color': '#e6eff8', 'fog-color': '#eef1f2', 'sky-horizon-blend': 0.7,
  'horizon-fog-blend': 0.9, 'fog-ground-blend': 0.85, 'atmosphere-blend': 0 };
const EARTH_M = 40075016.686;
const RAD = Math.PI / 180;
// Encuadre de cada vista: el avión completo ocupa como mucho esta fracción del hueco libre (entre la etiqueta y la barra).
const FILL = 0.8;

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
uniform mat4 u_matrix; uniform float u_half; out vec4 v_col;
void main() { v_col = a_col; gl_Position = u_matrix * vec4(a_pos.xy + a_off * u_half, a_pos.z, 1.0); }`;
const LINE_FS = `#version 300 es
precision mediump float; in vec4 v_col; uniform float u_fade; out vec4 color; void main() { color = v_col * u_fade; }`;

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
    const top = rgba(altitudeColor(b[2]), 0.3), low = rgba(altitudeColor(b[2]), 0.04);
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
const CONTROLS = `<div class="map3d-ui">
  <p class="map3d-info" aria-live="polite"><span class="map3d-model"></span><span class="map3d-age"></span><span class="map3d-note">Orientado según la trayectoria; inclinación no medida</span></p>
  <div class="map3d-zoom">
    <button type="button" class="map-btn" data-cam="in" aria-label="Acercar" title="Acercar">+</button>
    <button type="button" class="map-btn" data-cam="out" aria-label="Alejar" title="Alejar">−</button>
    <button type="button" class="map-btn" data-cam="left" aria-label="Girar la cámara a la izquierda" title="Girar a la izquierda">⟲</button>
    <button type="button" class="map-btn" data-cam="right" aria-label="Girar la cámara a la derecha" title="Girar a la derecha">⟳</button>
    <button type="button" class="map-btn" data-cam="tilt-side" aria-label="Inclinar: ver más de lado" title="Ver más de lado">${TILT_SIDE}</button>
    <button type="button" class="map-btn" data-cam="tilt-top" aria-label="Inclinar: ver más desde arriba" title="Ver más desde arriba">${TILT_TOP}</button>
  </div>
  <div class="map3d-bar">
    <div class="map3d-views" role="group" aria-label="Perspectiva">${Object.entries(VIEWS).map(([k, v]) => `<button type="button" data-view="${k}">${v.label}</button>`).join('')}</div>
    <button type="button" class="map3d-follow" data-cam="follow" aria-pressed="true">Seguir avión</button>
    <button type="button" class="map3d-reset" data-cam="reset">Restablecer vista</button>
  </div>
</div>`;

// map, ml: el mapa y MapLibre; hero: el #map-card; state(): lo que pinta el 2D (ver createRouteMap.state3d).
// Rechaza si no hay WebGL 2 o la capa no se puede crear: quien llama vuelve al 2D.
export async function enable3d({ map, ml, hero, state, clock = { raf: cb => requestAnimationFrame(cb), caf: id => cancelAnimationFrame(id) } }) {
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
    if (autoFrame && follow && state().plane) applyView(view, { animate: false }); // el encuadre, con las medidas del modelo real
    map.triggerRepaint();
  }

  // ---- Capa WebGL ----
  let gl = null, meshProg = null, lineProg = null, mesh = null, tex = null, ribbonBuf = null, curtainBuf = null, dropBuf = null;
  let tipRibbonBuf = null, tipCurtainBuf = null;
  let trail = { origin: null, ribbonN: 0, curtainN: 0, last: null }, trailDirty = true, failed = false;
  const del = () => {
    if (!gl) return;
    for (const b of [mesh?.pos, mesh?.nor, mesh?.uv, mesh?.idx, ribbonBuf, curtainBuf, dropBuf, tipRibbonBuf, tipCurtainBuf]) if (b) gl.deleteBuffer(b);
    if (mesh?.vao) gl.deleteVertexArray(mesh.vao);
    if (tex) gl.deleteTexture(tex);
    if (meshProg) gl.deleteProgram(meshProg);
    if (lineProg) gl.deleteProgram(lineProg);
    mesh = tex = ribbonBuf = curtainBuf = dropBuf = tipRibbonBuf = tipCurtainBuf = meshProg = lineProg = null;
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
  const drawLines = (buf, n, mode, matrix, half, fade = 1) => {
    gl.useProgram(lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const at = (name, size, off) => { const l = gl.getAttribLocation(lineProg, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 36, off); return l; };
    const ls = [at('a_pos', 3, 0), at('a_off', 2, 12), at('a_col', 4, 20)];
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'u_matrix'), false, Float32Array.from(matrix));
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_half'), half);
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_fade'), fade);
    gl.drawArrays(mode, 0, n);
    for (const l of ls) gl.disableVertexAttribArray(l);
  };
  let lastScale = 1;
  // Mirando casi en horizontal, la cortina de la estela taparía media vista: se atenúa (la cinta, a su altura, se queda).
  const curtainFade = () => { const p = map.getPitch(); return p <= 65 ? 1 : Math.max(0.4, 1 - ((p - 65) / 25) * 0.6); };
  const layer = {
    id: 'aircraft-3d', type: 'custom', renderingMode: '3d',
    onAdd(_map, g) {
      gl = g;
      try { meshProg = program(gl, MESH_VS, MESH_FS); lineProg = program(gl, LINE_VS, LINE_FS); } catch { failed = true; }
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
      const tip = tipTrail(s);
      if (trail.origin) {
        const m = mult(main, translate(trail.origin[0], trail.origin[1], 0));
        gl.depthMask(false);
        if (trail.curtainN) drawLines(curtainBuf, trail.curtainN, gl.TRIANGLES, m, 0, curtainFade());
        gl.depthMask(true);
        if (trail.ribbonN) drawLines(ribbonBuf, trail.ribbonN, gl.TRIANGLES, m, RIBBON_PX / worldPx);
      }
      if (tip) {
        const m = mult(main, translate(tip.origin[0], tip.origin[1], 0));
        gl.depthMask(false);
        drawLines(tipCurtainBuf, tip.n, gl.TRIANGLES, m, 0, curtainFade());
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
        const col = rgba('rgb(30, 40, 55)', 0.45);
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
  let view = 'diagonal', offset = VIEWS.diagonal.offset, follow = true, interacting = false, easing = false;
  // autoFrame: el encuadre es el de la vista elegida (si llega el modelo real, se reajusta); un zoom manual lo deja.
  let shownHeading = null, targetHeading = null, frame = null, lastT = null, autoFrame = true;
  // Gestos del 3D, también dentro de la ficha (sin ampliar el mapa): sin los «gestos cooperativos» del 2D. Un dedo en
  // horizontal gira alrededor del avión y en vertical desplaza la página (touch-action: pan-y; ampliado, inclina);
  // pellizcar acerca o aleja SOBRE el avión; dos dedos giran e inclinan. En pantalla táctil no se arrastra el mapa (no
  // hay forma de hacerlo sin chocar con el desplazamiento de la página); con ratón, arrastrar sí lo mueve y deja de
  // seguir. La rueda desplaza la página; con Ctrl/⌘ (o pellizco en el panel táctil), acerca.
  const coarse = Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);
  const box = map.getCanvasContainer?.() ?? null;
  const prevTouch = box?.style.touchAction ?? '';
  const prevSky = map.getSky?.();
  const expandedNow = () => hero.classList.contains('expanded');
  const setTouch = () => { if (box) box.style.touchAction = expandedNow() ? 'none' : 'pan-y'; };
  map.cooperativeGestures?.disable?.();
  if (coarse) map.dragPan?.disable?.();
  map.scrollZoom?.disable?.();
  map.setMaxPitch?.(MAX_PITCH);
  map.dragRotate?.enable?.(); map.touchPitch?.enable?.();
  map.touchZoomRotate?.enable?.({ around: 'center' }); map.touchZoomRotate?.enableRotation?.();
  map.setCenterClampedToGround?.(false);
  try { map.setSky?.(SKY); } catch { /* sin cielo: se ve el fondo del mapa */ }
  setTouch();
  // La capa «background» del estilo calcula su propia cobertura de teselas sin tope (MapLibre 6.11.2): con la cámara a
  // la altura del avión y zoom alto pedía teselas de nivel 26 («z=26 outside of bounds», medido a ~90° y zoom ≈ 19,7).
  // En 3D queda transparente y la tierra la pinta un polígono mundial del mismo color en una fuente GeoJSON (acotada
  // abajo como las demás). Al volver a 2D, todo como estaba.
  const backgrounds = (map.getStyle?.()?.layers ?? []).filter(l => l.type === 'background').map(l => ({ id: l.id, opacity: map.getPaintProperty?.(l.id, 'background-opacity') }));
  const groundColor = (backgrounds[0] && map.getPaintProperty?.(backgrounds[0].id, 'background-color')) || '#f4f5f2';
  const firstLayer = (map.getStyle?.()?.layers ?? []).find(l => l.type !== 'background')?.id;
  try {
    map.addSource('map3d-ground', { type: 'geojson', maxzoom: 4,
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
    map.addLayer({ id: 'map3d-ground', type: 'fill', source: 'map3d-ground', paint: { 'fill-color': typeof groundColor === 'string' ? groundColor : '#f4f5f2' } }, firstLayer);
    for (const b of backgrounds) map.setPaintProperty(b.id, 'background-opacity', 0);
  } catch { /* sin suelo propio: se queda el fondo del estilo */ }
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
    map.touchZoomRotate?.enable?.();
    map.dragPan?.enable?.(); map.scrollZoom?.enable?.();
    if (!expandedNow()) map.cooperativeGestures?.enable?.();
    try { map.setSky?.(prevSky); } catch { /* ya sin cielo */ }
    if (box) box.style.touchAction = prevTouch;
    for (const src of lodSources) src.calculateTileZoom = undefined; // la de MapLibre por defecto
    try {
      for (const b of backgrounds) map.setPaintProperty(b.id, 'background-opacity', b.opacity ?? 1);
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
  const bearingNow = () => (shownHeading ?? 0) + offset;
  function followFrame() {
    const p = state().plane;
    if (!follow || !p || interacting || easing) return;
    map.jumpTo({ ...planeCamera(p), bearing: bearingNow() });
  }
  function setFollow(on) {
    follow = on && Boolean(state().plane);
    $('[data-cam="follow"]').setAttribute('aria-pressed', String(follow));
  }
  // Hueco libre para el avión: entre la etiqueta (arriba) y la barra de perspectivas (abajo). El centro de la cámara
  // va al medio de ese hueco (padding de MapLibre).
  function framePadding() {
    const mr = map.getContainer().getBoundingClientRect();
    const top = Math.max(0, $('.map3d-info').getBoundingClientRect().bottom - mr.top) + 10;
    const bottom = Math.max(0, mr.bottom - $('.map3d-bar').getBoundingClientRect().top) + 10;
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
  // Animación de la cámara que el seguimiento no interrumpe (followFrame espera a que acabe y luego recoloca el centro).
  // Cada animación lleva su número: al empezar otra, MapLibre da por acabada la anterior (moveend) y solo la última
  // devuelve el control al seguimiento.
  let easeId = 0;
  function easeCam(target, duration = 300) {
    if (reduced) { map.jumpTo(target); return; }
    const id = ++easeId;
    easing = true;
    map.easeTo({ ...target, duration });
    map.once('moveend', () => { if (id === easeId) { easing = false; followFrame(); } });
  }
  const easeAround = (opts, duration) => {
    const p = state().plane;
    easeCam({ ...opts, ...(follow && p ? { ...planeCamera(p), bearing: opts.bearing ?? bearingNow() } : {}) }, duration);
  };
  function applyView(key, { animate = true } = {}) {
    view = key; offset = VIEWS[key].offset; autoFrame = true;
    for (const b of panel.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === key));
    const p = state().plane;
    setFollow(true);
    const pad = framePadding();
    map.setPadding?.({ top: pad.top, bottom: pad.bottom, left: 0, right: 0 });
    const target = { pitch: VIEWS[key].pitch, bearing: p ? bearingNow() : map.getBearing(), ...(p ? { ...planeCamera(p), zoom: fitZoom(key, p, pad) } : {}) };
    if (!animate) { easeId++; easing = false; map.jumpTo(target); return; }
    easeCam(target, 700);
  }
  // El usuario gira, inclina o acerca: el encuadre elegido pasa a ser ese (sigue siguiendo); si arrastra el mapa, deja de seguir.
  const onStart = e => { if (e?.originalEvent) interacting = true; };
  const onEnd = e => {
    if (!e?.originalEvent && !interacting) return;
    interacting = false;
    autoFrame = false;
    if (shownHeading !== null) offset = wrap(map.getBearing() - shownHeading);
    followFrame();
  };
  const onDrag = e => { if (e?.originalEvent) setFollow(false); };
  map.on('movestart', onStart); map.on('moveend', onEnd); map.on('dragstart', onDrag);

  // Un dedo: en horizontal, gira alrededor del avión; en vertical, la página se desplaza (dentro de la ficha) o, con el
  // mapa ampliado, inclina. Un segundo dedo cancela (lo llevan los gestos de MapLibre).
  const touches = new Set();
  let drag = null;
  const camTo = (bearing, pitch) => {
    autoFrame = false;
    const p = state().plane;
    if (shownHeading !== null) offset = wrap(bearing - shownHeading);
    map.jumpTo({ bearing, pitch, ...(follow && p ? planeCamera(p) : {}) });
  };
  const onDown = e => {
    if (e.pointerType === 'mouse') return;
    touches.add(e.pointerId);
    drag = touches.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, axis: null, bearing: map.getBearing(), pitch: map.getPitch() } : null;
  };
  const onMove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'h' : expandedNow() ? 'v' : null;
      if (!drag.axis) { drag = null; return; }
    }
    if (drag.axis === 'h') camTo(drag.bearing - dx * ORBIT_DEG_PX, map.getPitch());
    else camTo(map.getBearing(), Math.min(MAX_PITCH, Math.max(0, drag.pitch - dy * 0.3)));
  };
  const onUp = e => { touches.delete(e.pointerId); if (drag?.id === e.pointerId) drag = null; };
  const onWheel = e => {
    if (!(e.ctrlKey || e.metaKey || expandedNow())) return; // la rueda sola desplaza la página
    e.preventDefault();
    autoFrame = false;
    map.jumpTo({ zoom: Math.min(22, Math.max(2, map.getZoom() - e.deltaY * (e.ctrlKey ? 0.02 : 0.004))) });
  };
  box?.addEventListener('pointerdown', onDown);
  box?.addEventListener('pointermove', onMove);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) box?.addEventListener(ev, onUp);
  box?.addEventListener('wheel', onWheel, { passive: false });

  let goal = null, goalTimer = null;
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    // Pulsaciones seguidas: cada una parte del destino de la anterior (no de un punto a mitad de animación).
    const at = goal ?? { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    if (b.dataset.view) applyView(b.dataset.view);
    else if (b.dataset.cam === 'reset') applyView(view);
    else if (b.dataset.cam === 'follow') { if (follow) setFollow(false); else applyView(view); }
    else if (b.dataset.cam === 'in' || b.dataset.cam === 'out') {
      autoFrame = false;
      goal = { ...at, zoom: Math.min(22, Math.max(2, at.zoom + (b.dataset.cam === 'in' ? 1 : -1))) };
      easeAround({ zoom: goal.zoom });
    } else if (b.dataset.cam === 'tilt-side' || b.dataset.cam === 'tilt-top') {
      autoFrame = false;
      goal = { ...at, pitch: Math.min(MAX_PITCH, Math.max(0, at.pitch + (b.dataset.cam === 'tilt-side' ? TILT_STEP : -TILT_STEP))) };
      easeAround({ pitch: goal.pitch });
    } else if (b.dataset.cam === 'left' || b.dataset.cam === 'right') {
      const d = b.dataset.cam === 'left' ? -30 : 30;
      goal = { ...at, bearing: at.bearing + d };
      offset = wrap(offset + d);
      easeAround({ bearing: goal.bearing });
    }
    if (!b.dataset.cam?.match(/^(in|out|tilt-side|tilt-top|left|right)$/)) goal = null;
    clearTimeout(goalTimer);
    goalTimer = setTimeout(() => { goal = null; }, 400);
  });

  // ---- Giro suave hacia la dirección nueva (solo presentación; la dirección es siempre la medida) ----
  function tick(t) {
    frame = null;
    const dt = lastT === null ? 16 : Math.min(100, t - lastT);
    lastT = t;
    if (targetHeading === null) return;
    if (shownHeading === null || reduced) shownHeading = targetHeading;
    else {
      const d = wrap(targetHeading - shownHeading), stepDeg = TURN_DEG_S * dt / 1000;
      shownHeading = Math.abs(d) <= stepDeg ? targetHeading : shownHeading + Math.sign(d) * stepDeg;
    }
    followFrame();
    map.triggerRepaint();
    if (shownHeading !== targetHeading) frame = clock.raf(tick);
    else lastT = null;
  }

  // ---- Etiqueta: modelo y decoración, antigüedad de la posición y tamaño ----
  function info(ident = lastIdent) {
    if (!res) return;
    $('.map3d-model').textContent = aircraftLabel(res, ident, spec?.name ?? '');
    hero.dataset.aircraft3d = res.level;
  }
  function ageText() {
    const p = state().plane;
    if (!p) return 'Sin posición reciente del avión';
    const ageS = Number.isFinite(p.obsMono) ? Math.max(0, Math.round((monoNow() - p.obsMono) / 1000)) : null;
    const age = ageS === null ? 'Posición real' : ageS < 60 ? `Posición real de hace ${ageS} s` : `Posición real de hace ${Math.floor(ageS / 60)} min ${ageS % 60} s`;
    return `${age}${lastScale > 1.5 ? ` · tamaño ×${Math.round(lastScale)}` : ''}`;
  }
  const showAge = () => {
    const t = ageText();
    if ($('.map3d-age').textContent !== t) $('.map3d-age').textContent = t;
    $('.map3d-note').hidden = !state().plane;
  };
  const ageTimer = setInterval(showAge, 1000);

  let lastIdent = null;
  function update({ trail: trailChanged = false } = {}) {
    const s = state();
    const key = JSON.stringify(s.aircraft ?? null);
    if (key !== identKey) { identKey = key; lastIdent = s.aircraft; loadAircraft(s.aircraft).catch(() => {}); }
    if (trailChanged) trailDirty = true;
    const h = s.plane && Number.isFinite(s.plane.heading) ? s.plane.heading : null;
    if (h !== targetHeading) { targetHeading = h; if (h === null) shownHeading = null; else if (frame === null) frame = clock.raf(tick); }
    if (!s.plane && follow) setFollow(false);
    showAge();
    followFrame();
    map.triggerRepaint();
  }

  function teardown() {
    try { if (map.getLayer?.('aircraft-3d')) map.removeLayer('aircraft-3d'); } catch { /* el mapa ya no existe */ }
    del();
  }
  // Primera vista: diagonal siguiendo al avión; sin avión (aterrizado), la estela inclinada donde estaba la vista.
  update({ trail: true });
  if (state().plane) applyView('diagonal');
  else {
    setFollow(false);
    for (const b of panel.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', 'false');
    map.easeTo({ pitch: 60, duration: reduced ? 0 : 600 });
  }

  return {
    update,
    // El mapa se amplía o vuelve a la ficha: gestos de la página y encuadre del hueco nuevo.
    setExpanded() {
      setTouch();
      if (autoFrame && follow) { applyView(view, { animate: false }); return; }
      const { top, bottom } = framePadding();
      map.setPadding?.({ top, bottom, left: 0, right: 0 });
    },
    // Vuelta al 2D: fuera la capa, los recursos de WebGL, los controles y los gestos de giro; la vista 2D de antes.
    destroy({ restore = true } = {}) {
      loadToken++;
      if (frame !== null) clock.caf(frame);
      clearInterval(ageTimer);
      clearTimeout(goalTimer);
      map.off?.('movestart', onStart); map.off?.('moveend', onEnd); map.off?.('dragstart', onDrag);
      box?.removeEventListener('pointerdown', onDown);
      box?.removeEventListener('pointermove', onMove);
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) box?.removeEventListener(ev, onUp);
      box?.removeEventListener('wheel', onWheel);
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
