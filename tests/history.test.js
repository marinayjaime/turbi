import { describe, it, expect } from 'vitest';
import { loadHistory, saveToHistory } from '../js/history.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
const entry = id => ({ id, number: id, origin: { iata: 'PMI' }, destination: { iata: 'BCN' }, date: '2026-09-25', time: '07:15' });

describe('history', () => {
  it('vacío al principio', () => {
    expect(loadHistory(memoryStorage())).toEqual([]);
  });
  it('guarda el más reciente primero, sin duplicados, máximo 5', () => {
    const s = memoryStorage();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) saveToHistory(entry(id), s);
    expect(loadHistory(s).map(e => e.id)).toEqual(['b', 'f', 'e', 'd', 'c']);
  });
  it('JSON corrupto o storage que lanza → lista vacía, sin excepción', () => {
    const s = memoryStorage(); s.setItem('turbi.history', '{roto');
    expect(loadHistory(s)).toEqual([]);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadHistory(broken)).toEqual([]);
    expect(() => saveToHistory(entry('x'), broken)).not.toThrow();
  });
});
