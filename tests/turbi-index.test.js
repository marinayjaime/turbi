import { describe, it, expect } from 'vitest';
import {
  anchorScale, gradient, layerDiagnostics, componentScores, turbiIndex, pointForecast, altitudeForecast, flToPressure, CAUSE_LABELS,
} from '../js/turbi-index.js';
import { LAYERS } from '../js/altitude.js';

const R = 287.05, G = 9.80665;

describe('anchorScale', () => {
  const A = [[0, 0], [4, 25], [8, 50], [12, 75], [16, 100]];
  it('interpola linealmente y satura', () => {
    expect(anchorScale(0, A)).toBe(0);
    expect(anchorScale(6, A)).toBe(37.5);
    expect(anchorScale(12, A)).toBe(75);
    expect(anchorScale(40, A)).toBe(100);
    expect(anchorScale(-3, A)).toBe(0);
    expect(anchorScale(null, A)).toBeNull();
    expect(anchorScale(NaN, A)).toBeNull();
  });
});

describe('gradient (plano por mínimos cuadrados)', () => {
  it('recupera el gradiente exacto de un campo lineal con puntos irregulares', () => {
    const f = (x, y) => 3 + 0.002 * x - 0.001 * y;
    const pts = [[0, 0], [51, 2], [-49, -1], [1, 50], [-2, -48]].map(([x, y]) => ({ x, y, v: f(x, y) }));
    const g = gradient(pts);
    expect(g.dx).toBeCloseTo(0.002, 9);
    expect(g.dy).toBeCloseTo(-0.001, 9);
  });
  it('menos de 3 puntos o colineales → null', () => {
    expect(gradient([{ x: 0, y: 0, v: 1 }, { x: 1, y: 0, v: 2 }])).toBeNull();
    expect(gradient([0, 1, 2].map(x => ({ x, y: 0, v: x })))).toBeNull();
  });
});

// Muestra con viento del oeste (dirección 270) de velocidad s en cada nivel.
const sample = (lat, lon, speeds, temps = { 300: -40, 250: -50 }) => {
  const s = { lat, lon };
  for (const p of [400, 300, 250, 200, 150]) {
    s[`wind_speed_${p}hPa`] = speeds[p] ?? 20;
    s[`wind_direction_${p}hPa`] = 270;
    s[`temperature_${p}hPa`] = temps[p] ?? -30;
    s[`vertical_velocity_${p}hPa`] = 0;
  }
  return s;
};

describe('layerDiagnostics (capa 300–250)', () => {
  const layer = LAYERS[1];
  // u crece hacia el este solo a 250 hPa: du/dx = 10 m/s en 2·dx
  const center = sample(40, 0, { 300: 20, 250: 30 });
  const km = x => x / (111.32 * Math.cos(40 * Math.PI / 180)); // km → grados de longitud a 40°N
  const nb = [
    sample(40, km(-50), { 300: 20, 250: 25 }), sample(40, km(50), { 300: 20, 250: 35 }),
    sample(40.45, 0, { 300: 20, 250: 30 }), sample(39.55, 0, { 300: 20, 250: 30 }),
  ];
  const d = layerDiagnostics(center, nb, layer);
  const tMean = (233.15 + 223.15) / 2;
  const dz = (R * tMean / G) * Math.log(300 / 250);
  const vws = 10 / dz;
  const def = (10 / 100000) / 2; // 250 hPa: 1e-4; 300 hPa: 0 → media
  it('grosor hipsométrico, cizalladura, deformación y Ellrod', () => {
    expect(d.dz).toBeCloseTo(dz, 3);
    expect(d.vws).toBeCloseTo(vws, 8);
    expect(d.def).toBeCloseTo(def, 7);
    expect(d.ti1).toBeCloseTo(vws * def * 1e7, 2);
    expect(d.shearKt).toBeCloseTo(vws * 304.8 * 1.94384, 4);
    expect(d.windMax).toBe(30);
  });
  it('Richardson con temperatura potencial', () => {
    const th3 = 233.15 * (1000 / 300) ** 0.2857, th25 = 223.15 * (1000 / 250) ** 0.2857;
    const n2 = (G / ((th3 + th25) / 2)) * (th25 - th3) / dz;
    expect(d.ri).toBeCloseTo(n2 / vws ** 2, 3);
  });
  it('sin vecinos: cizalladura y Ri sí, deformación y Ellrod no', () => {
    const d0 = layerDiagnostics(center, [], layer);
    expect(d0.vws).toBeCloseTo(vws, 8);
    expect(d0.def).toBeNull();
    expect(d0.ti1).toBeNull();
  });
  it('datos nulos en el centro → diagnósticos nulos, sin excepción', () => {
    const c = sample(40, 0, {}); c.wind_speed_250hPa = null; c.temperature_300hPa = null;
    const dn = layerDiagnostics(c, nb, layer);
    expect(dn.vws).toBeNull();
    expect(dn.ri).toBeNull();
    expect(dn.ti1).toBeNull();
  });
  it('sin cizalladura → Ri infinito', () => {
    expect(layerDiagnostics(sample(40, 0, { 300: 20, 250: 20 }), [], layer).ri).toBe(Infinity);
  });
});

