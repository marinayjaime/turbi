// Turbi Index: diagnósticos por capa, escala común 0–100 y combinación por mecanismos.
// Metodología y anclajes: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §3
// No es EDR: es un índice propio y orientativo.
import { LAYERS, pressureToFL } from './altitude.js';

const R_DRY = 287.05; // J/(kg·K)
const G = 9.80665;
const KT_PER_1000FT = 304.8 * 1.94384; // s⁻¹ → kt/1000 ft
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.32;

export const ANCHORS = {
  ellrod: [[0, 0], [4, 25], [8, 50], [12, 75], [16, 100]], // 10⁻⁷ s⁻² (Ellrod & Knapp 1992)
  shear: [[0, 0], [5, 25], [8, 50], [11, 75], [14, 100]], // kt/1000 ft
  riInv: [[-5, 0], [-2, 25], [-1, 50], [-0.5, 75]], // sobre −Ri: Ri ≥ 5 → 0 … Ri ≤ 0,5 → 75 (tope)
  w: [[0, 0], [0.5, 25], [1, 50], [2, 75], [3, 100]], // |w| m/s
  cape: [[0, 0], [500, 25], [1000, 50], [2500, 75], [4000, 100]], // J/kg
  mountain: [[10, 0], [15, 25], [25, 50], [35, 75]], // viento 700 hPa m/s con terreno ≥ 1500 m (tope 75)
};

const CAT_WEIGHTS = { ellrod: 0.5, shear: 0.3, ri: 0.2 };
const JET_MS = 40;
const LOW_FL = 200; // por debajo no hay capas en altura

export const CAUSE_LABELS = {
  clear_air: 'Turbulencia en aire claro',
  vertical_shear: 'Cizalladura vertical',
  instability: 'Capa poco estable',
  vertical_motion: 'Movimiento vertical fuerte',
  convection: 'Nubes convectivas',
  thunderstorm: 'Tormentas',
  mountain_wave: 'Onda de montaña',
  jet_stream: 'Corriente en chorro',
};
const COMPONENT_CAUSE = {
  ellrod: 'clear_air', shear: 'vertical_shear', ri: 'instability', w: 'vertical_motion',
  cape: 'convection', storm: 'thunderstorm', mountain: 'mountain_wave',
};

const isNum = x => typeof x === 'number' && !Number.isNaN(x);

// Escala por tramos lineales entre anclajes [[x, puntuación], …] (x ascendente), saturando en los extremos.
export function anchorScale(x, anchors) {
  if (!isNum(x)) return null;
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return anchors.at(-1)[1];
}

export const scoreToLevel = s => (s === null ? null : s >= 75 ? 3 : s >= 50 ? 2 : s >= 25 ? 1 : 0);

// Gradiente de un campo escalar por mínimos cuadrados (plano v = a + b·x + c·y). x, y en km.
export function gradient(pts) {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  const mv = pts.reduce((s, p) => s + p.v, 0) / n;
  let sxx = 0, syy = 0, sxy = 0, sxv = 0, syv = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my, dv = p.v - mv;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy; sxv += dx * dv; syv += dy * dv;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9 * Math.max(1, sxx * syy)) return null; // puntos colineales
  return { dx: (sxv * syy - syv * sxy) / det, dy: (syv * sxx - sxv * sxy) / det };
}

function windUV(s, p) {
  const speed = s?.[`wind_speed_${p}hPa`], dir = s?.[`wind_direction_${p}hPa`];
  if (!isNum(speed) || !isNum(dir)) return null;
  const r = dir * Math.PI / 180;
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}

// Deformación horizontal total (s⁻¹) en un nivel, con el centro y sus vecinos reales.
function deformationAt(center, neighbours, p) {
  const cosLat = Math.cos(center.lat * Math.PI / 180);
  const pts = [center, ...neighbours].map(s => ({ s, w: windUV(s, p) })).filter(x => x.w)
    .map(({ s, w }) => ({
      x: (s.lon - center.lon) * KM_PER_DEG_LON_EQ * cosLat * 1000,
      y: (s.lat - center.lat) * KM_PER_DEG_LAT * 1000,
      u: w.u, v: w.v,
    }));
  const gu = gradient(pts.map(q => ({ x: q.x, y: q.y, v: q.u })));
  const gv = gradient(pts.map(q => ({ x: q.x, y: q.y, v: q.v })));
  if (!gu || !gv) return null;
  return Math.hypot(gu.dx - gv.dy, gv.dx + gu.dy);
}

