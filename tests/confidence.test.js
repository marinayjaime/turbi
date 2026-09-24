import { describe, it, expect } from 'vitest';
import { computeConfidence } from '../js/confidence.js';

const NOW = Date.parse('2026-09-24T10:00:00Z');
const h = n => NOW + n * 3600000;
const pt = (level, components = {}) => ({ level, score: level * 25 + 5, valid: true, components });
const calmPts = n => Array.from({ length: n }, () => pt(0));
const base = { nowMs: NOW, models: ['ECMWF', 'GFS'], agreement: { level: 'alta' }, coverage: 1, points: calmPts(10) };

describe('computeConfidence', () => {
  it('ejemplo ALTA: < 24 h, modelos de acuerdo, cobertura completa', () => {
    const c = computeConfidence({ ...base, departureMs: h(5) });
    expect(c.level).toBe('alta');
    expect(c.reasons).toEqual(['faltan menos de 24 h', 'ECMWF y GFS muestran un patrón parecido', 'cobertura meteorológica completa']);
  });
  it('ejemplo BAJA: 4 días, modelos discrepan, puntos sin datos', () => {
    const c = computeConfidence({ ...base, departureMs: h(96), agreement: { level: 'baja' }, coverage: 0.6 });
    expect(c.level).toBe('baja');
    expect(c.reasons).toEqual(['faltan 4 días', 'ECMWF y GFS discrepan', 'varios puntos no tienen todos los datos necesarios']);
  });
  it('con más de 3 días nunca es alta', () => {
    expect(computeConfidence({ ...base, departureMs: h(80) }).level).toBe('media');
  });
  it('más de 7 días: sin cálculo', () => {
    expect(computeConfidence({ ...base, departureMs: h(170) }).level).toBeNull();
  });
  it('un solo modelo', () => {
    const c = computeConfidence({ ...base, departureMs: h(5), models: ['GFS'], agreement: { level: 'no disponible' } });
    expect(c.reasons).toContain('solo hay un modelo disponible (GFS)');
    expect(c.level).toBe('media');
  });
  it('acuerdo medio y cobertura parcial', () => {
    const c = computeConfidence({ ...base, departureMs: h(30), agreement: { level: 'media' }, coverage: 0.8 });
    expect(c.reasons).toEqual(['falta 1 día', 'ECMWF y GFS coinciden solo en parte', 'algunos puntos no tienen todos los datos']);
    expect(c.level).toBe('media');
  });
  it('pronóstico inestable entre puntos vecinos resta', () => {
    const points = [0, 2, 0, 2, 0, 2, 0, 0, 0, 0].map(l => pt(l));
    const c = computeConfidence({ ...base, departureMs: h(5), points });
    expect(c.reasons).toContain('el pronóstico cambia mucho de un punto a otro');
    expect(c.level).toBe('alta'); // 2 + 2 + 1 − 1 = 4
  });
  it('turbulencia moderada apoyada en un solo indicador resta', () => {
    const single = { ellrod: 60, shear: 5, ri: 0, cape: 0, storm: 0, w: 0, mountain: 0 };
    const points = [pt(2, single), pt(2, single), ...calmPts(8)];
    const c = computeConfidence({ ...base, departureMs: h(5), points });
    expect(c.reasons).toContain('los indicadores no coinciden entre sí');
  });
  it('varios indicadores de acuerdo no restan', () => {
    const many = { ellrod: 60, shear: 55, ri: 30, cape: 0, storm: 0, w: 0, mountain: 0 };
    const c = computeConfidence({ ...base, departureMs: h(5), points: [pt(2, many), ...calmPts(9)] });
    expect(c.reasons).not.toContain('los indicadores no coinciden entre sí');
  });
  it('sin porcentajes: solo alta, media o baja', () => {
    const c = computeConfidence({ ...base, departureMs: h(5) });
    expect(Object.keys(c)).toEqual(['level', 'reasons']);
  });
});
