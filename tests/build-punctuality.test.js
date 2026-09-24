import { describe, it, expect } from 'vitest';
import { observe, mergeRecords, prune, aggregateFlights } from '../scripts/build-punctuality.mjs';
import { buildLegs } from '../scripts/aena.mjs';

const row = over => ({
  iataCompania: 'IB', oaciCompania: 'IBE', nombreCompania: 'Iberia', numVuelo: '1668',
  fecha: '24/09/2026', horaProgramada: '18:25:00', fechaEstimada: '24/09/2026', horaEstimada: '18:37:00',
  iataOtro: 'MAD', estado: 'BOR', terminal: 'N', puertaPrimera: 'D', tipoAeronave: 'A21N', ...over,
});
const S = over => ({ airport: 'PMI', type: 'S', row: row(over) });
const L = over => ({ airport: 'MAD', type: 'L', row: row({ iataOtro: 'PMI', horaProgramada: '19:50:00', horaEstimada: '19:56:00', estado: 'IBK', ...over }) });
const obsOf = entries => observe(entries, buildLegs(entries));

describe('observe: solo datos finales', () => {
  it('salida «Finalizado» y llegada «Entrega equip.» → un vuelo con ambos retrasos', () => {
    const o = [...obsOf([S(), L()]).values()];
    expect(o).toEqual([{ d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '18:25', sa: '19:50', f: ['IB1668'], dd: 12, ad: 6 }]);
  });
  it('estimaciones (embarcando, en vuelo, aproximándose) no se guardan', () => {
    expect([...obsOf([S({ estado: 'EMB' }), L({ estado: 'FLY' })]).values()]).toEqual([]);
    expect([...obsOf([S({ estado: 'BOR' }), L({ estado: 'FNL' })]).values()][0]).toMatchObject({ dd: 12 });
    expect([...obsOf([S({ estado: 'BOR' }), L({ estado: 'FNL' })]).values()][0].ad).toBeUndefined();
  });
  it('llegada al día siguiente: se asocia a la fecha de salida', () => {
    const o = [...obsOf([S({ horaProgramada: '23:15:00', horaEstimada: '23:40:00' }),
      L({ fecha: '25/09/2026', fechaEstimada: '25/09/2026', horaProgramada: '00:15:00', horaEstimada: '00:35:00', estado: 'LND' })]).values()];
    expect(o).toEqual([{ d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '23:15', sa: '00:15', f: ['IB1668'], dd: 25, ad: 20 }]);
  });
  it('códigos compartidos: un solo vuelo físico con los dos números', () => {
    const cs = over => ({ iataCompania: 'I2', oaciCompania: 'IBS', numVuelo: '1668', ...over });
    const o = [...obsOf([S(), L(), S(cs()), L(cs())]).values()];
    expect(o).toHaveLength(1);
    expect(o[0].f).toEqual(['IB1668', 'I21668']);
  });
  it('cancelado y desviado', () => {
    expect([...obsOf([S({ estado: 'CAN' })]).values()][0]).toMatchObject({ x: 1 });
    expect([...obsOf([S({ estado: 'BOR' }), L({ estado: 'DES' })]).values()][0]).toMatchObject({ x: 2, dd: 12 });
  });
});

describe('mergeRecords', () => {
  const base = { d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '18:25', sa: '19:50', f: ['IB1668'] };
  it('sin duplicados: la última observación sustituye; se unen números', () => {
    const store = new Map();
    mergeRecords(store, new Map([['k', { ...base, dd: 12 }]]));
    mergeRecords(store, new Map([['k', { ...base, dd: 14, ad: 6, f: ['I21668'] }]]));
    expect([...store.values()]).toEqual([{ ...base, dd: 14, ad: 6, x: 0, f: ['IB1668', 'I21668'] }]);
  });
  it('una cancelación no borra un vuelo que ya operó', () => {
    const store = new Map([['k', { ...base, dd: 12, ad: 6, x: 0 }]]);
    mergeRecords(store, new Map([['k', { ...base, x: 1 }]]));
    expect(store.get('k').x).toBe(0);
  });
  it('devuelve los días modificados', () => {
    const store = new Map();
    expect([...mergeRecords(store, new Map([['k', { ...base, dd: 1 }]]))]).toEqual(['2026-09-24']);
    expect([...mergeRecords(store, new Map([['k', { ...base, dd: 1 }]]))]).toEqual([]); // sin cambios
  });
});

describe('prune', () => {
  it('conserva 100 días', () => {
    const store = new Map([['a', { d: '2026-06-01' }], ['b', { d: '2026-09-01' }]]);
    prune(store, '2026-09-24', 100);
    expect([...store.keys()]).toEqual(['b']);
  });
});

describe('aggregateFlights', () => {
  const day = i => new Date(Date.parse('2026-09-24') - i * 86400000).toISOString().slice(0, 10);
  const recs = [
    ...Array.from({ length: 40 }, (_, i) => ({ d: day(i), o: 'PMI', a: 'MAD', sd: '18:25', sa: '19:50', dd: i % 5, ad: i < 8 ? 40 : i % 10, x: 0, f: ['IB1668', 'I21668'] })),
    { d: day(3), o: 'PMI', a: 'MAD', sd: '18:25', sa: '19:50', dd: null, ad: null, x: 1, f: ['IB1668'] },
    ...Array.from({ length: 12 }, (_, i) => ({ d: day(i), o: 'PMI', a: 'MAD', sd: '07:00', sa: '08:20', dd: 0, ad: 2, x: 0, f: ['UX6096'] })),
    ...Array.from({ length: 5 }, (_, i) => ({ d: day(i), o: 'PMI', a: 'LHR', sd: '10:00', sa: null, dd: 20, ad: null, x: 0, f: ['FR100'] })),
  ];
  const { files } = aggregateFlights(recs, '2026-09-24');
  const ib = files['IB/1668.json'].routes['PMI-MAD'];
  it('un archivo por número de vuelo y ruta, con los códigos compartidos', () => {
    expect(Object.keys(files).sort()).toEqual(['FR/100.json', 'I2/1668.json', 'IB/1668.json', 'UX/6096.json']);
    expect(ib.basis).toBe('arr');
  });
  it('ventanas: últimos 7 vuelos, 30 y 90 días; cancelación aparte', () => {
    expect(ib.last7.flights).toHaveLength(7);
    expect(ib.last7.flights[0]).toEqual([day(0), 40, 0]);
    expect(ib.d30.sample).toBe(30);
    expect(ib.d90.sample).toBe(40);
    expect(ib.d90.cancelled).toBe(1);
    expect(ib.d90.otp15).toBeCloseTo(32 / 40, 5);
  });
  it('contexto: ruta (todas las aerolíneas), aerolínea + ruta, día de la semana y franja', () => {
    expect(ib.route.sample).toBe(52);
    expect(ib.airlineRoute.sample).toBe(40);
    expect(Object.keys(ib.slot).sort()).toEqual(['1', '3']);
    expect(ib.slot['3'].sample).toBe(40);
    expect(Object.values(ib.dow).reduce((a, s) => a + s.sample, 0)).toBe(52);
  });
  it('destino extranjero: puntualidad de salida', () => {
    expect(files['FR/100.json'].routes['PMI-LHR']).toMatchObject({ basis: 'dep' });
    expect(files['FR/100.json'].routes['PMI-LHR'].d90).toMatchObject({ sample: 5, quality: 'insuficiente' });
  });
});