export function layerDiagnostics(center, neighbours, layer) {
  const { bottom: pb, top: pt } = layer;
  const vb = windUV(center, pb), vt = windUV(center, pt);
  const tb = center[`temperature_${pb}hPa`], tt = center[`temperature_${pt}hPa`];
  const out = { dz: null, vws: null, shearKt: null, ri: null, def: null, ti1: null, w: null, windMax: null };

  if (isNum(tb) && isNum(tt)) {
    const tbK = tb + 273.15, ttK = tt + 273.15;
    out.dz = (R_DRY * ((tbK + ttK) / 2) / G) * Math.log(pb / pt); // ecuación hipsométrica
    if (vb && vt) {
      out.vws = Math.hypot(vt.u - vb.u, vt.v - vb.v) / out.dz;
      out.shearKt = out.vws * KT_PER_1000FT;
      const thb = tbK * (1000 / pb) ** 0.2857, tht = ttK * (1000 / pt) ** 0.2857;
      const n2 = (G / ((thb + tht) / 2)) * (tht - thb) / out.dz;
      out.ri = out.vws < 1e-6 ? Infinity : n2 / out.vws ** 2;
    }
  }

  const defs = [pb, pt].map(p => deformationAt(center, neighbours, p)).filter(isNum);
  if (defs.length) out.def = defs.reduce((a, b) => a + b, 0) / defs.length;
  if (isNum(out.vws) && isNum(out.def)) out.ti1 = out.vws * out.def * 1e7;

  const ws = [pb, pt].map(p => center[`vertical_velocity_${p}hPa`]).filter(isNum).map(Math.abs);
  if (ws.length) out.w = Math.max(...ws);
  const sp = [pb, pt].map(p => center[`wind_speed_${p}hPa`]).filter(isNum);
  if (sp.length) out.windMax = Math.max(...sp);
  return out;
}

// Cada diagnóstico en la escala común 0–100 (null si falta el dato).
export function componentScores(diag, ctx) {
  const stormScore = !isNum(ctx.weather_code) ? null
    : ctx.weather_code >= 95 ? ([96, 99].includes(ctx.weather_code) ? 90 : 75) : 0;
  const mountain = !isNum(ctx.elevation) || !isNum(ctx.wind700) ? null
    : ctx.elevation >= 1500 ? anchorScale(ctx.wind700, ANCHORS.mountain) : 0;
  return {
    ellrod: anchorScale(diag.ti1, ANCHORS.ellrod),
    shear: anchorScale(diag.shearKt, ANCHORS.shear),
    ri: isNum(diag.ri) || diag.ri === Infinity ? anchorScale(-diag.ri, ANCHORS.riInv) : null,
    w: anchorScale(diag.w, ANCHORS.w),
    // El CAPE es energía potencial: sin chubascos ni tormentas previstas (código WMO < 80) no pasa de ligera.
    cape: isNum(ctx.cape) ? Math.min(anchorScale(ctx.cape, ANCHORS.cape), isNum(ctx.weather_code) && ctx.weather_code >= 80 ? 100 : 49) : null,
    storm: stormScore,
    mountain,
  };
}

const maxOf = xs => (xs.length ? Math.max(...xs) : null);

// Techo convectivo aproximado (FL) según el CAPE de superficie: 1000 J/kg ≈ FL300, 2000 ≈ FL350,
// con tope en la tropopausa típica de latitudes medias (≈ FL400). Heurística documentada.
export function convectiveTopFL(cape) {
  return isNum(cape) ? Math.min(400, 250 + cape / 20) : null;
}

// Fracción de la convección que alcanza un nivel: completa hasta el techo y se desvanece en 50 FL por encima.
function convectiveReach(fl, cape) {
  if (fl < LOW_FL) return 1;
  const top = convectiveTopFL(cape);
  if (top === null) return 0;
  return fl <= top ? 1 : Math.max(0, 1 - (fl - top) / 50);
}

