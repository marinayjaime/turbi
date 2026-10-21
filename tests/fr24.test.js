// Prueba de Flightradar24 (server/fr24.mjs): solo bajo demanda en /fr24-test/<vuelo>.json; /health solo dice si la clave
// existe. La clave nunca aparece en ninguna respuesta.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fr24Lookup, fr24TestResponse, fr24Configured, normalizeFlight, FR24_BASE } from '../server/fr24.mjs';
import { createState, handle } from '../server/live.mjs';

const TOKEN = 'tok_SECRETO_1234567890abcdef';
const env = { FR24_API_TOKEN: TOKEN };
const json = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null },
  json: async () => body });
const ITEM = {
  fr24_id: '3a1b2c3d', flight: 'XX123', callsign: 'XXX123', lat: 40.12345, lon: -3.5678, track: 72, alt: 23475, gspeed: 410, vspeed: 1536,
  squawk: '1234', timestamp: '2026-10-21T05:50:00Z', source: 'ADSB', hex: '34ABCD', type: 'A321', reg: 'EC-ABC',
  painted_as: 'XXX', operating_as: 'XXX', orig_iata: 'AAA', orig_icao: 'LAAA', dest_iata: 'BBB', dest_icao: 'LBBB', eta: '2026-10-21T06:25:00Z',
};
const noToken = s => expect(s).not.toContain(TOKEN);

afterEach(() => vi.restoreAllMocks());

