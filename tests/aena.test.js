import { describe, it, expect } from 'vitest';
import { buildLegs, mergeLegs, shardLegs, patchFailed } from '../scripts/aena.mjs';

const row = over => ({
  iataCompania: 'IB', oaciCompania: 'IBE', nombreCompania: 'Iberia', numVuelo: '1668',
  fecha: '24/09/2026', horaProgramada: '17:55:00', fechaEstimada: '24/09/2026', horaEstimada: '17:55:00',
  iataOtro: 'MAD', estado: 'SCH', terminal: 'N', puertaPrimera: 'D', tipoAeronave: 'A21N',
  ...over,
});
const dep = (over = {}) => ({ airport: 'PMI', type: 'S', row: row(over) });
const arr = (over = {}) => ({ airport: 'MAD', type: 'L', row: row({ iataOtro: 'PMI', horaProgramada: '19:25:00', horaEstimada: '19:25:00', terminal: '4', puertaPrimera: 'null', estado: '', ...over }) });

describe('buildLegs', () => {
  it('une salida y llegada del mismo vuelo', () => {
    const legs = buildLegs([dep(), arr()]);
    expect(legs).toEqual([{
      al: 'IB', icao: 'IBE', name: 'Iberia', n: '1668',
      d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '17:55', ed: '2026-09-24T17:55',
      sa: '19:25', ea: '2026-09-24T19:25', td: 'N', ta: '4', g: 'D', st: 'SCH', std: 'SCH', sta: null, ac: 'A21N',
    }]);
  });
  it('llegada al día siguiente se une con la salida de la noche anterior', () => {
    const legs = buildLegs([
      dep({ horaProgramada: '23:30:00', horaEstimada: '23:30:00' }),
      arr({ fecha: '25/09/2026', fechaEstimada: '25/09/2026', horaProgramada: '00:50:00', horaEstimada: '00:50:00' }),
    ]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ d: '2026-09-24', sd: '23:30', sa: '00:50', ea: '2026-09-25T00:50' });
  });
  it('no mezcla días distintos del mismo vuelo', () => {
    const legs = buildLegs([
      dep(), dep({ fecha: '25/09/2026', fechaEstimada: '25/09/2026' }),
      arr(), arr({ fecha: '25/09/2026', fechaEstimada: '25/09/2026', horaProgramada: '19:30:00' }),
    ]);
    expect(legs.map(l => [l.d, l.sa])).toEqual([['2026-09-24', '19:25'], ['2026-09-25', '19:30']]);
  });
  it('salida sin llegada (destino extranjero) y llegada sin salida (origen extranjero)', () => {
    const legs = buildLegs([
      dep({ iataOtro: 'LHR' }),
      { airport: 'PMI', type: 'L', row: row({ iataOtro: 'FRA', numVuelo: '0042', iataCompania: 'LH', oaciCompania: 'DLH', nombreCompania: 'Lufthansa', horaProgramada: '12:10:00', horaEstimada: '12:40:00' }) },
    ]);
    expect(legs.find(l => l.a === 'LHR')).toMatchObject({ o: 'PMI', sd: '17:55', sa: null, ea: null, ta: null });
    expect(legs.find(l => l.al === 'LH')).toMatchObject({ n: '42', o: 'FRA', a: 'PMI', d: '2026-09-24', sd: null, ed: null, sa: '12:10', ea: '2026-09-24T12:40', g: null });
  });
  it('guarda el estado de salida y el de llegada por separado; «Finalizado» de salida lo sustituye la llegada en curso', () => {
    const [l] = buildLegs([dep({ estado: 'BOR' }), arr({ estado: 'FLY' })]);
    expect(l).toMatchObject({ std: 'BOR', sta: 'FLY', st: 'FLY' });
    const [m] = buildLegs([dep({ estado: 'BOR' }), arr({ estado: 'SCH' })]);
    expect(m).toMatchObject({ std: 'BOR', sta: 'SCH', st: 'BOR' });
  });
  it('estado de la llegada sustituye a uno de salida sin información', () => {
    const [l] = buildLegs([dep({ estado: '' }), arr({ estado: 'ATE' })]);
    expect(l.st).toBe('ATE');
    const [m] = buildLegs([dep({ estado: 'CAN' }), arr({ estado: 'ATE' })]);
    expect(m.st).toBe('CAN');
  });
  it('limpia valores vacíos, "null" y filas sin aerolínea; quita ceros del número', () => {
    const legs = buildLegs([dep({ numVuelo: '0123', terminal: '', puertaPrimera: 'null', estado: '', tipoAeronave: '' }), dep({ iataCompania: '' })]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ n: '123', td: null, g: null, st: null, ac: null });
  });
  it('estimada en otro día se guarda con su fecha', () => {
    const [l] = buildLegs([dep({ horaProgramada: '23:50:00', fechaEstimada: '25/09/2026', horaEstimada: '00:40:00' })]);
    expect(l.ed).toBe('2026-09-25T00:40');
  });
});

