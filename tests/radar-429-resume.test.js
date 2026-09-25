// Un 429 de adsb.lol a mitad de la identificación NO es definitivo (caso real de producción, FR8297 ALC → BRS,
// 26/09/2026: el indicativo directo falló, la identificación empezó y la segunda zona recibió 429; el vuelo se quedó
// en «Sin señal ADS-B»). Servidor real (radarResponse + registro + limitador de producción: 5/8 s y 3/min), con
// reloj simulado. FR8297 solo aparece aquí, como datos de regresión; el hex y el indicativo son ficticios.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter, adsbGet, createLimiter, ADSB_DEFAULT_COOLDOWN_MS, ADSB_MAX_COOLDOWN_MS } from '../server/adsb.mjs';

const ALC = [38.2822, -0.558156], BRS = [51.3827, -2.71909];
const airports = { ALC: ['', '', ...ALC, 'Europe/Madrid'], BRS: ['', '', ...BRS, 'Europe/London'] };
const MIN = 60000;
const dep = Date.parse('2026-09-26T06:10:00Z');
const T0 = dep + 30 * MIN;
const leg = { al: 'FR', icao: 'RYR', n: '8297', d: '2026-09-26', o: 'ALC', a: 'BRS', sd: '08:05', ed: '2026-09-26T08:10', st: 'BOR', std: 'BOR', sta: null,
  ac: '738W', op: 'FR' };
const PHYS = 'phys|2026-09-26|ALC|BRS|08:05';
const plane = () => ({ hex: 'abc123', flight: 'RYR12AB ', t: 'B738', lat: 41.9, lon: -1.05, track: 352, alt_baro: 36000, gs: 450, seen: 1, seen_pos: 1 });
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const tooMany = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };

beforeEach(() => { vi.useFakeTimers({ now: T0 }); adsbLimiter.reset(); }); // limitador con los valores de producción
// Una consulta puede esperar su turno en el limitador (tope por minuto): se avanza el reloj simulado hasta que responda.
async function settled(promise) {
  let done = false, value;
  promise.then(v => { done = true; value = v; });
  for (let i = 0; i < 600 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  return value;
}
afterEach(() => { adsbLimiter.reset(); vi.useRealTimers(); });

// adsb.lol simulado: el indicativo exacto no aparece; la segunda consulta por zona devuelve 429 (una sola vez).
function network({ zone429 = [2] } = {}) {
  const calls = [];
  let zones = 0;
  const fetchFn = vi.fn(async url => {
    calls.push({ t: Date.now(), url });
    if (url.includes('/v2/callsign/')) return ok({ ac: [] });
    if (url.includes('/v2/point/')) return zone429.includes(++zones) ? tooMany : ok({ ac: [plane()] });
    if (url.includes('/v2/hex/abc123')) return ok({ ac: [plane()] });
    if (url.includes('adsbdb')) return ok({ response: { flightroute: { origin: { iata_code: 'ALC' }, destination: { iata_code: 'BRS' } } } });
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null }; // VRS: desconocido
  });
  return { fetchFn, calls, adsb: () => calls.filter(c => c.url.includes('adsb.lol')) };
}

