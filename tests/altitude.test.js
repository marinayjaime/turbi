import { describe, it, expect } from 'vitest';
import { pressureToFL, cruiseFL, flightLevelAt, phaseAt, buildProfile, LAYERS } from '../js/altitude.js';

const PMI = { lat: 39.5517, lon: 2.7388 };
const BCN = { lat: 41.2971, lon: 2.0785 };
const MAD = { lat: 40.4719, lon: -3.5626 };
const JFK = { lat: 40.6398, lon: -73.7789 };
const DEP = Date.parse('2026-09-25T05:15:00Z');

describe('pressureToFL (atmósfera estándar)', () => {
  it('corresponde con la tabla ISA', () => {
    expect(Math.round(pressureToFL(400))).toBe(236);
    expect(Math.round(pressureToFL(300))).toBe(301);
    expect(Math.round(pressureToFL(250))).toBe(340);
    expect(Math.round(pressureToFL(200))).toBe(387);
    expect(Math.round(pressureToFL(150))).toBe(446);
    expect(Math.round(pressureToFL(1013.25))).toBe(0);
  });
});

describe('LAYERS', () => {
  it('cuatro capas comunes a ECMWF y GFS, con su punto medio en FL', () => {
    expect(LAYERS.map(l => [l.bottom, l.top])).toEqual([[400, 300], [300, 250], [250, 200], [200, 150]]);
    expect(LAYERS.map(l => Math.round(l.midFL))).toEqual([268, 320, 363, 417]);
  });
});

describe('cruiseFL', () => {
  it('según distancia, con suelo FL150 y techo por radio', () => {
    expect(cruiseFL(200)).toBe(240);
    expect(cruiseFL(550)).toBe(360);
    expect(cruiseFL(1250)).toBe(370);
    expect(cruiseFL(6200)).toBe(380);
    expect(cruiseFL(50)).toBe(150);
  });
});

describe('flightLevelAt y phaseAt', () => {
  it('rampas de 2000 ft/min subiendo y 1500 bajando', () => {
    expect(flightLevelAt(0, 90, 360)).toBe(0);
    expect(flightLevelAt(9, 90, 360)).toBe(180);
    expect(flightLevelAt(18, 90, 360)).toBe(360);
    expect(flightLevelAt(50, 90, 360)).toBe(360);
    expect(flightLevelAt(84, 90, 360)).toBe(90);
    expect(flightLevelAt(90, 90, 360)).toBe(0);
    expect(phaseAt(9, 90, 360)).toBe('climb');
    expect(phaseAt(50, 90, 360)).toBe('cruise');
    expect(phaseAt(84, 90, 360)).toBe('descent');
  });
  it('vuelo muy corto: perfil triangular sin llegar al crucero', () => {
    const peak = Math.max(...Array.from({ length: 26 }, (_, t) => flightLevelAt(t, 25, 240)));
    expect(peak).toBeLessThan(240);
    expect(phaseAt(5, 25, 240)).toBe('climb');
    expect(phaseAt(20, 25, 240)).toBe('descent');
  });
});

describe('buildProfile', () => {
  it('PMI–MAD: puntos cada ~60 km (mín. 8), con nivel de vuelo y fase', () => {
    const r = buildProfile(PMI, MAD, DEP, 90);
    expect(r.cruiseFL).toBe(360);
    expect(r.durationMin).toBe(90);
    expect(r.points.length).toBe(Math.min(30, Math.max(8, Math.round(r.km / 60) + 1)));
    expect(r.points[0]).toMatchObject({ lat: PMI.lat, min: 0, time: DEP, fl: 0, phase: 'climb' });
    expect(r.points.at(-1).fl).toBe(0);
    expect(r.points.some(p => p.phase === 'cruise' && p.fl === 360)).toBe(true);
  });
  it('sin duración real, la estima igual que la v1', () => {
    expect(buildProfile(PMI, BCN, DEP).durationMin).toBe(45);
  });
  it('largo radio: como mucho 30 puntos', () => {
    expect(buildProfile(PMI, JFK, DEP).points.length).toBe(30);
  });
  it('mismo aeropuerto → error', () => {
    expect(() => buildProfile(PMI, PMI, DEP)).toThrow('Origen y destino son el mismo aeropuerto');
  });
});