// ctx = { fl, cape (J/kg sin escalar), windMax (m/s) }
export function turbiIndex(c, ctx) {
  // Ri solo refuerza: su peso (0,2) es fijo y nunca se renormaliza ni entra en el suelo «máx − 15»,
  // porque en capas casi neutras sale bajo aunque apenas haya cizalladura.
  const cat = (() => {
    const avail = ['ellrod', 'shear'].filter(k => isNum(c[k]));
    const ri = isNum(c.ri) ? c.ri : null;
    if (!avail.length && ri === null) return null;
    if (!avail.length) return CAT_WEIGHTS.ri * ri;
    const wsum = avail.reduce((s, k) => s + CAT_WEIGHTS[k], 0);
    const base = avail.reduce((s, k) => s + CAT_WEIGHTS[k] * c[k], 0) / wsum;
    const mean = ri === null ? base : (1 - CAT_WEIGHTS.ri) * base + CAT_WEIGHTS.ri * ri;
    return Math.max(mean, Math.max(...avail.map(k => c[k])) - 15);
  })();

  const high = ctx.fl >= LOW_FL;
  const reach = convectiveReach(ctx.fl, ctx.cape);
  const effective = {
    ellrod: c.ellrod, shear: c.shear, ri: c.ri, w: c.w,
    cape: isNum(c.cape) ? c.cape * reach : null,
    storm: isNum(c.storm) ? c.storm * reach : null,
    mountain: isNum(c.mountain) ? c.mountain * (high ? 0.6 : 1) : null,
  };
  const conv = maxOf([effective.cape, effective.storm, effective.w].filter(isNum));
  const mtw = isNum(effective.mountain) ? effective.mountain : null;

  const best = maxOf([cat, conv, mtw].filter(isNum));
  if (best === null) return { score: null, level: null, causes: [], mechanisms: { cat, conv, mtw }, components: c };
  const score = Math.round(best);

  const causes = Object.entries(effective)
    .filter(([, v]) => isNum(v) && v >= 25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => COMPONENT_CAUSE[k]);
  if (isNum(cat) && cat >= 25 && ctx.windMax >= JET_MS) causes.push('jet_stream');

  return { score, level: scoreToLevel(score), causes, mechanisms: { cat, conv, mtw }, components: c };
}

// Resultado en el nivel de vuelo del avión: interpola entre los puntos medios de las capas válidas.
// low = resultado de baja altura (sin capas) para FL < 200.
export function pointForecast(layerResults, fl, low) {
  const empty = { score: null, level: null, causes: [] };
  if (fl < LOW_FL) return low ?? empty;
  const valid = layerResults.filter(l => isNum(l.score)).sort((a, b) => a.layer.midFL - b.layer.midFL);
  if (!valid.length) return empty;

  let score;
  if (fl <= valid[0].layer.midFL) score = valid[0].score;
  else if (fl >= valid.at(-1).layer.midFL) score = valid.at(-1).score;
  else {
    const i = valid.findIndex(l => l.layer.midFL >= fl);
    const a = valid[i - 1], b = valid[i];
    const f = (fl - a.layer.midFL) / (b.layer.midFL - a.layer.midFL);
    score = a.score + f * (b.score - a.score);
  }
  score = Math.round(score);
  const nearest = valid.reduce((a, b) => (Math.abs(b.layer.midFL - fl) < Math.abs(a.layer.midFL - fl) ? b : a));
  const level = scoreToLevel(score);
  return { score, level, causes: level > 0 ? nearest.causes : [] };
}

// Presión ISA (hPa) de un nivel de vuelo: inversa de pressureToFL.
export function flToPressure(fl) {
  const ft = fl * 100;
  return ft <= 36089.24
    ? 1013.25 * (1 - ft / 145366.45) ** (1 / 0.190284)
    : 226.321 * Math.exp(-(ft - 36089.24) / 20805.8);
}

export const ALTITUDE_FLS = [300, 320, 340, 360, 380, 400];

export function altitudeForecast(layerResults, fls = ALTITUDE_FLS) {
  return fls.map(fl => {
    const r = pointForecast(layerResults, fl, null);
    return { flightLevel: fl, pressureLevel: Math.round(flToPressure(fl)), score: r.score, turbulenceLevel: r.level, causes: r.causes };
  });
}

export { LAYERS, pressureToFL };
