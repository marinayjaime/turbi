// Avión 3D del mapa (modo 3D, js/map3d.js): qué avión es, con qué forma y con qué decoración. Sin WebGL: identificación,
// catálogo y geometría (para las pruebas y para quien la necesite).
//
// Catálogo (data/aircraft3d, ver docs/aircraft-3d.md): index.json (nombre de modelo de Turbi → modelo del catálogo;
// decoraciones con sus códigos de operadora y los modelos para los que están hechas), un JSON por modelo (medidas) y uno
// por decoración (colores). Nada se descarga al abrir la app: solo al activar el 3D, y solo el índice, el modelo y la
// decoración de ESE vuelo.
//
// Orden de preferencia (resolveAircraft):
//   1. modelo conocido + decoración de la operadora hecha para ese modelo → 'exact';
//   2. modelo conocido sin decoración válida (operadora sin decoración, no confirmada o decoración no hecha para ese
//      modelo) → 'neutral': el modelo con colores neutros;
//   3. modelo desconocido → 'generic': el avión genérico, gris y rotulado como tal.
// Nunca la decoración de una aerolínea sobre un modelo para el que no está hecha.

const BASE = new URL('../data/aircraft3d/', import.meta.url);
const jsonCache = new Map();
async function getJson(path, fetchFn) {
  if (!jsonCache.has(path)) {
    jsonCache.set(path, fetchFn(new URL(path, BASE)).then(r => (r.ok ? r.json() : null)).catch(() => null)
      .then(v => { if (!v) jsonCache.delete(path); return v; }));
  }
  return jsonCache.get(path);
}
const SAFE_ID = /^[a-z0-9-]{1,32}$/;
export const loadCatalogIndex = (fetchFn = fetch) => getJson('index.json', fetchFn);
export const loadModel = (id, fetchFn = fetch) => (SAFE_ID.test(id ?? '') ? getJson(`models/${id}.json`, fetchFn) : Promise.resolve(null));
export const loadLivery = (id, fetchFn = fetch) => (SAFE_ID.test(id ?? '') ? getJson(`liveries/${id}.json`, fetchFn) : Promise.resolve(null));

// Qué avión es: identifyAircraft (js/aircraft-id.js, que la ficha usa sin cargar este módulo).

// → { modelId, liveryId, level: 'exact' | 'neutral' | 'generic', operator (nombre o null), why }
export function resolveAircraft(index, ident) {
  const modelId = (ident?.model && index?.types?.[ident.model]) || null;
  const entries = Object.entries(index?.liveries ?? {});
  const byIata = ident?.opIata ? entries.find(([, l]) => l.iata?.includes(ident.opIata)) : null;
  const byIcao = ident?.opIcao ? entries.find(([, l]) => l.icao?.includes(ident.opIcao)) : null;
  // Las dos fuentes de operadora, si existen, tienen que señalar la misma decoración; una que no está en el catálogo
  // con la otra sí es otra aerolínea (p. ej. un avión fletado con otro indicativo): sin confirmar.
  const conflict = Boolean(ident?.opIata && ident?.opIcao && byIata?.[0] !== byIcao?.[0]);
  const found = conflict ? null : byIata ?? byIcao;
  if (!modelId) return { modelId: 'generic', liveryId: null, level: 'generic', operator: null, why: ident?.model ? 'modelo-sin-recurso' : 'modelo-desconocido' };
  if (conflict) return { modelId, liveryId: null, level: 'neutral', operator: null, why: 'operadora-sin-confirmar' };
  if (!found) return { modelId, liveryId: null, level: 'neutral', operator: null, why: ident?.opIata || ident?.opIcao ? 'operadora-sin-decoracion' : 'operadora-desconocida' };
  const [liveryId, livery] = found;
  if (!livery.models?.includes(modelId)) return { modelId, liveryId: null, level: 'neutral', operator: livery.name, why: 'decoracion-no-hecha-para-el-modelo' };
  return { modelId, liveryId, level: 'exact', operator: livery.name, why: null };
}

