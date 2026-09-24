export const LEVELS = ['nula', 'ligera', 'moderada', 'fuerte'];
export const CAUSES = {
  ellrod: 'Aire claro',
  shear: 'Cizalladura',
  convection: 'Tormentas',
  mountain: 'Onda de montaña',
};

const NEIGHBOUR_SPACING_M = 50000;
const M_PER_1000FT = 304.8;
const KT_PER_MS = 1.94384;

// Nivel según umbrales ascendentes (≥). NaN o null → 0.
function byThreshold(x, thresholds) {
  if (x === null || Number.isNaN(x)) return 0;
  return thresholds.reduce((lvl, th, i) => (x >= th ? i + 1 : lvl), 0);
}

// Dirección meteorológica: de dónde viene el viento. Dato ausente → NaN.
function windUV(speed, dirDeg) {
  if (speed === null || dirDeg === null) return { u: NaN, v: NaN };
  const r = dirDeg * Math.PI / 180;
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}

// Cizalladura vertical 300→250 hPa en s⁻¹ (NaN si faltan datos).
function verticalShear(c) {
  const a = windUV(c.wind_speed_300hPa, c.wind_direction_300hPa);
  const b = windUV(c.wind_speed_250hPa, c.wind_direction_250hPa);
  if (c.geopotential_height_250hPa === null || c.geopotential_height_300hPa === null) return NaN;
  const dz = c.geopotential_height_250hPa - c.geopotential_height_300hPa;
  if (!(dz > 0)) return NaN;
  return Math.hypot(b.u - a.u, b.v - a.v) / dz;
}

// Deformación horizontal a 250 hPa en s⁻¹ con vecinos N/S/E/O.
function deformation(w) {
  if (!w.n || !w.s || !w.e || !w.w) return NaN;
  const uv = k => windUV(w[k].wind_speed_250hPa, w[k].wind_direction_250hPa);
  const N = uv('n'), S = uv('s'), E = uv('e'), W = uv('w');
  const d = 2 * NEIGHBOUR_SPACING_M;
  const dudx = (E.u - W.u) / d, dvdx = (E.v - W.v) / d;
  const dudy = (N.u - S.u) / d, dvdy = (N.v - S.v) / d;
  return Math.hypot(dudx - dvdy, dvdx + dudy);
}

export function ellrodTI1(w) {
  return verticalShear(w.center) * deformation(w) * 1e7;
}

export function scorePoint(phase, w) {
  const c = w.center;
  const storm = c.weather_code !== null && c.weather_code >= 95;
  const scores = {};

  if (phase === 'cruise') {
    scores.ellrod = byThreshold(ellrodTI1(w), [4, 8, 12]);
    scores.shear = byThreshold(verticalShear(c) * M_PER_1000FT * KT_PER_MS, [5, 8]);
    scores.convection = c.cape !== null && c.cape > 2000 ? (storm ? 3 : 2) : 0;
  } else {
    scores.convection = storm ? 3 : byThreshold(c.cape, [500, 1000]);
  }
  scores.mountain = c.elevation !== null && c.elevation >= 1500
    ? byThreshold(c.wind_speed_700hPa, [15, 25])
    : 0;

  let level = 0, cause = null;
  for (const [k, v] of Object.entries(scores)) {
    if (v > level) { level = v; cause = k; }
  }
  return { level, cause };
}

export function buildSegments(points, scored) {
  const durationMin = points[points.length - 1].min;
  const step = durationMin / (points.length - 1);
  const groups = [];
  scored.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && last.level === s.level) last.endIdx = i;
    else groups.push({ level: s.level, startIdx: i, endIdx: i, causes: {} });
    const g = groups[groups.length - 1];
    if (s.cause) g.causes[s.cause] = (g.causes[s.cause] || 0) + 1;
  });

  return groups.map(g => {
    const top = Object.entries(g.causes).sort((a, b) => b[1] - a[1])[0];
    return {
      level: g.level,
      startMin: Math.max(0, Math.round(points[g.startIdx].min - step / 2)),
      endMin: Math.min(durationMin, Math.round(points[g.endIdx].min + step / 2)),
      cause: top ? top[0] : null,
      mid: points[Math.floor((g.startIdx + g.endIdx) / 2)],
    };
  });
}

export function verdict(segments, durationMin) {
  const minutesAt = lvl => segments
    .filter(s => s.level === lvl)
    .reduce((acc, s) => acc + (s.endMin - s.startMin), 0);
  if (segments.some(s => s.level === 3) || minutesAt(2) > 15) return 'turbulento';
  if (minutesAt(2) === 0 && minutesAt(1) < 0.1 * durationMin) return 'tranquilo';
  return 'movimiento';
}

export function reliability(departureMs, nowMs) {
  const hours = (departureMs - nowMs) / 3600000;
  if (hours > 168) return null;
  if (hours > 72) return 'baja';
  if (hours >= 24) return 'media';
  return 'alta';
}

export function analyze(route, weather) {
  const scored = route.points.map((p, i) => scorePoint(p.phase, weather[i]));
  const segments = buildSegments(route.points, scored);
  return { segments, verdict: verdict(segments, route.durationMin) };
}
