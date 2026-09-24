import { describe, it, expect } from 'vitest';
import { buildSegmentsV2, summarize, percentages, altitudeTable } from '../js/summary.js';
import { LAYERS } from '../js/altitude.js';

// 11 puntos cada 10 min (100 min), con FL y resultado combinado
const pts = (levels, fls = levels.map((_, i) => [0, 150, 300, 360, 360, 360, 360, 360, 300, 150, 0][i])) =>
  levels.map((level, i) => ({ min: i * 10, fl: fls[i], lat: 40, lon: i, kmFromOrigin: i * 60, phase: fls[i] >= 360 ? 'cruise' : i < 5 ? 'climb' : 'descent' }));
const res = (levels, causes = {}) => levels.map((level, i) => ({ level, score: level * 25 + 5, valid: true, causes: causes[i] ?? (level ? ['vertical_shear'] : []) }));

describe('buildSegmentsV2', () => {
  it('tramos con minutos, nivel, causas agregadas y rango de altitud', () => {
    const levels = [0, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0];
    const segs = buildSegmentsV2(pts(levels), res(levels, { 4: ['vertical_shear', 'jet_stream'], 5: ['convection'] }));
    expect(segs.map(s => [s.level, s.startMin, s.endMin])).toEqual([[0, 0, 25], [1, 25, 35], [2, 35, 55], [1, 55, 65], [0, 65, 100]]);
    expect(segs[2]).toMatchObject({ flMin: 360, flMax: 360 });
    expect(segs[2].causes).toEqual(['vertical_shear', 'jet_stream', 'convection']);
    expect(segs[0].causes).toEqual([]);
  });
  it('puntos sin datos cuentan como nula pero se marcan', () => {
    const r = res([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]); r[1] = { level: null, score: null, valid: false, causes: [] };
    const segs = buildSegmentsV2(pts(Array(11).fill(0)), r);
    expect(segs[0].level).toBe(0);
    expect(segs.some(s => s.missing)).toBe(true);
  });
});

describe('percentages', () => {
  it('múltiplos de 5 que suman 100, por el mayor resto', () => {
    expect(percentages([61, 28, 11, 0].map(x => x), 100)).toEqual([60, 30, 10, 0]);
  });
  it('un nivel presente nunca se queda en 0 %', () => {
    const p = percentages([97, 0, 0, 3], 100);
    expect(p[3]).toBe(5);
    expect(p.reduce((a, b) => a + b)).toBe(100);
  });
});

describe('summarize', () => {
  it('máximo, duración y momento de los tramos de nivel máximo', () => {
    const levels = [0, 0, 0, 1, 2, 2, 1, 0, 0, 0, 0];
    const s = summarize(buildSegmentsV2(pts(levels), res(levels)), 100);
    expect(s).toMatchObject({ headline: 'Turbulento', maxLevel: 2, maxDurationMin: 20, moments: [{ startMin: 35, endMin: 55 }] });
    expect(s.percentages).toEqual([60, 20, 20, 0]);
  });
  it('guarda todos los tramos de nivel máximo (la vista decide cuántos enseña)', () => {
    const levels = [0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0];
    const s = summarize(buildSegmentsV2(pts(levels), res(levels)), 100);
    expect(s.moments).toHaveLength(4);
    expect(s.maxDurationMin).toBe(s.moments.reduce((a, m) => a + m.endMin - m.startMin, 0));
  });
  it('sin turbulencia: Tranquilo y sin momentos', () => {
    const s = summarize(buildSegmentsV2(pts(Array(11).fill(0)), res(Array(11).fill(0))), 100);
    expect(s).toMatchObject({ headline: 'Tranquilo', maxLevel: 0, moments: [], percentages: [100, 0, 0, 0] });
  });
  it('poca turbulencia ligera: Mayormente tranquilo', () => {
    const levels = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // último tramo: 95–100 min (5 %)
    expect(summarize(buildSegmentsV2(pts(levels), res(levels)), 100).headline).toBe('Mayormente tranquilo');
  });
});

describe('altitudeTable', () => {
  const layers = scores => scores.map((score, i) => ({ layer: LAYERS[i], score, causes: score >= 25 ? ['vertical_shear'] : [] }));
  const profilePts = [{ fl: 360, phase: 'cruise' }, { fl: 360, phase: 'cruise' }];
  it('peor nivel y % de ruta por FL; destaca la capa más tranquila', () => {
    const results = [{ valid: true, layers: layers([0, 60, 10, 0]) }, { valid: true, layers: layers([0, 30, 10, 0]) }];
    const t = altitudeTable(profilePts, results, 360);
    expect(t.map(r => r.flightLevel)).toEqual([300, 320, 340, 360, 380, 400]);
    const fl320 = t.find(r => r.flightLevel === 320);
    expect(fl320).toMatchObject({ worst: 2, share: 1 });
    expect(t.filter(r => r.calmest).length).toBeGreaterThanOrEqual(1);
    expect(t.find(r => r.calmest).worst).toBe(0);
  });
  it('todas iguales: ninguna destacada', () => {
    const results = [{ valid: true, layers: layers([0, 0, 0, 0]) }];
    expect(altitudeTable(profilePts, results, 360).some(r => r.calmest)).toBe(false);
  });
  it('sin puntos altos: tabla vacía', () => {
    expect(altitudeTable([{ fl: 150, phase: 'climb' }], [{ valid: true, layers: [] }], 240)).toEqual([]);
  });
});
