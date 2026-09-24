import { describe, it, expect } from 'vitest';
import { distanceKm, buildRoute } from '../js/route.js';

const PMI = { lat: 39.5517, lon: 2.7388 };
const BCN = { lat: 41.2971, lon: 2.0785 };
const MAD = { lat: 40.4719, lon: -3.5626 };
const DEP = Date.parse('2026-09-25T05:15:00Z');

describe('distanceKm', () => {
  it('PMI–BCN ≈ 200 km', () => {
    const d = distanceKm(PMI, BCN);
    expect(d).toBeGreaterThan(195);
    expect(d).toBeLessThan(210);
  });
  it('es simétrica y 0 para el mismo punto', () => {
    expect(distanceKm(PMI, MAD)).toBeCloseTo(distanceKm(MAD, PMI), 6);
    expect(distanceKm(PMI, PMI)).toBe(0);
  });
});

describe('buildRoute', () => {
  it('vuelo corto PMI–BCN: 45 min, mínimo 10 puntos, reparto 40/20/40', () => {
    const r = buildRoute(PMI, BCN, DEP);
    expect(r.durationMin).toBe(45);
    expect(r.points.length).toBe(10);
    expect(r.arrivalMs).toBe(DEP + 45 * 60000);
    expect(r.points[0]).toMatchObject({ lat: PMI.lat, min: 0, time: DEP, phase: 'climb', kmFromOrigin: 0 });
    expect(r.points[9].lat).toBeCloseTo(BCN.lat, 4);
    expect(r.points[9].phase).toBe('descent');
    const phases = r.points.map(p => p.phase);
    expect(phases).toContain('cruise');
    // climb < 18 min, descent > 27 min
    for (const p of r.points) {
      if (p.min < 18) expect(p.phase).toBe('climb');
      else if (p.min > 27) expect(p.phase).toBe('descent');
      else expect(p.phase).toBe('cruise');
    }
  });

  it('vuelo largo PMI–MAD: un punto cada ~50 km, subida 20 min y bajada 25 min', () => {
    const r = buildRoute(PMI, MAD, DEP);
    expect(r.durationMin).toBeGreaterThanOrEqual(60);
    expect(r.points.length).toBe(Math.max(10, Math.round(r.km / 50) + 1));
    for (const p of r.points) {
      if (p.min < 20) expect(p.phase).toBe('climb');
      else if (p.min > r.durationMin - 25) expect(p.phase).toBe('descent');
      else expect(p.phase).toBe('cruise');
    }
  });

  it('usa la duración real si se la dan (horario de Aena)', () => {
    const r = buildRoute(PMI, MAD, DEP, 90);
    expect(r.durationMin).toBe(90);
    expect(r.arrivalMs).toBe(DEP + 90 * 60000);
    expect(r.points.at(-1).min).toBe(90);
    // duración absurda (≤ 0) → se ignora y se estima
    expect(buildRoute(PMI, MAD, DEP, 0).durationMin).toBe(buildRoute(PMI, MAD, DEP).durationMin);
  });

  it('vuelos largos: como máximo 40 puntos (cupo de Open-Meteo)', () => {
    const FRA = { lat: 50.0333, lon: 8.5706 }, JFK = { lat: 40.6398, lon: -73.7789 };
    expect(buildRoute(FRA, JFK, DEP).points.length).toBe(40);
  });

  it('lanza error si origen y destino coinciden', () => {
    expect(() => buildRoute(PMI, PMI, DEP)).toThrow('Origen y destino son el mismo aeropuerto');
  });
});
