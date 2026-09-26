import { describe, it, expect, vi } from 'vitest';
import { lookupFlight, lookupFlightResult, canonicalRoute } from '../js/flight.js';

const ADSBDB_OK = {
  response: { flightroute: {
    callsign: 'VY3902', callsign_iata: 'VY3902',
    airline: { name: 'Vueling Airlines' },
    origin: { iata_code: 'BCN', name: 'Josep Tarradellas Barcelona-El Prat Airport', municipality: 'Barcelona', latitude: 41.2971, longitude: 2.07846 },
    destination: { iata_code: 'PMI', name: 'Palma de Mallorca Airport', municipality: 'Palma De Mallorca', latitude: 39.551701, longitude: 2.73881 },
  } },
};
const ok = body => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));

describe('lookupFlight', () => {
  it('normaliza el número y devuelve la ruta', async () => {
    const f = ok(ADSBDB_OK);
    const r = await lookupFlight(' vy 3902 ', f);
    expect(f.mock.calls[0][0]).toBe('https://api.adsbdb.com/v0/callsign/VY3902');
    expect(r).toEqual({
      number: 'VY3902', airline: 'Vueling Airlines',
      origin: { iata: 'BCN', name: 'Josep Tarradellas Barcelona-El Prat Airport', city: 'Barcelona', lat: 41.2971, lon: 2.07846 },
      destination: { iata: 'PMI', name: 'Palma de Mallorca Airport', city: 'Palma De Mallorca', lat: 39.551701, lon: 2.73881 },
    });
  });
  it('404 → null', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ response: 'unknown callsign' }) }));
    expect(await lookupFlight('XX9999', f)).toBeNull();
  });
  it('respuesta sin flightroute → null', async () => {
    expect(await lookupFlight('VY3902', ok({ response: 'unknown callsign' }))).toBeNull();
  });
  it('error de red → null', async () => {
    expect(await lookupFlight('VY3902', vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toBeNull();
  });
  it('si adsbdb no responde, se rinde tras el tiempo límite → null', async () => {
    const hang = vi.fn((url, opts) => new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    }));
    const t0 = Date.now();
    expect(await lookupFlight('VY3902', hang, 50)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 2000);
  it('aeropuerto sin coordenadas → null (se abre la entrada manual)', async () => {
    const body = structuredClone(ADSBDB_OK);
    delete body.response.flightroute.destination.latitude;
    expect(await lookupFlight('VY3902', ok(body))).toBeNull();
  });
  it('formato inválido → null sin llamar a la API', async () => {
    const f = ok(ADSBDB_OK);
    expect(await lookupFlight('hola', f)).toBeNull();
    expect(await lookupFlight('', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('canonicalRoute', () => {
  const db = { HND: ['Tokyo Haneda International Airport', 'Tokyo', 35.5497, 139.787, 'Asia/Tokyo'],
    HKG: ['Hong Kong International Airport', 'Hong Kong', 22.3118, 113.9149, 'Asia/Hong_Kong'] };
  const raw = { number: 'UO625', airline: 'Hong Kong Express',
    origin: { iata: 'HND', name: 'Haneda', city: 'Tokyo', lat: 35.55, lon: 139.78 },
    destination: { iata: 'HKG', name: 'Chek Lap Kok', city: 'HK', lat: 22.31, lon: 113.91 } };
  it('sustituye los aeropuertos de ADSBDB por los de data/airports.json (con zona horaria)', () => {
    expect(canonicalRoute(raw, db)).toEqual({ number: 'UO625', airline: 'Hong Kong Express',
      origin: { iata: 'HND', name: 'Tokyo Haneda International Airport', city: 'Tokyo', lat: 35.5497, lon: 139.787, tz: 'Asia/Tokyo' },
      destination: { iata: 'HKG', name: 'Hong Kong International Airport', city: 'Hong Kong', lat: 22.3118, lon: 113.9149, tz: 'Asia/Hong_Kong' } });
  });
  it('origen o destino desconocido (o sin código) → null', () => {
    expect(canonicalRoute({ ...raw, destination: { ...raw.destination, iata: 'ZZZ' } }, db)).toBeNull();
    expect(canonicalRoute({ ...raw, origin: { ...raw.origin, iata: undefined } }, db)).toBeNull();
  });
});

describe('lookupFlightResult: qué significa cada respuesta de ADSBDB', () => {
  const status = code => vi.fn(async () => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({ response: 'x' }) }));
  it('ruta → found con los IATA', async () => {
    expect(await lookupFlightResult('VY3902', ok(ADSBDB_OK))).toMatchObject({ status: 'found', iata: ['BCN', 'PMI'], flight: { number: 'VY3902' } });
  });
  it('ruta sin coordenadas → found, pero sin ruta utilizable', async () => {
    const body = structuredClone(ADSBDB_OK);
    delete body.response.flightroute.origin.latitude;
    expect(await lookupFlightResult('VY3902', ok(body))).toEqual({ status: 'found', flight: null, iata: ['BCN', 'PMI'] });
  });
  it('404 o respuesta sin ruta → unknown', async () => {
    expect(await lookupFlightResult('XX9999', status(404))).toEqual({ status: 'unknown' });
    expect(await lookupFlightResult('VY3902', ok({ response: 'unknown callsign' }))).toEqual({ status: 'unknown' });
  });
  it('429, 5xx, red o tiempo límite → error (fallo temporal, no «desconocido»)', async () => {
    expect(await lookupFlightResult('VY3902', status(429))).toEqual({ status: 'error' });
    expect(await lookupFlightResult('VY3902', status(503))).toEqual({ status: 'error' });
    expect(await lookupFlightResult('VY3902', vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).toEqual({ status: 'error' });
    const hang = vi.fn((url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new DOMException('t', 'TimeoutError')))));
    expect(await lookupFlightResult('VY3902', hang, 30)).toEqual({ status: 'error' });
  });
});
