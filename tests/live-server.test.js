import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { createState, runCycle, handle, needsRefresh, radarResponse } from '../server/live.mjs';

const row = over => ({
  iataCompania: 'IB', oaciCompania: 'IBE', nombreCompania: 'Iberia', numVuelo: '1668',
  fecha: '24/09/2026', horaProgramada: '17:55:00', fechaEstimada: '24/09/2026', horaEstimada: '18:44:00',
  iataOtro: 'MAD', estado: 'BOR', terminal: 'N', puertaPrimera: 'D86', tipoAeronave: 'A21N', ...over,
});
const entries = [
  { airport: 'PMI', type: 'S', row: row() },
  { airport: 'MAD', type: 'L', row: row({ iataOtro: 'PMI', horaProgramada: '19:25:00', horaEstimada: '20:10:00', estado: 'BOR', puertaPrimera: 'null' }) },
];
const deps = { fetchAenaFn: async () => ({ entries, failed: [] }), now: () => new Date('2026-09-24T18:45:00Z'), today: () => '2026-09-24' };

describe('runCycle', () => {
  it('publica los vuelos de hoy/mañana tal cual los da Aena, con la auditoría', async () => {
    const state = createState();
    await runCycle(state, deps);
    expect(state.flights.get('IB/1668.json').legs[0]).toMatchObject({ ed: '2026-09-24T18:44', ea: '2026-09-24T20:10', g: 'D86' });
    expect(state.flights.get('IB/1668.json').updated).toBe('2026-09-24T18:45:00.000Z');
    expect(state.audit).toEqual({ checked: 2, mismatches: 0, duplicates: 0 });
  });
  it('si Aena falla, conserva lo anterior y anota el error', async () => {
    const state = createState();
    await runCycle(state, deps);
    await expect(runCycle(state, { ...deps, fetchAenaFn: async () => ({ entries: [], failed: new Array(86).fill({}) }) })).rejects.toThrow('Aena no disponible');
    expect(state.flights.has('IB/1668.json')).toBe(true);
  });
});

describe('handle (servidor)', () => {
  it('rutas, CORS y 404', async () => {
    const state = createState();
    await runCycle(state, deps);
    const r = handle(state, '/flights/IB/1668.json');
    expect(r.status).toBe(200);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(JSON.parse(r.body).legs[0].g).toBe('D86');
    expect(handle(state, '/flights/XX/1.json').status).toBe(404);
    expect(handle(state, '/punctuality/IB/1668.json').status).toBe(404);
    expect(handle(state, '/../../etc/passwd').status).toBe(404);
    expect(JSON.parse(handle(state, '/health').body)).toMatchObject({ updated: '2026-09-24T18:45:00.000Z', audit: { mismatches: 0 } });
  });
});

describe('servicio que se duerme (Render gratis)', () => {
  it('al recibir una petición, refresca si los datos tienen más de 10 min o no hay datos', () => {
    const now = Date.parse('2026-09-24T19:00:00Z');
    expect(needsRefresh({ updated: null, running: false }, now)).toBe(true);
    expect(needsRefresh({ updated: '2026-09-24T18:55:00Z', running: false }, now)).toBe(false);
    expect(needsRefresh({ updated: '2026-09-24T18:49:00Z', running: false }, now)).toBe(true);
    expect(needsRefresh({ updated: '2026-09-24T18:49:00Z', running: true }, now)).toBe(false);
  });
});

describe('vuelos al extranjero (radar)', () => {
  const dub = { airport: 'PMI', type: 'S', row: row({ iataCompania: 'EI', oaciCompania: 'EIN', nombreCompania: 'Aer Lingus', numVuelo: '737', iataOtro: 'DUB', horaProgramada: '20:55:00', horaEstimada: '21:10:00', estado: 'BOR' }) };
  it('Aena retira la salida 2 h después de despegar: el servidor la conserva', async () => {
    const state = createState();
    await runCycle(state, { ...deps, fetchAenaFn: async () => ({ entries: [...entries, dub], failed: [] }) });
    await runCycle(state, deps);
    expect(state.flights.get('EI/737.json').legs[0]).toMatchObject({ o: 'PMI', a: 'DUB', std: 'BOR' });
  });
  it('/radar: pregunta al radar solo si ha salido y Aena no informa de la llegada', async () => {
    const state = createState();
    await runCycle(state, { ...deps, fetchAenaFn: async () => ({ entries: [...entries, dub], failed: [] }) });
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ ac: [{ hex: 'a', flight: 'EIN737', alt_baro: 30000, gs: 450, lat: 45, lon: -2, seen: 2 }] }) }));
    const now = Date.parse('2026-09-24T20:00:00Z');
    const r = await radarResponse(state, '/radar/EI/737.json', { fetchFn, nowMs: now, pauseMs: 0 });
    expect(r.status).toBe(200);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(JSON.parse(r.body)).toMatchObject({ state: 'volando', callsign: 'EIN737', altM: 9144 });
    // Segunda petición en menos de 60 s: de la caché, sin volver a preguntar al radar.
    await radarResponse(state, '/radar/EI/737.json', { fetchFn, nowMs: now + 30000, pauseMs: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // IB1668 va a Madrid: lo dice Aena, no hace falta radar.
    expect(JSON.parse((await radarResponse(state, '/radar/IB/1668.json', { fetchFn, nowMs: now, pauseMs: 0 })).body).state).toBe('no-aplica');
    expect((await radarResponse(state, '/radar/../x', { fetchFn, nowMs: now, pauseMs: 0 })).status).toBe(404);
  });
});
