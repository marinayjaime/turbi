import { describe, it, expect } from 'vitest';
import { computeCalmScore } from '../js/calm-score.js';

const points = (n, score) => Array.from({ length: n }, () => ({ valid: true, score }));

describe('Calm Score (todo el vuelo, sin datos añadidos)', () => {
  it('100 para un vuelo completamente tranquilo y 0 para intensidad máxima sostenida', () => {
    expect(computeCalmScore(points(11, 0), 90)).toBe(100);
    expect(computeCalmScore(points(11, 100), 90)).toBe(0);
    expect(computeCalmScore(points(11, 15), 90)).toBe(100);
  });

  it('la intensidad creciente nunca mejora la nota, también dentro de cada nivel', () => {
    const scores = [0, 15, 25, 35, 49, 50, 65, 75, 90, 100]
      .map(s => computeCalmScore(points(11, s), 120));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    expect(scores[2]).toBeGreaterThan(scores[4]); // ligera suave vs ligera alta
  });

  it('penaliza más la turbulencia prolongada y los episodios intensos', () => {
    const brief = points(21, 0), long = points(21, 0), mild = points(21, 0);
    brief[10].score = 80;
    mild[10].score = 30;
    for (let i = 7; i <= 13; i++) long[i].score = 80;
    expect(computeCalmScore(long, 120)).toBeLessThan(computeCalmScore(brief, 120));
    expect(computeCalmScore(brief, 120)).toBeLessThan(computeCalmScore(mild, 120));
  });

  it('mantiene el resultado con distinta densidad de puntos para condiciones uniformes', () => {
    expect(computeCalmScore(points(10, 50), 90)).toBe(computeCalmScore(points(40, 50), 90));
    expect(computeCalmScore(points(40, 70), 90)).toBe(computeCalmScore(points(40, 70), 720));
  });

  it('no confunde datos ausentes, inválidos o no finitos con aire tranquilo', () => {
    expect(computeCalmScore([], 90)).toBeNull();
    expect(computeCalmScore(points(10, 0), 0)).toBeNull();
    expect(computeCalmScore(points(10, 0), NaN)).toBeNull();
    const missing = points(11, 0);
    missing[5] = { valid: false, score: null }; // 10 % temporal sin datos
    expect(computeCalmScore(missing, 100)).toBeNull();
    missing[5] = { valid: true, score: Infinity };
    expect(computeCalmScore(missing, 100)).toBeNull();
  });

  it('tolera hasta el 5 % ausente (extremo), calculando solo sobre tramos válidos', () => {
    const almost = points(11, 12);
    almost[0] = { valid: false, score: null };
    expect(computeCalmScore(almost, 100)).toBe(100);
  });
});