describe('componentScores', () => {
  it('anclajes del diseño', () => {
    const c = componentScores({ ti1: 8, shearKt: 5, ri: 1, w: 2, windMax: 45 }, { cape: 1000, weather_code: 95, elevation: 2000, wind700: 25 });
    expect(c).toEqual({ ellrod: 50, shear: 25, ri: 50, w: 75, cape: 50, storm: 75, mountain: 50 });
  });
  it('Ri: grande → 0, negativo (capa inestable) → 75, infinito → 0', () => {
    expect(componentScores({ ri: 10 }, {}).ri).toBe(0);
    expect(componentScores({ ri: -0.2 }, {}).ri).toBe(75);
    expect(componentScores({ ri: Infinity }, {}).ri).toBe(0);
  });
  it('granizo 96/99 → 90; sin tormenta → 0; terreno bajo → sin onda de montaña', () => {
    expect(componentScores({}, { weather_code: 99 }).storm).toBe(90);
    expect(componentScores({}, { weather_code: 3 }).storm).toBe(0);
    expect(componentScores({}, { elevation: 800, wind700: 40 }).mountain).toBe(0);
  });
  it('datos ausentes → null (no 0)', () => {
    const c = componentScores({}, {});
    expect(c.ellrod).toBeNull();
    expect(c.cape).toBeNull();
  });
});

