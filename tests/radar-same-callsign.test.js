// Varios aviones EN VUELO con el mismo indicativo en una búsqueda directa (p. ej. dos tramos del mismo número a la
// vez): nunca se toma el primero; solo el único compatible con el tramo pedido según corridor(). Con un solo avión,
// exactamente como antes. Datos simulados; sin nada específico de ningún vuelo en el código.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findOnRadar } from '../server/radar.mjs';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';

const MAD = [40.4934, -3.5722], PEK = [40.0773, 116.5967], GRU = [-23.4313, -46.47];
const airports = { MAD: ['', '', ...MAD, 'Europe/Madrid'], PEK: ['', '', ...PEK, 'Asia/Shanghai'], GRU: ['', '', ...GRU, 'America/Sao_Paulo'] };
const T0 = Date.parse('2026-09-26T12:00:00Z');
const D = '2026-09-26';
// MAD → PEK salió hace 35 min (13:25 en Madrid).
const leg = { al: 'CA', icao: 'CCA', n: '898', d: D, o: 'MAD', a: 'PEK', sd: '13:25', ed: `${D}T13:25`, st: 'BOR', std: 'BOR', sta: null, ac: '789', op: 'CA' };
const ac = (hex, lat, lon, track) => ({ hex, flight: 'CCA898  ', t: 'B789', lat, lon, track, alt_baro: 35000, gs: 480, seen: 1, seen_pos: 1 });
// Posiciones comprobadas con corridor(): A y A2 compatibles con MAD → PEK; B (sobre el Atlántico, hacia Madrid), C y D no.
const A = ac('a00001', 43.2, 0.9, 45), A2 = ac('a00002', 43.0, 0.3, 48), B = ac('b00001', 36.0, -12.0, 40), C = ac('c00001', 39.0, -8.0, 230), D2 = ac('d00001', 44.5, 3.2, 46);

beforeEach(() => { vi.useFakeTimers({ now: T0 }); adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });
afterEach(() => { adsbLimiter.reset(); vi.useRealTimers(); });

function api(list) {
  const calls = [];
  const fetchFn = vi.fn(async url => { calls.push(url); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ac: url.includes('/v2/callsign/') ? list : [] }) }; });
  return { fetchFn, calls };
}
const find = (list, extra = {}) => { const a = api(list); let diag; return findOnRadar({ leg, fetchFn: a.fetchFn, pauseMs: 0, nowMs: T0, origin: MAD, dest: PEK,
  onDiagnostic: d => { diag = d; }, ...extra }).then(r => ({ r, calls: a.calls, diag })); };

describe('búsqueda directa con varios aviones en vuelo con el mismo indicativo', () => {
  it('1) solo uno compatible con MAD → PEK → ese (y nunca el primero de la lista)', async () => {
    const { r, calls } = await find([B, A]);
    expect(r).toMatchObject({ state: 'volando', callsign: 'CCA898' });
    expect(r.remainingKm).toBe(Math.round((await find([A])).r.remainingKm)); // el de A, no el de B
    expect(calls.filter(u => u.includes('/v2/callsign/'))).toHaveLength(1); // 6) ni una consulta más
  });
  it('2) dos compatibles → ambiguo: no elige ninguno', async () => {
    const { r, diag } = await find([A, A2]);
    expect(r.state).toBe('sin-datos');
    expect(diag).toMatchObject({ found: false, ambiguous: 1 });
  });
  it('3) ninguno compatible → no elige ninguno', async () => {
    expect((await find([B, C, D2])).r.state).toBe('sin-datos');
  });
  it('4) el orden de ac[] no altera el resultado', async () => {
    const perms = [[B, A, C], [A, B, C], [C, B, A], [B, C, A]];
    const km = new Set();
    for (const p of perms) { const { r } = await find(p); expect(r.state).toBe('volando'); km.add(r.remainingKm); }
    expect(km.size).toBe(1);
    for (const p of [[A, A2, B], [B, A2, A]]) expect((await find(p)).r.state).toBe('sin-datos');
  });
  it('5) un único avión en vuelo: exactamente como antes (sin comprobar el pasillo)', async () => {
    const { r, diag } = await find([B]); // incompatible, pero es el único: se usa como siempre
    expect(r).toMatchObject({ state: 'volando', callsign: 'CCA898' });
    expect(diag.ambiguous).toBeUndefined();
    const ground = { ...A, alt_baro: 'ground' };
    expect((await find([ground, B])).r.state).toBe('volando'); // uno en tierra + uno en vuelo: un único en vuelo
  });
  it('sin hora de salida o sin coordenadas no se puede comprobar: con varios, no elige', async () => {
    expect((await find([A, B], { origin: null })).r.state).toBe('sin-datos');
  });
});

describe('a través del servidor (limitador de producción)', () => {
  it('6-7) mismas consultas que antes y nunca más de 3 en 60 s; el tramo pedido obtiene su avión', async () => {
    const kmA = (await find([A])).r.remainingKm, kmB = (await find([B])).r.remainingKm; // distancia de cada avión a Pekín
    expect(kmA).not.toBe(kmB);
    adsbLimiter.reset(); // valores de producción: 5/8 s y 3/min
    const inbound = { ...leg, o: 'GRU', a: 'MAD', sd: null, ed: null, sa: '15:10', ea: `${D}T15:10`, st: 'FLY', std: null, sta: 'FLY' };
    const state = createState();
    state.legs = [inbound, leg];
    const calls = [];
    const fetchFn = vi.fn(async url => { calls.push({ t: Date.now(), url }); return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ ac: url.includes('/v2/callsign/') ? [B, A] : [] }) }; });
    const ask = async key => {
      let out;
      radarResponse(state, `/radar/CA/898.json?leg=${encodeURIComponent(key)}`, { fetchFn, nowMs: Date.now(), pauseMs: 0, airports }).then(r => { out = JSON.parse(r.body); });
      for (let i = 0; i < 300 && !out; i++) await vi.advanceTimersByTimeAsync(1000);
      return out;
    };
    const out = await ask(physicalFlightKey(leg));
    expect(out).toMatchObject({ state: 'volando' });
    expect(out.remainingKm).toBe(kmA); // A, el compatible con MAD → PEK (no B, el primero de la lista)
    expect(calls.filter(c => c.url.includes('/v2/callsign/'))).toHaveLength(1);
    for (let i = 0; i < 5; i++) { state.radar.clear(); state.directMisses.clear(); await ask(physicalFlightKey(i % 2 ? inbound : leg)); }
    const starts = calls.filter(c => c.url.includes('api.adsb.lol')).map(c => c.t);
    for (const t of starts) expect(starts.filter(u => u >= t && u < t + 60000).length).toBeLessThanOrEqual(3);
  });
});
