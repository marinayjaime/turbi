import { describe, it, expect } from 'vitest';
import {
  delayMinutes, delayBand, currentPunctuality, percentile, median, stats, sampleQuality, qualityLabel,
  slotOf, dowOf, lastFlights, withinDays, trend, pack, unpack,
} from '../js/punctuality.js';

// Registro: { d, o, a, sd, dd, sa, ad, x, f }
const rec = (d, ad, over = {}) => ({ d, o: 'PMI', a: 'MAD', sd: '17:55', dd: ad, sa: '19:25', ad, x: 0, f: ['IB1668'], ...over });

describe('delayMinutes (fechas completas)', () => {
  it('retraso, adelanto y paso de día', () => {
    expect(delayMinutes('2026-09-24', '18:25', '2026-09-24T18:37')).toBe(12);
    expect(delayMinutes('2026-09-24', '19:25', '2026-09-24T19:16')).toBe(-9);
    expect(delayMinutes('2026-09-24', '23:50', '2026-09-25T00:40')).toBe(50);
    expect(delayMinutes('2026-09-24', null, '2026-09-24T18:37')).toBeNull();
    expect(delayMinutes('2026-09-24', '18:25', null)).toBeNull();
  });
});

describe('delayBand', () => {
  it('verde ≤15 · amarillo 16–30 · naranja 31–60 · rojo >60', () => {
    expect([-5, 15, 16, 30, 31, 60, 61].map(delayBand)).toEqual(['ok', 'ok', 'warn', 'warn', 'late', 'late', 'bad']);
  });
});

const NOW = Date.parse('2026-09-24T20:00:00Z');
const leg = over => ({ d: '2026-09-24', o: 'PMI', a: 'MAD', sd: '18:25', ed: '2026-09-24T18:37', sa: '19:50', ea: '2026-09-24T19:56', st: 'FLY', ...over });

describe('currentPunctuality (vuelo de hoy)', () => {
  it('vuelo en el aire: llegada prevista puntual (+6), salida final (+12)', () => {
    const c = currentPunctuality(leg(), NOW);
    expect(c.dep).toMatchObject({ sched: '18:25', time: '18:37', delay: 12, final: true });
    expect(c.arr).toMatchObject({ sched: '19:50', time: '19:56', delay: 6, final: false });
    expect(c.state).toBe('puntual');
    expect(c.text).toBe('Llegada prevista puntual');
  });
  it('llegado con retraso', () => {
    const c = currentPunctuality(leg({ st: 'IBK', ea: '2026-09-24T20:31' }), NOW);
    expect(c).toMatchObject({ state: 'retrasado', text: 'Llegó con 41 min de retraso', band: 'late' });
    expect(c.arr.final).toBe(true);
  });
  it('llegada al día siguiente', () => {
    const c = currentPunctuality(leg({ sd: '23:15', ed: '2026-09-24T23:40', sa: '00:15', ea: '2026-09-25T00:35', st: 'FLY' }), NOW);
    expect(c.arr.delay).toBe(20);
    expect(c.state).toBe('retrasado');
  });
  it('llegada adelantada: puntual', () => {
    expect(currentPunctuality(leg({ ea: '2026-09-24T19:40' }), NOW)).toMatchObject({ state: 'puntual' });
  });
  it('muestra exactamente lo publicado por Aena (caso real IB1668) y de qué aeropuerto viene cada hora', () => {
    const c = currentPunctuality(leg({ o: 'PMI', a: 'MAD', sd: '17:55', ed: '2026-09-24T18:02', sa: '19:25', ea: '2026-09-24T20:07', st: 'INI', std: 'INI', sta: 'INI' }));
    expect(c.dep).toMatchObject({ time: '18:02', delay: 7, source: 'PMI' });
    expect(c.arr).toMatchObject({ time: '20:07', delay: 42, source: 'MAD', beforeTakeoff: true });
  });
  it('en el aire o aterrizado: la llegada ya no es «antes del despegue»', () => {
    expect(currentPunctuality(leg()).arr.beforeTakeoff).toBe(false);
    expect(currentPunctuality(leg({ st: 'IBK', sta: 'IBK', std: 'BOR', ea: '2026-09-24T20:31' })).arr.beforeTakeoff).toBe(false);
  });
  it('cancelado y desviado', () => {
    expect(currentPunctuality(leg({ st: 'CAN' }), NOW)).toMatchObject({ state: 'cancelado', text: 'Vuelo cancelado' });
    expect(currentPunctuality(leg({ st: 'DES' }), NOW)).toMatchObject({ state: 'desviado', text: 'Vuelo desviado' });
  });
  it('sin hora estimada distinta: sin cambios (nunca «puntual seguro»)', () => {
    const c = currentPunctuality(leg({ ed: '2026-09-24T18:25', ea: '2026-09-24T19:50', st: 'SCH' }), NOW);
    expect(c).toMatchObject({ state: 'sin-cambios', text: 'Sin cambios sobre el horario programado' });
    expect(currentPunctuality(leg({ ed: null, ea: null, st: null }), NOW).state).toBe('sin-cambios');
  });
  it('destino extranjero: solo salida, se clasifica por la salida y lo dice', () => {
    const c = currentPunctuality(leg({ sa: null, ea: null, ed: '2026-09-24T19:05', st: 'BOR' }), NOW);
    expect(c).toMatchObject({ basis: 'dep', state: 'retrasado', text: 'Salió con 40 min de retraso' });
  });
});

