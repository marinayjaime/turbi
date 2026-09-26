// AeroDataBox en la app (js/adb.js): caché del navegador, refresco operativo y textos.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAdb, refreshDue, adbTimes, adbInfo, sourceNote, adbPhysical } from '../js/adb.js';
import { normalizeFlights } from '../server/aerodatabox.mjs';

const RAW = [{
  number: 'TO 3416', callSign: 'TVF93ZL', status: 'Departed', codeshareStatus: 'IsOperator', airline: { name: 'Transavia France' },
  departure: { airport: { iata: 'NTE' }, scheduledTime: { utc: '2026-09-26 10:30Z', local: '2026-09-26 12:30+02:00' },
    revisedTime: { utc: '2026-09-26 10:23Z', local: '2026-09-26 12:23+02:00' }, runwayTime: { utc: '2026-09-26 10:34Z', local: '2026-09-26 12:34+02:00' } },
  arrival: { airport: { iata: 'AYT' }, scheduledTime: { utc: '2026-09-26 14:30Z', local: '2026-09-26 17:30+03:00' }, predictedTime: { utc: '2026-09-26 14:21Z', local: '2026-09-26 17:21+03:00' } },
  aircraft: { model: 'Boeing 737-800' },
}];
const [LEG] = normalizeFlights(RAW);
const FOUND = { status: 'found', source: 'aerodatabox', number: 'TO3416', date: '2026-09-26', fetchedAt: '2026-09-26T11:00:00.000Z', legs: [LEG] };
const LIVE = 'https://render.example';
const res = body => ({ ok: true, status: 200, json: async () => body });

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, m };
}
let store;
beforeEach(() => { store = memoryStorage(); vi.stubGlobal('localStorage', store); });
afterEach(() => vi.unstubAllGlobals());

describe('fetchAdb', () => {
  it('pide a Render /schedule/{número}/{fecha}.json y guarda la respuesta en el navegador', async () => {
    const f = vi.fn(async () => res(FOUND));
    expect(await fetchAdb('to 3416', '2026-09-26', { fetchFn: f, liveBase: LIVE, nowMs: Date.parse('2026-09-26T12:00Z') })).toEqual(FOUND);
    expect(f.mock.calls[0][0]).toBe(`${LIVE}/schedule/TO3416/2026-09-26.json`);
    // Segunda vez: del navegador, sin preguntar a Render.
    expect(await fetchAdb('TO3416', '2026-09-26', { fetchFn: f, liveBase: LIVE, nowMs: Date.parse('2026-09-26T12:05Z') })).toEqual(FOUND);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('negativa también se guarda; «no disponible» no (se volverá a intentar en otra búsqueda)', async () => {
    const nf = { status: 'not_found', legs: [], fetchedAt: '2026-09-26T11:00:00.000Z' };
    const f = vi.fn(async () => res(nf));
    await fetchAdb('XX1', '2026-09-26', { fetchFn: f, liveBase: LIVE });
    await fetchAdb('XX1', '2026-09-26', { fetchFn: f, liveBase: LIVE });
    expect(f).toHaveBeenCalledTimes(1);
    const u = vi.fn(async () => res({ status: 'unavailable', reason: 'http-429' }));
    expect(await fetchAdb('XX2', '2026-09-26', { fetchFn: u, liveBase: LIVE })).toEqual({ status: 'unavailable', reason: 'http-429' });
    await fetchAdb('XX2', '2026-09-26', { fetchFn: u, liveBase: LIVE });
    expect(u).toHaveBeenCalledTimes(2);
  });
  it('Render caído, lento o con error → «no disponible» sin lanzar', async () => {
    expect(await fetchAdb('XX3', '2026-09-26', { fetchFn: vi.fn(async () => { throw new TypeError('x'); }), liveBase: LIVE })).toMatchObject({ status: 'unavailable' });
    expect(await fetchAdb('XX3', '2026-09-26', { fetchFn: vi.fn(async () => ({ ok: false, status: 502 })), liveBase: LIVE })).toMatchObject({ status: 'unavailable', reason: 'http-502' });
  });
  it('base guardada de un día anterior y ya en las 3 h previas: se vuelve a preguntar a Render (una vez)', async () => {
    const old = { ...FOUND, fetchedAt: '2026-09-24T09:00:00.000Z' };
    const refreshed = { ...old, refreshedAt: '2026-09-26T09:00:00.000Z' };
    const f = vi.fn(async () => res(refreshed));
    const at = Date.parse('2026-09-26T09:00Z'); // salida 10:30Z
    store.setItem('turbi-adb:TO3416|2026-09-26', JSON.stringify(old));
    expect(await fetchAdb('TO3416', '2026-09-26', { fetchFn: f, liveBase: LIVE, nowMs: at })).toEqual(refreshed);
    expect(await fetchAdb('TO3416', '2026-09-26', { fetchFn: f, liveBase: LIVE, nowMs: at + 600000 })).toEqual(refreshed);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('limpia del navegador lo de hace más de 3 días', async () => {
    store.setItem('turbi-adb:AA1|2026-09-20', '{}');
    store.setItem('turbi-adb:AA1|2026-09-25', '{}');
    await fetchAdb('TO3416', '2026-09-26', { fetchFn: vi.fn(async () => res(FOUND)), liveBase: LIVE, nowMs: Date.parse('2026-09-26T12:00Z') });
    expect([...store.m.keys()].sort()).toEqual(['turbi-adb:AA1|2026-09-25', 'turbi-adb:TO3416|2026-09-26']);
  });
});

describe('horas y textos', () => {
  it('mejor hora: pista > revisada/prevista > programada; duración real', () => {
    const t = adbTimes(LEG);
    expect(t.dep.local).toBe('2026-09-26T12:34');
    expect(t.arr.local).toBe('2026-09-26T17:21');
    expect(t.durationMin).toBe(227);
  });
  it('adbInfo: estado, salida real, llegada prevista, aeronave y cuándo se consultó', () => {
    expect(adbInfo(FOUND, LEG, Date.parse('2026-09-26T13:00Z')))
      .toBe('Horario según AeroDataBox (consultado hace 2 h): Ha salido · salida 12:34 (programada 12:30) · llegada prevista 17:21 · Boeing 737-800');
  });
  it('sourceNote y clave física del tramo', () => {
    expect(sourceNote({ routeSource: 'aerodatabox' })).toBe('horario según AeroDataBox');
    expect(sourceNote({ routeSource: 'adsbdb' })).toBe('ruta según ADSBDB (no oficial)');
    expect(sourceNote({})).toBe('');
    expect(adbPhysical(LEG)).toEqual({ d: '2026-09-26', o: 'NTE', a: 'AYT', sd: '12:30' });
    expect(refreshDue({ ...FOUND, fetchedAt: '2026-09-25T09:00:00.000Z' }, Date.parse('2026-09-26T09:00Z'))).toBe(true);
  });
});