describe('turbiIndex', () => {
  const none = { ellrod: null, shear: null, ri: null, w: null, cape: null, storm: null, mountain: null };
  it('CAT: media ponderada 0,5/0,3/0,2', () => {
    const r = turbiIndex({ ...none, ellrod: 60, shear: 40, ri: 20 }, { fl: 340 });
    expect(r.mechanisms.cat).toBeCloseTo(46, 5);
    expect(r.score).toBe(46);
    expect(r.level).toBe(1);
  });
  it('CAT: una señal muy fuerte no se diluye (máx − 15)', () => {
    const r = turbiIndex({ ...none, ellrod: 90, shear: 0, ri: 0 }, { fl: 340 });
    expect(r.score).toBe(75);
    expect(r.level).toBe(3);
  });
  it('Richardson bajo por sí solo no llega a ligera (solo refuerza)', () => {
    expect(turbiIndex({ ...none, ellrod: 0, shear: 0, ri: 75 }, { fl: 340 }).level).toBe(0);
    expect(turbiIndex({ ...none, ri: 75 }, { fl: 340 }).level).toBeLessThan(2);
  });
  it('CAT con diagnósticos ausentes: renormaliza los pesos', () => {
    expect(turbiIndex({ ...none, shear: 50, ri: 50 }, { fl: 340 }).mechanisms.cat).toBeCloseTo(50, 5);
  });
  it('convección en crucero según alcance del CAPE', () => {
    expect(turbiIndex({ ...none, cape: 50 }, { fl: 360, cape: 1000 }).mechanisms.conv).toBeCloseTo(30, 5);
    expect(turbiIndex({ ...none, cape: 50 }, { fl: 150, cape: 1000 }).mechanisms.conv).toBeCloseTo(50, 5);
    expect(turbiIndex({ ...none, storm: 75, cape: 80 }, { fl: 360, cape: 3000 }).mechanisms.conv).toBeCloseTo(80, 5);
  });
  it('onda de montaña atenuada en crucero', () => {
    expect(turbiIndex({ ...none, mountain: 50 }, { fl: 360 }).mechanisms.mtw).toBeCloseTo(30, 5);
    expect(turbiIndex({ ...none, mountain: 50 }, { fl: 100 }).mechanisms.mtw).toBeCloseTo(50, 5);
  });
  it('mecanismos independientes: gana el máximo; causas ordenadas y chorro', () => {
    const r = turbiIndex({ ...none, ellrod: 70, shear: 60, ri: 10, cape: 20 }, { fl: 340, windMax: 45 });
    expect(r.causes).toEqual(['clear_air', 'vertical_shear', 'jet_stream']);
    expect(r.causes.every(c => CAUSE_LABELS[c])).toBe(true);
  });
  it('sin ningún dato → score null', () => {
    expect(turbiIndex(none, { fl: 340 })).toMatchObject({ score: null, level: null, causes: [] });
  });
  it('niveles: 24→0, 25→1, 50→2, 75→3', () => {
    for (const [v, lvl] of [[24, 0], [25, 1], [50, 2], [75, 3]]) {
      expect(turbiIndex({ ...none, shear: v, ellrod: v, ri: v }, { fl: 340 }).level).toBe(lvl);
    }
  });
});

describe('pointForecast y altitudeForecast', () => {
  // puntuación por capa A, B, C, D
  const layers = [10, 60, 30, 0].map((score, i) => ({ score, level: Math.min(3, Math.floor(score / 25)), causes: score >= 25 ? ['vertical_shear'] : [], layer: LAYERS[i] }));
  it('interpola entre puntos medios de capa y satura en los extremos', () => {
    const mid = (LAYERS[0].midFL + LAYERS[1].midFL) / 2;
    expect(pointForecast(layers, mid, null).score).toBe(35);
    expect(pointForecast(layers, LAYERS[1].midFL, null).score).toBe(60);
    expect(pointForecast(layers, 220, null).score).toBe(10);
    expect(pointForecast(layers, 450, null).score).toBe(0);
  });
  it('nivel nulo → sin causas', () => {
    const quiet = [10, 12, 30, 0].map((score, i) => ({ score, causes: ['instability'], layer: LAYERS[i] }));
    expect(pointForecast(quiet, 320, null)).toMatchObject({ level: 0, causes: [] });
  });
  it('las causas son las de la capa más cercana', () => {
    expect(pointForecast(layers, 325, null).causes).toEqual(['vertical_shear']);
  });
  it('por debajo de FL200 usa el resultado de baja altura', () => {
    const low = { score: 40, level: 1, causes: ['convection'] };
    expect(pointForecast(layers, 120, low)).toMatchObject({ score: 40, causes: ['convection'] });
  });
  it('capas nulas se ignoran en la interpolación', () => {
    const withNull = layers.map((l, i) => (i === 1 ? { ...l, score: null } : l));
    expect(pointForecast(withNull, LAYERS[1].midFL, null).score).not.toBeNull();
  });
  it('altitudeForecast: FL300…FL400 con presión ISA aproximada', () => {
    const a = altitudeForecast(layers);
    expect(a.map(x => x.flightLevel)).toEqual([300, 320, 340, 360, 380, 400]);
    expect(a[0].pressureLevel).toBe(Math.round(flToPressure(300)));
    expect(Math.round(flToPressure(340))).toBe(250);
    expect(a.every(x => [0, 1, 2, 3].includes(x.turbulenceLevel))).toBe(true);
  });
});
