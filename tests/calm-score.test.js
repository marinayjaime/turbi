// Calm Score (js/calm-score.js): lo tranquilo que se prevé el vuelo completo, 0–100, a partir del Turbi Index por punto.
// Los escenarios pasan por buildSegmentsV2 y summarize (los de la app), así el titular es el mismo que vería el usuario.
import { describe, it, expect } from 'vitest';
import { calmScore, severity, CALM_MIN_COVERAGE, CALM_MAX_GAP_MIN } from '../js/calm-score.js';
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
  it('escenarios tipo, de más tranquilo a más turbulento, con su titular', () => {
    const cases = [
      ['todo nulo', () => 10, 'Tranquilo', 100, 100],
      ['ligera breve (8 min)', during(40, 48, 37), 'Mayormente tranquilo', 90, 99],
      ['moderada aislada (1 punto)', (m, i) => (i === 15 ? 55 : 10), 'Algo de movimiento', 80, 92],
      ['ligera todo el vuelo', () => 37, 'Algo de movimiento', 50, 70],
      ['moderada 15 min', during(40, 55, 62), 'Turbulento', 40, 55],
      ['moderada 40 min', during(40, 80, 62), 'Turbulento', 20, 39],
      ['fuerte 20 min', during(40, 60, 85), 'Turbulento', 5, 19],
      ['extremo todo el vuelo', () => 100, 'Turbulento', 0, 0],
    ];
    let prev = 101;
    for (const [name, f, headline, lo, hi] of cases) {
      const v = view(f);
      const { score } = calmScore(v);
      expect(v.summary.headline, name).toBe(headline);
      expect(score, name).toBeGreaterThanOrEqual(lo);
      expect(score, name).toBeLessThanOrEqual(hi);
      expect(score, `${name}: más turbulencia, menos nota`).toBeLessThan(prev);
      prev = score;
    }
  });

  it('sin saltos: cruzar un umbral de nivel (25, 50, 75) por décimas cambia la nota por décimas; siempre monótona', () => {
    for (const t of [25, 50, 75]) {
      expect(Math.abs(calm(() => t - 0.2) - calm(() => t + 0.2)), `todo el vuelo en ${t}`).toBeLessThanOrEqual(2); // 0,4 durante 2 h
      expect(Math.abs(calm(during(40, 52, t - 0.2)) - calm(during(40, 52, t + 0.2))), `episodio en ${t}`).toBeLessThanOrEqual(1);
      expect(severity(t - 1e-9)).toBeCloseTo(severity(t), 6); // la severidad es continua en los umbrales
    }
    let prev = 101;
    for (let s = 0; s <= 100; s += 0.5) {
      const c = calm(() => s);
      expect(c, `s = ${s}`).toBeLessThanOrEqual(prev);
      expect(prev - c, `s = ${s}`).toBeLessThanOrEqual(6); // nunca un desplome entre pronósticos casi iguales
      prev = c;
    }
    expect(calm(() => 25.5)).toBeGreaterThanOrEqual(95); // un rastro de ligera en todo el vuelo apenas resta
  });

  it('intensidad dentro del nivel y duración: ligera casi moderada < ligera baja; más minutos, menos nota; la ligera se diluye en vuelos largos', () => {
    expect(calm(during(40, 48, 48))).toBeLessThan(calm(during(40, 48, 27)));
    expect(calm(() => 48)).toBeLessThan(calm(() => 37));
    expect(calm(() => 37)).toBeLessThan(calm(() => 27));
    expect(calm(during(40, 60, 74))).toBeLessThan(calm(during(40, 60, 51))); // moderada alta < moderada baja
    expect(calm(() => 24)).toBe(100); // por debajo del umbral de ligera no hay turbulencia
    for (const [a, b] of [[20, 40], [40, 80]]) expect(calm(during(40, 40 + b, 62))).toBeLessThan(calm(during(40, 40 + a, 62)));
    const strong1 = calm((m, i) => (i === 15 ? 88 : 10));
    expect(strong1).toBeGreaterThanOrEqual(35); // un punto fuerte resta mucho, pero no hunde la nota
    expect(strong1).toBeLessThanOrEqual(55);
    // Los mismos 20 min (ligeros o moderados) pesan menos en un vuelo de 6 h, casi todo tranquilo, que en uno de 1 h.
    expect(calm(during(20, 40, 37), { D: 360, n: 91 })).toBeGreaterThan(calm(during(20, 40, 37), { D: 60, n: 16 }));
    expect(calm(during(20, 36, 62), { D: 360, n: 91 })).toBeGreaterThan(calm(during(20, 36, 62), { D: 60, n: 16 }));
  });

  it('sin datos no es calma: cobertura < 80 % o un hueco seguido de más de 15 min → sin nota; los huecos no diluyen lo visto', () => {
    expect(CALM_MIN_COVERAGE).toBe(0.8);
    expect(CALM_MAX_GAP_MIN).toBe(15);
    expect(calmScore(view((m, i) => (i < 9 ? null : 10)))).toBeNull(); // 30 % sin datos, el resto en calma: nada
    expect(calmScore(view((m, i) => (i >= 10 && i < 14 ? null : 10)))).toBeNull(); // 16 min seguidos sin datos
    expect(calmScore(view((m, i) => (i >= 10 && i < 13 ? null : 10)))).not.toBeNull(); // 12 min: cabe
    expect(calmScore(view((m, i) => (i % 7 === 3 ? null : 10))).score).toBe(100); // huecos sueltos de un punto
    const full = calmScore(view(during(60, 72, 62)));
    const gaps = calmScore(view((m, i) => (i === 3 || i === 25 ? null : during(60, 72, 62)(m))));
    expect(gaps.coverage).toBeLessThan(1);
    expect(gaps.score).toBeLessThanOrEqual(full.score); // los huecos no suben la nota
    expect(calmScore(view(() => null))).toBeNull();
  });

  it('entradas incompletas → null; pronóstico guardado sin score → el centro de cada nivel; determinista', () => {
    expect(calmScore(null)).toBeNull();
    expect(calmScore({ durationMin: 90, route: [] })).toBeNull();
    expect(calmScore({ ...view(() => 10), durationMin: 0 })).toBeNull();
    const v = view(during(40, 80, 62.5));
    const old = { ...v, route: v.route.map(({ score, ...p }) => p) }; // sin score: nivel 2 → 62,5
    expect(calmScore(old).score).toBe(calmScore(v).score);
    expect(calmScore(v)).toEqual(calmScore(view(during(40, 80, 62.5))));
  });
});
