import { describe, it, expect } from 'vitest';
import { createState, runCycle, handle, needsRefresh } from '../server/live.mjs';

const row = over => ({
  iataCompania: 'IB', oaciCompania: 'IBE', nombreCompania: 'Iberia', numVuelo: '1668',
  fecha: '24/09/2026', horaProgramada: '17:55:00', fechaEstimada: '24/09/2026', horaEstimada: '18:44:00',
  iataOtro: 'MAD', estado: 'BOR', terminal: 'N', puertaPrimera: 'D86', tipoAeronave: 'A21N', ...over,
});
const entries = [
  { airport: 'PMI', type: 'S', row: row() },
  { airport: 'MAD', type: 'L', row: row({ iataOtro: 'PMI', horaProgramada: '19:25:00', horaEstimada: '20:10:00', estado: 'BOR', puertaPrimera: 'null' }) },
];
const deps = { fetchAenaFn: async () => ({ entries, failed: [] }), now: () => new Date('2026-09-24T18:45:00Z') };

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