// Decoración neutra (modelo conocido sin la de su operadora) y la del genérico (gris, sin nada de ninguna aerolínea).
export const NEUTRAL_PAINT = { fuselage: '#f4f5f7', belly: { color: '#c9ced6', from: 0.38 }, tail: { color: '#dfe3e8' }, wings: '#c3c8cf', engines: '#d4d8de', winglets: '#dfe3e8' };
// Avión genérico: un bimotor medio que no es ningún modelo concreto. Va en el código (no en el catálogo) para que haya
// avión aunque el catálogo no cargue. Siempre gris y rotulado «Avión genérico».
export const GENERIC_SPEC = { id: 'generic', name: 'Avión genérico', length: 38, span: 35.8, width: 3.76, fuselage: { nose: 0.1, tail: 0.27 },
  wing: { at: 0.38, rootChord: 6, tipChord: 1.25, sweep: 27, dihedral: 6, mount: 'low' },
  tailplane: { span: 14.35, rootChord: 3.6, tipChord: 1.1, sweep: 32, dihedral: 7, mount: 'fuselage' },
  fin: { height: 6.6, rootChord: 6, tipChord: 1.6, sweep: 37 },
  engines: { kind: 'underwing', at: 0.3, length: 4, diameter: 1.9, tucked: true }, winglet: 'none' };
export const GENERIC_PAINT = { fuselage: '#b9c0c9', tail: { color: '#a3abb6' }, wings: '#a9b0ba', engines: '#9aa2ad', winglets: '#a3abb6' };

// ---- Textura de la decoración ----
// Una sola textura por avión, con zonas fijas (las coordenadas UV de buildAircraftGeometry), así cualquier decoración
// sirve a cualquier modelo sin tocar la geometría:
//   v 0–0,5   fuselaje: u = del morro (0) a la cola (1); v = del techo (0) a la panza (0,5), igual a los dos lados;
//   v 0,5–0,75 u 0–0,5 deriva (u: de la raíz a la punta; v: del borde de ataque al de salida); u 0,5–1 alas y estabilizador;
//   v 0,75–1  u 0–0,5 motores (u 0–0,06: la toma de aire, oscura); u 0,5–1 winglets.
export const TEXTURE_SIZE = [512, 256];
export const UV = {
  fuselage: [0, 0, 1, 0.5], fin: [0, 0.5, 0.5, 0.75], wings: [0.5, 0.5, 1, 0.75], engines: [0, 0.75, 0.5, 1], winglets: [0.5, 0.75, 1, 1],
};
export function paintLivery(ctx, paint, [w, h] = TEXTURE_SIZE) {
  const rect = ([u0, v0, u1, v1], color) => { ctx.fillStyle = color; ctx.fillRect(u0 * w, v0 * h, (u1 - u0) * w, (v1 - v0) * h); };
  const [fu0, fv0, fu1, fv1] = UV.fuselage;
  rect(UV.fuselage, paint.fuselage);
  if (paint.belly) rect([fu0, fv0 + (fv1 - fv0) * paint.belly.from * 2, fu1, fv1], paint.belly.color);
  // Ventanillas y cabina: una línea de ventanas a cada lado y el parabrisas (no son de ninguna aerolínea).
  ctx.fillStyle = '#26303b';
  const winV = (fv1 - fv0) * 0.36, step = 0.0105;
  for (let u = 0.16; u < 0.8; u += step) ctx.fillRect(u * w, winV * h, step * w * 0.5, 0.012 * h);
  ctx.fillRect(0.025 * w, (fv1 - fv0) * 0.27 * h, 0.03 * w, 0.03 * h);
  rect(UV.fin, paint.tail.color);
  const [tu0, tv0, tu1, tv1] = UV.fin;
  for (const b of paint.tail.bands ?? []) rect([tu0 + (tu1 - tu0) * b.from, tv0, tu0 + (tu1 - tu0) * b.to, tv1], b.color);
  rect(UV.wings, paint.wings);
  rect(UV.engines, paint.engines);
  const [eu0, ev0, , ev1] = UV.engines;
  rect([eu0, ev0, eu0 + 0.03, ev1], '#3a434e');
  rect(UV.winglets, paint.winglets);
}

// ---- Geometría ----
// Modelo en metros, morro hacia +Y, ala derecha hacia +X, arriba +Z, con el centro del fuselaje en el origen.
// Simplificada (pocas caras, apta para el móvil) con las proporciones del modelo: largo, envergadura, diámetro,
// flecha, posición del ala (baja o alta), motores (bajo el ala, en la cola o turbohélices), cola en T o normal y tipo
// de punta de ala. No es una maqueta exacta ni reproduce la configuración de una matrícula concreta.
class Mesh {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.idx = []; }
  vert(p, n, uv) { this.pos.push(...p); this.nor.push(...n); this.uv.push(...uv); return this.pos.length / 3 - 1; }
  tri(a, b, c) { this.idx.push(a, b, c); }
  // Cuadrilátero plano a-b-c-d con su normal hacia `out` (si se da) o la del orden dado.
  quad(a, b, c, d, uvs, out = null) {
    let n = normalize(cross(sub(b, a), sub(d, a)));
    let order = [a, b, c, d], tex = uvs;
    if (out && dot(n, out) < 0) { n = n.map(x => -x); order = [a, d, c, b]; tex = [uvs[0], uvs[3], uvs[2], uvs[1]]; }
    const i = order.map((p, k) => this.vert(p, n, tex[k]));
    this.tri(i[0], i[1], i[2]); this.tri(i[0], i[2], i[3]);
  }
  build() {
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nor), uvs: new Float32Array(this.uv),
      indices: this.pos.length / 3 > 65535 ? new Uint32Array(this.idx) : new Uint16Array(this.idx) };
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
const lerpUv = ([u0, v0, u1, v1], u, v) => [u0 + (u1 - u0) * u, v0 + (v1 - v0) * v];
const RAD = Math.PI / 180;

