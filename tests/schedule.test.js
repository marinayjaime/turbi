import { describe, it, expect, vi } from 'vitest';
import { parseFlightNumber, fetchSchedule, pickLeg, tabDates, legDeparture, legArrival, flightStatus } from '../js/schedule.js';

const leg = over => ({ d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '17:55', ed: '2026-09-24T17:55', sa: '19:25', ea: '2026-09-24T19:25', td: 'N', ta: 'T4', g: 'D', st: 'SCH', ac: 'A21N', ...over });

describe('parseFlightNumber', () => {
  it('IATA, ICAO, espacios y ceros', () => {
    expect(parseFlightNumber(' ib 1668 ')).toEqual({ prefix: 'IB', n: '1668' });
    expect(parseFlightNumber('IBE1668')).toEqual({ prefix: 'IBE', n: '1668' });
    expect(parseFlightNumber('VY3902')).toEqual({ prefix: 'VY', n: '3902' });
    expect(parseFlightNumber('U28123')).toEqual({ prefix: 'U2', n: '8123' });
    expect(parseFlightNumber('FR0042')).toEqual({ prefix: 'FR', n: '42' });
    expect(parseFlightNumber('hola')).toBeNull();
    expect(parseFlightNumber('')).toBeNull();
  });
});

describe('fetchSchedule', () => {
  it('pide el archivo del vuelo y resuelve ICAO con airlines.json', async () => {
    const f = vi.fn(async url => ({
      ok: true,
      json: async () => (url.endsWith('airlines.json') ? { IBE: 'IB' } : { name: 'Iberia', legs: [leg()] }),
    }));
    const r = await fetchSchedule('IBE1668', f);
    expect(f.mock.calls.map(c => c[0])).toEqual(['data/flights/airlines.json', 'data/flights/IB/1668.json']);
    expect(r).toEqual({ al: 'IB', n: '1668', name: 'Iberia', legs: [leg()] });
  });
  it('404, error de red o ICAO desconocido → null', async () => {
    expect(await fetchSchedule('IB9999', vi.fn(async () => ({ ok: false, status: 404 })))).toBeNull();
    expect(await fetchSchedule('IB1668', vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toBeNull();
    expect(await fetchSchedule('XXX1', vi.fn(async () => ({ ok: true, json: async () => ({}) })))).toBeNull();
  });
});

describe('pickLeg y tabDates', () => {
  const legs = ['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
    .map(d => leg({ d }));
  it('elige el tramo de la fecha', () => {
    expect(pickLeg(legs, '2026-09-25').d).toBe('2026-09-25');
    expect(pickLeg(legs, '2026-12-01')).toBeNull();
  });
  it('pestañas: hasta 7 fechas empezando el día anterior a la elegida', () => {
    expect(tabDates(legs, '2026-09-25')).toEqual(['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(tabDates(legs, '2026-09-23')[0]).toBe('2026-09-23');
    expect(tabDates([leg(), leg()], '2026-09-24')).toEqual(['2026-09-24']);
  });
});

describe('horas', () => {
  it('salida: estimada si existe; si no, programada', () => {
    expect(legDeparture(leg({ ed: '2026-09-24T18:40' }))).toEqual({ date: '2026-09-24', time: '18:40' });
    expect(legDeparture(leg({ ed: null }))).toEqual({ date: '2026-09-24', time: '17:55' });
    expect(legDeparture(leg({ sd: null, ed: null }))).toBeNull();
  });
  it('llegada: estimada; si no, programada, pasando al día siguiente si es antes que la salida', () => {
    expect(legArrival(leg())).toEqual({ date: '2026-09-24', time: '19:25' });
    expect(legArrival(leg({ ea: null, sd: '23:30', sa: '00:50' }))).toEqual({ date: '2026-09-25', time: '00:50' });
    expect(legArrival(leg({ sa: null, ea: null }))).toBeNull();
  });
});

describe('flightStatus', () => {
  it('traduce estados de Aena', () => {
    expect(flightStatus(leg())).toEqual({ text: 'Programado', tone: 'ok' });
    expect(flightStatus(leg({ st: 'CAN' }))).toEqual({ text: 'Cancelado', tone: 'bad' });
    expect(flightStatus(leg({ st: 'BOR' }))).toEqual({ text: 'Embarcando', tone: 'info' });
    expect(flightStatus(leg({ st: 'ATE' }))).toEqual({ text: 'Aterrizado', tone: 'ok' });
    expect(flightStatus(leg({ st: 'ZZZ' }))).toEqual({ text: 'Programado', tone: 'ok' });
  });
  it('retraso: estado RET o estimada > programada + 15 min', () => {
    expect(flightStatus(leg({ ed: '2026-09-24T18:30' }))).toEqual({ text: 'Retrasado · sale 18:30', tone: 'warn' });
    expect(flightStatus(leg({ ed: '2026-09-24T18:05' }))).toEqual({ text: 'Programado', tone: 'ok' });
    expect(flightStatus(leg({ st: 'RET', ed: '2026-09-25T00:40', sd: '23:50' }))).toEqual({ text: 'Retrasado · sale 00:40', tone: 'warn' });
  });
});
