// Ritmo conservador con adsb.lol (producción, 25/09/2026: 3 aciertos y un 429 a los 1,5 s). Valores reales del
// limitador (sin ponerlos a 0) y reloj simulado: ninguna petición sale a menos de 5 s de la anterior, la
// identificación deja 8 s y el radar (indicativo y hex) va siempre por delante.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLimiter, adsbGet, adsbLimiter, ADSB_MIN_INTERVAL_MS, ADSB_IDENTIFY_INTERVAL_MS, ADSB_DEFAULT_COOLDOWN_MS } from '../server/adsb.mjs';
import { createState, radarResponse } from '../server/live.mjs';

const T0 = Date.parse('2026-09-25T10:00:00Z');
beforeEach(() => vi.useFakeTimers({ now: T0 }));
afterEach(() => vi.useRealTimers());

const ok = () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ac: [] }) });
const tooMany = () => ({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) });
// Deja correr el reloj simulado hasta que terminen las promesas.
async function settle(promises, stepMs = 250, maxMs = 120000) {
  let done = false;
  const all = Promise.all(promises).then(r => { done = true; return r; });
  for (let t = 0; t < maxMs && !done; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  return all;
}

describe('ritmo global de adsb.lol', () => {
  it('valores: 5 s entre peticiones de radar y 8 s para la identificación; pausa de 60 s sin Retry-After', () => {
    expect(ADSB_MIN_INTERVAL_MS).toBe(5000);
    expect(ADSB_IDENTIFY_INTERVAL_MS).toBe(8000);
    expect(ADSB_DEFAULT_COOLDOWN_MS).toBe(60000);
  });
  it('ninguna petición sale a menos de 5 s de la anterior (vuelos y usuarios distintos, todo a la vez)', async () => {
    const limiter = createLimiter();
    const starts = [];
    const fetchFn = vi.fn(async url => { starts.push({ t: Date.now(), kind: url.split('/')[4] }); return ok(); });
    const calls = [
      ...['IBE1', 'AEA2', 'RYR3', 'VLG4'].map(cs => adsbGet(`/callsign/${cs}`, { fetchFn, limiter })),
      adsbGet('/hex/abc123', { fetchFn, limiter }),
      ...[1, 2].map(i => adsbGet(`/point/${i}/1/150`, { fetchFn, limiter, priority: 'identificacion' })),
    ];
    await settle(calls);
    expect(starts).toHaveLength(7);
    for (let i = 1; i < starts.length; i++) expect(starts[i].t - starts[i - 1].t).toBeGreaterThanOrEqual(5000);
  });
  it('la identificación deja al menos 8 s desde la petición anterior, sea del tipo que sea', async () => {
    const limiter = createLimiter();
    const starts = [];
    const fetchFn = vi.fn(async url => { starts.push({ t: Date.now(), kind: url.split('/')[4] }); return ok(); });
    await settle([adsbGet('/callsign/A', { fetchFn, limiter }), adsbGet('/point/1/1/150', { fetchFn, limiter, priority: 'identificacion' }),
      adsbGet('/point/2/2/150', { fetchFn, limiter, priority: 'identificacion' })]);
    expect(starts.map(s => s.kind)).toEqual(['callsign', 'point', 'point']);
    expect(starts[1].t - starts[0].t).toBeGreaterThanOrEqual(8000);
    expect(starts[2].t - starts[1].t).toBeGreaterThanOrEqual(8000);
  });
  it('el radar (indicativo y hex) pasa por delante de la identificación, aunque esta llegara antes', async () => {
    const limiter = createLimiter();
    const order = [];
    const fetchFn = vi.fn(async url => { order.push(url.split('/v2/')[1]); return ok(); });
    const first = adsbGet('/callsign/A', { fetchFn, limiter });
    const ident = adsbGet('/point/1/1/150', { fetchFn, limiter, priority: 'identificacion' });
    await vi.advanceTimersByTimeAsync(3000); // la identificación espera sus 8 s…
    const hex = adsbGet('/hex/abc123', { fetchFn, limiter }); // …y llega el seguimiento por hex
    const cs = adsbGet('/callsign/B', { fetchFn, limiter });
    await settle([first, ident, hex, cs]);
    expect(order).toEqual(['callsign/A', 'hex/abc123', 'callsign/B', 'point/1/1/150']);
  });
  it('un 429 sigue cancelando la identificación pendiente y abre la pausa: cero llamadas hasta que acaba', async () => {
    const limiter = createLimiter();
    let n = 0;
    const fetchFn = vi.fn(async () => (++n === 1 ? tooMany() : ok()));
    const results = await settle([adsbGet('/callsign/A', { fetchFn, limiter }),
      adsbGet('/point/1/1/150', { fetchFn, limiter, priority: 'identificacion' }),
      adsbGet('/point/2/2/150', { fetchFn, limiter, priority: 'identificacion' })]);
    expect(results.map(r => r.error)).toEqual(['rate-limited', 'rate-limited', 'rate-limited']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ADSB_DEFAULT_COOLDOWN_MS - 2000);
    expect((await adsbGet('/callsign/B', { fetchFn, limiter })).error).toBe('rate-limited');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    const after = await settle([adsbGet('/callsign/B', { fetchFn, limiter })]);
    expect(after[0].data).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('cachés: el mismo avión no genera tráfico repetido', () => {
  const PMI = [39.5517, 2.73881], LBA = [53.8659, -1.66057];
  const leg = { al: 'FR', icao: 'RYR', n: '2311', d: '2026-09-25', o: 'PMI', a: 'LBA', sd: '09:25', ed: '2026-09-25T09:27', st: 'BOR', std: 'BOR', sta: null, ac: '738W', op: 'FR' };
  const codeshare = { ...leg, al: 'EI', icao: 'EIN', n: '8311', op: 'FR' };
  const plane = { hex: '4d225e', flight: 'RYR19HB ', t: 'B738', lat: 45.0, lon: 0.6, track: 345, alt_baro: 37000, gs: 450, seen: 1, seen_pos: 1 };
  it('seguimiento por hex ya conocido: una sola consulta en 60 s, para dos usuarios y para el código compartido', async () => {
    adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0 });
    const calls = [];
    const fetchFn = vi.fn(async url => { calls.push(url); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ac: url.includes('/hex/') ? [plane] : [] }) }; });
    const state = createState();
    state.legs = [leg, codeshare];
    await state.hexes.resolve('phys|2026-09-25|PMI|LBA|09:25', async () => ({ state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' }), T0);
    const airports = { PMI: ['', '', ...PMI], LBA: ['', '', ...LBA] };
    const now = Date.parse('2026-09-25T08:57:00Z');
    const ask = (path, t) => radarResponse(state, path, { fetchFn, nowMs: t, pauseMs: 0, airports }).then(r => JSON.parse(r.body));
    expect(await ask('/radar/FR/2311.json', now)).toMatchObject({ state: 'volando', hex: '4d225e' });
    expect(await ask('/radar/FR/2311.json', now + 20000)).toMatchObject({ state: 'volando', hex: '4d225e' }); // otro usuario
    expect(await ask('/radar/EI/8311.json', now + 30000)).toMatchObject({ state: 'volando', hex: '4d225e' }); // código compartido
    expect(calls.filter(u => u.includes('/v2/'))).toEqual(['https://api.adsb.lol/v2/hex/4d225e']);
  });
});
