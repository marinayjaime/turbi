// Ficha completa también en vuelos del histórico e internacionales: horas (oficial > ETA en vuelo guardada >
// estimación por la duración de la ruta) y foto (exacta > de la aerolínea del número > representativa de la aerolínea).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { turbiEstimate, etaSide, departureUtcMs, departureEstimate, ROUTE_NOTE } from '../js/eta.js';
import { legFromHistory } from '../js/punctuality.js';
import { photoFor } from '../js/airline-photos.js';
import { buildRoute } from '../js/route.js';
import { legArrival } from '../js/schedule.js';
import { localToUtcMs } from '../js/time.js';
import { presentStatus } from '../js/radar.js';

const MAD = 'Europe/Madrid';
const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const photos = JSON.parse(readFileSync('data/airline-photos.json', 'utf8'));
const apt = iata => ({ lat: airports[iata][2], lon: airports[iata][3] });
const routeMin = (o, a) => buildRoute(apt(o), apt(a), 0).durationMin; // la misma duración estimada que usa la app
const now = localToUtcMs('2026-09-25', '12:00', MAD);

// Ficha (sin la app): llegada visible y salida visible con las mismas funciones que usa la app.
function card(leg, al, { oTz = MAD, dTz, prev = null } = {}) {
  const plannedMin = routeMin(leg.o, leg.a);
  const official = legArrival(leg);
  const arrivalUtc = official ? localToUtcMs(official.date, official.time, dTz) : null;
  const depUtcMs = departureUtcMs(leg, oTz) ?? (arrivalUtc !== null ? arrivalUtc - plannedMin * 60000 : null);
  const eta = turbiEstimate({ leg, depUtcMs, plannedMin, tz: dTz, nowMs: now, prev });
  return {
    arrival: official ? { ...official, official: true } : etaSide(eta),
    departure: departureEstimate({ leg, arrivalUtcMs: arrivalUtc, plannedMin, tz: oTz }),
    photo: photoFor(photos, leg, al),
  };
}

describe('regresión EI737 del 24/09 (fila real del histórico; sin lógica especial)', () => {
  const leg = legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '20:55', 17, null, null, 0, null, null]);
  const c = card(leg, 'EI', { dTz: 'Europe/Dublin' });
  it('salida final de Aena guardada: 21:12 (20:55 + 17)', () => {
    expect(leg).toMatchObject({ sd: '20:55', ed: '2026-09-24T21:12' });
    expect(c.departure).toBeNull(); // la salida es de Aena: la ficha la muestra tal cual
  });
  it('llegada estimada retrospectivamente: 21:12 Palma + 157 min (PMI–DUB) = 22:49 Dublín → 22:50, rotulada', () => {
    expect(routeMin('PMI', 'DUB')).toBe(157);
    expect(c.arrival).toEqual({ date: '2026-09-24', time: '22:50', estimated: true, note: ROUTE_NOTE });
  });
  it('estado: «Aterrizado» estimado (estimated-landed), varias horas después de la llegada estimada visible', () => {
    const arrivalMs = localToUtcMs(c.arrival.date, c.arrival.time, 'Europe/Dublin');
    expect(presentStatus({ leg, city: 'Dublin', visibleArrivalMs: arrivalMs, arrivalSource: 'turbi', nowMs: now }))
      .toEqual({ text: 'Aterrizado', tone: 'ok', note: 'Según la llegada estimada por Turbi', landing: 'estimated-landed' });
  });
  it('foto verificada de Aer Lingus, representativa (el histórico no conserva el modelo)', () => {
    expect(c.photo).toMatchObject({ representative: true, shared: true });
    expect(Object.keys(photos.photos).find(k => photos.photos[k]?.thumb === c.photo.thumb)).toMatch(/^EI\|/);
  });
});