// Superficie sustentadora (ala, estabilizador, deriva, winglet): trapecio con espesor, de `root` hacia `sDir` (envergadura
// `span`), cuerda hacia `cDir` (atrás), grosor hacia `tDir`. Flecha del borde de ataque `sweep` (grados).
function surface(m, { root, sDir, cDir, tDir, span, rootChord, tipChord, sweep, thick = 0.11, uv }) {
  const S = 4;
  const rows = [];
  for (let i = 0; i <= S; i++) {
    const f = i / S, chord = rootChord + (tipChord - rootChord) * f;
    const le = add(add(root, mul(sDir, span * f)), mul(cDir, span * f * Math.tan(sweep * RAD)));
    const t = chord * thick * 0.5;
    rows.push({ f, le, te: add(le, mul(cDir, chord)), up: add(add(le, mul(cDir, chord * 0.3)), mul(tDir, t)), dn: add(add(le, mul(cDir, chord * 0.3)), mul(tDir, -t * 0.6)) });
  }
  const neg = mul(tDir, -1);
  for (let i = 0; i < S; i++) {
    const a = rows[i], b = rows[i + 1];
    const uvA = (c) => lerpUv(uv, a.f, c), uvB = (c) => lerpUv(uv, b.f, c);
    m.quad(a.le, b.le, b.up, a.up, [uvA(0), uvB(0), uvB(0.3), uvA(0.3)], tDir);
    m.quad(a.up, b.up, b.te, a.te, [uvA(0.3), uvB(0.3), uvB(1), uvA(1)], tDir);
    m.quad(a.le, b.le, b.dn, a.dn, [uvA(0), uvB(0), uvB(0.3), uvA(0.3)], neg);
    m.quad(a.dn, b.dn, b.te, a.te, [uvA(0.3), uvB(0.3), uvB(1), uvA(1)], neg);
  }
  const tip = rows[S], c = lerpUv(uv, 1, 0.5);
  m.quad(tip.le, tip.up, tip.te, tip.dn, [c, c, c, c], sDir);
  return tip;
}

// Cuerpo de revolución a lo largo de Y (fuselaje, góndolas): `stations` [{ y, r, z }] del morro a la cola, sección
// elíptica (ancho r, alto r·k). UV: u a lo largo, v alrededor (0 arriba, 0,5 abajo, simétrico).
function lathe(m, stations, { x = 0, k = 1, n = 16, uv, capEnd = true }) {
  const ring = [];
  const yMax = stations[0].y, yMin = stations.at(-1).y;
  for (const s of stations) {
    const row = [];
    for (let j = 0; j <= n; j++) {
      const th = -Math.PI + (2 * Math.PI * j) / n;
      const p = [x + s.r * Math.sin(th), s.y, s.z + s.r * k * Math.cos(th)];
      const nn = normalize([Math.sin(th) / 1, 0, Math.cos(th) / k]);
      row.push(m.vert(p, nn, lerpUv(uv, (yMax - s.y) / (yMax - yMin || 1), Math.abs(th) / Math.PI)));
    }
    ring.push(row);
  }
  for (let i = 0; i < ring.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = ring[i][j], b = ring[i][j + 1], c = ring[i + 1][j + 1], d = ring[i + 1][j];
      m.tri(a, d, c); m.tri(a, c, b);
    }
  }
  if (capEnd) {
    const last = stations.at(-1), c = m.vert([x, last.y, last.z], [0, -1, 0], lerpUv(uv, 1, 0.5));
    for (let j = 0; j < n; j++) m.tri(c, ring.at(-1)[j + 1], ring.at(-1)[j]);
  }
}

