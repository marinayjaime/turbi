// /health: diagnóstico de adsb.lol sin hacer ninguna consulta nueva a adsb.lol. Se actualiza en el acceso
// centralizado (server/adsb.mjs), así cubre las consultas por indicativo, zona y hex.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { adsbLimiter, adsbGet, adsbHealth, ADSB_DEFAULT_COOLDOWN_MS } from '../server/adsb.mjs';
import { createState, handle } from '../server/live.mjs';

const T0 = Date.parse('2026-09-25T10:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }); adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });
afterEach(() => vi.useRealTimers());

const health = () => JSON.parse(handle(createState(), '/health').body);
const adsbHealthNow = () => adsbHealth();
const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => ({ ac: [] }) });

describe('/health.adsb', () => {
  it('mantiene los campos actuales y añade adsb (sin nada sensible)', () => {
    const h = health();
    for (const k of ['updated', 'runs', 'audit', 'lastError', 'flights']) expect(h).toHaveProperty(k);
    expect(h.adsb).toEqual({
      blocked: false, blockedUntil: null, retryInSec: 0, last429At: null, lastSuccessAt: null, lastErrorAt: null,
      lastError: null, lastStatus: null, rateLimitedCount: 0, successCount: 0, failedCount: 0, backoffStrikes: 0, lastCooldownSec: null,
      lastAttemptAt: null, lastAttemptEndpoint: null, lastFailureKind: null, localRateLimitedCount: 0,
      attemptsByEndpoint: {}, rateLimitedByEndpoint: {}, lastRateLimitHeaders: null, last429Headers: null,
      pendingRadar: 0, pendingIdentification: 0,
    });
    expect(h.radar).toMatchObject({ requests: 0, cacheHits: 0, directLookups: 0, directFound: 0,
      identificationStarted: 0, identificationBusyPolls: 0, identificationSucceeded: 0, blockedReasons: {} });
  });
  it('1. un 429 → blocked, blockedUntil (la pausa global real), last429At, contador y segundos restantes', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(429, { 'retry-after': '30' })) });
    const a = health().adsb;
    expect(a).toMatchObject({ blocked: true, retryInSec: 30, last429At: new Date(T0).toISOString(), lastError: '429', lastStatus: 429, rateLimitedCount: 1, failedCount: 0 });
    expect(a.blockedUntil).toBe(new Date(adsbLimiter.blockedUntil).toISOString());
    vi.setSystemTime(T0 + 12500);
    expect(health().adsb.retryInSec).toBe(18); // hacia arriba
  });
  it('2. durante la pausa, /health no provoca ninguna llamada externa (ni las consultas tampoco)', async () => {
    const fetchFn = vi.fn(async () => res(429));
    await adsbGet('/point/1/1/150', { fetchFn, priority: 'identificacion' });
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no debe llamarse'); });
    try {
      for (let i = 0; i < 3; i++) health();
      await adsbGet('/hex/abc', { fetchFn });
      expect(spy).not.toHaveBeenCalled();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(health().adsb).toMatchObject({ blocked: true, rateLimitedCount: 1 }); // lo rechazado en pausa no cuenta como otro 429
    } finally { spy.mockRestore(); }
  });
  it('3. una respuesta 200 → lastSuccessAt, successCount y lastStatus', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(200)) });
    expect(health().adsb).toMatchObject({ lastSuccessAt: new Date(T0).toISOString(), successCount: 1, lastStatus: 200, lastError: null, blocked: false });
  });
  it('4. tiempo agotado o fallo de red → error, pero no 429 (ni pausa)', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) });
    expect(health().adsb).toMatchObject({ lastError: 'timeout', lastErrorAt: new Date(T0).toISOString(), failedCount: 1, rateLimitedCount: 0, blocked: false, last429At: null });
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => { throw new TypeError('fetch failed'); }) });
    expect(health().adsb).toMatchObject({ lastError: 'network', failedCount: 2, rateLimitedCount: 0, blocked: false });
  });
  it('5. 5xx, 403 y otros 4xx quedan diferenciados', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(503)) });
    expect(health().adsb).toMatchObject({ lastError: '5xx', lastStatus: 503, failedCount: 1, rateLimitedCount: 0, blocked: false });
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(403)) });
    expect(health().adsb).toMatchObject({ lastError: '403', lastStatus: 403, failedCount: 2 });
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(404)) });
    expect(health().adsb).toMatchObject({ lastError: '4xx', lastStatus: 404, failedCount: 3 });
  });
  it('un acierto posterior no borra el último error (queda con su fecha para el diagnóstico)', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(503)) });
    vi.setSystemTime(T0 + 5000);
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(200)) });
    expect(health().adsb).toMatchObject({ lastError: '5xx', lastErrorAt: new Date(T0).toISOString(), lastSuccessAt: new Date(T0 + 5000).toISOString(), lastStatus: 200 });
  });
  it('6. al terminar la pausa → blocked=false y 0 s (el histórico del 429 se conserva)', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(429)) });
    vi.setSystemTime(T0 + ADSB_DEFAULT_COOLDOWN_MS + 1);
    expect(health().adsb).toMatchObject({ blocked: false, retryInSec: 0, rateLimitedCount: 1, last429At: new Date(T0).toISOString() });
  });
  it('consultas esperando, por prioridad', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const fetchFn = vi.fn(async () => { await gate; return res(200); });
    const all = [adsbGet('/callsign/A', { fetchFn }), adsbGet('/callsign/B', { fetchFn }), adsbGet('/point/1/1/1', { fetchFn, priority: 'identificacion' })];
    await Promise.resolve();
    expect(health().adsb).toMatchObject({ pendingRadar: 1, pendingIdentification: 1 });
    release();
    await Promise.all(all);
    expect(health().adsb).toMatchObject({ pendingRadar: 0, pendingIdentification: 0, successCount: 3 });
  });
});

