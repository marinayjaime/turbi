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
    expect(c.reasons).toEqual(['faltan menos de 24 h', 'los dos modelos del tiempo (europeo y estadounidense) prevén algo parecido', 'hay datos del tiempo de toda la ruta']);
  });
  it('ejemplo BAJA: 4 días, modelos discrepan, puntos sin datos', () => {
    const c = computeConfidence({ ...base, departureMs: h(96), agreement: { level: 'baja' }, coverage: 0.6 });
    expect(c.level).toBe('baja');
    expect(c.reasons).toEqual(['faltan 4 días', 'los dos modelos del tiempo no coinciden', 'faltan datos del tiempo en bastantes tramos']);
  });
  it('con más de 3 días nunca es alta', () => {
    expect(computeConfidence({ ...base, departureMs: h(80) }).level).toBe('media');
  });
  it('más de 7 días: sin cálculo', () => {
    expect(computeConfidence({ ...base, departureMs: h(170) }).level).toBeNull();
  });
  it('un solo modelo', () => {
    const c = computeConfidence({ ...base, departureMs: h(5), models: ['GFS'], agreement: { level: 'no disponible' } });
    expect(c.reasons).toContain('solo se ha podido consultar un modelo del tiempo (GFS)');
    expect(c.level).toBe('media');
  });
  it('acuerdo medio y cobertura parcial', () => {
    const c = computeConfidence({ ...base, departureMs: h(30), agreement: { level: 'media' }, coverage: 0.8 });
    expect(c.reasons).toEqual(['falta 1 día', 'los dos modelos del tiempo coinciden solo en parte', 'faltan datos del tiempo en algún tramo']);
    expect(c.level).toBe('media');
  });
  it('pronóstico inestable entre puntos vecinos resta', () => {
    const points = [0, 2, 0, 2, 0, 2, 0, 0, 0, 0].map(l => pt(l));
    const c = computeConfidence({ ...base, departureMs: h(5), points });
    expect(c.reasons).toContain('la previsión cambia mucho de un tramo a otro');
    expect(c.level).toBe('alta'); // 2 + 2 + 1 − 1 = 4
  });
  it('turbulencia moderada apoyada en un solo indicador resta', () => {
    const single = { ellrod: 60, shear: 5, ri: 0, cape: 0, storm: 0, w: 0, mountain: 0 };
    const points = [pt(2, single), pt(2, single), ...calmPts(8)];
    const c = computeConfidence({ ...base, departureMs: h(5), points });
    expect(c.reasons).toContain('las distintas señales de turbulencia no coinciden entre sí');
  });
  it('varios indicadores de acuerdo no restan', () => {
    const many = { ellrod: 60, shear: 55, ri: 30, cape: 0, storm: 0, w: 0, mountain: 0 };
    const c = computeConfidence({ ...base, departureMs: h(5), points: [pt(2, many), ...calmPts(9)] });
    expect(c.reasons).not.toContain('las distintas señales de turbulencia no coinciden entre sí');
  });
  it('sin porcentajes: solo alta, media o baja', () => {
    const c = computeConfidence({ ...base, departureMs: h(5) });
    expect(Object.keys(c)).toEqual(['level', 'reasons']);
  });
});