function nacelle(m, { x, y, z, length, diameter }) {
  const r = diameter / 2;
  lathe(m, [
    { y: y + length / 2, r: r * 0.86, z }, { y: y + length * 0.42, r, z }, { y: y - length * 0.1, r: r * 0.95, z },
    { y: y - length / 2, r: r * 0.55, z },
  ], { x, n: 12, uv: UV.engines });
  // Toma de aire: un disco oscuro (la zona u 0–0,06 de la textura de motores).
  const front = y + length / 2, c = m.vert([x, front, z], [0, 1, 0], lerpUv(UV.engines, 0.01, 0.5));
  const n = 12, ids = [];
  for (let j = 0; j <= n; j++) {
    const th = (2 * Math.PI * j) / n;
    ids.push(m.vert([x + r * 0.86 * Math.sin(th), front, z + r * 0.86 * Math.cos(th)], [0, 1, 0], lerpUv(UV.engines, 0.01, 0.5)));
  }
  for (let j = 0; j < n; j++) m.tri(c, ids[j], ids[j + 1]);
}

export function buildAircraftGeometry(spec) {
  const m = new Mesh();
  const L = spec.length, R = spec.width / 2, half = L / 2;
  const nose = spec.fuselage?.nose ?? 0.1, tailF = spec.fuselage?.tail ?? 0.27;
  // Fuselaje: morro redondeado y algo caído, cuerpo cilíndrico y cono de cola que se estrecha y sube por abajo.
  const stations = [];
  for (const t of [0, 0.004, 0.015, 0.035, 0.06, 0.085, nose, 0.2, 0.35, 0.5, 0.6, 1 - tailF, 1 - tailF * 0.7, 1 - tailF * 0.4, 1 - tailF * 0.15, 1]) {
    let r = R, z = 0;
    if (t < nose) { const s = 1 - t / nose; r = R * Math.sqrt(Math.max(0, 1 - s ** 2.2)); z = -(R - r) * 0.35; }
    if (t > 1 - tailF) { const s = (t - (1 - tailF)) / tailF; r = R * (1 - 0.86 * s ** 1.1); z = (R - r) * 0.82; }
    stations.push({ y: half - t * L, r: Math.max(r, 0.02), z });
  }
  lathe(m, stations, { k: 1.04, n: 18, uv: UV.fuselage });

  // Alas: borde de ataque de la raíz en `wing.at` del largo; baja (por debajo del eje) o alta (encima del fuselaje).
  const w = spec.wing, semi = spec.span / 2, rootY = half - w.at * L;
  const high = w.mount === 'high';
  const wz = high ? R * 0.92 : -R * 0.55;
  const dih = (w.dihedral ?? 0) * RAD;
  const tips = [];
  for (const side of [1, -1]) {
    const sDir = normalize([side * Math.cos(dih), 0, Math.sin(dih)]);
    tips.push({ side, sDir, tip: surface(m, { root: [0, rootY, wz], sDir, cDir: [0, -1, 0], tDir: [0, 0, 1], span: semi / Math.cos(dih),
      rootChord: w.rootChord, tipChord: w.tipChord, sweep: w.sweep, thick: 0.12, uv: UV.wings }) });
  }
  const wingAt = f => ({ y: rootY - semi * f * Math.tan(w.sweep * RAD), z: wz + semi * f * Math.tan(dih), chord: w.rootChord + (w.tipChord - w.rootChord) * f });

  // Puntas de ala.
  for (const { side, tip } of tips) {
    const h = spec.width * 0.6;
    const base = tip.le, chord = Math.hypot(...sub(tip.te, tip.le));
    const wl = (cant, height, sweep, down = false) => surface(m, { root: base, sDir: normalize([side * Math.sin(cant * RAD), 0, (down ? -1 : 1) * Math.cos(cant * RAD)]),
      cDir: [0, -1, 0], tDir: [side, 0, 0], span: height, rootChord: chord * 0.95, tipChord: chord * 0.35, sweep, thick: 0.08, uv: UV.winglets });
    if (spec.winglet === 'sharklet') wl(18, h * 0.62, 42);
    else if (spec.winglet === 'blended') wl(15, h * 0.68, 38);
    else if (spec.winglet === 'split') { wl(15, h * 0.68, 40); wl(35, h * 0.28, 35, true); }
    else if (spec.winglet === 'canted') wl(30, h * 0.4, 40);
    else if (spec.winglet === 'fence') { wl(0, h * 0.22, 30); wl(0, h * 0.14, 30, true); }
  }

  // Motores.
  const e = spec.engines;
  if (e.kind === 'underwing' || e.kind === 'turboprop') {
    for (const side of [1, -1]) {
      const at = wingAt(e.at);
      const x = side * semi * e.at;
      if (e.kind === 'underwing') {
        const z = at.z - e.diameter * (e.tucked ? 0.42 : 0.62);
        const y = at.y + e.length * (e.tucked ? 0.32 : 0.22);
        nacelle(m, { x, y, z, length: e.length, diameter: e.diameter });
        surface(m, { root: [x, y - e.length * 0.05, z + e.diameter * 0.35], sDir: [0, 0, 1], cDir: [0, -1, 0], tDir: [1, 0, 0],
          span: Math.max(0.3, at.z - z - e.diameter * 0.3), rootChord: e.length * 0.7, tipChord: at.chord * 0.6, sweep: -20, thick: 0.1, uv: UV.engines });
      } else {
        // Turbohélice: góndola bajo el ala alta, adelantada; hélice de `blades` palas (fija: no se inventa su giro).
        const z = at.z - e.diameter * 0.3, y = at.y + e.length * 0.25;
        nacelle(m, { x, y, z, length: e.length, diameter: e.diameter });
        const hub = [x, y + e.length / 2 + 0.25, z];
        lathe(m, [{ y: hub[1] + 0.7, r: 0.04, z }, { y: hub[1] + 0.35, r: 0.3, z }, { y: hub[1], r: 0.36, z }], { x, n: 10, uv: UV.engines });
        for (let b = 0; b < (e.blades ?? 6); b++) {
          const th = (2 * Math.PI * b) / (e.blades ?? 6) + 0.3;
          const d = [Math.sin(th), 0, Math.cos(th)], q = [Math.cos(th), 0, -Math.sin(th)];
          const p0 = add(hub, mul(d, 0.3)), p1 = add(hub, mul(d, (e.propeller ?? 3.9) / 2));
          const wB = 0.13, c = lerpUv(UV.engines, 0.01, 0.5);
          m.quad(add(p0, mul(q, wB)), add(p1, mul(q, wB * 0.6)), add(p1, mul(q, -wB * 0.6)), add(p0, mul(q, -wB)), [c, c, c, c], [0, 1, 0]);
          m.quad(add(p0, mul(q, wB)), add(p1, mul(q, wB * 0.6)), add(p1, mul(q, -wB * 0.6)), add(p0, mul(q, -wB)), [c, c, c, c], [0, -1, 0]);
        }
      }
    }
  } else if (e.kind === 'rear') {
    for (const side of [1, -1]) {
      const y = half - e.at * L, x = side * (R + e.diameter * 0.62), z = R * 0.35;
      nacelle(m, { x, y, z, length: e.length, diameter: e.diameter });
      surface(m, { root: [side * R * 0.7, y + e.length * 0.1, z], sDir: [side, 0, 0], cDir: [0, -1, 0], tDir: [0, 0, 1],
        span: Math.abs(x) - R * 0.7 - e.diameter * 0.4, rootChord: e.length * 0.55, tipChord: e.length * 0.5, sweep: 0, thick: 0.12, uv: UV.engines });
    }
  }

  // Deriva sobre el cono de cola y estabilizador (en el fuselaje o en lo alto de la deriva: cola en T).
  // Nada sobresale por detrás del fuselaje: el largo del modelo es el largo total real (la deriva muy inclinada y la cola
  // en T del CRJ adelantan la deriva).
  const f = spec.fin, tp = spec.tailplane, tailEnd = -half;
  const finBack = f.height * Math.tan(f.sweep * RAD);
  const finRootY = tailEnd + Math.max(f.rootChord * 1.08 + L * 0.015, finBack + f.tipChord + 0.1,
    tp.mount === 'fin' ? finBack + f.tipChord * 0.05 + (tp.span / 2) * Math.tan(tp.sweep * RAD) + tp.tipChord + 0.1 : 0);
  const finTip = surface(m, { root: [0, finRootY, R * 0.82], sDir: [0, 0, 1], cDir: [0, -1, 0], tDir: [1, 0, 0], span: f.height,
    rootChord: f.rootChord, tipChord: f.tipChord, sweep: f.sweep, thick: 0.12, uv: UV.fin });
  const tpRoot = tp.mount === 'fin'
    ? [0, finTip.le[1] - f.tipChord * 0.05, finTip.le[2] - 0.05]
    : [0, tailEnd + tp.rootChord * 1.35 + L * 0.01, R * 0.15];
  for (const side of [1, -1]) {
    const d = (tp.dihedral ?? 0) * RAD;
    surface(m, { root: tpRoot, sDir: normalize([side * Math.cos(d), 0, Math.sin(d)]), cDir: [0, -1, 0], tDir: [0, 0, 1],
      span: tp.span / 2, rootChord: tp.rootChord, tipChord: tp.tipChord, sweep: tp.sweep, thick: 0.1, uv: UV.wings });
  }
  return { ...m.build(), length: L };
}
