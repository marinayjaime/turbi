import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, runCycle, handle } from '../server/live.mjs';

const row = over => ({
  iataCompania: 'IB', oaciCompania: 'IBE', nombreCompania: 'Iberia', numVuelo: '1668',
  fecha: '24/09/2026', horaProgramada: '17:55:00', fechaEstimada: '24/09/2026', horaEstimada: '18:44:00',
  iataOtro: 'MAD', estado: 'BOR', terminal: 'N', puertaPrimera: 'D86', tipoAeronave: 'A21N', ...over,
});
const entries = [
  { airport: 'PMI', type: 'S', row: row() },
  { airport: 'MAD', type: 'L', row: row({ iataOtro: 'PMI', horaProgramada: '19:25:00', horaEstimada: '20:10:00', estado: 'BOR', puertaPrimera: 'null' }) },
];
const okFetch = async () => ({ entries, failed: [] });
const deps = async () => ({
  fetchAenaFn: okFetch, storeDir: await mkdtemp(join(tmpdir(), 'turbi-')),
  now: () => new Date('2026-09-24T18:45:00Z'), today: () => '2026-09-24',
});

describe('runCycle', () => {
  it('publica los vuelos de hoy/mañana, la auditoría y la puntualidad, y guarda el historial en disco', async () => {
    const state = createState();
    const d = await deps();
    await runCycle(state, d);
    expect(state.flights.get('IB/1668.json').legs[0]).toMatchObject({ ed: '2026-09-24T18:44', ea: '2026-09-24T20:10', g: 'D86' });
    expect(state.flights.get('IB/1668.json').updated).toBe('2026-09-24T18:45:00.000Z');
    expect(state.audit).toEqual({ checked: 2, mismatches: 0, duplicates: 0 });
    expect(state.punctuality.get('IB/1668.json').routes['PMI-MAD'].last7.flights).toEqual([['2026-09-24', 45, 0]]);
    expect(await readdir(join(d.storeDir, 'days'))).toEqual(['2026-09-24.json']);
  });
  it('si Aena falla, conserva lo anterior y anota el error', async () => {
    const state = createState();
    const d = await deps();
    await runCycle(state, d);
    await expect(runCycle(state, { ...d, fetchAenaFn: async () => ({ entries: [], failed: new Array(86).fill({}) }) })).rejects.toThrow('Aena no disponible');
    expect(state.flights.has('IB/1668.json')).toBe(true);
  });
  it('el historial sobrevive a un reinicio (se lee del disco)', async () => {
    const d = await deps();
    await runCycle(createState(), d);
    const fresh = createState();
    await runCycle(fresh, { ...d, fetchAenaFn: async () => ({ entries: [], failed: [] }) }).catch(() => {});
    await runCycle(fresh, { ...d, fetchAenaFn: async () => ({ entries: [entries[0]], failed: [] }) });
    expect(fresh.punctuality.get('IB/1668.json').routes['PMI-MAD'].last7.flights[0]).toEqual(['2026-09-24', 45, 0]);
  });
});

describe('handle (servidor)', () => {
  it('rutas, CORS y 404', async () => {
    const state = createState();
    await runCycle(state, await deps());
    const r = handle(state, '/flights/IB/1668.json');
    expect(r.status).toBe(200);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(JSON.parse(r.body).legs[0].g).toBe('D86');
    expect(handle(state, '/punctuality/IB/1668.json').status).toBe(200);
    expect(handle(state, '/flights/XX/1.json').status).toBe(404);
    expect(handle(state, '/../../etc/passwd').status).toBe(404);
    const h = JSON.parse(handle(state, '/health').body);
    expect(h).toMatchObject({ updated: '2026-09-24T18:45:00.000Z', audit: { mismatches: 0 } });
  });
});
