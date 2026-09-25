// Límite de adsb.lol: limitador global con prioridad, pausa tras un 429 y cancelación de la identificación.
// Requisito: la identificación por ruta nunca puede empeorar los vuelos que ya funcionan por su indicativo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { adsbLimiter, adsbGet, createLimiter, ADSB_DEFAULT_COOLDOWN_MS } from '../server/adsb.mjs';
import { identifyByZone } from '../server/identify.mjs';
import { createState, radarResponse } from '../server/live.mjs';

const T0 = Date.parse('2026-09-25T08:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }); adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });
afterEach(() => vi.useRealTimers());

const PMI = [39.5517, 2.73881], LBA = [53.8659, -1.66057], MAD = [40.4719, -3.5626], LHR = [51.4706, -0.461941];
const airports = { PMI: ['', '', ...PMI], LBA: ['', '', ...LBA], MAD: ['', '', ...MAD], LHR: ['', '', ...LHR] };
const fr = { al: 'FR', icao: 'RYR', n: '2311', d: '2026-09-25', o: 'PMI', a: 'LBA', sd: '09:25', ed: '2026-09-25T09:27', st: 'BOR', std: 'BOR', sta: null, ac: '738W', op: 'FR' };
const ib = { al: 'IB', icao: 'IBE', n: '715', d: '2026-09-25', o: 'MAD', a: 'LHR', sd: '09:10', ed: '2026-09-25T09:41', st: 'BOR', std: 'BOR', sta: null, ac: '32N', op: 'IB' };
const now = Date.parse('2026-09-25T07:57:00Z') + 60 * 60000; // hora y media tras la salida de los dos
const ryr = { hex: '4d225e', flight: 'RYR19HB ', t: 'B738', lat: 45.0, lon: 0.6, track: 345, alt_baro: 37000, gs: 450, seen: 1, seen_pos: 1 };
const ibe = { hex: '3423c1', flight: 'IBE715  ', t: 'A20N', lat: 47.0, lon: -1.2, track: 10, alt_baro: 36000, gs: 440, seen: 1, seen_pos: 1 };
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const tooMany = (retryAfter = null) => ({ ok: false, status: 429, headers: { get: k => (k.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => ({}) });

// adsb.lol + adsbdb simulados; `plan` decide la respuesta de cada consulta a adsb.lol (por tipo y número de orden).
function apis(plan = () => null) {
  const calls = [];
  const fetchFn = vi.fn(async url => {
    calls.push(url);
    if (url.includes('adsbdb')) {
      const cs = url.split('/').pop();
      return ok({ response: { flightroute: cs === 'RYR19HB' ? { origin: { iata_code: 'PMI' }, destination: { iata_code: 'LBA' } } : { origin: { iata_code: 'STN' }, destination: { iata_code: 'AGP' } } } });
    }
    const kind = url.split('/')[4];
    const special = plan(kind, calls.filter(u => u.split('/')[4] === kind).length);
    if (special) return special;
    if (kind === 'callsign') return ok({ ac: url.endsWith('/IBE715') ? [ibe] : [] });
    if (kind === 'point') return ok({ ac: [ryr] });
    if (kind === 'hex') return ok({ ac: url.endsWith('/4d225e') ? [ryr] : [] });
    return ok({ ac: [] });
  });
  const count = kind => calls.filter(u => u.startsWith('https://api.adsb.lol/') && u.split('/')[4] === kind).length;
  return { fetchFn, calls, count, adsbCount: () => calls.filter(u => u.startsWith('https://api.adsb.lol/')).length };
}
const serverWith = legs => { const s = createState(); s.legs = legs; return s; };
const ask = (state, path, fetchFn, nowMs = now) => radarResponse(state, path, { fetchFn, nowMs, pauseMs: 0, airports }).then(r => JSON.parse(r.body));

describe('429: pausa global, sin reintentos y sin más consultas', () => {
  it('sin Retry-After: 60 s de pausa; durante la pausa, cero llamadas y «no disponible»; después, el radar normal vuelve', async () => {
    const a = apis((kind, n) => (kind === 'callsign' && n === 1 ? tooMany() : null));
    const state = serverWith([ib]);
    expect((await ask(state, '/radar/IB/715.json', a.fetchFn)).state).toBe('no-disponible');
    expect(a.adsbCount()).toBe(1); // el 429 no se reintenta
    vi.setSystemTime(T0 + ADSB_DEFAULT_COOLDOWN_MS - 1000);
    state.radar.clear(); // sin la caché de 60 s, para comprobar que tampoco se llama a adsb.lol
    expect((await ask(state, '/radar/IB/715.json', a.fetchFn, now + 59000)).state).toBe('no-disponible');
    expect(a.adsbCount()).toBe(1);
    vi.setSystemTime(T0 + ADSB_DEFAULT_COOLDOWN_MS + 1);
    state.radar.clear();
    expect(await ask(state, '/radar/IB/715.json', a.fetchFn, now + 61000)).toMatchObject({ state: 'volando', callsign: 'IBE715' });
  });
  it('con Retry-After: se respeta su tiempo (30 s)', async () => {
    const a = apis((kind, n) => (n === 1 ? tooMany('30') : null));
    expect(await adsbGet('/callsign/IBE715', { fetchFn: a.fetchFn })).toEqual({ error: 'rate-limited' });
    vi.setSystemTime(T0 + 29000);
    expect(await adsbGet('/callsign/IBE715', { fetchFn: a.fetchFn })).toEqual({ error: 'rate-limited' });
    expect(a.adsbCount()).toBe(1);
    vi.setSystemTime(T0 + 30001);
    expect((await adsbGet('/callsign/IBE715', { fetchFn: a.fetchFn })).data.ac[0].flight).toBe('IBE715  ');
  });
});

describe('la identificación nunca empeora el radar que ya funciona', () => {
  it('429 durante la identificación: se abandona en el acto (ni más zonas ni adsbdb) y, pasada la pausa, el radar normal funciona', async () => {
    const a = apis((kind, n) => (kind === 'point' && n === 1 ? tooMany() : null));
    const r = await identifyByZone({ leg: fr, legs: [fr], origin: PMI, dest: LBA, nowMs: now, fetchFn: a.fetchFn });
    expect(r).toMatchObject({ state: 'no-disponible', rateLimited: true });
    expect(a.count('point')).toBe(1);
    expect(a.calls.some(u => u.includes('adsbdb'))).toBe(false);
    vi.setSystemTime(T0 + ADSB_DEFAULT_COOLDOWN_MS + 1);
    const state = serverWith([ib]);
    expect(await ask(state, '/radar/IB/715.json', a.fetchFn)).toMatchObject({ state: 'volando', callsign: 'IBE715' });
  });
  it('el radar normal pasa por delante de las consultas de identificación que esperan', async () => {
    const limiter = createLimiter(0, { identifyIntervalMs: 0, maxPerWindow: Infinity });
    const order = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const first = limiter.schedule(async () => { order.push('radar-1'); await gate; }); // ocupada
    const idents = [1, 2].map(i => limiter.schedule(async () => { order.push(`zona-${i}`); }, { priority: 'identificacion' }));
    const radar2 = limiter.schedule(async () => { order.push('radar-2'); });
    release();
    await Promise.all([first, radar2, ...idents]);
    expect(order).toEqual(['radar-1', 'radar-2', 'zona-1', 'zona-2']);
  });
  it('al primer 429, las consultas de identificación que esperaban se cancelan sin llamar a adsb.lol', async () => {
    const limiter = createLimiter(0, { identifyIntervalMs: 0, maxPerWindow: Infinity });
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? tooMany() : ok({ ac: [] })));
    const results = await Promise.all([
      adsbGet('/callsign/X', { fetchFn, limiter }),
      adsbGet('/point/1/1/150', { fetchFn, limiter, priority: 'identificacion' }),
      adsbGet('/point/2/2/150', { fetchFn, limiter, priority: 'identificacion' }),
    ]);
    expect(results).toEqual([{ error: 'rate-limited' }, { error: 'rate-limited' }, { error: 'rate-limited' }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('se cancelan aunque la pausa sea de 0 s (Retry-After: 0): el 429 cancela, no solo la pausa', async () => {
    const limiter = createLimiter(0, { identifyIntervalMs: 0, maxPerWindow: Infinity });
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? tooMany('0') : ok({ ac: [] })));
    const results = await Promise.all([
      adsbGet('/callsign/X', { fetchFn, limiter }),
      adsbGet('/point/1/1/150', { fetchFn, limiter, priority: 'identificacion' }),
    ]);
    expect(results).toEqual([{ error: 'rate-limited' }, { error: 'rate-limited' }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('las consultas de identificación dejan más hueco que las del radar (heurística ajustable)', async () => {
    vi.useFakeTimers({ now: T0 }); // reloj simulado: medidas exactas, sin depender de la velocidad de la máquina
    const limiter = createLimiter(0, { identifyIntervalMs: 60, maxPerWindow: Infinity });
    const starts = [];
    const task = () => async () => { starts.push(Date.now()); };
    await limiter.schedule(task());
    const ident = limiter.schedule(task(), { priority: 'identificacion' });
    await vi.advanceTimersByTimeAsync(60);
    await ident;
    await limiter.schedule(task());
    expect(starts[1] - starts[0]).toBe(60);
    expect(starts[2] - starts[1]).toBe(0);
  });
  it('un vuelo que funciona por su indicativo (Iberia) no dispara ninguna identificación', async () => {
    const a = apis();
    const state = serverWith([ib]);
    const r = await ask(state, '/radar/IB/715.json', a.fetchFn);
    expect(r).toMatchObject({ state: 'volando', callsign: 'IBE715' });
    expect(r.identifying).toBeUndefined();
    expect(a.count('point') + a.count('hex')).toBe(0);
  });
  it('un Ryanair que emite con su indicativo comercial (RYR + número) tampoco', async () => {
    const leg = { ...fr, n: '9428' };
    const a = apis((kind) => (kind === 'callsign' ? ok({ ac: [{ ...ryr, flight: 'RYR9428 ' }] }) : null));
    const r = await ask(serverWith([leg]), '/radar/FR/9428.json', a.fetchFn);
    expect(r).toMatchObject({ state: 'volando', callsign: 'RYR9428' });
    expect(r.identifying).toBeUndefined();
    expect(a.count('point') + a.count('hex')).toBe(0);
  });
  it('se conservan las cachés: la misma consulta de radar antes de 60 s no llama a adsb.lol', async () => {
    const a = apis();
    const state = serverWith([ib]);
    await ask(state, '/radar/IB/715.json', a.fetchFn);
    await ask(state, '/radar/IB/715.json', a.fetchFn, now + 30000);
    expect(a.adsbCount()).toBe(1);
  });
});

describe('adsbdb: caché por indicativo', () => {
  it('la ruta de un indicativo no se vuelve a pedir en otra identificación', async () => {
    const a = apis();
    await identifyByZone({ leg: fr, legs: [fr], origin: PMI, dest: LBA, nowMs: now, fetchFn: a.fetchFn });
    await identifyByZone({ leg: fr, legs: [fr], origin: PMI, dest: LBA, nowMs: now + 60000, fetchFn: a.fetchFn });
    expect(a.calls.filter(u => u.includes('adsbdb'))).toEqual(['https://api.adsbdb.com/v0/callsign/RYR19HB']);
  });
});
