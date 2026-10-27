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
const MAX_PITCH = 85;
export const VIEWS = {
  behind: { label: 'Detrás', offset: 0, pitch: 74 },
  side: { label: 'Lado', offset: 90, pitch: 80 },
  diagonal: { label: 'Diagonal', offset: 40, pitch: 66 },
  top: { label: 'Arriba', offset: 0, pitch: 0 },
};
const FOLLOW_ZOOM = 11;

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
precision mediump float; in vec4 v_col; out vec4 color; void main() { color = v_col; }`;

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

const CONTROLS = `<div class="map3d-ui">
  <p class="map3d-info" aria-live="polite"><span class="map3d-model"></span><span class="map3d-age"></span><span class="map3d-note">Orientado según la trayectoria; inclinación no medida</span></p>
  <div class="map3d-zoom">
    <button type="button" class="map-btn" data-cam="in" aria-label="Acercar">+</button>
    <button type="button" class="map-btn" data-cam="out" aria-label="Alejar">−</button>
    <button type="button" class="map-btn" data-cam="left" aria-label="Girar la cámara a la izquierda">⟲</button>
    <button type="button" class="map-btn" data-cam="right" aria-label="Girar la cámara a la derecha">⟳</button>
  </div>
  <div class="map3d-bar">
    <div class="map3d-views" role="group" aria-label="Perspectiva">${Object.entries(VIEWS).map(([k, v]) => `<button type="button" data-view="${k}">${v.label}</button>`).join('')}</div>
    <button type="button" class="map3d-follow" data-cam="follow" aria-pressed="true">Seguir avión</button>
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
    paintLivery(canvas.getContext('2d'), paint);
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
  const drawLines = (buf, n, mode, matrix, half) => {
    gl.useProgram(lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const at = (name, size, off) => { const l = gl.getAttribLocation(lineProg, name); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 36, off); return l; };
    const ls = [at('a_pos', 3, 0), at('a_off', 2, 12), at('a_col', 4, 20)];
    gl.uniformMatrix4fv(gl.getUniformLocation(lineProg, 'u_matrix'), false, Float32Array.from(matrix));
    gl.uniform1f(gl.getUniformLocation(lineProg, 'u_half'), half);
    gl.drawArrays(mode, 0, n);
    for (const l of ls) gl.disableVertexAttribArray(l);
  };
  let lastScale = 1;
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
        if (trail.curtainN) drawLines(curtainBuf, trail.curtainN, gl.TRIANGLES, m, 0);
        gl.depthMask(true);
        if (trail.ribbonN) drawLines(ribbonBuf, trail.ribbonN, gl.TRIANGLES, m, RIBBON_PX / worldPx);
      }
      if (tip) {
        const m = mult(main, translate(tip.origin[0], tip.origin[1], 0));
        gl.depthMask(false);
        drawLines(tipCurtainBuf, tip.n, gl.TRIANGLES, m, 0);
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
  let shownHeading = null, targetHeading = null, frame = null, lastT = null;
  map.setMaxPitch?.(MAX_PITCH);
  map.dragRotate?.enable?.(); map.touchPitch?.enable?.(); map.touchZoomRotate?.enableRotation?.();
  map.setCenterClampedToGround?.(false);
  // Punto de mira algo por debajo del centro: arriba quedan la etiqueta del avión y los botones.
  const savedPadding = map.getPadding?.() ?? null;
  map.setPadding?.({ top: 110, bottom: 50, left: 0, right: 0 });
  const restoreGestures = () => {
    if (savedPadding) map.setPadding?.(savedPadding);
    map.setCenterClampedToGround?.(true);
    map.dragRotate?.disable?.(); map.touchPitch?.disable?.(); map.touchZoomRotate?.disableRotation?.();
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
  function applyView(key) {
    view = key; offset = VIEWS[key].offset;
    for (const b of panel.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === key));
    const p = state().plane;
    setFollow(true);
    const target = { pitch: VIEWS[key].pitch, bearing: p ? bearingNow() : map.getBearing(), ...(p ? { ...planeCamera(p), zoom: Math.max(map.getZoom(), p ? FOLLOW_ZOOM - 1 : 0) } : {}) };
    if (reduced) { map.jumpTo(target); return; }
    easing = true;
    map.easeTo({ ...target, duration: 700 });
    map.once('moveend', () => { easing = false; followFrame(); });
  }
  // El usuario gira, inclina o acerca: el encuadre elegido pasa a ser ese (sigue siguiendo); si arrastra el mapa, deja de seguir.
  const onStart = e => { if (e?.originalEvent) interacting = true; };
  const onEnd = e => {
    if (!e?.originalEvent && !interacting) return;
    interacting = false;
    if (shownHeading !== null) offset = wrap(map.getBearing() - shownHeading);
    followFrame();
  };
  const onDrag = e => { if (e?.originalEvent) setFollow(false); };
  map.on('movestart', onStart); map.on('moveend', onEnd); map.on('dragstart', onDrag);

  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.view) applyView(b.dataset.view);
    else if (b.dataset.cam === 'follow') { if (follow) setFollow(false); else applyView(view); }
    else if (b.dataset.cam === 'in' || b.dataset.cam === 'out') map.easeTo({ zoom: map.getZoom() + (b.dataset.cam === 'in' ? 1 : -1), duration: reduced ? 0 : 300 });
    else if (b.dataset.cam === 'left' || b.dataset.cam === 'right') {
      const d = b.dataset.cam === 'left' ? -30 : 30;
      offset = wrap(offset + d);
      if (follow && state().plane) followFrame();
      else map.easeTo({ bearing: map.getBearing() + d, duration: reduced ? 0 : 300 });
    }
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
    // Vuelta al 2D: fuera la capa, los recursos de WebGL, los controles y los gestos de giro; la vista 2D de antes.
    destroy({ restore = true } = {}) {
      loadToken++;
      if (frame !== null) clock.caf(frame);
      clearInterval(ageTimer);
      map.off?.('movestart', onStart); map.off?.('moveend', onEnd); map.off?.('dragstart', onDrag);
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
