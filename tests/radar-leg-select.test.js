// El radar consulta exactamente el vuelo físico que muestra la app (?leg=<physicalFlightKey>). Un mismo número puede
// tener varios tramos la misma fecha (CA898: GRU → MAD y MAD → PEK); el servidor nunca escoge otro tramo por su cuenta,
// y caché, trabajos, fallos directos y registro de hex van por vuelo físico. Datos simulados.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';
import { distanceKm } from '../server/radar.mjs';

const GRU = [-23.4356, -46.4731], MAD = [40.4719, -3.5626], PEK = [40.0801, 116.585];
const airports = { GRU: ['', '', ...GRU, 'America/Sao_Paulo'], MAD: ['', '', ...MAD, 'Europe/Madrid'], PEK: ['', '', ...PEK, 'Asia/Shanghai'] };
const T0 = Date.parse('2026-09-26T12:00:00Z'); // 14:00 en Madrid
const D = '2026-09-26';
// Dos tramos del mismo número, los dos con radar a la vez: la llegada aún volando y la salida ya despegada.
const inbound = { al: 'CA', icao: 'CCA', n: '898', d: D, o: 'GRU', a: 'MAD', sd: null, ed: null, sa: '15:10', ea: `${D}T15:10`, st: 'FLY', std: null, sta: 'FLY', ac: '789', op: 'CA' };
const outbound = { al: 'CA', icao: 'CCA', n: '898', d: D, o: 'MAD', a: 'PEK', sd: '13:30', ed: `${D}T13:35`, sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ac: '789', op: 'CA' };
const K_IN = physicalFlightKey(inbound), K_OUT = physicalFlightKey(outbound);
// Un avión con ese indicativo, ya al este de Madrid (lo que devuelva adsb.lol es igual para las dos peticiones).
const plane = { hex: '780abc', flight: 'CCA898  ', t: 'B789', lat: 41.5, lon: 1.0, track: 60, alt_baro: 30000, gs: 480, seen: 1, seen_pos: 1 };
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

beforeEach(() => { vi.useFakeTimers({ now: T0 }); adsbLimiter.reset(); }); // limitador de producción (3/min)
afterEach(() => { adsbLimiter.reset(); vi.useRealTimers(); });

function server(legs, { callsignAc = [plane], hold = false } = {}) {
  const state = createState();
  state.legs = legs;
  const calls = [];
  let release = () => {};
  const gate = hold ? new Promise(r => { release = r; }) : null;
  const fetchFn = vi.fn(async url => {
    calls.push({ t: Date.now(), url });
    if (url.includes('/v2/callsign/')) { if (gate) await gate; return ok({ ac: callsignAc }); }
    if (url.includes('/v2/')) return ok({ ac: [] });
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
  });
  const ask = path => {
    let out;
    const p = radarResponse(state, path, { fetchFn, nowMs: Date.now(), pauseMs: 0, airports }).then(r => { out = JSON.parse(r.body); return out; });
    return { p, get: () => out };
  };
  const settled = async path => { const a = ask(path); for (let i = 0; i < 300 && !a.get(); i++) await vi.advanceTimersByTimeAsync(1000); return a.get(); };
  return { state, calls, ask, settled, adsb: () => calls.filter(c => c.url.includes('api.adsb.lol')), release: () => release() };
}
const km = to => Math.round(distanceKm([plane.lat, plane.lon], to));
const q = key => `/radar/CA/898.json?leg=${encodeURIComponent(key)}`;

describe('1-3) dos vuelos físicos del mismo número con radar a la vez', () => {
  it('?leg del SEGUNDO tramo → solo ese tramo (distancia hasta Pekín); ?leg del primero → hasta Madrid; cachés separadas', async () => {
    const s = server([inbound, outbound]);
    const out = await s.settled(q(K_OUT));
    expect(out).toMatchObject({ state: 'volando', remainingKm: km(PEK) });
    const inb = await s.settled(q(K_IN)); // misma URL, otro tramo: nunca la respuesta en caché del otro
    expect(inb).toMatchObject({ state: 'volando', remainingKm: km(MAD) });
    expect(s.state.radar.has(`phys|${K_OUT}`) && s.state.radar.has(`phys|${K_IN}`)).toBe(true);
  });
  it('invertir el orden de state.legs no cambia nada', async () => {
    for (const legs of [[inbound, outbound], [outbound, inbound]]) {
      const s = server(legs);
      expect(await s.settled(q(K_OUT))).toMatchObject({ remainingKm: km(PEK) });
    }
  });
  it('sin ?leg y con varios vuelos físicos con radar → no se escoge ninguno (y cero consultas a adsb.lol)', async () => {
    const s = server([inbound, outbound]);
    const r = await s.settled('/radar/CA/898.json?debug=1');
    expect(r.state).toBe('no-aplica');
    expect(r.diagnostic.gateReason).toBe('varios-tramos-sin-elegir');
    expect(s.adsb()).toHaveLength(0);
  });
});

