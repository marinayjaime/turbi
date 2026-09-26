import { describe, it, expect } from 'vitest';
import { buildLegs, mergeLegs, shardLegs, patchFailed, auditLegs } from '../scripts/aena.mjs';

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
      sa: '19:25', ea: '2026-09-24T19:25', td: 'N', ta: '4', g: 'D', st: 'SCH', std: 'SCH', sta: null, ac: 'A21N', op: 'IB', // sin códigos compartidos: la opera Iberia
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
    expect(auditLegs(entries, buildLegs(entries))).toEqual({ checked: 2, mismatches: [], duplicates: 0 });
  });
  it('detecta una hora que no coincide con su fila de Aena', () => {
    const entries = [dep(), arr({ horaEstimada: '19:50:00' })];
    const legs = buildLegs(entries); legs[0].ea = '2026-09-24T20:07';
    const r = auditLegs(entries, legs);
    expect(r.mismatches).toEqual([{ flight: 'IB1668', side: 'llegada', airport: 'MAD', aena: '2026-09-24T19:50', turbi: '2026-09-24T20:07' }]);
  });
});

describe('filas duplicadas en Aena (mismo vuelo, fecha y hora programada)', () => {
  it('una sola ficha; principal = la que trae estado; la otra hora se conserva como alternativa', () => {
    const legs = buildLegs([dep({ horaEstimada: '17:55:00', estado: '' }), dep({ horaEstimada: '18:02:00', estado: 'SCH' })]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ ed: '2026-09-24T18:02', edAlt: ['2026-09-24T17:55'] });
  });
  it('llegadas duplicadas con horas distintas: igual', () => {
    const [l] = buildLegs([dep(), arr({ horaEstimada: '19:25:00', estado: '' }), arr({ horaEstimada: '19:40:00', estado: 'FLY' })]);
    expect(l).toMatchObject({ ea: '2026-09-24T19:40', eaAlt: ['2026-09-24T19:25'], sta: 'FLY' });
  });
  it('duplicadas con la misma hora: sin alternativa', () => {
    const legs = buildLegs([dep(), dep()]);
    expect(legs).toHaveLength(1);
    expect(legs[0].edAlt).toBeUndefined();
  });
  it('la auditoría acepta cualquiera de las horas publicadas y cuenta los duplicados aparte', () => {
    const entries = [dep({ horaEstimada: '17:55:00', estado: '' }), dep({ horaEstimada: '18:02:00', estado: 'SCH' })];
    expect(auditLegs(entries, buildLegs(entries))).toEqual({ checked: 2, mismatches: [], duplicates: 1 });
  });
});

import { keepDeparted, departedLegs } from '../scripts/aena.mjs';
const dleg = over => ({ al: 'EI', icao: 'EIN', n: '737', d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
describe('vuelos que Aena retira tras despegar', () => {
  it('departedLegs: lo que hay que guardar para la siguiente descarga (salidos de ayer y hoy)', () => {
    const legs = [dleg(), dleg({ n: '1', std: 'EMB', st: 'EMB' }), dleg({ n: '2', d: '2026-09-22' })];
    expect(departedLegs(legs, '2026-09-24').map(l => l.n)).toEqual(['737']);
  });
  it('se conserva la salida ya despegada hasta el día siguiente', () => {
    const old = [dleg(), dleg({ n: '100', std: 'EMB', st: 'EMB' }), dleg({ n: '5', d: '2026-09-22' })];
    const fresh = [dleg({ n: '739', d: '2026-09-25' })];
    expect(keepDeparted(old, fresh, '2026-09-24').map(l => l.n)).toEqual(['739', '737']);
  });
  it('si Aena lo sigue publicando, gana lo nuevo', () => {
    expect(keepDeparted([dleg({ ed: 'viejo' })], [dleg()], '2026-09-24')).toEqual([dleg()]);
  });
});


describe('aerolínea que opera el vuelo (para la foto real)', () => {
  it('Aena lo indica en codigosCompania: IB1243 lo opera Air Nostrum (YW)', () => {
    const legs = buildLegs([dep({ iataCompania: 'IB', numVuelo: '1243', codigosCompania: 'YW,ANE,IB,IBE,ANE,IBE', tipoAeronave: 'CRJX' })]);
    expect(legs[0].op).toBe('YW');
  });
  it('vuelo sin códigos compartidos: la opera la propia aerolínea', () => {
    const legs = buildLegs([dep({ iataCompania: 'FR', numVuelo: '1234', codigosCompania: 'FR,RYR,FR,RYR,RYR,RYR' })]);
    expect(legs[0].op).toBe('FR');
  });
  it('códigos compartidos sin que Aena diga quién opera: no se sabe (sin foto)', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'IB', numVuelo: '1629', codigosCompania: 'IB,IBE,IB,IBE,IBE,IBE' }),
      dep({ iataCompania: 'QR', numVuelo: '8031', codigosCompania: 'QR,QTR,,QR,QR,QTR' }),
    ]);
    expect(legs.map(l => l.op)).toEqual([undefined, undefined]);
  });
  it('códigos compartidos y uno de ellos dice quién opera: todos lo heredan', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'IB', numVuelo: '1243', codigosCompania: 'YW,ANE,IB,IBE,ANE,IBE' }),
      dep({ iataCompania: 'VY', numVuelo: '5554', codigosCompania: 'VY,VLG,VY,VLG,VLG,VLG' }),
    ]);
    expect(legs.map(l => l.op)).toEqual(['YW', 'YW']);
  });
});