describe('mergeLegs', () => {
  it('sustituye solo las fechas refrescadas', () => {
    const old = [{ al: 'IB', n: '1', d: '2026-09-24', st: 'SCH' }, { al: 'IB', n: '1', d: '2026-09-30', st: 'SCH' }, { al: 'IB', n: '1', d: '2026-09-20' }];
    const fresh = [{ al: 'IB', n: '1', d: '2026-09-24', st: 'BOR' }];
    const merged = mergeLegs(old, fresh, ['2026-09-24', '2026-09-25'], '2026-09-23');
    expect(merged).toEqual([{ al: 'IB', n: '1', d: '2026-09-24', st: 'BOR' }, { al: 'IB', n: '1', d: '2026-09-30', st: 'SCH' }]);
  });
});

describe('shardLegs', () => {
  it('un archivo por vuelo, ordenado por fecha, y mapa ICAO→IATA', () => {
    const legs = buildLegs([dep({ fecha: '25/09/2026', fechaEstimada: '25/09/2026' }), dep(), dep({ numVuelo: '3902', iataCompania: 'VY', oaciCompania: 'VLG', nombreCompania: 'Vueling' })]);
    const { files, airlines } = shardLegs(legs);
    expect(Object.keys(files).sort()).toEqual(['IB/1668.json', 'VY/3902.json']);
    const ib = files['IB/1668.json'];
    expect(ib.name).toBe('Iberia');
    expect(ib.legs.map(l => l.d)).toEqual(['2026-09-24', '2026-09-25']);
    expect(ib.legs[0].al).toBeUndefined();
    expect(airlines).toEqual({ IBE: 'IB', VLG: 'VY' });
  });
});

describe('patchFailed', () => {
  const L = over => ({ al: 'IB', n: '1', d: '2026-09-24', o: 'PMI', a: 'LPA', sd: '10:00', ed: null, sa: '12:00', ea: null, td: null, ta: '1', g: null, st: null, ac: null, ...over });
  it('llegadas fallidas en X: completa la llegada con los datos anteriores', () => {
    const fresh = [L({ sa: null, ta: null }), L({ n: '2', a: 'MAD', sa: null })];
    const old = [L({ sa: '12:05', ea: '2026-09-24T12:10', ta: '2' }), L({ n: '2', a: 'MAD', sa: '11:00' })];
    const out = patchFailed(fresh, old, [{ airport: 'LPA', type: 'L' }]);
    expect(out[0]).toMatchObject({ sa: '12:05', ea: '2026-09-24T12:10', ta: '2' });
    expect(out[1].sa).toBeNull(); // MAD no falló: no se toca
  });
  it('llegadas fallidas en X: recupera vuelos desde el extranjero que solo estaban en las llegadas', () => {
    const foreign = L({ n: '9', o: 'FRA', sd: null });
    const out = patchFailed([], [foreign, L({ n: '8', o: 'PMI' })], [{ airport: 'LPA', type: 'L' }], ['PMI', 'LPA']);
    expect(out).toEqual([foreign]);
  });
  it('salidas fallidas en X: sustituye los tramos que salen de X por los anteriores', () => {
    const fresh = [L({ o: 'LPA', a: 'MAD', sd: null, sa: '15:00' }), L({ n: '5' })];
    const old = [L({ o: 'LPA', a: 'MAD', sd: '12:30', sa: '15:00', g: 'B' })];
    const out = patchFailed(fresh, old, [{ airport: 'LPA', type: 'S' }]);
    expect(out).toContainEqual(old[0]);
    expect(out).toContainEqual(L({ n: '5' }));
    expect(out).toHaveLength(2);
  });
  it('sin fallos devuelve lo mismo', () => {
    const fresh = [L()];
    expect(patchFailed(fresh, [L({ sa: '99:99' })], [])).toBe(fresh);
  });
});

describe('fecha de actualización en cada vuelo', () => {
  it('shardLegs añade updated si se le pasa', () => {
    const { files } = shardLegs(buildLegs([dep()]), '2026-09-24T10:00:00.000Z');
    expect(files['IB/1668.json'].updated).toBe('2026-09-24T10:00:00.000Z');
  });
});

import { auditLegs } from '../scripts/aena.mjs';

describe('auditoría: lo publicado coincide con Aena', () => {
  it('sin discrepancias cuando las horas salen de las filas correctas', () => {
    const entries = [dep({ horaEstimada: '18:02:00' }), arr({ horaEstimada: '19:50:00' })];
    expect(auditLegs(entries, buildLegs(entries))).toEqual({ checked: 2, mismatches: [] });
  });
  it('detecta una hora que no coincide con su fila de Aena', () => {
    const entries = [dep(), arr({ horaEstimada: '19:50:00' })];
    const legs = buildLegs(entries); legs[0].ea = '2026-09-24T20:07';
    const r = auditLegs(entries, legs);
    expect(r.mismatches).toEqual([{ flight: 'IB1668', side: 'llegada', airport: 'MAD', aena: '2026-09-24T19:50', turbi: '2026-09-24T20:07' }]);
  });
});
