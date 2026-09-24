import { describe, it, expect, vi } from 'vitest';
import { lookupFlight } from '../js/flight.js';

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
  it('formato inválido → null sin llamar a la API', async () => {
    const f = ok(ADSBDB_OK);
    expect(await lookupFlight('hola', f)).toBeNull();
    expect(await lookupFlight('', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
