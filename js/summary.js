// Resumen del vuelo, tramos enriquecidos y condiciones por altitud (a partir del pronóstico combinado).
// Diseño: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §6
import { verdict } from './turbulence.js';
import { pointForecast, ALTITUDE_FLS } from './turbi-index.js';

const round10 = x => Math.round(x / 10) * 10;

// Tramos de puntos consecutivos con el mismo nivel. Un punto sin datos cuenta como nulo y marca el tramo.
export function buildSegmentsV2(points, results) {
  const durationMin = points.at(-1).min;
  const step = durationMin / (points.length - 1);
  const groups = [];
  results.forEach((r, i) => {
    const level = r.valid ? r.level : 0;
    const last = groups.at(-1);
    if (last && last.level === level) last.end = i;
    else groups.push({ level, start: i, end: i });
  });

  return groups.map(g => {
    const idx = Array.from({ length: g.end - g.start + 1 }, (_, k) => g.start + k);
    const weight = new Map();
    for (const i of idx) for (const c of results[i].causes ?? []) weight.set(c, (weight.get(c) ?? 0) + (results[i].score ?? 0) + 1);
    const causes = g.level > 0 ? [...weight.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c) : [];
    const fls = idx.map(i => points[i].fl);
    return {
      level: g.level,
      startMin: Math.max(0, Math.round(points[g.start].min - step / 2)),
      endMin: Math.min(durationMin, Math.round(points[g.end].min + step / 2)),
      causes,
      flMin: round10(Math.min(...fls)),
      flMax: round10(Math.max(...fls)),
      mid: points[Math.floor((g.start + g.end) / 2)],
      missing: idx.some(i => !results[i].valid),
    };
  });
}

// % del vuelo por nivel en múltiplos de 5 que suman 100 (mayor resto). Un nivel presente nunca queda en 0 %.
export function percentages(minutesByLevel, durationMin) {
  const raw = minutesByLevel.map(m => (m / durationMin) * 100);
  const out = raw.map(x => Math.floor(x / 5) * 5);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - out[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; out[i] += 5; left -= 5; }
  minutesByLevel.forEach((m, i) => {
    if (m > 0 && out[i] === 0) {
      out[i] = 5;
      const big = out.indexOf(Math.max(...out));
      out[big] -= 5;
    }
  });
  return out;
}

const HEADLINES = { turbulento: 'Turbulento', movimiento: 'Algo de movimiento' };

export function summarize(segments, durationMin) {
  const minutes = [0, 1, 2, 3].map(l => segments.filter(s => s.level === l).reduce((a, s) => a + s.endMin - s.startMin, 0));
  const maxLevel = Math.max(...segments.map(s => s.level));
  const v = verdict(segments, durationMin);
  const headline = HEADLINES[v] ?? (minutes[1] > 0 ? 'Mayormente tranquilo' : 'Tranquilo');
  const top = maxLevel > 0 ? segments.filter(s => s.level === maxLevel) : [];
  return {
    headline,
    verdict: v,
    maxLevel,
    maxDurationMin: top.reduce((a, s) => a + s.endMin - s.startMin, 0),
    moments: top.slice(0, 2).map(s => ({ startMin: s.startMin, endMin: s.endMin })),
    percentages: percentages(minutes, durationMin),
  };
}

// Condiciones por nivel de vuelo durante el crucero: peor nivel y % de puntos con turbulencia.
export function altitudeTable(points, results, cruiseFL, fls = ALTITUDE_FLS) {
  let idx = points.map((p, i) => i).filter(i => points[i].phase === 'cruise' && results[i]?.valid && results[i].layers?.length);
  if (!idx.length) idx = points.map((p, i) => i).filter(i => results[i]?.valid && results[i].layers?.length);
  if (!idx.length) return [];

  const rows = fls.map(fl => {
    const levels = idx.map(i => pointForecast(results[i].layers, fl, null).level).filter(l => l !== null);
    return {
      flightLevel: fl,
      worst: levels.length ? Math.max(...levels) : null,
      share: levels.length ? levels.filter(l => l >= 1).length / levels.length : null,
      isCruise: false,
      calmest: false,
    };
  });
  const nearest = rows.reduce((a, b) => (Math.abs(b.flightLevel - cruiseFL) < Math.abs(a.flightLevel - cruiseFL) ? b : a));
  nearest.isCruise = true;

  const key = r => (r.worst ?? 99) * 10 + (r.share ?? 1);
  const best = Math.min(...rows.map(key));
  if (rows.some(r => key(r) !== best)) rows.forEach(r => { r.calmest = key(r) === best; });
  return rows;
}
