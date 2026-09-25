import { describe, it, expect } from 'vitest';
import { estimateArrival, flightPhase } from '../js/eta.js';
import { localToUtcMs } from '../js/time.js';

const MIN = 60000;
const MAD = 'Europe/Madrid', LON = 'Europe/London', NYC = 'America/New_York';
const intl = over => ({ d: '2026-09-25', o: 'PMI', a: 'LHR', sd: '17:00', ed: '2026-09-25T17:00', sa: null, ea: null, st: 'SCH', std: 'SCH', sta: null, ...over });
const dep = (date, time) => localToUtcMs(date, time, MAD);
const base = over => ({ leg: intl(), depUtcMs: dep('2026-09-25', '17:00'), plannedMin: 150, tz: LON, nowMs: dep('2026-09-25', '12:00'), ...over });
const cruise = over => ({ state: 'volando', altFt: 36000, kmh: 830, vRateFpm: 0, remainingKm: 600, seenS: 3, ...over });

describe('prioridad de fuentes', () => {
  it('1. PMI → MAD con llegada de Aena: gana Aena (aunque haya radar o ETA previa)', () => {
    const leg = intl({ a: 'MAD', sd: '17:55', ed: '2026-09-24T18:44', sa: '19:25', ea: '2026-09-24T20:10', std: 'BOR', sta: 'LND', st: 'LND' });
    const r = estimateArrival(base({ leg, tz: MAD, radar: cruise(), prev: { ms: 0, at: 0 } }));
    expect(r).toEqual({ date: '2026-09-24', time: '20:10', source: 'aena', method: 'official', confidence: 'high' });
  });
  it('solo hora programada de Aena: se usa como referencia', () => {
    const r = estimateArrival(base({ leg: intl({ a: 'MAD', sa: '18:25' }), tz: MAD }));
    expect(r).toMatchObject({ date: '2026-09-25', time: '18:25', source: 'aena', method: 'scheduled', confidence: 'medium' });
  });
});

