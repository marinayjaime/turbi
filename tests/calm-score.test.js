// Calm Score (js/calm-score.js): lo tranquilo que se prevé el vuelo completo, 0–100, a partir del Turbi Index por punto.
// Los escenarios pasan por buildSegmentsV2 y summarize (los de la app), así el titular es el mismo que vería el usuario.
import { describe, it, expect } from 'vitest';
import { calmScore, CALM_MIN_COVERAGE } from '../js/calm-score.js';
import { buildSegmentsV2, summarize } from '../js/summary.js';

const levelOf = s => (s >= 75 ? 3 : s >= 50 ? 2 : s >= 25 ? 1 : 0);
// f(minuto, i) → Turbi Index del punto (null = sin datos). 31 puntos cada 4 min en un vuelo de 120 min (por defecto).
function view(f, { D = 120, n = 31 } = {}) {
  const step = D / (n - 1);
  const points = Array.from({ length: n }, (_, i) => ({ min: i * step, fl: 350 }));
  const results = points.map((p, i) => {
    const s = f(p.min, i);
    return s === null ? { valid: false } : { valid: true, score: s, level: levelOf(s), causes: [] };
  });
  return { durationMin: D, summary: summarize(buildSegmentsV2(points, results), D),
    route: results.map(r => ({ lat: 40, lon: 0, level: r.valid ? r.level : null, score: r.valid ? r.score : null })) };
}
const calm = (f, o) => calmScore(view(f, o))?.score ?? null;
const during = (from, to, s, base = 10) => m => (m >= from && m < to ? s : base);

describe('Calm Score', () => {
  // Orden: un bache moderado aislado (≈ 4 min) se prevé más llevadero que dos horas seguidas de ligera.
  it('escenarios tipo: tranquilo, ligero, moderado y fuerte, en orden y cada uno en la banda de su titular', () => {
    const cases = [
      ['todo nulo', () => 10, 'Tranquilo', 100, 100],
      ['ligera breve (8 min)', during(40, 48, 37), 'Mayormente tranquilo', 80, 99],
      ['moderada aislada (1 punto)', (m, i) => (i === 15 ? 55 : 10), 'Algo de movimiento', 50, 79],
      ['ligera todo el vuelo', () => 37, 'Algo de movimiento', 50, 79],
      ['moderada 40 min', during(40, 80, 62), 'Turbulento', 0, 49],
      ['fuerte 20 min', during(40, 60, 85), 'Turbulento', 0, 49],
    ];
    let prev = 101;
    for (const [name, f, headline, lo, hi] of cases) {
      const v = view(f);
      const r = calmScore(v);
      expect(v.summary.headline, name).toBe(headline);
      expect(r.score, name).toBeGreaterThanOrEqual(lo);
      expect(r.score, name).toBeLessThanOrEqual(hi);
      expect(r.score, `${name}: más turbulencia, menos nota`).toBeLessThan(prev);
      prev = r.score;
    }
  });

  it('dentro de un nivel cuenta la intensidad: ligera casi moderada < ligera apenas perceptible (breve y en todo el vuelo)', () => {
    expect(calm(during(40, 48, 48))).toBeLessThan(calm(during(40, 48, 27)));
    expect(calm(() => 48)).toBeLessThan(calm(() => 37));
    expect(calm(() => 37)).toBeLessThan(calm(() => 27));
    expect(calm(during(40, 60, 74, 10))).toBeLessThan(calm(during(40, 60, 51, 10))); // moderada alta < moderada baja
    expect(calm(() => 100)).toBe(0); // el extremo de la escala de Turbi
    expect(calm(() => 24)).toBe(100); // por debajo del umbral de ligera no hay turbulencia
  });

  it('episodios breves no hunden la nota y la duración cuenta: más minutos (o más proporción de ligera), menos nota', () => {
    const isolatedModerate = calm((m, i) => (i === 15 ? 55 : 10));
    expect(isolatedModerate).toBeGreaterThanOrEqual(70); // un punto moderado: sigue siendo «algo de movimiento» alto
    const strong1 = calm((m, i) => (i === 15 ? 78 : 10));
    expect(strong1).toBeGreaterThanOrEqual(40); // un punto fuerte: turbulento, pero no hundido
    expect(strong1).toBeLessThanOrEqual(49);
    for (const [a, b] of [[20, 40], [40, 80]]) expect(calm(during(40, 40 + b, 62))).toBeLessThan(calm(during(40, 40 + a, 62)));
    // Ligera: proporción del vuelo. Los mismos 20 min ligeros pesan menos en un vuelo de 6 h que en uno de 1 h.
    expect(calm(during(20, 40, 37), { D: 360, n: 91 })).toBeGreaterThan(calm(during(20, 40, 37), { D: 60, n: 16 }));
    // Moderada: minutos absolutos. 16 min moderados restan lo mismo en 1 h que en 6 h (mismo titular, misma nota).
    expect(calm(during(20, 36, 62), { D: 360, n: 91 })).toBe(calm(during(20, 36, 62), { D: 60, n: 16 }));
  });

  it('sin datos no es calma: cobertura < 80 % → sin nota; con huecos, la turbulencia vista no se diluye en ellos', () => {
    expect(CALM_MIN_COVERAGE).toBe(0.8);
    expect(calmScore(view((m, i) => (i < 9 ? null : 10)))).toBeNull(); // 30 % sin datos, el resto en calma: nada
    const full = calmScore(view(during(60, 72, 62)));
    const gaps = calmScore(view((m, i) => (i < 5 ? null : during(60, 72, 62)(m))));
    expect(gaps.coverage).toBeLessThan(1);
    expect(gaps.coverage).toBeGreaterThanOrEqual(0.8);
    expect(gaps.score).toBeLessThanOrEqual(full.score); // los huecos no suben la nota
    expect(calmScore(view(() => null))).toBeNull();
  });

  it('entradas incompletas: sin ruta, sin duración o sin titular → null; pronóstico guardado sin score → el centro de cada nivel', () => {
    expect(calmScore(null)).toBeNull();
    expect(calmScore({ durationMin: 90, summary: { headline: 'Tranquilo' }, route: [] })).toBeNull();
    expect(calmScore({ ...view(() => 10), durationMin: 0 })).toBeNull();
    expect(calmScore({ ...view(() => 10), summary: {} })).toBeNull();
    const v = view(during(40, 80, 62));
    const old = { ...v, route: v.route.map(({ score, ...p }) => p) }; // sin score: nivel 2 → 62,5
    expect(calmScore(old).score).toBe(calmScore(v).score);
    // Determinista: el mismo pronóstico, la misma nota.
    expect(calmScore(v)).toEqual(calmScore(view(during(40, 80, 62))));
  });
});
