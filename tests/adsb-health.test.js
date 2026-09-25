// /health: diagnóstico de adsb.lol sin hacer ninguna consulta nueva a adsb.lol. Se actualiza en el acceso
// centralizado (server/adsb.mjs), así cubre las consultas por indicativo, zona y hex.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { adsbLimiter, adsbGet, ADSB_DEFAULT_COOLDOWN_MS } from '../server/adsb.mjs';
import { createState, handle } from '../server/live.mjs';

const T0 = Date.parse('2026-09-25T10:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 }); adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });
afterEach(() => vi.useRealTimers());

const health = () => JSON.parse(handle(createState(), '/health').body);
const res = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => ({ ac: [] }) });

describe('/health.adsb', () => {
  it('mantiene los campos actuales y añade adsb (sin nada sensible)', () => {
    const h = health();
    for (const k of ['updated', 'runs', 'audit', 'lastError', 'flights']) expect(h).toHaveProperty(k);
    expect(h.adsb).toEqual({
      blocked: false, blockedUntil: null, retryInSec: 0, last429At: null, lastSuccessAt: null, lastErrorAt: null,
      lastError: null, lastStatus: null, rateLimitedCount: 0, successCount: 0, failedCount: 0, pendingRadar: 0, pendingIdentification: 0,
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