describe('FR8297 (regresión): 429 en la segunda zona → pausa, reanudación automática e identificación', () => {
  it('estado temporal durante la pausa, cero llamadas, reanuda sola, identifica y los sondeos lo ven sin recargar', async () => {
    const state = createState();
    state.legs = [leg];
    const net = network();
    const ask = path => settled(radarResponse(state, path, { fetchFn: net.fetchFn, nowMs: Date.now(), pauseMs: 0, airports }).then(r => JSON.parse(r.body)));
    const zones = () => net.calls.filter(c => c.url.includes('/v2/point/'));

    // 0 s: la app abre la ficha → indicativo directo (falla) e identificación en segundo plano.
    expect(await ask('/radar/FR/8297.json')).toMatchObject({ state: 'sin-datos', identifying: true });
    // Primera zona bien; la segunda (con el tope de 3/min, ya cerca del minuto) recibe 429.
    for (let i = 0; i < 120 && zones().length < 2; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(zones()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(adsbLimiter.isBlocked()).toBe(true);
    const pauseStart = Date.now();

    // El sondeo de la app → sigue identificando, temporal, con la espera del servidor.
    const during = await ask('/radar/FR/8297.json?poll=1');
    expect(during).toMatchObject({ state: 'sin-datos', identifying: true, temporary: true });
    expect(during.retryAfterSec).toBeGreaterThan(30);
    // Otro usuario abre el mismo vuelo (sin poll): tampoco arranca nada nuevo.
    expect(await ask('/radar/FR/8297.json')).toMatchObject({ identifying: true, temporary: true });

    // Durante la pausa: cero llamadas a adsb.lol, aunque la app siga sondeando.
    const before = net.adsb().length;
    for (let t = 0; t < 40; t += 10) { await vi.advanceTimersByTimeAsync(10000); await ask('/radar/FR/8297.json?poll=1'); }
    expect(net.adsb()).toHaveLength(before);

    // Al acabar la pausa, el propio servidor reanuda (sin que nadie recargue) y termina identificando.
    await vi.advanceTimersByTimeAsync(180000);
    expect(state.hexes.get(PHYS)).toMatchObject({ hex: 'abc123', callsign: 'RYR12AB' });
    const resumedZones = zones().slice(2);
    expect(resumedZones.length).toBeGreaterThan(0);
    expect(resumedZones[0].t - pauseStart).toBeGreaterThanOrEqual(ADSB_DEFAULT_COOLDOWN_MS); // nunca antes de que acabe la pausa
    // Ritmo respetado en todo momento: nunca más de 3 peticiones en 60 s.
    const starts = net.adsb().map(c => c.t);
    for (const t of starts) expect(starts.filter(u => u >= t && u < t + 60000).length).toBeLessThanOrEqual(3);

    // El siguiente sondeo de la app ya ve el avión.
    expect(await ask('/radar/FR/8297.json?poll=1')).toMatchObject({ state: 'volando', hex: 'abc123', match: 'ruta' });
  });

  it('nunca dos identificaciones del mismo vuelo a la vez, ni durante la pausa ni al reanudar', async () => {
    const state = createState();
    state.legs = [leg];
    const net = network();
    const resolve = vi.spyOn(state.hexes, 'resolve');
    const ask = path => settled(radarResponse(state, path, { fetchFn: net.fetchFn, nowMs: Date.now(), pauseMs: 0, airports }));
    await ask('/radar/FR/8297.json');
    for (let t = 0; t < 300; t += 7) {
      await vi.advanceTimersByTimeAsync(7000);
      await ask(t % 2 ? '/radar/FR/8297.json' : '/radar/FR/8297.json?poll=1');
    }
    expect(resolve).toHaveBeenCalledTimes(1); // la reanudación la hace el registro, no una consulta
    expect(state.hexes.get(PHYS)).toMatchObject({ hex: 'abc123' });
    // Las consultas por zona: 2 (la segunda con 429) + como mucho 3 al reanudar.
    expect(net.calls.filter(c => c.url.includes('/v2/point/')).length).toBeLessThanOrEqual(5);
  });
});

describe('pausa larga (Retry-After: 300 s) sin sondeos intermedios', () => {
  it('la app solo pregunta al acabar la pausa: la reanudación ya ocurrió sola, poll=1 no llamó a adsb.lol y hubo una sola identificación', async () => {
    const state = createState();
    state.legs = [leg];
    const calls = [];
    let zones = 0;
    const retry300 = { ok: false, status: 429, headers: { get: k => (k.toLowerCase() === 'retry-after' ? '300' : null) }, json: async () => ({}) };
    const fetchFn = vi.fn(async url => {
      calls.push({ t: Date.now(), url });
      if (url.includes('/v2/callsign/')) return ok({ ac: [] });
      if (url.includes('/v2/point/')) return ++zones === 2 ? retry300 : ok({ ac: [plane()] });
      if (url.includes('/v2/hex/abc123')) return ok({ ac: [plane()] });
      if (url.includes('adsbdb')) return ok({ response: { flightroute: { origin: { iata_code: 'ALC' }, destination: { iata_code: 'BRS' } } } });
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
    });
    const resolve = vi.spyOn(state.hexes, 'resolve');
    const ask = path => settled(radarResponse(state, path, { fetchFn, nowMs: Date.now(), pauseMs: 0, airports }).then(r => JSON.parse(r.body)));
    await ask('/radar/FR/8297.json');
    for (let i = 0; i < 120 && zones < 2; i++) await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    const pauseStart = Date.now();
    const paused = await ask('/radar/FR/8297.json?poll=1'); // un sondeo al empezar la pausa
    expect(paused).toMatchObject({ identifying: true, temporary: true });
    expect(paused.retryAfterSec).toBeGreaterThanOrEqual(300);
    const adsbBefore = calls.filter(c => c.url.includes('adsb.lol')).length;
    // Ni un sondeo más hasta que acabe la pausa (la app espera retryAfterSec + 3 s).
    await vi.advanceTimersByTimeAsync(299000);
    expect(calls.filter(c => c.url.includes('adsb.lol'))).toHaveLength(adsbBefore); // cero llamadas durante la pausa
    await vi.advanceTimersByTimeAsync(200000); // el servidor reanuda solo y termina (3 zonas con el tope de 2/min)
    expect(calls.filter(c => c.url.includes('/v2/point/')).slice(2)[0].t - pauseStart).toBeGreaterThanOrEqual(300000);
    expect(state.hexes.get(PHYS)).toMatchObject({ hex: 'abc123' });
    expect(resolve).toHaveBeenCalledTimes(1);
    // poll=1 nunca llama a adsb.lol por sí mismo (el seguimiento por hex, una vez identificado, es radar normal).
    const n = calls.length;
    expect(await ask('/radar/FR/8297.json?poll=1')).toMatchObject({ state: 'volando', hex: 'abc123' });
    expect(calls.slice(n).every(c => c.url.includes('/v2/hex/'))).toBe(true);
  });
});

describe('pausa adaptativa tras 429 repetidos', () => {
  const at = () => Date.now();
  it('60 s → 120 s → 180 s … (máx. 5 min); Retry-After se respeta; una racha de aciertos vuelve a 60 s', async () => {
    const limiter = createLimiter(0, { identifyIntervalMs: 0, maxPerWindow: Infinity });
    let status = 429;
    const fetchFn = vi.fn(async () => (status === 429 ? tooMany : ok({ ac: [] })));
    const pauses = [];
    for (let i = 0; i < 6; i++) {
      await adsbGet('/callsign/X', { fetchFn, limiter });
      pauses.push((limiter.blockedUntil - at()) / 1000);
      vi.setSystemTime(limiter.blockedUntil + 1000); // justo tras la pausa, otro 429
    }
    expect(pauses).toEqual([60, 120, 180, 240, 300, 300]);
    // Durante una pausa, cero llamadas.
    await adsbGet('/callsign/X', { fetchFn, limiter });
    const n = fetchFn.mock.calls.length;
    vi.setSystemTime(at() + 1000);
    expect((await adsbGet('/callsign/Y', { fetchFn, limiter })).error).toBe('rate-limited');
    expect(fetchFn.mock.calls.length).toBe(n);
    // Recuperación: tras la pausa, 5 aciertos seguidos y el siguiente 429 vuelve a la pausa base.
    vi.setSystemTime(limiter.blockedUntil + 1000);
    status = 200;
    for (let i = 0; i < 5; i++) expect((await adsbGet('/callsign/Z', { fetchFn, limiter })).data).toBeDefined();
    status = 429;
    await adsbGet('/callsign/Z', { fetchFn, limiter });
    expect((limiter.blockedUntil - at()) / 1000).toBe(60);
  });
  it('Retry-After mayor que la pausa adaptativa manda; y un 429 aislado (10 min después) vuelve a empezar en 60 s', async () => {
    const limiter = createLimiter(0, { identifyIntervalMs: 0, maxPerWindow: Infinity });
    const withRetry = s => ({ ...tooMany, headers: { get: k => (k.toLowerCase() === 'retry-after' ? String(s) : null) } });
    const fetchFn = vi.fn().mockResolvedValueOnce(withRetry(30)).mockResolvedValueOnce(withRetry(400)).mockResolvedValue(tooMany);
    await adsbGet('/a', { fetchFn, limiter });
    expect((limiter.blockedUntil - at()) / 1000).toBe(30); // primer 429: su Retry-After
    vi.setSystemTime(limiter.blockedUntil + 1);
    await adsbGet('/b', { fetchFn, limiter });
    expect((limiter.blockedUntil - at()) / 1000).toBe(400); // Retry-After por encima del máximo adaptativo: se respeta
    vi.setSystemTime(limiter.blockedUntil + 11 * MIN);
    await adsbGet('/c', { fetchFn, limiter });
    expect((limiter.blockedUntil - at()) / 1000).toBe(ADSB_DEFAULT_COOLDOWN_MS / 1000);
    expect(ADSB_MAX_COOLDOWN_MS).toBe(300000);
  });
  it('el máximo de peticiones por minuto nunca sube solo', () => {
    const limiter = createLimiter();
    limiter.rateLimited(null);
    for (let i = 0; i < 50; i++) limiter.succeeded();
    expect(limiter.maxPerWindow).toBe(3);
  });
});
