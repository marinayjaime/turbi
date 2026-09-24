import { describe, it, expect, vi } from 'vitest';
import { punctualityHtml, signedDelay } from '../js/ui-punctuality.js';
import { fetchPunctuality } from '../js/punctuality.js';

const st = (over = {}) => ({ sample: 67, otp15: 0.82, median: 6, mean: 11, p75: 17, p90: 34, cancelled: 1, cancelRate: 0.015, quality: 'util', ...over });
const history = {
  basis: 'arr',
  last7: { ...st({ sample: 7, quality: 'insuficiente' }), flights: [['2026-09-24', 12, 0], ['2026-09-23', null, 1], ['2026-09-22', 45, 0]] },
  d30: st({ otp15: 0.7, sample: 31 }), d90: st(),
  route: st({ otp15: 0.74, sample: 300 }), airlineRoute: st({ otp15: 0.78, sample: 120 }),
  dow: { 5: st({ otp15: 0.72, sample: 40 }) }, slot: { 3: st({ otp15: 0.76, sample: 90 }), 1: st({ sample: 4, quality: 'insuficiente' }) },
};
const current = { state: 'puntual', text: 'Llegada prevista puntual', band: 'ok', basis: 'arr',
  dep: { sched: '18:25', time: '18:37', delay: 12, final: true }, arr: { sched: '19:50', time: '19:56', delay: 6, final: false } };
const base = { current, history, flight: 'VY3902', airline: 'Vueling', route: ['PMI', 'BCN'], dow: 5, slot: 3, since: '2026-09-24' };

describe('signedDelay', () => {
  it('lenguaje llano', () => {
    expect(signedDelay(6)).toBe('+6 min');
    expect(signedDelay(0)).toBe('a su hora');
    expect(signedDelay(-3)).toBe('3 min antes');
  });
});

describe('punctualityHtml', () => {
  it('hoy: salida y llegada programada → actual, retraso y estado', () => {
    const h = punctualityHtml(base);
    for (const t of ['Hoy', 'Salida', '18:25 → 18:37', '+12 min', 'salió', 'Llegada', '19:50 → 19:56', '+6 min', 'prevista', 'Llegada prevista puntual']) expect(h).toContain(t);
  });
  it('histórico: OTP15 destacado, mediana, P75, P90, cancelaciones y n', () => {
    const h = punctualityHtml(base);
    for (const t of ['82 %', 'llegaron con 15 min de retraso o menos', 'Retraso habitual', '+6 min', '3 de cada 4', '17 min', '9 de cada 10', '34 min', 'Cancelaciones', '1,5 %', '67 vuelos analizados', 'buena']) expect(h).toContain(t);
    expect(h).toContain('La puntualidad reciente está por debajo de su media de 90 días.');
  });
  it('desplegable «Ver histórico» con ventanas y contexto; muestras pequeñas no dan porcentaje', () => {
    const h = punctualityHtml(base);
    for (const t of ['Ver histórico', 'Últimos 7 vuelos', 'Últimos 30 días', '70 %', 'Últimos 90 días', 'Ruta PMI → BCN', '74 %', 'Vueling en esta ruta', '78 %', 'Los viernes', '72 %', 'Salidas de 18:00 a 23:59', '76 %', 'cancelado', '+45 min']) expect(h).toContain(t);
    expect(h).not.toMatch(/probabilidad/i);
  });
  it('sin historial suficiente: lo dice, y sigue mostrando la situación de hoy', () => {
    const h = punctualityHtml({ ...base, history: { ...history, d90: st({ sample: 4, quality: 'insuficiente' }) } });
    expect(h).toContain('Todavía no hay suficiente historial de este vuelo');
    expect(h).toContain('solo hay 4 vuelos registrados');
    expect(h).toContain('Llegada prevista puntual');
    expect(h).not.toContain('82 %');
    const none = punctualityHtml({ ...base, history: null });
    expect(none).toContain('Todavía no hay suficiente historial de este vuelo');
    expect(none).toContain('24 de septiembre de 2026');
  });
  it('muestra orientativa: lo indica', () => {
    expect(punctualityHtml({ ...base, history: { ...history, d90: st({ sample: 20, quality: 'orientativa' }) } })).toContain('dato orientativo');
  });
  it('solo datos de salida: lo explica', () => {
    const h = punctualityHtml({ ...base, history: { ...history, basis: 'dep' } });
    expect(h).toContain('salieron con 15 min de retraso o menos');
    expect(h).toContain('solo hay datos de salida');
  });
  it('cargando', () => {
    expect(punctualityHtml({ ...base, history: undefined })).toContain('Buscando el historial');
  });
  it('cancelado hoy', () => {
    expect(punctualityHtml({ ...base, current: { state: 'cancelado', text: 'Vuelo cancelado', band: 'bad', dep: null, arr: null } })).toContain('Vuelo cancelado');
  });
});

describe('fetchPunctuality', () => {
  it('pide el archivo del vuelo y devuelve su ruta; 404 o error → null', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ routes: { 'PMI-BCN': { basis: 'arr' } } }) }));
    expect(await fetchPunctuality('VY', '3902', 'PMI-BCN', f)).toEqual({ basis: 'arr' });
    expect(f.mock.calls[0][0]).toBe('data/punctuality/VY/3902.json');
    expect(await fetchPunctuality('VY', '3902', 'PMI-MAD', f)).toBeNull();
    expect(await fetchPunctuality('VY', '1', 'PMI-BCN', vi.fn(async () => ({ ok: false, status: 404 })))).toBeNull();
    expect(await fetchPunctuality('VY', '1', 'PMI-BCN', vi.fn(async () => { throw new TypeError('x'); }))).toBeNull();
  });
});