describe('percentiles y mediana', () => {
  const xs = [-5, 0, 2, 4, 6, 8, 10, 15, 20, 60];
  it('rango más cercano', () => {
    expect(percentile(xs, 75)).toBe(15);
    expect(percentile(xs, 90)).toBe(20);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
  it('mediana (par e impar)', () => {
    expect(median(xs)).toBe(7);
    expect(median([1, 2, 9])).toBe(2);
  });
});

describe('stats', () => {
  const recs = [...[-5, 0, 2, 4, 6, 8, 10, 15, 20, 60].map((ad, i) => rec(`2026-09-${String(10 + i).padStart(2, '0')}`, ad)),
    rec('2026-09-21', null, { x: 1 })];
  it('OTP15, mediana, media, P75, P90 y cancelaciones', () => {
    expect(stats(recs, 'arr')).toEqual({
      sample: 10, otp15: 0.8, median: 7, mean: 12, p75: 15, p90: 20, cancelled: 1, cancelRate: 1 / 11, quality: 'orientativa',
    });
  });
  it('una cancelación no distorsiona los percentiles', () => {
    const withMore = [...recs, rec('2026-09-22', null, { x: 1 }), rec('2026-09-23', null, { x: 2 })];
    const s = stats(withMore, 'arr');
    expect([s.median, s.p75, s.p90, s.otp15, s.sample]).toEqual([7, 15, 20, 0.8, 10]);
    expect(s.cancelled).toBe(3);
  });
  it('vuelos sin hora final válida no cuentan', () => {
    expect(stats([rec('2026-09-10', null), rec('2026-09-11', 5)], 'arr').sample).toBe(1);
  });
  it('por salida cuando no hay llegada', () => {
    expect(stats([rec('2026-09-10', null, { dd: 30, ad: null })], 'dep')).toMatchObject({ sample: 1, otp15: 0 });
  });
  it('muestra insuficiente: sin porcentajes', () => {
    const s = stats(recs.slice(0, 5), 'arr');
    expect(s.quality).toBe('insuficiente');
  });
});

describe('sampleQuality y qualityLabel', () => {
  it('umbrales 10 y 30', () => {
    expect([9, 10, 29, 30].map(sampleQuality)).toEqual(['insuficiente', 'orientativa', 'orientativa', 'util']);
  });
  it('etiqueta descriptiva solo con muestra útil', () => {
    expect(qualityLabel({ otp15: 0.92, quality: 'util' })).toBe('excelente');
    expect(qualityLabel({ otp15: 0.82, quality: 'util' })).toBe('buena');
    expect(qualityLabel({ otp15: 0.7, quality: 'util' })).toBe('normal');
    expect(qualityLabel({ otp15: 0.5, quality: 'util' })).toBe('baja');
    expect(qualityLabel({ otp15: 0.95, quality: 'orientativa' })).toBeNull();
  });
});

describe('franja y día de la semana', () => {
  it('cuatro franjas de 6 h y día de la semana (0 = domingo)', () => {
    expect(['00:30', '06:00', '11:59', '12:00', '18:25', '23:59'].map(slotOf)).toEqual([0, 1, 1, 2, 3, 3]);
    expect(dowOf('2026-09-25')).toBe(5); // viernes
  });
});

describe('ventanas', () => {
  const recs = Array.from({ length: 40 }, (_, i) => rec(new Date(Date.parse('2026-06-01') + i * 3 * 86400000).toISOString().slice(0, 10), i));
  it('últimos 7 vuelos (los más recientes)', () => {
    const l = lastFlights(recs, 7);
    expect(l).toHaveLength(7);
    expect(l[0].d > l[6].d).toBe(true);
  });
  it('30 y 90 días respecto a hoy', () => {
    const today = '2026-09-24';
    expect(withinDays(recs, today, 30).every(r => r.d > '2026-08-25')).toBe(true);
    expect(withinDays(recs, today, 90).length).toBeGreaterThan(withinDays(recs, today, 30).length);
  });
});

describe('trend', () => {
  const s = (otp15, quality = 'util') => ({ otp15, quality });
  it('solo con muestras útiles y diferencias ≥ 10 puntos', () => {
    expect(trend(s(0.7), s(0.82))).toBe('La puntualidad reciente está por debajo de su media de 90 días.');
    expect(trend(s(0.92), s(0.8))).toBe('La puntualidad reciente está por encima de su media de 90 días.');
    expect(trend(s(0.78), s(0.82))).toBe('Sin cambios relevantes.');
    expect(trend(s(0.5, 'orientativa'), s(0.9))).toBeNull();
  });
});

describe('pack / unpack', () => {
  it('ida y vuelta sin pérdidas', () => {
    const r = rec('2026-09-24', 6, { dd: 12, f: ['IB1668', 'I21668'] });
    expect(unpack(pack(r))).toEqual(r);
    expect(pack(r)).toEqual(['2026-09-24', 'PMI', 'MAD', '17:55', 12, '19:25', 6, 0, ['IB1668', 'I21668']]);
  });
});