describe('4) un tramo que no existe nunca cae en otro', () => {
  it('clave desconocida, de otra fecha, de otro número o sin radar → no aplica, sin consultar adsb.lol', async () => {
    const other = { ...outbound, al: 'IB', icao: 'IBE', n: '6543', sd: '09:00', ed: `${D}T09:00` };
    const landed = { ...inbound, sa: '06:10', ea: `${D}T06:10`, st: 'LND', sta: 'LND' };
    const s = server([inbound, outbound, other, landed]);
    for (const key of ['2026-09-26|MAD|PEK|99:99', K_OUT.replace(D, '2026-09-27'), physicalFlightKey(other), physicalFlightKey(landed), 'x'.repeat(200)]) {
      const r = await s.settled(`${q(key)}&debug=1`);
      expect(r.state, key).toBe('no-aplica');
      expect(['tramo-desconocido', 'tramo-sin-radar']).toContain(r.diagnostic.gateReason);
    }
    expect(s.adsb()).toHaveLength(0);
  });
});

describe('5) sondeos y trabajos por vuelo físico', () => {
  it('poll=1 con el mismo ?leg lee SU trabajo; con el otro tramo, nunca el trabajo ajeno', async () => {
    const s = server([inbound, outbound], { hold: true });
    s.ask(q(K_OUT)); // búsqueda directa del segundo tramo en curso (retenida)
    await vi.advanceTimersByTimeAsync(1000);
    expect(await s.ask(`${q(K_OUT)}&poll=1`).p).toMatchObject({ identifying: true, phase: 'direct' });
    const otherPoll = await s.ask(`${q(K_IN)}&poll=1`).p;
    expect(otherPoll.identifying).toBeUndefined(); // el primer tramo no tiene trabajo: no hereda el del segundo
    expect(s.state.radarJobs.has(`phys|${K_OUT}`)).toBe(true);
    expect(s.state.radarJobs.has(`phys|${K_IN}`)).toBe(false);
    s.release();
  });
  it('7) dos códigos comerciales del MISMO vuelo físico comparten el trabajo (una sola búsqueda directa)', async () => {
    const share = { ...outbound, al: 'IB', icao: 'IBE', n: '6543', op: 'CA' }; // mismo avión, otro código
    const s = server([inbound, outbound, share], { hold: true });
    const a = s.ask(q(K_OUT));
    await vi.advanceTimersByTimeAsync(1000);
    const b = s.ask(`/radar/IB/6543.json?leg=${encodeURIComponent(K_OUT)}`);
    s.release();
    for (let i = 0; i < 60 && !(a.get() && b.get()); i++) await vi.advanceTimersByTimeAsync(1000);
    expect(s.calls.filter(c => c.url.includes('/v2/callsign/'))).toHaveLength(1);
    expect(a.get()).toMatchObject({ state: 'volando', remainingKm: km(PEK) });
    expect(b.get()).toMatchObject({ state: 'volando', remainingKm: km(PEK) });
  });
});

describe('8) vuelo normal con un solo tramo', () => {
  it('sin ?leg (clientes antiguos) y con ?leg, igual que antes', async () => {
    const s = server([outbound]);
    expect(await s.settled('/radar/CA/898.json')).toMatchObject({ state: 'volando', remainingKm: km(PEK) });
    const s2 = server([outbound]);
    expect(await s2.settled(q(K_OUT))).toMatchObject({ state: 'volando', remainingKm: km(PEK) });
  });
});

describe('10) límite de 3 peticiones/min', () => {
  it('con los dos tramos consultados repetidamente, nunca más de 3 inicios en 60 s', async () => {
    const s = server([inbound, outbound]);
    for (let i = 0; i < 6; i++) { // cada consulta (sin caché) hace de verdad su búsqueda directa
      await s.settled(q(i % 2 ? K_IN : K_OUT));
      s.state.radar.clear();
      s.state.directMisses.clear();
    }
    const starts = s.adsb().map(c => c.t);
    expect(starts.length).toBeGreaterThan(3);
    for (const t of starts) expect(starts.filter(u => u >= t && u < t + 60000).length).toBeLessThanOrEqual(3);
  });
});