// Filas reales de Aena (26/09/2026) de aerolíneas fuera de su catálogo: iataCompania, oaciCompania y nombreCompania
// vacíos; la aerolínea solo aparece en `compania` (OACI) y en codigosCompania ([0] IATA, [1] OACI).
describe('aerolíneas fuera del catálogo de Aena (iataCompania vacía)', () => {
  const gap = over => ({ iataCompania: '', oaciCompania: '', nombreCompania: '', ...over });
  const ju571 = gap({ compania: 'ASL', codigosCompania: 'JU,ASL,JU,ASL,ASL,ASL', numVuelo: '571', iataOtro: 'BEG', tipoAeronave: 'BCS3' });

  it('JU571 MAD → BEG: se recupera con el IATA y el OACI explícitos de Aena, sin inventar el nombre', () => {
    const legs = buildLegs([{ airport: 'MAD', type: 'S', row: row(ju571) }]);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ al: 'JU', icao: 'ASL', name: null, n: '571', o: 'MAD', a: 'BEG', op: 'JU' });
    expect(legs[0]).not.toHaveProperty('rec');
    const { files, airlines } = shardLegs(legs);
    expect(Object.keys(files)).toEqual(['JU/571.json']);
    expect(airlines).toEqual({ ASL: 'JU' }); // «ASL571» también lleva al vuelo
  });
  it('también en llegadas (el tramo de vuelta JU570 BEG → MAD)', () => {
    const legs = buildLegs([{ airport: 'MAD', type: 'L', row: row({ ...ju571, numVuelo: '570', estado: 'IBK' }) }]);
    expect(legs[0]).toMatchObject({ al: 'JU', icao: 'ASL', n: '570', o: 'BEG', a: 'MAD', sta: 'IBK' });
  });
  it('sin datos explícitos y coherentes se sigue descartando (no se deduce nada)', () => {
    const cases = [
      gap({ compania: 'FRO', codigosCompania: 'FRO,FRO,,EH,EH,FRO' }), // [0] no es un código IATA
      gap({ compania: 'GSM', codigosCompania: 'GSM,GSM,GSM,GSM,GSM,GSM' }),
      gap({ compania: 'ASL', codigosCompania: 'JU,XXX,JU,ASL,ASL,ASL' }), // [1] no coincide con compania
      gap({ compania: '', codigosCompania: 'JU,ASL,JU,ASL,ASL,ASL' }),
      gap({ compania: 'ASL', codigosCompania: '' }),
      gap({ compania: 'null', codigosCompania: 'null' }),
    ];
    for (const r of cases) expect(buildLegs([dep(r)]), JSON.stringify(r)).toEqual([]);
  });
  it('código compartido recuperado: la operadora del vuelo que ya se publicaba no cambia y al recuperado no se le asigna', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'IB', numVuelo: '731', codigosCompania: 'IB,IBE,IB,IBE,IBE,IBE' }),
      dep(gap({ compania: 'JAL', codigosCompania: 'JL,JAL,JL,JAL,JAL,JAL', numVuelo: '7839' })),
    ]);
    expect(legs.map(l => [l.al, l.op])).toEqual([['IB', 'IB'], ['JL', undefined]]);
  });
  it('código compartido recuperado cuando Aena sí dice quién opera: lo hereda como los demás', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'IB', numVuelo: '1243', codigosCompania: 'YW,ANE,IB,IBE,ANE,IBE' }),
      dep(gap({ compania: 'JAL', codigosCompania: 'JL,JAL,JL,JAL,JAL,JAL', numVuelo: '9429' })),
    ]);
    expect(legs.map(l => [l.al, l.op])).toEqual([['IB', 'YW'], ['JL', 'YW']]);
  });
  it('colisión con una fila explícita: ese IATA con otro OACI en la descarga → no se recupera', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'JU', oaciCompania: 'XJU', nombreCompania: 'Otra JU', numVuelo: '100', codigosCompania: 'JU,XJU,JU,XJU,XJU,XJU' }),
      { airport: 'MAD', type: 'S', row: row(ju571) },
    ]);
    expect(legs.map(l => `${l.al}${l.n} ${l.icao}`)).toEqual(['JU100 XJU']); // la explícita sigue; la recuperable no
  });
  it('colisión con una fila explícita por el OACI: ese OACI con otro IATA → no se recupera', () => {
    const legs = buildLegs([
      dep({ iataCompania: 'J9', oaciCompania: 'ASL', nombreCompania: 'Otra', numVuelo: '100', codigosCompania: 'J9,ASL,J9,ASL,ASL,ASL' }),
      { airport: 'MAD', type: 'S', row: row(ju571) },
    ]);
    expect(legs.map(l => `${l.al}${l.n}`)).toEqual(['J9100']);
  });
  it('colisión entre dos filas recuperables: mismo IATA con OACI distintos → ninguna se recupera', () => {
    const legs = buildLegs([
      { airport: 'MAD', type: 'S', row: row(ju571) },
      dep(gap({ compania: 'XJU', codigosCompania: 'JU,XJU,JU,XJU,XJU,XJU', numVuelo: '200' })),
    ]);
    expect(legs).toEqual([]);
  });
  it('sin colisión: varias filas de la misma pareja (JU/ASL) y otras aerolíneas explícitas → se recuperan', () => {
    const legs = buildLegs([
      { airport: 'MAD', type: 'S', row: row(ju571) },
      { airport: 'MAD', type: 'L', row: row({ ...ju571, numVuelo: '570' }) },
      dep({ iataCompania: 'IB', numVuelo: '731', oaciCompania: 'IBE' }),
    ]);
    expect(legs.map(l => `${l.al}${l.n}`).sort()).toEqual(['IB731', 'JU570', 'JU571']);
  });
  it('la auditoría usa las mismas filas recuperadas que buildLegs', () => {
    const conflict = [{ airport: 'MAD', type: 'S', row: row({ ...ju571, horaEstimada: '12:40:00' }) },
      dep(gap({ compania: 'XJU', codigosCompania: 'JU,XJU,JU,XJU,XJU,XJU', numVuelo: '200' }))];
    expect(auditLegs(conflict, buildLegs(conflict)).checked).toBe(0);
    const ok = [{ airport: 'MAD', type: 'S', row: row({ ...ju571, horaEstimada: '12:40:00' }) }];
    expect(auditLegs(ok, buildLegs(ok))).toMatchObject({ checked: 1, mismatches: [] });
  });
  it('dos recuperados solos en el mismo vuelo físico: nadie dice quién opera → sin operadora', () => {
    const legs = buildLegs([
      dep(gap({ compania: 'JAL', codigosCompania: 'JL,JAL,JL,JAL,JAL,JAL', numVuelo: '1' })),
      dep(gap({ compania: 'ASA', codigosCompania: 'AS,ASA,AS,ASA,ASA,ASA', numVuelo: '2' })),
    ]);
    expect(legs.map(l => l.op)).toEqual([undefined, undefined]);
  });
});
