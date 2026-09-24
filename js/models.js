// Pronóstico de la ruta con ECMWF y GFS por separado, combinación y acuerdo entre modelos.
// Diseño: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §2 y §4
import { LAYERS, PRESSURE_LEVELS } from './altitude.js';
import { layerDiagnostics, componentScores, turbiIndex, pointForecast } from './turbi-index.js';
import { fetchModelLocations, sampleVars } from './weather.js';

export const MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF', meta: 'ecmwf_ifs025', grid: null },
  // gfs_seamless devuelve la coordenada de su rejilla fina (0,11°), pero los datos en altura vienen de la de 0,25°:
  // se ajusta la coordenada para que las distancias de las derivadas sean las reales (revisión del 24/09/2026).
  { id: 'gfs_seamless', label: 'GFS', meta: 'ncep_gfs025', grid: 0.25 },
];

export function snapToGrid(p, grid) {
  if (!grid) return { lat: p.lat, lon: p.lon };
  return { lat: Math.round(p.lat / grid) * grid, lon: Math.round(p.lon / grid) * grid };
}

export const CENTER_VARS = [
  ...PRESSURE_LEVELS.flatMap(p => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `temperature_${p}hPa`]),
  ...[400, 300, 250, 200].map(p => `vertical_velocity_${p}hPa`),
  'cape', 'weather_code', 'wind_speed_700hPa',
];
export const CROSS_VARS = PRESSURE_LEVELS.flatMap(p => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`]);

const HIGH_FL = 200; // a partir de aquí se evalúan las capas en altura
const CROSS_KM = 50;
const MIN_VALID_SHARE = 0.5; // un modelo con menos puntos válidos se descarta
const R_KM = 6371;
const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;

function bearing(a, b) {
  const φ1 = rad(a.lat), φ2 = rad(b.lat), Δλ = rad(b.lon - a.lon);
  return Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ));
}

function destination(p, brg, km) {
  const δ = km / R_KM, φ1 = rad(p.lat), λ1 = rad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(brg));
  const λ2 = λ1 + Math.atan2(Math.sin(brg) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: deg(λ2) };
}

// Vecinos transversales (±50 km perpendiculares a la ruta) solo donde el avión va alto.
// A lo largo de la ruta se reutilizan los puntos anterior y siguiente.
export function planRoute(profile) {
  const pts = profile.points;
  const cross = [];
  pts.forEach((p, i) => {
    if (p.fl < HIGH_FL) return;
    const brg = bearing(pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i + 1)]);
    for (const side of [-1, 1]) cross.push({ i, side, ...destination(p, brg + side * Math.PI / 2, CROSS_KM) });
  });
  return { centers: pts, cross };
}

async function fetchModelRoute(profile, model, fetchFn) {
  const plan = planRoute(profile);
  const { departureMs: t0, arrivalMs: t1 } = profile;
  const [centers, cross] = await Promise.all([
    fetchModelLocations(plan.centers, CENTER_VARS, model.id, t0, t1, fetchFn),
    plan.cross.length ? fetchModelLocations(plan.cross, CROSS_VARS, model.id, t0, t1, fetchFn) : [],
  ]);
  const n = profile.points.length;
  const sample = (loc, t, vars) => { const s = sampleVars(loc, t, vars); return s && { ...s, ...snapToGrid(s, model.grid) }; };
  return profile.points.map((p, i) => {
    const center = sample(centers[i], p.time, CENTER_VARS);
    const neighbours = [];
    if (p.fl >= HIGH_FL) {
      // Todos los vecinos se toman a la hora del punto central.
      for (const j of [i - 1, i + 1]) if (j >= 0 && j < n) neighbours.push(sample(centers[j], p.time, CROSS_VARS));
      plan.cross.forEach((c, k) => { if (c.i === i) neighbours.push(sample(cross[k], p.time, CROSS_VARS)); });
    }
    return { center, neighbours: neighbours.filter(Boolean) };
  });
}

const EMPTY = { score: null, level: null, causes: [], layers: [], components: null, valid: false };

export function analyzeModel(profile, data) {
  return profile.points.map((p, i) => {
    const { center, neighbours } = data[i];
    if (!center) return EMPTY;
    const ctx = { cape: center.cape, weather_code: center.weather_code, elevation: center.elevation, wind700: center.wind_speed_700hPa };
    const low = turbiIndex(componentScores({}, ctx), { fl: p.fl, cape: ctx.cape });
    const layers = p.fl < HIGH_FL ? [] : LAYERS.map(layer => {
      const diag = layerDiagnostics(center, neighbours, layer);
      const components = componentScores(diag, ctx);
      const idx = turbiIndex(components, { fl: layer.midFL, cape: ctx.cape, windMax: diag.windMax });
      return { layer, score: idx.score, level: idx.level, causes: idx.causes, components, diag };
    });
    const pf = pointForecast(layers, p.fl, low);
    const nearest = layers.length
      ? layers.reduce((a, b) => (Math.abs(b.layer.midFL - p.fl) < Math.abs(a.layer.midFL - p.fl) ? b : a))
      : null;
    // Válido solo si hay los datos esenciales: viento en altura arriba, CAPE abajo.
    const valid = pf.score !== null && (nearest ? typeof nearest.diag.vws === 'number' : typeof ctx.cape === 'number');
    return { score: pf.score, level: pf.level, causes: pf.causes, layers, components: nearest?.components ?? low.components, valid };
  });
}

const levelOf = s => (s >= 75 ? 3 : s >= 50 ? 2 : s >= 25 ? 1 : 0);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

// Media del índice de los modelos disponibles (media de conjunto). Causas: primero las del modelo más alto.
export function combineModels(results) {
  const n = results[0].points.length;
  return Array.from({ length: n }, (_, i) => {
    const avail = results.map(r => r.points[i]).filter(p => p.valid).sort((a, b) => b.score - a.score);
    if (!avail.length) return { ...EMPTY };
    const score = Math.round(mean(avail.map(p => p.score)));
    const layers = avail[0].layers.map((l, k) => {
      const scores = avail.map(p => p.layers[k]?.score).filter(s => typeof s === 'number');
      const s = scores.length ? Math.round(mean(scores)) : null;
      return { layer: l.layer, score: s, level: s === null ? null : levelOf(s), causes: l.causes };
    });
    return {
      score, level: levelOf(score),
      causes: [...new Set(avail.flatMap(p => p.causes))].slice(0, 3),
      layers, components: avail[0].components, valid: true,
      byModel: results.map(r => r.points[i].level),
    };
  });
}

export function agreement(a, b) {
  const idx = a.map((_, i) => i).filter(i => a[i].valid && b[i].valid);
  if (!idx.length) return { level: 'no disponible' };
  const la = idx.map(i => a[i].level), lb = idx.map(i => b[i].level);
  const maxA = Math.max(...la), maxB = Math.max(...lb);
  const equal = idx.filter((_, k) => la[k] === lb[k]).length / idx.length;
  const within1 = idx.filter((_, k) => Math.abs(la[k] - lb[k]) <= 1).length / idx.length;
  const level = maxA === maxB && equal >= 0.8 ? 'alta'
    : Math.abs(maxA - maxB) <= 1 && within1 >= 0.8 ? 'media' : 'baja';
  return { level, maxA, maxB, equal, within1 };
}

export async function forecastRoute(profile, fetchFn = fetch) {
  const settled = await Promise.allSettled(MODELS.map(async model => ({
    model, points: analyzeModel(profile, await fetchModelRoute(profile, model, fetchFn)),
  })));
  const ok = settled.filter(s => s.status === 'fulfilled').map(s => s.value)
    .filter(r => r.points.filter(p => p.valid).length / r.points.length >= MIN_VALID_SHARE);
  if (!ok.length) {
    const errors = settled.filter(s => s.status === 'rejected').map(s => s.reason);
    throw errors.find(e => /Demasiadas consultas/.test(e?.message)) ?? errors[0]
      ?? Object.assign(new Error('Los modelos meteorológicos no tienen datos suficientes para esta ruta.'), { retryable: true });
  }
  const points = combineModels(ok.map(r => ({ model: r.model.label, points: r.points })));
  return {
    models: ok.map(r => r.model.label),
    points,
    coverage: points.filter(p => p.valid).length / points.length,
    agreement: ok.length === 2 ? agreement(ok[0].points, ok[1].points) : { level: 'no disponible' },
  };
}

// Hora de inicialización de la última ejecución de cada modelo (meta.json de Open-Meteo).
export async function fetchModelRuns(labels, fetchFn = fetch) {
  const out = {};
  await Promise.all(MODELS.filter(m => labels.includes(m.label)).map(async m => {
    try {
      const res = await fetchFn(`https://api.open-meteo.com/data/${m.meta}/static/meta.json`, { signal: AbortSignal.timeout(8000) });
      const t = res.ok ? (await res.json()).last_run_initialisation_time : null;
      if (typeof t === 'number') out[m.label] = t * 1000;
    } catch { /* sin dato: no se muestra */ }
  }));
  return Object.fromEntries(labels.filter(l => l in out).map(l => [l, out[l]]));
}