describe('horas del histórico: jerarquía y etiquetas', () => {
  it('internacional con salida pero sin llegada → llegada estimada (salida final + duración)', () => {
    const leg = legFromHistory({ o: 'MAD', a: 'LHR' }, ['2026-09-24', '10:00', 25, null, null, 0, 'A21N', 'IB']);
    const c = card(leg, 'IB', { dTz: 'Europe/London' });
    const expected = localToUtcMs('2026-09-24', '10:25', MAD) + routeMin('MAD', 'LHR') * 60000;
    expect(c.arrival).toMatchObject({ estimated: true, note: ROUTE_NOTE });
    expect(localToUtcMs(c.arrival.date, c.arrival.time, 'Europe/London')).toBe(Math.round(expected / 300000) * 300000);
  });
  it('con llegada pero sin salida (origen extranjero) → salida estimada = llegada − duración, en hora del origen', () => {
    const leg = legFromHistory({ o: 'LHR', a: 'PMI' }, ['2026-09-24', null, null, '12:00', 10, 0, null, null]);
    const c = card(leg, 'FR', { oTz: 'Europe/London', dTz: MAD });
    expect(c.arrival).toMatchObject({ date: '2026-09-24', time: '12:10', official: true });
    const dep = localToUtcMs('2026-09-24', '12:10', MAD) - routeMin('LHR', 'PMI') * 60000;
    expect(c.departure).toMatchObject({ estimated: true, note: ROUTE_NOTE });
    expect(localToUtcMs(c.departure.date, c.departure.time, 'Europe/London')).toBe(Math.round(dep / 300000) * 300000);
  });
  it('se usa la salida final de Aena antes que la programada', () => {
    const final = legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '20:55', 40, null, null, 0, null, null]);
    expect(departureUtcMs(final, MAD)).toBe(localToUtcMs('2026-09-24', '21:35', MAD));
    const sched = { d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: null, st: 'SCH', std: 'SCH' };
    expect(departureUtcMs(sched, MAD)).toBe(localToUtcMs('2026-09-24', '20:55', MAD));
  });
  it('la ETA registrada durante el vuelo tiene prioridad sobre el cálculo retrospectivo', () => {
    const leg = legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '20:55', 17, null, null, 0, null, null]);
    const prev = { ms: localToUtcMs('2026-09-24', '23:40', MAD), at: now - 10 * 3600000, method: 'estimated-inflight' };
    expect(card(leg, 'EI', { dTz: 'Europe/Dublin', prev }).arrival).toMatchObject({ time: '22:40', note: expect.stringMatching(/^Última estimación Turbi/) });
  });
  it('Aena manda siempre sobre cualquier cálculo de Turbi', () => {
    const leg = legFromHistory({ o: 'PMI', a: 'MAD' }, ['2026-09-24', '17:55', 49, '19:25', 45, 0, 'A21N', null]);
    const prev = { ms: 0, at: now, method: 'estimated-inflight' };
    expect(card(leg, 'IB', { dTz: MAD, prev }).arrival).toEqual({ date: '2026-09-24', time: '20:10', official: true });
    expect(card(leg, 'IB', { dTz: MAD, prev }).departure).toBeNull();
  });
  it('cambio de zona horaria (PMI → JFK) y llegada al día siguiente', () => {
    const jfk = legFromHistory({ o: 'PMI', a: 'JFK' }, ['2026-09-24', '14:00', 0, null, null, 0, null, null]);
    const c = card(jfk, 'UX', { dTz: 'America/New_York' });
    const exp = localToUtcMs('2026-09-24', '14:00', MAD) + routeMin('PMI', 'JFK') * 60000;
    expect(localToUtcMs(c.arrival.date, c.arrival.time, 'America/New_York')).toBe(Math.round(exp / 300000) * 300000);
    expect(c.arrival.time < '20:00').toBe(true); // hora de Nueva York, no de Palma
    const night = legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '23:40', 0, null, null, 0, null, null]);
    expect(card(night, 'EI', { dTz: 'Europe/Dublin' }).arrival.date).toBe('2026-09-25');
  });
  it('cancelado o desviado: sin llegada estimada', () => {
    expect(card(legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '20:55', null, null, null, 1, null, null]), 'EI', { dTz: 'Europe/Dublin' }).arrival).toBeNull();
    expect(card(legFromHistory({ o: 'PMI', a: 'DUB' }, ['2026-09-24', '20:55', 5, null, null, 2, null, null]), 'EI', { dTz: 'Europe/Dublin' }).arrival).toBeNull();
  });
});

describe('fotos: exacta, de la aerolínea del número, o representativa de la misma aerolínea', () => {
  it('modelo conocido y foto de ese modelo → exacta (sin «representativa»)', () => {
    const p = photoFor(photos, { op: 'EI', ac: '320' }, 'EI');
    expect(p.representative).toBeUndefined();
    expect(p.thumb).toBe(photos.photos['EI|Airbus A320'].thumb);
  });
  it('sin modelo → representativa de la misma aerolínea', () => {
    expect(photoFor(photos, { op: 'EI', ac: null }, 'EI')).toMatchObject({ representative: true });
  });
  it('nunca una foto de otra aerolínea (si la aerolínea no tiene ninguna, sin foto)', () => {
    for (const al of ['EI', 'FR', 'IB', 'UX', 'VY']) {
      const p = photoFor(photos, { ac: null }, al);
      const key = Object.keys(photos.photos).find(k => photos.photos[k]?.thumb === p?.thumb);
      expect(key.split('|')[0]).toBe(al);
    }
    expect(photoFor(photos, { ac: null }, 'Q9')).toBeNull();
  });
  it('la foto representativa no aporta ningún modelo (no se usa para inferirlo)', () => {
    const p = photoFor(photos, { op: 'EI', ac: null }, 'EI');
    expect(Object.keys(p).sort()).toEqual(['artist', 'license', 'page', 'representative', 'thumb']);
  });
});