describe('estimación Turbi', () => {
  it('2. PMI → LHR sin llegada de Aena, antes de despegar: salida + duración estimada, en hora de Londres', () => {
    // 17:00 Palma = 15:00 UTC; + 150 min = 17:30 UTC = 18:30 en Londres (BST)
    expect(estimateArrival(base())).toEqual({ date: '2026-09-25', time: '18:30', source: 'turbi', method: 'estimated-preflight', confidence: 'low', ms: dep('2026-09-25', '19:30') });
  });
  it('3. PMI → LHR en crucero: el radar mejora la estimación (sin fiarse solo de la velocidad instantánea)', () => {
    const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: dep('2026-09-25', '18:00'), radar: cruise() }));
    expect(r).toMatchObject({ source: 'turbi', method: 'estimated-inflight', confidence: 'medium' });
    // Plan: 17:30 UTC. Radar: 600 km en crucero → antes. Mezcla prudente (a más de 500 km, 40 % radar): ~17:17 UTC → 18:15 Londres.
    expect(r.time).toBe('18:15');
  });
  it('4. el radar desaparece un rato: se conserva la última ETA válida, con la confianza que tenía', () => {
    const now = dep('2026-09-25', '18:10');
    const prev = { ms: dep('2026-09-25', '19:17'), at: now - 10 * MIN, method: 'estimated-inflight', remainingKm: 500, confidence: 'medium' };
    for (const radar of [{ state: 'sin-datos' }, { state: 'no-disponible' }, null]) {
      const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: now, radar, prev }));
      expect(r).toMatchObject({ time: '18:15', method: 'estimated-inflight', confidence: 'medium', held: true, ageMin: 10 });
    }
  });
  it('4b. sin radar más de 12 min: sigue la última ETA, pero con confianza baja (la ficha dice que es la última disponible)', () => {
    const now = dep('2026-09-25', '18:30');
    const prev = { ms: dep('2026-09-25', '19:17'), at: now - 30 * MIN, method: 'estimated-inflight', remainingKm: 500, confidence: 'medium' };
    expect(estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: now, radar: null, prev }))).toMatchObject({ confidence: 'low', held: true, ageMin: 30 });
  });
  it('5. cancelado: sin ETA', () => {
    expect(estimateArrival(base({ leg: intl({ st: 'CAN', std: 'CAN' }) }))).toBeNull();
  });
  it('6. desviado: sin ETA contra el destino original, aunque el radar lo vea', () => {
    expect(estimateArrival(base({ leg: intl({ st: 'DES', std: 'BOR', sta: 'DES' }), radar: cruise() }))).toBeNull();
  });
  it('7. llegada al día siguiente', () => {
    // 23:30 Palma = 21:30 UTC; + 150 = 00:00 UTC del 26 = 01:00 en Londres
    const r = estimateArrival(base({ leg: intl({ sd: '23:30', ed: '2026-09-25T23:30' }), depUtcMs: dep('2026-09-25', '23:30') }));
    expect(r).toMatchObject({ date: '2026-09-26', time: '01:00' });
  });
  it('8. cambio de zona horaria: PMI → JFK a las 14:00 de Palma llega a las 16:40 de Nueva York', () => {
    const r = estimateArrival(base({ leg: intl({ a: 'JFK', sd: '14:00', ed: '2026-09-25T14:00' }), depUtcMs: dep('2026-09-25', '14:00'), plannedMin: 520, tz: NYC }));
    expect(r).toMatchObject({ date: '2026-09-25', time: '16:40' });
  });
  it('9. velocidad ADS-B anómala (rodando o imposible): no se usa', () => {
    const at = speed => estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: dep('2026-09-25', '18:00'), radar: cruise({ kmh: speed }) }));
    expect(at(90).ms).toBe(at(2000).ms);
    expect(at(90).confidence).toBe('low');
    expect(at(90).ms).not.toBe(at(830).ms);
  });
  it('10. cerca del destino: la ETA no oscila aunque el cálculo salte', () => {
    let prev = { ms: dep('2026-09-25', '19:10'), at: dep('2026-09-25', '18:50'), method: 'estimated-inflight', remainingKm: 90 };
    const shown = [];
    [70, 80, 60, 75, 50].forEach((km, i) => {
      const now = dep('2026-09-25', '18:52') + i * 2 * MIN;
      const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: now,
        radar: cruise({ altFt: 9000, vRateFpm: -900, kmh: i % 2 ? 250 : 520, remainingKm: km }), prev }));
      expect(Math.abs(r.ms - prev.ms)).toBeLessThanOrEqual(4 * MIN);
      prev = { ms: r.ms, at: now, method: r.method, remainingKm: km };
      shown.push(r.time);
    });
    expect(new Set(shown).size).toBeLessThanOrEqual(2);
  });
  it('el peso del radar baja de forma continua con la antigüedad de la señal (nunca pesa igual una más vieja)', () => {
    const at = seenS => estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: dep('2026-09-25', '19:00'), radar: cruise({ seenS, remainingKm: 300 }) })).ms;
    const planMs = dep('2026-09-25', '19:30');
    const pull = [5, 20, 45, 60, 90, 120, 170].map(sec => Math.abs(at(sec) - planMs)); // cuánto aparta el radar la ETA del plan
    pull.slice(1).forEach((p, i) => expect(p).toBeLessThan(pull[i]));
  });
  it('señal ADS-B vieja: pesa menos que una reciente, sobre todo cerca del destino', () => {
    const at = (seenS, km) => estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: dep('2026-09-25', '19:00'), radar: cruise({ seenS, remainingKm: km }) }));
    const planMs = dep('2026-09-25', '19:30');
    for (const km of [600, 80]) {
      const fresh = at(5, km), old = at(150, km);
      // Con la señal vieja, la mezcla queda más cerca del plan (el radar pesa menos)
      expect(Math.abs(old.ms - planMs)).toBeLessThan(Math.abs(fresh.ms - planMs));
      expect(old.confidence).toBe('low');
    }
    // Cerca del destino la penalización es mayor: la señal vieja se aleja más de la fresca que lejos del destino
    const gap = km => Math.abs(at(150, km).ms - at(5, km).ms) / Math.abs(at(5, km).ms - planMs);
    expect(gap(80)).toBeGreaterThan(gap(600));
  });
  it('salto de posición imposible respecto a la última lectura: se conserva la ETA anterior', () => {
    const now = dep('2026-09-25', '18:10');
    const prev = { ms: dep('2026-09-25', '19:17'), at: now - 3 * MIN, method: 'estimated-inflight', remainingKm: 300 };
    const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: now, radar: cruise({ remainingKm: 520 }), prev }));
    expect(r).toMatchObject({ held: true, ms: prev.ms });
  });
  it('sin coordenadas (sin distancia restante): no se inventa, se queda la ETA previa al vuelo', () => {
    const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: dep('2026-09-25', '17:20'), radar: cruise({ remainingKm: undefined }) }));
    expect(r).toMatchObject({ method: 'estimated-preflight' });
  });
  it('nunca antes de ahora: el avión en el aire no «ha llegado» por cálculo', () => {
    const now = dep('2026-09-25', '20:00'); // la estimación previa (19:30) ya pasó y sigue volando
    const r = estimateArrival(base({ leg: intl({ std: 'BOR', st: 'BOR' }), nowMs: now, radar: cruise({ remainingKm: 200 }) }));
    expect(r.ms).toBeGreaterThan(now);
  });
});

