import { describe, it, expect } from 'vitest';
import { ellrodTI1, scorePoint, buildSegments, verdict, reliability, analyze } from '../js/turbulence.js';

// Muestra neutra: viento flojo, sin cizalladura, sin CAPE, terreno bajo.
function sample(over = {}) {
  return {
    wind_speed_300hPa: 20, wind_direction_300hPa: 270, geopotential_height_300hPa: 9650,
    wind_speed_250hPa: 20, wind_direction_250hPa: 270, geopotential_height_250hPa: 10900,
    wind_speed_700hPa: 5, cape: 0, weather_code: 1, elevation: 100,
    ...over,
  };
}
// Campo sintético: VWS = 10 m/s / 1250 m = 0.008 s⁻¹, DEF = (35-25)/100000 = 1e-4 s⁻¹ → TI1 = 8.
function jetField() {
  return {
    center: sample({ wind_speed_300hPa: 20, wind_speed_250hPa: 30 }),
    n: sample({ wind_speed_250hPa: 30 }),
    s: sample({ wind_speed_250hPa: 30 }),
    e: sample({ wind_speed_250hPa: 35 }),
    w: sample({ wind_speed_250hPa: 25 }),
  };
}
const calm = () => ({ center: sample(), n: sample(), s: sample(), e: sample(), w: sample() });

describe('ellrodTI1', () => {
  it('campo sintético conocido da TI1 = 8', () => {
    expect(ellrodTI1(jetField())).toBeCloseTo(8, 5);
  });
  it('sin cizalladura da 0', () => {
    expect(ellrodTI1(calm())).toBeCloseTo(0, 6);
  });
});

describe('scorePoint', () => {
  it('crucero con TI1 = 8 → moderada por aire claro', () => {
    expect(scorePoint('cruise', jetField())).toEqual({ level: 2, cause: 'ellrod' });
  });
  it('crucero en calma → nula', () => {
    expect(scorePoint('cruise', calm())).toEqual({ level: 0, cause: null });
  });
  it('umbrales de Ellrod con ≥: 4 → ligera, 12 → fuerte', () => {
    const f4 = jetField(); f4.e.wind_speed_250hPa = 32.5; f4.w.wind_speed_250hPa = 27.5; // DEF 5e-5 → TI1 4
    expect(scorePoint('cruise', f4).level).toBe(1);
    const f12 = jetField(); f12.e.wind_speed_250hPa = 37.5; f12.w.wind_speed_250hPa = 22.5; // DEF 1.5e-4 → TI1 12
    expect(scorePoint('cruise', f12).level).toBe(3);
  });
  it('cizalladura: ≥ 5 kt/1000 ft → ligera, ≥ 8 → moderada', () => {
    // kt/1000ft = Δv / Δz × 304.8 × 1.94384. Con Δz = 1250 m: Δv 10.6 m/s ≈ 5.02 kt; Δv 17 m/s ≈ 8.06 kt
    const w1 = calm(); w1.center.wind_speed_250hPa = 30.6;
    expect(scorePoint('cruise', w1)).toEqual({ level: 1, cause: 'shear' });
    const w2 = calm(); w2.center.wind_speed_250hPa = 37;
    expect(scorePoint('cruise', w2)).toEqual({ level: 2, cause: 'shear' });
  });
  it('convección en subida/bajada: CAPE 500 → ligera, 1000 → moderada, tormenta → fuerte', () => {
    expect(scorePoint('climb', { center: sample({ cape: 500 }) })).toEqual({ level: 1, cause: 'convection' });
    expect(scorePoint('descent', { center: sample({ cape: 1000 }) })).toEqual({ level: 2, cause: 'convection' });
    expect(scorePoint('climb', { center: sample({ weather_code: 95 }) })).toEqual({ level: 3, cause: 'convection' });
  });
  it('convección en crucero solo con CAPE > 2000', () => {
    expect(scorePoint('cruise', { ...calm(), center: sample({ cape: 1500 }) }).level).toBe(0);
    expect(scorePoint('cruise', { ...calm(), center: sample({ cape: 2500 }) })).toEqual({ level: 2, cause: 'convection' });
    expect(scorePoint('cruise', { ...calm(), center: sample({ cape: 2500, weather_code: 96 }) })).toEqual({ level: 3, cause: 'convection' });
  });
  it('onda de montaña: terreno ≥ 1500 m y viento 700 hPa ≥ 15 / ≥ 25 m/s', () => {
    expect(scorePoint('climb', { center: sample({ elevation: 2000, wind_speed_700hPa: 15 }) })).toEqual({ level: 1, cause: 'mountain' });
    expect(scorePoint('climb', { center: sample({ elevation: 2000, wind_speed_700hPa: 25 }) })).toEqual({ level: 2, cause: 'mountain' });
    expect(scorePoint('climb', { center: sample({ elevation: 800, wind_speed_700hPa: 30 }) }).level).toBe(0);
  });
  it('un solo dato null en el centro no inventa cizalladura', () => {
    const w = calm(); w.center.wind_speed_250hPa = 40; w.center.wind_speed_300hPa = null;
    expect(scorePoint('cruise', w)).toEqual({ level: 0, cause: null });
    const h = calm(); h.center.wind_speed_250hPa = 40; h.center.geopotential_height_300hPa = null;
    expect(scorePoint('cruise', h)).toEqual({ level: 0, cause: null });
    const d = calm(); d.center.wind_speed_250hPa = 40; d.center.wind_direction_300hPa = null;
    expect(scorePoint('cruise', d)).toEqual({ level: 0, cause: null });
  });
  it('un solo vecino null no inventa aire claro', () => {
    const w = jetField();
    for (const k of ['n', 's', 'e', 'w']) w[k].wind_speed_250hPa = 40;
    w.e.wind_speed_250hPa = null;
    expect(ellrodTI1(w)).toBeNaN();
    expect(scorePoint('cruise', w).cause).not.toBe('ellrod');
  });
  it('datos null no rompen: el indicador vale 0', () => {
    const w = calm();
    for (const k of Object.keys(w.center)) w.center[k] = null;
    w.e.wind_speed_250hPa = null;
    expect(scorePoint('cruise', w)).toEqual({ level: 0, cause: null });
    expect(scorePoint('climb', { center: w.center })).toEqual({ level: 0, cause: null });
  });
});

