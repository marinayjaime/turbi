// Tiempo en el aire para el pronóstico (js/airtime.js): la física de js/eta.js y el encaje dentro del bloque.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { airMinutesForKm, forecastWindow, MIN_GROUND_MIN } from '../js/airtime.js';
import { distanceKm } from '../js/route.js';
import { buildProfile } from '../js/altitude.js';

const A = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const ap = c => ({ lat: A[c][2], lon: A[c][3] });
const km = (o, d) => distanceKm(ap(o), ap(d));
const T = Date.parse('2026-09-28T13:45:00Z'); // 15:45 en Madrid
const MIN = 60000;

describe('duración en el aire (misma física que la ETA en vuelo)', () => {
  it('MAD → PMI: ≈ 55 min a partir de la distancia (sin valores fijados para la ruta)', () => {
    expect(airMinutesForKm(km('MAD', 'PMI'))).toBeGreaterThan(53);
    expect(airMinutesForKm(km('MAD', 'PMI'))).toBeLessThan(58);
  });
});

describe('forecastWindow: ventana en el aire dentro del horario de bloque', () => {
  it('bloque de 85 min (IB1667 MAD → PMI simulado): ≈ 55 min en el aire, centrado (≈ 15 min de tierra a cada lado)', () => {
    const w = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN });
    expect(w.blockDurationMin).toBe(85);
    expect(w.forecastAirborneMin).toBeGreaterThanOrEqual(54.5); // ≈ 55
    expect(w.forecastAirborneMin).toBeLessThanOrEqual(60);
    const before = (w.forecastTakeoffMs - T) / MIN, after = (T + 85 * MIN - w.forecastLandingMs) / MIN;
    expect(before).toBeCloseTo(after, 5);
    expect(before).toBeGreaterThan(12);
    expect(w.source).toBe('estimada');
  });
  it('vuelo corto con bloque de 85 min → perfil sensiblemente menor que el bloque', () => {
    const w = forecastWindow({ km: km('MAD', 'VLC'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN });
    expect(w.forecastAirborneMin).toBeLessThan(85 * 0.75);
  });
  it('límite: el aire nunca supera el bloque menos el rodaje mínimo (estimación mayor que el bloque)', () => {
    const w = forecastWindow({ km: 2500, blockDepartureMs: T, blockArrivalMs: T + 150 * MIN }); // estimado ≈ 208 min
    expect(w.forecastAirborneMin).toBe(150 - MIN_GROUND_MIN);
    expect(w.forecastTakeoffMs).toBe(T + (MIN_GROUND_MIN / 2) * MIN);
  });
  it('bloque muy corto: el aire no baja del 60 % del bloque', () => {
    const w = forecastWindow({ km: 400, blockDepartureMs: T, blockArrivalMs: T + 20 * MIN }); // 20 − 10 < 12
    expect(w.forecastAirborneMin).toBe(12);
  });
  it('AeroDataBox con pista de salida y de llegada: despegue y aterrizaje reales, duración = su diferencia', () => {
    const w = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN,
      runwayDepartureMs: T + 18 * MIN, runwayArrivalMs: T + 71 * MIN });
    expect(w).toMatchObject({ forecastTakeoffMs: T + 18 * MIN, forecastAirborneMin: 53, forecastLandingMs: T + 71 * MIN, source: 'pista' });
  });
  it('solo pista de salida: despegue real y aire estimado, sin pasar de la llegada de bloque', () => {
    const w = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 60 * MIN, runwayDepartureMs: T + 20 * MIN });
    expect(w).toMatchObject({ forecastTakeoffMs: T + 20 * MIN, forecastAirborneMin: 40, source: 'pista-salida' });
  });
  it('minutos enteros (los tramos del pronóstico se muestran en minutos: nunca «34–54.855…»)', () => {
    for (const k of [120, 547, 1234, 5000]) expect(Number.isInteger(forecastWindow({ km: k, blockDepartureMs: T, blockArrivalMs: T + 333 * MIN }).forecastAirborneMin)).toBe(true);
  });
  it('AeroDataBox sin pista: la misma estimación que Aena', () => {
    const a = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN });
    const b = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN, runwayDepartureMs: null, runwayArrivalMs: null });
    expect(b).toEqual(a);
  });
  it('perfil vertical sobre la ventana en el aire: alcanza el crucero y sus fases y FL se reparten en ≈ 55 min, no en 85', () => {
    const w = forecastWindow({ km: km('MAD', 'PMI'), blockDepartureMs: T, blockArrivalMs: T + 85 * MIN });
    const air = buildProfile(ap('MAD'), ap('PMI'), w.forecastTakeoffMs, w.forecastAirborneMin);
    const block = buildProfile(ap('MAD'), ap('PMI'), T, 85);
    expect(air.points.at(-1).min).toBeCloseTo(w.forecastAirborneMin, 5);
    expect(Math.max(...air.points.map(p => p.fl))).toBe(air.cruiseFL); // llega al nivel de crucero
    const cruiseShare = p => p.points.filter(x => x.phase === 'cruise').length / p.points.length;
    expect(cruiseShare(air)).toBeLessThan(cruiseShare(block)); // menos crucero: ascenso y descenso pesan más
    expect(air.points[0].time).toBe(w.forecastTakeoffMs);
    expect(air.arrivalMs).toBe(w.forecastLandingMs);
  });
});