describe('fase de vuelo (velocidad vertical ADS-B directa)', () => {
  it('sube, crucero, baja', () => {
    expect(flightPhase({ altFt: 12000, vRateFpm: 1800, remainingKm: 900 })).toBe('climb');
    expect(flightPhase({ altFt: 37000, vRateFpm: 0, remainingKm: 600 })).toBe('cruise');
    expect(flightPhase({ altFt: 20000, vRateFpm: -1500, remainingKm: 150 })).toBe('descent');
  });
  it('sin velocidad vertical: por altitud y distancia', () => {
    expect(flightPhase({ altFt: 36000, vRateFpm: null, remainingKm: 600 })).toBe('cruise');
    expect(flightPhase({ altFt: 9000, vRateFpm: null, remainingKm: 60 })).toBe('descent');
  });
});

import { recallEta, rememberEta } from '../js/eta.js';
describe('última ETA en vuelo (memoria de la sesión y almacenamiento)', () => {
  const fake = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
  it('se guarda solo la ETA en vuelo calculada (no la previa al vuelo ni una conservada)', () => {
    const st = fake();
    rememberEta('FR1|2026-09-25', { method: 'estimated-preflight', ms: 1 }, 0, st);
    expect(recallEta('FR1|2026-09-25', st)).toBeNull();
    rememberEta('FR1|2026-09-25', { method: 'estimated-inflight', ms: 5, remainingKm: 400, confidence: 'medium' }, 100, st);
    expect(recallEta('FR1|2026-09-25', st)).toEqual({ ms: 5, at: 100, method: 'estimated-inflight', remainingKm: 400, confidence: 'medium' });
  });
  it('la antigüedad se cuenta desde la observación ADS-B, no desde la consulta (consulta − seenS)', () => {
    const st = fake();
    rememberEta('LH9|2026-09-25', { method: 'estimated-inflight', ms: 5, remainingKm: 400, confidence: 'medium', seenS: 120 }, 1000000, st);
    expect(recallEta('LH9|2026-09-25', st).at).toBe(1000000 - 120000);
  });
  it('sobrevive a reabrir la app (se lee del almacenamiento si no está en memoria)', () => {
    const st = fake();
    st.setItem('turbi-eta', JSON.stringify({ 'VY9|2026-09-25': { ms: 7, at: 1, method: 'estimated-inflight' } }));
    expect(recallEta('VY9|2026-09-25', st)).toMatchObject({ ms: 7 });
  });
});

import { etaSide } from '../js/eta.js';
describe('lado «Llegada» de la ficha con la estimación', () => {
  it('Turbi antes y en vuelo; Aena no pasa por aquí; sin estimación, nada', () => {
    expect(etaSide({ date: '2026-09-25', time: '18:30', source: 'turbi', method: 'estimated-preflight' })).toEqual({ date: '2026-09-25', time: '18:30', estimated: true, note: 'Estimación Turbi' });
    expect(etaSide({ date: '2026-09-25', time: '18:15', source: 'turbi', method: 'estimated-inflight' }).note).toBe('Estimación Turbi actualizada en vuelo');
    expect(etaSide({ date: '2026-09-25', time: '18:15', source: 'turbi', method: 'estimated-inflight', held: true, ageMin: 8 }).note).toBe('Estimación Turbi actualizada en vuelo');
    expect(etaSide({ date: '2026-09-25', time: '18:15', source: 'turbi', method: 'estimated-inflight', held: true, ageMin: 25 }).note)
      .toBe('Última estimación Turbi disponible (hace 25 min, sin señal de radar desde entonces)');
    expect(etaSide({ date: '2026-09-25', time: '20:10', source: 'aena', method: 'official' })).toBeNull();
    expect(etaSide(null)).toBeNull();
  });
});