// Diagnóstico del 429 desde Render (20/10/2026): adsb.lol publica sus límites en cabeceras (x-ratelimit-*, sin
// Retry-After). /health guarda las de la última respuesta y las del último 429 real, saneadas y con lista cerrada.
describe('/health.adsb: diagnóstico de los límites de adsb.lol', () => {
  const RL = { 'x-ratelimit-limit': '4, 4;w=1, 60;w=60, 500;w=86400', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '41234', 'x-envoy-ratelimited': 'true' };

  it('lastAttemptAt y lastAttemptEndpoint solo cuando sale una petición real a adsb.lol', async () => {
    await adsbGet('/callsign/RYR1104', { fetchFn: vi.fn(async () => res(200)) });
    expect(health().adsb).toMatchObject({ lastAttemptAt: new Date(T0).toISOString(), lastAttemptEndpoint: 'callsign', attemptsByEndpoint: { callsign: 1 } });
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(429, RL)) });
    vi.setSystemTime(T0 + 5000);
    const fetchFn = vi.fn();
    await adsbGet('/hex/abc', { fetchFn }); // en pausa: respuesta local, sin llamar
    expect(fetchFn).not.toHaveBeenCalled();
    expect(health().adsb).toMatchObject({ lastAttemptAt: new Date(T0).toISOString(), lastAttemptEndpoint: 'callsign', attemptsByEndpoint: { callsign: 2 } });
  });

  it('un 429 real y una respuesta local «rate-limited» se cuentan por separado', async () => {
    await adsbGet('/point/1/1/150', { fetchFn: vi.fn(async () => res(429, RL)), priority: 'identificacion' });
    await adsbGet('/hex/abc', { fetchFn: vi.fn() });
    await adsbGet('/callsign/X', { fetchFn: vi.fn() });
    expect(health().adsb).toMatchObject({ rateLimitedCount: 1, localRateLimitedCount: 2, lastFailureKind: 'rate-limit', lastError: '429',
      rateLimitedByEndpoint: { point: 1 }, attemptsByEndpoint: { point: 1 } });
  });

  it('guarda las cabeceras de límite del último 429 y de la última respuesta', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(200, { 'x-ratelimit-limit': '4, 4;w=1, 60;w=60, 500;w=86400', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1' })) });
    expect(health().adsb.lastRateLimitHeaders).toEqual({ at: new Date(T0).toISOString(), status: 200, endpoint: 'callsign',
      'x-ratelimit-limit': '4, 4;w=1, 60;w=60, 500;w=86400', 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1' });
    expect(health().adsb.last429Headers).toBeNull();
    vi.setSystemTime(T0 + 6000);
    await adsbGet('/point/1/1/150', { fetchFn: vi.fn(async () => res(429, RL)) });
    const a = health().adsb;
    expect(a.last429Headers).toEqual({ at: new Date(T0 + 6000).toISOString(), status: 429, endpoint: 'point', ...RL });
    expect(a.lastRateLimitHeaders).toEqual(a.last429Headers);
  });

  it('el 429 de adsb.lol sin Retry-After sigue con la pausa actual (no se usa x-ratelimit-reset todavía)', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(429, RL)) });
    expect(health().adsb).toMatchObject({ blocked: true, retryInSec: ADSB_DEFAULT_COOLDOWN_MS / 1000, lastCooldownSec: ADSB_DEFAULT_COOLDOWN_MS / 1000 });
  });

  it('tipos de fallo: rate-limit, http, timeout, network y parse', async () => {
    const kinds = [];
    const run = async fetchFn => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); await adsbGet('/hex/a', { fetchFn }); kinds.push(health().adsb.lastFailureKind); };
    await run(vi.fn(async () => res(429)));
    await run(vi.fn(async () => res(503)));
    await run(vi.fn(async () => res(403)));
    await run(vi.fn(async () => res(404)));
    await run(vi.fn(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }));
    await run(vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await run(vi.fn(async () => ({ ...res(200), json: async () => { throw new SyntaxError('bad json'); } })));
    expect(kinds).toEqual(['rate-limit', 'http', 'http', 'http', 'timeout', 'network', 'parse']);
  });

  it('ningún dato sensible: solo cabeceras de la lista, sin cookies, URL, indicativo ni IP; valores saneados', async () => {
    const headers = { ...RL, 'set-cookie': 'globe-reapi-sticky3=secreto; HttpOnly', 'x-forwarded-for': '10.1.2.3', authorization: 'Bearer x',
      'x-ratelimit-reset': '1\r\nX-Inyectada: sí' + 'x'.repeat(300), server: 'istio-envoy' };
    await adsbGet('/callsign/SECRETO123', { fetchFn: vi.fn(async () => res(429, headers)) });
    const json = JSON.stringify(health());
    for (const bad of ['secreto', 'sticky', '10.1.2.3', 'Bearer', 'SECRETO123', 'api.adsb.lol', 'X-Inyectada: sí', 'istio']) expect(json).not.toContain(bad);
    const h = health().adsb.last429Headers;
    expect(Object.keys(h).sort()).toEqual(['at', 'endpoint', 'status', 'x-envoy-ratelimited', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']);
    expect(h['x-ratelimit-reset'].length).toBeLessThanOrEqual(120);
    expect(h['x-ratelimit-reset']).toMatch(/^[\w ,;=.:/-]*$/);
  });

  it('una identificación cancelada por un 429 cuenta como respuesta local, no como 429 ni como intento', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const radar = adsbGet('/callsign/X', { fetchFn: vi.fn(async () => { await gate; return res(429, RL); }) });
    const identify = adsbGet('/point/1/1/150', { fetchFn: vi.fn(), priority: 'identificacion' });
    await Promise.resolve();
    release();
    expect(await radar).toEqual({ error: 'rate-limited' });
    expect(await identify).toEqual({ error: 'rate-limited' });
    expect(health().adsb).toMatchObject({ rateLimitedCount: 1, localRateLimitedCount: 1, attemptsByEndpoint: { callsign: 1 }, rateLimitedByEndpoint: { callsign: 1 } });
  });

  it('una URL completa que no es de adsb.lol nunca se etiqueta como traza', async () => {
    const { endpointKind } = await import('../server/adsb.mjs');
    expect(endpointKind('https://adsb.lol/data/traces/5e/trace_full_4d225e.json')).toBe('trace');
    expect(endpointKind('https://otro.example/traces/x')).toBe('other');
    expect(endpointKind('/RYR123/x')).toBe('other');
    expect(endpointKind('/point/1/2/3?k=v')).toBe('point');
  });

  it('/health devuelve copias: modificar la respuesta no cambia el estado interno', async () => {
    await adsbGet('/callsign/X', { fetchFn: vi.fn(async () => res(429, RL)) });
    const h = adsbHealthNow();
    h.attemptsByEndpoint.callsign = 99;
    h.last429Headers['x-ratelimit-reset'] = 'x';
    expect(adsbHealthNow()).toMatchObject({ attemptsByEndpoint: { callsign: 1 }, last429Headers: { 'x-ratelimit-reset': '41234' } });
  });

  it('las trazas (URL completa de adsb.lol) cuentan como endpoint «trace», sin guardar la URL', async () => {
    await adsbGet('https://adsb.lol/data/traces/5e/trace_full_4d225e.json', { fetchFn: vi.fn(async () => res(200)) });
    expect(health().adsb).toMatchObject({ lastAttemptEndpoint: 'trace', attemptsByEndpoint: { trace: 1 } });
    expect(JSON.stringify(health())).not.toContain('4d225e');
  });
});
