// ¿Cuándo se consulta el radar? Regla general (app y servidor): salida confirmada (BOR) + llegada NO final = candidato.
// FLY/FNL, siempre. Nunca: llegada final (LND, IBK, OPE, OPF, BOR), cancelado, desviado o salida aún no confirmada.
// Estados intermedios de llegada observados en Aena con la salida ya BOR (25/09/2026): INI, SCH, HOR, TMA.
import { describe, it, expect } from 'vitest';
import { wantsRadar, withRadar } from '../js/radar.js';
import { needsRadar } from '../server/radar.mjs';
import { flightCardHtml } from '../js/ui.js';

const LIVE = 'https://x';
const now = Date.parse('2026-09-25T09:30:00Z');
// Salida de Palma a las 10:51 locales (08:51 UTC): dentro de la ventana del servidor.
const leg = over => ({ al: 'UX', icao: 'AEA', n: '6030', d: '2026-09-25', o: 'PMI', a: 'MAD', sd: '10:40', ed: '2026-09-25T10:51',
  sa: '12:05', ea: '2026-09-25T12:06', st: 'BOR', std: 'BOR', sta: null, ac: '738W', ...over });
const both = l => [wantsRadar(l, LIVE, { nowMs: now }), needsRadar(l, now)];

describe('salida BOR + llegada no final → radar (app y servidor)', () => {
  it('1. sin estado de llegada', () => expect(both(leg())).toEqual([true, true]));
  it('2. llegada FLY (en vuelo)', () => expect(both(leg({ sta: 'FLY', st: 'FLY' }))).toEqual([true, true]));
  it('3. llegada FNL (aproximándose)', () => expect(both(leg({ sta: 'FNL', st: 'FNL' }))).toEqual([true, true]));
  it('4. estados intermedios no finales de la llegada (INI, SCH, HOR, TMA, RET)', () => {
    for (const sta of ['INI', 'SCH', 'HOR', 'TMA', 'RET']) expect(both(leg({ sta })), sta).toEqual([true, true]);
  });
});

describe('nunca radar', () => {
  it('5. llegada LND (aterrizado)', () => expect(both(leg({ sta: 'LND', st: 'LND' }))).toEqual([false, false]));
  it('6. llegada final IBK / OPE / OPF / BOR', () => {
    for (const sta of ['IBK', 'OPE', 'OPF', 'BOR']) expect(both(leg({ sta })), sta).toEqual([false, false]);
  });
  it('7. cancelado o desviado (en la salida o en la llegada)', () => {
    for (const over of [{ std: 'CAN', st: 'CAN' }, { sta: 'CAN' }, { sta: 'DES' }, { std: 'DES' }]) expect(both(leg(over)), JSON.stringify(over)).toEqual([false, false]);
  });
  it('8. salida aún no confirmada: antes de la hora de salida − 5 min, no; ya en la hora, comprobación barata (radarGate)', () => {
    const before = Date.parse('2026-09-25T08:30:00Z'); // primera salida (programada) 10:40 locales = 08:40 UTC; − 5 min = 08:35
    for (const std of ['EMB', 'SCH', 'INI', 'RET', 'ULL', null]) {
      const l = leg({ std, st: std, sta: 'INI' });
      expect([wantsRadar(l, LIVE, { nowMs: before }), needsRadar(l, before)], String(std)).toEqual([false, false]);
      expect(both(l), String(std)).toEqual([true, true]); // 09:30 UTC: ya pasada la salida
    }
  });
  it('el servidor mantiene la ventana: nunca antes del despegue ni más de 20 h después', () => {
    expect(needsRadar(leg({ sta: 'INI' }), Date.parse('2026-09-25T08:40:00Z'))).toBe(false); // antes de la salida
    expect(needsRadar(leg({ sta: 'INI' }), Date.parse('2026-09-26T05:00:00Z'))).toBe(false); // 20 h después
  });
});

describe('regresiones reales (datos de Aena del 25/09/2026, sin ningún código específico)', () => {
  it('9. UX6030 PMI → MAD: salida BOR y un estado de llegada intermedio → se consulta el radar y se ve el panel', () => {
    const l = leg({ sta: 'INI', st: 'BOR' });
    expect(both(l)).toEqual([true, true]);
    const card = withRadar({ status: { text: 'Ha salido', tone: 'info' } }, { state: 'volando', callsign: 'AEA6030', altM: 10000, kmh: 800, seenS: 1, source: 'adsb.lol' });
    expect(card.status).toMatchObject({ text: 'Volando', flying: true });
  });
  it('10. UX4024 PMI → ALC (BOR + FLY) sigue mostrando el panel ADS-B', () => {
    const l = leg({ n: '4024', a: 'ALC', sd: '10:40', ed: '2026-09-25T10:48', sa: '11:40', ea: '2026-09-25T11:44', st: 'FLY', std: 'BOR', sta: 'FLY', op: 'UX' });
    expect(both(l)).toEqual([true, true]);
    const r = { state: 'volando', callsign: 'AEA4024', altM: 7000, kmh: 700, seenS: 2, remainingKm: 120, source: 'adsb.lol' };
    const c = { al: 'UX', title: 'x', route: 'y', tabs: [], status: { text: 'En vuelo', tone: 'info', flying: true }, o: 'PMI', a: 'ALC', duration: 60,
      dep: { date: '2026-09-25', time: '10:48', est: null, late: false, terminal: null, gate: null }, arr: null, aircraft: null, updatedAgo: 'hace 1 min', stale: false };
    expect(flightCardHtml(withRadar(c, r))).toContain('class="telemetry"');
  });
});
