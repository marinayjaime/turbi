// Alias de números comerciales (scripts/aliases.mjs). Filas con la forma real de Aena (26/09/2026): CJ = BA CityFlyer,
// que Aena publica con número CJ y asocia a BA en codigosCompania. Ningún número está fijado en el código.
import { describe, it, expect } from 'vitest';
import { buildLegs } from '../scripts/aena.mjs';
import { buildAliases, MIN_NUMBERS, MAX_AGE_DAYS } from '../scripts/aliases.mjs';

const TODAY = '2026-09-26';
const row = over => ({
  numVuelo: '1', fecha: '26/09/2026', horaProgramada: '10:45:00', fechaEstimada: '26/09/2026', horaEstimada: '10:45:00',
  iataOtro: 'LCY', estado: 'SCH', terminal: 'T', puertaPrimera: '', tipoAeronave: 'E190', ...over,
});
const S = (airport, over) => ({ airport, type: 'S', row: row(over) });
// CityFlyer: par comercial completo (formato programado) o solo el IATA (formato del día).
const cj = (n, cc, over = {}) => S('PMI', { iataCompania: 'CJ', oaciCompania: 'CFE', compania: 'CFE', nombreCompania: 'BA CITYFLYER', numVuelo: n, codigosCompania: cc, ...over });
const STRONG = 'CJ,CFE,BA,BAW,BAW,CFE', WEAK = 'CJ,CFE,,BA,CFE,CFE';
const ba = (n, over = {}) => S('MAD', { iataCompania: 'BA', oaciCompania: 'BAW', compania: 'BAW', nombreCompania: 'British Airways', numVuelo: n, iataOtro: 'LHR', codigosCompania: 'BA,BAW,BA,BAW,BAW,BAW', ...over });
// Relación CJ → BA válida: 3 números con el par completo + BA8462 (IBZ → LCY) solo con el formato del día.
const base = () => [
  cj('4501', STRONG), cj('4502', STRONG, { iataOtro: 'EDI' }), cj('4503', STRONG, { iataOtro: 'GLA' }),
  S('IBZ', { iataCompania: 'CJ', oaciCompania: 'CFE', compania: 'CFE', nombreCompania: 'BA CITYFLYER', numVuelo: '8462', codigosCompania: WEAK, estado: 'CER' }),
  ba('1567'),
];
const run = (entries, previous = null, today = TODAY) => buildAliases(entries, buildLegs(entries), previous, today);

describe('buildAliases: relación válida (CityFlyer → BA)', () => {
  it('BA8462 → CJ8462 solo en la ruta con evidencia (IBZ → LCY), con el nombre de Aena', () => {
    const { aliases } = run(base());
    expect(aliases.BA8462).toEqual({ al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: TODAY });
    expect(Object.keys(aliases).sort()).toEqual(['BA4501', 'BA4502', 'BA4503', 'BA8462']);
  });
  it('otra ruta del mismo número sin evidencia no entra en el alias', () => {
    const entries = [...base(), S('LCY', { iataCompania: 'CJ', oaciCompania: 'CFE', compania: 'CFE', numVuelo: '8462', iataOtro: 'IBZ', codigosCompania: 'CJ,CFE,CJ,CFE,CFE,CFE' })];
    expect(run(entries).aliases.BA8462.routes).toEqual([['IBZ', 'LCY']]);
  });
  it('umbral: con menos de MIN_NUMBERS números la relación no vale (nunca se rebaja)', () => {
    expect(MIN_NUMBERS).toBe(3);
    const entries = [cj('4501', STRONG), cj('4502', STRONG, { iataOtro: 'EDI' }), ba('1567')];
    const r = run(entries);
    expect(r.aliases).toEqual({});
    expect(r.rejected).toContainEqual({ pair: 'CJ→BA', reason: 'solo 2 números con evidencia (mínimo 3)' });
  });
  it('solo con el formato del día (sin par IATA + OACI) no hay relación', () => {
    const entries = [cj('4501', WEAK), cj('4502', WEAK, { iataOtro: 'EDI' }), cj('4503', WEAK, { iataOtro: 'GLA' }), ba('1567')];
    expect(run(entries).rejected).toContainEqual({ pair: 'CJ→BA', reason: 'sin par IATA + OACI explícito' });
  });
});