describe('buildSegments', () => {
  // 11 puntos en 100 min → un punto cada 10 min
  const points = Array.from({ length: 11 }, (_, i) => ({ lat: 40, lon: i, min: i * 10 }));
  const lv = arr => arr.map(level => ({ level, cause: level ? 'ellrod' : null }));

  it('agrupa puntos consecutivos del mismo nivel', () => {
    const segs = buildSegments(points, lv([0, 0, 1, 1, 2, 2, 2, 1, 0, 0, 0]));
    expect(segs.map(s => [s.level, s.startMin, s.endMin])).toEqual([
      [0, 0, 15], [1, 15, 35], [2, 35, 65], [1, 65, 75], [0, 75, 100],
    ]);
    expect(segs[2].cause).toBe('ellrod');
    expect(segs[2].mid).toBe(points[5]);
    expect(segs[0].cause).toBe(null);
  });
  it('la causa del tramo es la más frecuente', () => {
    const scored = [{ level: 1, cause: 'shear' }, { level: 1, cause: 'mountain' }, { level: 1, cause: 'mountain' },
      ...lv([0, 0, 0, 0, 0, 0, 0, 0])];
    expect(buildSegments(points, scored)[0].cause).toBe('mountain');
  });
});

describe('verdict', () => {
  const seg = (level, startMin, endMin) => ({ level, startMin, endMin });
  it('tranquilo: sin moderada y ligera < 10 %', () => {
    expect(verdict([seg(0, 0, 95), seg(1, 95, 100)], 100)).toBe('tranquilo');
  });
  it('movimiento: ligera ≥ 10 %', () => {
    expect(verdict([seg(0, 0, 90), seg(1, 90, 100)], 100)).toBe('movimiento');
  });
  it('movimiento: moderada ≤ 15 min', () => {
    expect(verdict([seg(0, 0, 85), seg(2, 85, 100)], 100)).toBe('movimiento');
  });
  it('turbulento: moderada > 15 min', () => {
    expect(verdict([seg(0, 0, 84), seg(2, 84, 100)], 100)).toBe('turbulento');
  });
  it('turbulento: cualquier tramo fuerte', () => {
    expect(verdict([seg(0, 0, 98), seg(3, 98, 100)], 100)).toBe('turbulento');
  });
});

describe('reliability', () => {
  const now = Date.parse('2026-09-24T10:00:00Z');
  const h = n => now + n * 3600000;
  it('según antelación', () => {
    expect(reliability(h(-1), now)).toBe('alta');
    expect(reliability(h(23), now)).toBe('alta');
    expect(reliability(h(48), now)).toBe('media');
    expect(reliability(h(100), now)).toBe('baja');
    expect(reliability(h(168), now)).toBe('baja');
    expect(reliability(h(169), now)).toBe(null);
  });
});

describe('analyze', () => {
  it('une puntuación, tramos y veredicto', () => {
    const route = {
      durationMin: 20,
      points: [0, 10, 20].map((min, i) => ({ lat: 40, lon: i, min, phase: i === 1 ? 'cruise' : 'climb' })),
    };
    const weather = [{ center: sample() }, jetField(), { center: sample() }];
    const r = analyze(route, weather);
    expect(r.segments.map(s => s.level)).toEqual([0, 2, 0]);
    expect(r.verdict).toBe('movimiento');
  });
});
