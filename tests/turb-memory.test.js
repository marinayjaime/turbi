import { describe, it, expect } from 'vitest';
import { forecastDigest, legacyDigest, rememberTurb, recallTurb } from '../js/turb-memory.js';
import { flightCardHtml } from '../js/ui.js';

// Último pronóstico de turbulencias de cada vuelo físico, para «Turbulencias estimadas» tras el aterrizaje.
const NOW = Date.parse('2026-10-22T12:00:00Z');
const DAY = 24 * 3600000;
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
const view = { queriedAt: NOW, confidence: { level: 'media', reasons: [] }, segments: [{}], points: [{}],
  summary: { headline: 'Algo de movimiento', verdict: 'movimiento', maxLevel: 2, maxDurationMin: 14, moments: [{ startMin: 30, endMin: 44 }], percentages: [70, 20, 10, 0] } };

describe('resumen de turbulencias por vuelo físico (js/turb-memory.js)', () => {
  it('solo el resumen pequeño, por clave; fuera los de más de 7 días; pocos registros; el v1 sin datos inventados', () => {
    const s = memoryStorage();
    expect(forecastDigest(view)).toEqual({ headline: 'Algo de movimiento', verdict: 'movimiento', maxLevel: 2, maxDurationMin: 14,
      percentages: [70, 20, 10, 0], confidence: 'media', queriedAt: NOW });
    expect(forecastDigest({ ...view, calmScore: 82 })).toMatchObject({ calmScore: 82 });
    expect(legacyDigest({ verdict: 'turbulento', durationMin: 90, segments: [{ level: 0, startMin: 0, endMin: 60 }, { level: 3, startMin: 60, endMin: 70 }, { level: 1, startMin: 70, endMin: 90 }] }, NOW))
      .toEqual({ headline: 'Turbulento', verdict: 'turbulento', maxLevel: 3, maxDurationMin: 10, queriedAt: NOW });
    expect(legacyDigest({ verdict: 'tranquilo', durationMin: 90, segments: [] }, NOW)).toBeNull(); // sin tramos, nada

    rememberTurb('old', { ...forecastDigest(view), queriedAt: NOW - 8 * DAY }, NOW - 8 * DAY, s);
    rememberTurb('2026-10-22|PMI|MAD|08:00', forecastDigest(view), NOW, s);
    expect(JSON.parse(s.getItem('turbi-turb-estimates'))).not.toHaveProperty('old'); // caducado: fuera al guardar otro
    expect(recallTurb('2026-10-22|PMI|MAD|08:00', NOW + 6 * DAY, s)).toMatchObject({ headline: 'Algo de movimiento' });
    expect(recallTurb('2026-10-22|PMI|MAD|08:00', NOW + 8 * DAY, s)).toBeNull();
    expect(recallTurb('2026-10-22|PMI|MAD|20:00', NOW, s)).toBeNull(); // otro tramo del mismo día
    for (let i = 0; i < 30; i++) rememberTurb(`k${i}`, forecastDigest(view), NOW, s);
    expect(Object.keys(JSON.parse(s.getItem('turbi-turb-estimates')))).toHaveLength(20);
    rememberTurb('mal', { headline: 'Inventado', maxLevel: 7, queriedAt: NOW }, NOW, s);
    expect(recallTurb('mal', NOW, s)).toBeNull();
  });

  it('Resumen del vuelo: «Turbulencias estimadas» con el titular y el máximo estimado, en pasado; nunca como turbulencia observada', () => {
    const card = { number: 'IB 1668', title: 'IB 1668', route: 'Palma a Madrid', tabs: [], status: { text: 'Ha llegado', tone: 'ok' },
      o: 'PMI', a: 'MAD', cities: { o: 'Palma', a: 'Madrid' }, phase: 'terminado', source: 'aena', depFinal: true, arrFinal: true,
      dep: { date: '2026-10-22', time: '10:00' }, arr: { date: '2026-10-22', time: '11:03' }, depMs: NOW, arrMs: NOW + 63 * 60000, km: 546 };
    const html = flightCardHtml({ ...card, turbEstimate: { headline: 'Turbulento', maxLevel: 3, maxDurationMin: 9, queriedAt: NOW } }, { nowMs: NOW, monoMs: NOW });
    const sum = html.slice(html.indexOf('data-card="flight-summary"'));
    expect(sum).toContain('data-fs="turbulence"');
    expect(sum).toMatch(/Turbulencias estimadas<\/span><span class="v"><span class="lvl-ink3">Turbulento<\/span><span class="fs-sub">Máximo estimado: Fuerte · ≈ 10 min<\/span>/);
    expect(sum).not.toMatch(/fueron|tuvo turbulencia|reales|previst/i); // en pasado y como estimación
    const calm = flightCardHtml({ ...card, turbEstimate: { headline: 'Tranquilo', maxLevel: 0, maxDurationMin: 0, queriedAt: NOW } }, { nowMs: NOW, monoMs: NOW });
    expect(calm).toContain('<span class="fs-sub">No se estimó turbulencia relevante</span>');
    expect(flightCardHtml(card, { nowMs: NOW, monoMs: NOW })).not.toContain('Turbulencias estimadas'); // sin resumen, nada
  });
});