describe('buildAliases: lo que nunca genera un alias', () => {
  it('colisiones de número (NAY/RSC → NT): Aena publica NT+n como otro vuelo → la relación entera se descarta', () => {
    const nay = (n, dest) => S('TFN', { iataCompania: 'NAY', oaciCompania: 'NAY', compania: 'NAY', numVuelo: n, iataOtro: dest, codigosCompania: 'NAY,NAY,NT,IBB,NT,NAY' });
    const nt = (n, dest) => S('LPA', { iataCompania: 'NT', oaciCompania: 'IBB', compania: 'IBB', nombreCompania: 'Binter', numVuelo: n, iataOtro: dest, codigosCompania: 'NT,IBB,NT,IBB,IBB,IBB' });
    const r = run([nay('215', 'SPC'), nay('216', 'VDE'), nay('217', 'GMZ'), nt('216', 'FUE')]);
    expect(r.aliases).toEqual({});
    expect(r.rejected).toContainEqual({ pair: 'NAY→NT', reason: '1 colisiones de número (NT216…)' });
  });
  it('operadora ajena (IB con codigosCompania de Air Nostrum): no es un código comercial', () => {
    const ib = n => S('MAD', { iataCompania: 'IB', oaciCompania: 'IBE', compania: 'IBE', numVuelo: n, codigosCompania: 'YW,ANE,YW,ANE,ANE,IBE' });
    const yw = S('VLC', { iataCompania: 'YW', oaciCompania: 'ANE', compania: 'ANE', numVuelo: '8264', codigosCompania: 'YW,ANE,YW,ANE,ANE,ANE' });
    expect(run([ib('1209'), ib('1211'), ib('1213'), yw])).toEqual({ evidence: [], aliases: {}, rejected: [] });
  });
  it('código que no es una aerolínea del catálogo de Aena (LA → 1L): ni evidencia', () => {
    const la = n => S('MAD', { iataCompania: 'LA', oaciCompania: 'LAN', compania: 'LAN', numVuelo: n, codigosCompania: 'LA,LAN,,1L,1L,LAN' });
    expect(run([la('5418'), la('1803'), la('1665')]).evidence).toEqual([]);
  });
  it('Aena ya publica el número comercial (mismo vuelo): no hace falta alias', () => {
    const entries = [...base(), S('IBZ', { iataCompania: 'BA', oaciCompania: 'BAW', compania: 'BAW', numVuelo: '8462', codigosCompania: 'BA,BAW,BA,BAW,BAW,BAW', estado: 'CER' })];
    const r = run(entries);
    expect(r.aliases.BA8462).toBeUndefined();
    expect(r.rejected).toContainEqual({ pair: 'BA8462', reason: 'Aena ya publica el número comercial' });
  });
  it('Aena publica el número comercial como OTRO vuelo: colisión → toda la relación fuera', () => {
    const r = run([...base(), ba('8462', { iataOtro: 'JFK' })]);
    expect(r.aliases).toEqual({});
    expect(r.rejected[0]).toMatchObject({ pair: 'CJ→BA', reason: expect.stringContaining('colisiones') });
  });
  it('dos operadoras con evidencia para el mismo número comercial: ninguna', () => {
    const a0 = (n, dest) => S('AGP', { iataCompania: 'A0', oaciCompania: 'EFW', compania: 'EFW', numVuelo: n, iataOtro: dest, codigosCompania: 'A0,EFW,BA,BAW,BAW,EFW' });
    const r = run([...base(), a0('8462', 'LGW'), a0('2670', 'LGW'), a0('2671', 'LGW')]);
    expect(r.aliases.BA8462).toBeUndefined();
    expect(r.rejected).toContainEqual({ pair: 'BA8462', reason: 'varios destinos posibles' });
    expect(r.aliases.BA4501).toMatchObject({ al: 'CJ' });
  });
});

describe('buildAliases: persistencia (14 días) con todas las comprobaciones sobre los datos actuales', () => {
  const later = (days) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  // Descarga posterior: los mismos vuelos, pero ya sin BA en codigosCompania.
  const quiet = () => [
    cj('4501', 'CJ,CFE,CJ,CFE,CFE,CFE'), cj('4502', 'CJ,CFE,CJ,CFE,CFE,CFE', { iataOtro: 'EDI' }), cj('4503', 'CJ,CFE,CJ,CFE,CFE,CFE', { iataOtro: 'GLA' }),
    S('IBZ', { iataCompania: 'CJ', oaciCompania: 'CFE', compania: 'CFE', nombreCompania: 'BA CITYFLYER', numVuelo: '8462', codigosCompania: 'CJ,CFE,CJ,CFE,CFE,CFE' }),
    ba('1567'),
  ];
  const first = () => run(base());
  it('sin evidencia nueva, el alias se mantiene hasta MAX_AGE_DAYS días desde la última', () => {
    expect(MAX_AGE_DAYS).toBe(14);
    const kept = run(quiet(), first(), later(14));
    expect(kept.aliases.BA8462).toMatchObject({ al: 'CJ', lastEvidence: TODAY });
    expect(run(quiet(), first(), later(15)).aliases).toEqual({});
  });
  it('una colisión nueva lo elimina aunque la evidencia no haya caducado', () => {
    expect(run([...quiet(), ba('8462', { iataOtro: 'JFK' })], first(), later(1)).aliases).toEqual({});
  });
  it('si cambia la relación IATA ↔ OACI, fuera', () => {
    const changed = quiet().map(e => (e.row.iataCompania === 'BA' ? { ...e, row: { ...e.row, oaciCompania: 'XBA', compania: 'XBA', codigosCompania: 'BA,XBA,BA,XBA,XBA,XBA' } } : e));
    const r = run(changed, first(), later(1));
    expect(r.aliases).toEqual({});
    expect(r.rejected).toContainEqual({ pair: 'CJ→BA', reason: 'la relación IATA ↔ OACI ha cambiado' });
  });
  it('si Aena pasa a publicar M+n directamente, fuera', () => {
    const r = run([...quiet(), S('IBZ', { iataCompania: 'BA', oaciCompania: 'BAW', compania: 'BAW', numVuelo: '8462', codigosCompania: 'BA,BAW,BA,BAW,BAW,BAW' })], first(), later(1));
    expect(r.aliases.BA8462).toBeUndefined();
  });
  it('si la ruta deja de estar respaldada (Aena ya no publica X+n en esa ruta), fuera', () => {
    const r = run(quiet().filter(e => e.row.numVuelo !== '8462'), first(), later(1));
    expect(r.aliases.BA8462).toBeUndefined();
    expect(r.rejected).toContainEqual({ pair: 'BA8462', reason: 'Aena ya no publica el vuelo en la ruta con evidencia' });
  });
});