describe('fr24Lookup', () => {
  it('sin clave: no llama a FR24 y responde unavailable', async () => {
    const fetchFn = vi.fn();
    expect(await fr24Lookup('XX123', { fetchFn, env: {} })).toEqual({ state: 'unavailable', reason: 'sin-configurar', flight: 'XX123' });
    expect(await fr24Lookup('XX123', { fetchFn, env: { FR24_API_TOKEN: '  ' } })).toMatchObject({ state: 'unavailable', reason: 'sin-configurar' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('pide exactamente el endpoint oficial con las cabeceras obligatorias', async () => {
    const fetchFn = vi.fn(async () => json(200, { data: [ITEM] }));
    await fr24Lookup('XX123', { fetchFn, env });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe(`${FR24_BASE}/live/flight-positions/full?flights=XX123&limit=5`);
    expect(opts.headers).toEqual({ Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${TOKEN}` });
    expect(opts.signal).toBeDefined();
  });

  it('un vuelo: found con todos los campos normalizados', async () => {
    const r = await fr24Lookup('XX123', { fetchFn: vi.fn(async () => json(200, { data: [ITEM] })), env });
    expect(r).toEqual({
      state: 'found', flight: 'XX123', fr24Id: '3a1b2c3d', callsign: 'XXX123', lat: 40.12345, lon: -3.5678, track: 72, alt: 23475,
      gspeed: 410, vspeed: 1536, timestamp: '2026-10-21T05:50:00Z', source: 'ADSB', hex: '34ABCD', type: 'A321', reg: 'EC-ABC',
      operatingAs: 'XXX', paintedAs: 'XXX', originIata: 'AAA', destinationIata: 'BBB', eta: '2026-10-21T06:25:00Z',
    });
  });

  it('ningún resultado: not-found', async () => {
    expect(await fr24Lookup('XX123', { fetchFn: vi.fn(async () => json(200, { data: [] })), env })).toEqual({ state: 'not-found', flight: 'XX123' });
    expect(await fr24Lookup('XX123', { fetchFn: vi.fn(async () => json(200, {})), env })).toEqual({ state: 'not-found', flight: 'XX123' });
  });

  it('varios resultados: no elige ninguno; devuelve todos los candidatos para diagnosticar', async () => {
    const other = { ...ITEM, fr24_id: '9f8e7d6c', orig_iata: 'BBB', dest_iata: 'CCC', timestamp: '2026-10-21T05:49:00Z', hex: '34FFFF' };
    const r = await fr24Lookup('XX123', { fetchFn: vi.fn(async () => json(200, { data: [ITEM, other] })), env });
    expect(r.state).toBe('multiple');
    expect(r).not.toHaveProperty('fr24Id');
    expect(r).not.toHaveProperty('lat');
    expect(r.candidates.map(c => [c.fr24Id, c.originIata, c.destinationIata, c.timestamp])).toEqual([
      ['3a1b2c3d', 'AAA', 'BBB', '2026-10-21T05:50:00Z'], ['9f8e7d6c', 'BBB', 'CCC', '2026-10-21T05:49:00Z']]);
  });

  it.each([[401, 'autorizacion'], [403, 'autorizacion'], [429, 'limite'], [500, 'servidor'], [503, 'servidor'], [404, 'http']])(
    'HTTP %i → unavailable (%s), sin reintentar', async (status, reason) => {
      const fetchFn = vi.fn(async () => json(status, { message: `error ${TOKEN}` }, { 'retry-after': '30' }));
      const r = await fr24Lookup('XX123', { fetchFn, env });
      expect(r).toMatchObject({ state: 'unavailable', reason, httpStatus: status, flight: 'XX123' });
      if (status === 429) expect(r.retryAfterSec).toBe(30);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      noToken(JSON.stringify(r));
    });

  it('tiempo agotado y error de red → unavailable, sin reintentar', async () => {
    const timeout = vi.fn(async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }); });
    expect(await fr24Lookup('XX123', { fetchFn: timeout, env })).toEqual({ state: 'unavailable', reason: 'timeout', flight: 'XX123' });
    const network = vi.fn(async () => { throw new TypeError(`fetch failed ${TOKEN}`); });
    const r = await fr24Lookup('XX123', { fetchFn: network, env });
    expect(r).toEqual({ state: 'unavailable', reason: 'red', flight: 'XX123' });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('respuesta que no es JSON → unavailable', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('x'); } }));
    expect(await fr24Lookup('XX123', { fetchFn, env })).toEqual({ state: 'unavailable', reason: 'respuesta-invalida', flight: 'XX123' });
  });

  it('el token nunca aparece en la respuesta, ni aunque FR24 lo devolviera en un campo', async () => {
    const leaky = { ...ITEM, callsign: TOKEN, reg: `x${TOKEN}`, extra: TOKEN };
    const r = await fr24Lookup('XX123', { fetchFn: vi.fn(async () => json(200, { data: [leaky] })), env });
    noToken(JSON.stringify(r));
    expect(r).not.toHaveProperty('extra');
  });
});

describe('normalizeFlight', () => {
  it('solo campos conocidos, números finitos y textos cortos y seguros', () => {
    const n = normalizeFlight({ ...ITEM, lat: 'x', alt: NaN, reg: 'EC-ABC\r\nX-Inyectada: 1', callsign: 'A'.repeat(200), foo: 'bar' });
    expect(n.lat).toBeNull();
    expect(n.alt).toBeNull();
    expect(n.reg).toBe('EC-ABC');
    expect(n.callsign.length).toBeLessThanOrEqual(40);
    expect(n).not.toHaveProperty('foo');
  });
});

describe('/fr24-test/<vuelo>.json', () => {
  it('valida estrictamente el número de vuelo (sin llamar a FR24 si no es válido)', async () => {
    const fetchFn = vi.fn(async () => json(200, { data: [ITEM] }));
    for (const bad of ['/fr24-test/..%2F..%2Fetc.json', '/fr24-test/XX123?x=1.json', '/fr24-test/X.json', '/fr24-test/XX12345678.json',
      '/fr24-test/XX%26limit%3D100.json', '/fr24-test/XX-123.json', '/fr24-test/123.json', '/fr24-test/XX123', '/fr24-test/']) {
      const r = await fr24TestResponse(bad, { fetchFn, env });
      expect(r.status).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('acepta números de vuelo IATA/OACI en mayúsculas o minúsculas y responde sin caché', async () => {
    const fetchFn = vi.fn(async () => json(200, { data: [ITEM] }));
    for (const ok of ['/fr24-test/XX123.json', '/fr24-test/xx123.json', '/fr24-test/IB403.json', '/fr24-test/RYR19HB.json', '/fr24-test/U21234.json', '/fr24-test/FR1104A.json']) {
      const r = await fr24TestResponse(ok, { fetchFn, env });
      expect(r.status).toBe(200);
      expect(r.headers['Cache-Control']).toBe('no-store');
    }
    expect(fetchFn.mock.calls[1][0]).toContain('flights=XX123&');
  });

  it('el token nunca aparece en la respuesta del endpoint en ningún caso', async () => {
    const cases = [json(200, { data: [ITEM] }), json(200, { data: [ITEM, ITEM] }), json(200, { data: [] }), json(401, {}), json(429, {}), json(500, {})];
    for (const res of cases) noToken((await fr24TestResponse('/fr24-test/XX123.json', { fetchFn: vi.fn(async () => res), env })).body);
    noToken((await fr24TestResponse('/fr24-test/XX123.json', { fetchFn: vi.fn(async () => { throw new Error(TOKEN); }), env })).body);
  });
});

describe('/health.fr24', () => {
  it('solo dice si la clave existe; nunca llama a FR24 ni devuelve la clave', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no debe llamarse'); });
    const prev = process.env.FR24_API_TOKEN;
    try {
      process.env.FR24_API_TOKEN = TOKEN;
      const body = handle(createState(), '/health').body;
      expect(JSON.parse(body).fr24).toEqual({ configured: true });
      noToken(body);
      delete process.env.FR24_API_TOKEN;
      expect(JSON.parse(handle(createState(), '/health').body).fr24).toEqual({ configured: false });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.FR24_API_TOKEN; else process.env.FR24_API_TOKEN = prev;
    }
  });
  it('fr24Configured', () => {
    expect(fr24Configured({})).toBe(false);
    expect(fr24Configured({ FR24_API_TOKEN: '' })).toBe(false);
    expect(fr24Configured(env)).toBe(true);
  });
});
