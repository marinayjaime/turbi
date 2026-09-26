import { describe, it, expect, vi } from 'vitest';
import { findAlias, aliasLegs, aliasOffer, adsbdbVetoes } from '../js/aliases.js';

const ALIASES = { updated: '2026-09-26T10:00:00Z', aliases: {
  BA8462: { al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: '2026-09-26' } } };
const leg = (d, o, a, sd) => ({ d, o, a, sd, ed: null, sa: null, ea: null, st: 'SCH' });
const CJ8462 = { name: 'BA CITYFLYER', updated: '2026-09-26T10:00:00Z',
  legs: [leg('2026-09-26', 'IBZ', 'LCY', '10:45'), leg('2026-09-27', 'IBZ', 'LCY', '17:20'), leg('2026-09-28', 'LCY', 'IBZ', '08:00')] };
const net = (files = {}) => vi.fn(async url => (files[url] ? { ok: true, status: 200, json: async () => files[url] } : { ok: false, status: 404, json: async () => null }));
const FILES = { 'data/flights/_aliases.json': ALIASES, 'data/flights/CJ/8462.json': CJ8462, 'data/flights/airlines.json': { BAW: 'BA', CFE: 'CJ' } };

describe('findAlias', () => {
  it('por IATA o por OACI (BAW8462)', async () => {
    expect(await findAlias('BA8462', net(FILES))).toMatchObject({ al: 'CJ', n: '8462' });
    expect(await findAlias('baw 8462', net(FILES))).toMatchObject({ al: 'CJ', n: '8462' });
  });
  it('sin alias, sin archivo o formato inválido → null', async () => {
    expect(await findAlias('BA1', net(FILES))).toBeNull();
    expect(await findAlias('BA8462', net({}))).toBeNull();
    expect(await findAlias('hola', net(FILES))).toBeNull();
  });
});

describe('aliasOffer: solo número + ruta respaldada', () => {
  it('fecha con el vuelo en la ruta respaldada → candidato con esos tramos (y el horario sin otras rutas)', async () => {
    const o = await aliasOffer('BA8462', '2026-09-27', net(FILES), null);
    expect(o.legs.map(l => `${l.d} ${l.o}-${l.a}`)).toEqual(['2026-09-27 IBZ-LCY']);
    expect(o.schedule.legs.every(l => l.o === 'IBZ' && l.a === 'LCY')).toBe(true);
  });
  it('fecha en la que el vuelo solo va por otra ruta → sin candidato (nunca un alias global)', async () => {
    expect(await aliasOffer('BA8462', '2026-09-28', net(FILES), null)).toBeNull();
  });
  it('fecha sin vuelo → sin candidato', async () => {
    expect(await aliasOffer('BA8462', '2026-10-30', net(FILES), null)).toBeNull();
  });
  it('aliasLegs filtra por ruta exacta (origen y destino)', () => {
    expect(aliasLegs(CJ8462.legs, ALIASES.aliases.BA8462)).toHaveLength(2);
  });
});

describe('adsbdbVetoes', () => {
  const legs = [leg('2026-09-26', 'IBZ', 'LCY', '10:45')];
  it('ruta distinta en ADSBDB → veto absoluto', () => {
    expect(adsbdbVetoes({ status: 'found', iata: ['LGW', 'IBZ'], flight: null }, legs)).toBe(true);
  });
  it('coincidencia, desconocido o fallo temporal → no veta', () => {
    expect(adsbdbVetoes({ status: 'found', iata: ['IBZ', 'LCY'], flight: {} }, legs)).toBe(false);
    expect(adsbdbVetoes({ status: 'unknown' }, legs)).toBe(false);
    expect(adsbdbVetoes({ status: 'error' }, legs)).toBe(false);
  });
});
