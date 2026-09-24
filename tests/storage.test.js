import { describe, it, expect } from 'vitest';
import { recordSnapshot, forecastTrend, saveLast, loadLast, agoText, flightKey } from '../js/storage.js';

function mem() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}
const T = h => Date.parse('2026-09-24T07:00:00Z') + h * 3600000;
const snap = (h, maxLevel, verdict = maxLevel >= 2 ? 'turbulento' : maxLevel ? 'movimiento' : 'tranquilo') => ({ t: T(h), maxLevel, verdict, confidence: 'media' });
const fmt = ms => new Date(ms).toISOString().slice(11, 16);

describe('flightKey', () => {
  it('por número y fecha, o por ruta y fecha', () => {
    expect(flightKey({ number: 'VY3902', date: '2026-09-24' })).toBe('VY3902|2026-09-24');
    expect(flightKey({ number: '', origin: { iata: 'PMI' }, destination: { iata: 'MAD' }, date: '2026-09-24', time: '10:00' })).toBe('PMI-MAD-10:00|2026-09-24');
  });
});

describe('recordSnapshot', () => {
  it('guarda instantáneas por vuelo; si han pasado < 10 min, sustituye la última', () => {
    const s = mem();
    recordSnapshot('A', snap(0, 2), s);
    recordSnapshot('A', { ...snap(0, 1), t: T(0) + 5 * 60000 }, s);
    const list = recordSnapshot('A', snap(4, 1), s);
    expect(list.map(x => x.maxLevel)).toEqual([1, 1]);
  });
  it('como mucho 6 instantáneas por vuelo y 5 vuelos', () => {
    const s = mem();
    for (let i = 0; i < 9; i++) recordSnapshot('A', snap(i, 0), s);
    for (const k of ['B', 'C', 'D', 'E', 'F']) recordSnapshot(k, snap(0, 0), s);
    const all = JSON.parse(s.getItem('turbi.forecasts'));
    expect(all.A ?? null).toBeNull(); // el más antiguo sale
    expect(Object.keys(all)).toHaveLength(5);
    const s2 = mem();
    for (let i = 0; i < 9; i++) recordSnapshot('A', snap(i, 0), s2);
    expect(JSON.parse(s2.getItem('turbi.forecasts')).A).toHaveLength(6);
  });
  it('almacenamiento roto: no lanza y devuelve la instantánea actual', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(recordSnapshot('A', snap(0, 1), broken)).toEqual([snap(0, 1)]);
  });
});

describe('forecastTrend', () => {
  it('mejora, empeora y sin cambios desde hace X', () => {
    expect(forecastTrend([snap(0, 2), snap(4, 1)], T(4), fmt)).toBe('La previsión ha mejorado desde la consulta de las 07:00.');
    expect(forecastTrend([snap(0, 0), snap(4, 2)], T(4), fmt)).toBe('La previsión ha empeorado desde la consulta de las 07:00.');
    expect(forecastTrend([snap(0, 1), snap(2, 2), snap(3, 1), snap(6, 1)], T(6), fmt)).toBe('Sin cambios relevantes desde hace 3 horas.');
  });
  it('una sola consulta → null', () => {
    expect(forecastTrend([snap(0, 1)], T(0), fmt)).toBeNull();
  });
});

describe('último pronóstico (offline)', () => {
  it('guarda y recupera la vista ya procesada con su hora', () => {
    const s = mem();
    saveLast({ title: 'PMI → MAD' }, T(0), s);
    expect(loadLast(s)).toEqual({ savedAt: T(0), view: { title: 'PMI → MAD' } });
  });
  it('sin datos o corruptos → null', () => {
    const s = mem();
    expect(loadLast(s)).toBeNull();
    s.setItem('turbi.last', '{roto');
    expect(loadLast(s)).toBeNull();
  });
});

describe('agoText', () => {
  it('textos relativos', () => {
    expect(agoText(30 * 1000)).toBe('hace un momento');
    expect(agoText(18 * 60000)).toBe('hace 18 minutos');
    expect(agoText(60000)).toBe('hace 1 minuto');
    expect(agoText(2 * 3600000 + 10 * 60000)).toBe('hace 2 horas');
    expect(agoText(3600000)).toBe('hace 1 hora');
    expect(agoText(3 * 86400000)).toBe('hace 3 días');
    expect(agoText(86400000)).toBe('hace 1 día');
  });
});

describe('localStorage inaccesible (Safari con cookies bloqueadas)', () => {
  it('ninguna función lanza aunque leer localStorage dé SecurityError', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      expect(loadLast()).toBeNull();
      expect(() => saveLast({ a: 1 }, 1)).not.toThrow();
      expect(recordSnapshot('A', { t: 1, maxLevel: 0, verdict: 'tranquilo' })).toHaveLength(1);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'localStorage', desc); else delete globalThis.localStorage;
    }
  });
});
