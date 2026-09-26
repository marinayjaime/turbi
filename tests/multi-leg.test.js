// Un número de vuelo con varios vuelos físicos la misma fecha (caso real CA898, 26/09/2026: GRU → MAD, ya llegado,
// y después MAD → PEK, recién despegado; Turbi mostraba «Ha llegado»). Número + fecha no identifica un tramo: se
// distinguen con physicalFlightKey() y se elige por estado y hora, nunca por el orden de la lista. Datos simulados.
import { describe, it, expect } from 'vitest';
import { chooseLeg, legPhase } from '../js/schedule.js';
import { physicalFlightKey } from '../js/physical-flight.js';

const D = '2026-09-26';
const now = Date.parse('2026-09-26T11:00:00Z'); // 13:00 en Madrid
// GRU → MAD: Aena solo publica la llegada a Madrid. MAD → PEK: solo la salida.
const inbound = over => ({ al: 'CA', n: '898', d: D, o: 'GRU', a: 'MAD', sd: null, ed: null, sa: '07:10', ea: `${D}T07:25`, st: null, std: null, sta: 'LND', ...over });
const outbound = over => ({ al: 'CA', n: '898', d: D, o: 'MAD', a: 'PEK', sd: '12:30', ed: `${D}T12:45`, sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
const both = (a, b) => [[a, b], [b, a]]; // los dos órdenes posibles de la lista

describe('CA898: dos tramos del mismo número la misma fecha', () => {
  it('llegada terminada + salida ya en el aire → la salida, en cualquier orden de la lista', () => {
    for (const legs of both(inbound(), outbound())) {
      const { leg, choices } = chooseLeg(legs, D, now);
      expect(`${leg.o}-${leg.a}`).toBe('MAD-PEK');
      expect(choices.map(l => `${l.o}-${l.a}`)).toEqual(['GRU-MAD', 'MAD-PEK']); // ordenados por hora, para el selector
    }
  });
  it('llegada terminada + salida embarcando, última llamada o puerta cerrada → la salida', () => {
    for (const std of ['EMB', 'ULL', 'CER', 'BTR']) {
      for (const legs of both(inbound({ sta: 'IBK' }), outbound({ st: std, std }))) {
        expect(chooseLeg(legs, D, now - 45 * 60000).leg.o, std).toBe('MAD');
      }
    }
  });
  it('llegada aún en el aire (FLY/FNL) + salida terminada o cancelada → la llegada', () => {
    const early = Date.parse('2026-09-26T05:00:00Z');
    for (const legs of both(inbound({ sta: 'FNL' }), outbound({ st: 'CAN', std: 'CAN' }))) {
      expect(chooseLeg(legs, D, early).leg.a).toBe('MAD');
    }
  });
  it('dos tramos futuros el mismo día → no se escoge ninguno en silencio (el usuario elige por ruta)', () => {
    const tomorrow = '2026-09-27';
    for (const legs of both(inbound({ d: tomorrow, sta: null, ea: `${tomorrow}T07:10` }), outbound({ d: tomorrow, st: null, std: null, ed: `${tomorrow}T12:30` }))) {
      const { leg, choices } = chooseLeg(legs, tomorrow, now);
      expect(leg).toBeNull();
      expect(choices).toHaveLength(2);
    }
  });
  it('dos tramos terminados el mismo día → tampoco depende del orden: no se escoge ninguno', () => {
    const late = Date.parse('2026-09-27T09:00:00Z');
    const done = [inbound({ sta: 'OPF' }), outbound({ sa: '06:00', ea: `2026-09-27T06:00` })];
    const a = chooseLeg(done, D, late), b = chooseLeg([...done].reverse(), D, late);
    expect(a.leg).toBeNull();
    expect(b.leg).toBeNull();
    expect(a.choices.map(physicalFlightKey)).toEqual(b.choices.map(physicalFlightKey));
  });
  it('en curso + otro por salir más tarde → no se escoge (los dos son plausibles)', () => {
    const later = outbound({ sd: '18:00', ed: `${D}T18:00`, st: null, std: null });
    for (const legs of both(inbound({ sta: 'FLY' }), later)) expect(chooseLeg(legs, D, Date.parse('2026-09-26T05:00:00Z')).leg).toBeNull();
  });
  it('cambiar el orden de la lista nunca cambia el tramo elegido ni el orden de los tramos', () => {
    const legs = [inbound(), outbound(), inbound({ al: 'IB', n: '1234' })];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(p => p.map(i => legs[i]).filter(l => l.al === 'CA'));
    const results = perms.map(p => chooseLeg(p, D, now));
    for (const r of results) {
      expect(physicalFlightKey(r.leg)).toBe(physicalFlightKey(outbound()));
      expect(r.choices.map(physicalFlightKey)).toEqual(results[0].choices.map(physicalFlightKey));
    }
  });
  it('el mismo vuelo físico repetido en la lista cuenta una sola vez (no aparece un selector falso)', () => {
    expect(chooseLeg([outbound(), outbound()], D, now)).toEqual({ leg: expect.objectContaining({ a: 'PEK' }), choices: [] });
  });
});

describe('fase de un tramo', () => {
  it('estados de Aena', () => {
    expect(legPhase(inbound({ sta: 'LND' }), now)).toBe('terminado');
    expect(legPhase(inbound({ sta: 'FLY' }), now)).toBe('en-curso');
    expect(legPhase(outbound(), now)).toBe('en-curso'); // salida confirmada (BOR) sin llegada
    expect(legPhase(outbound({ st: 'CAN', std: 'CAN' }), now)).toBe('cancelado');
    expect(legPhase(outbound({ st: 'SCH', std: 'SCH', sd: '18:00', ed: `${D}T18:00` }), now)).toBe('pendiente');
  });
  it('salida confirmada hacia el extranjero (sin llegada): en curso hasta 20 h después de salir; después, terminado', () => {
    expect(legPhase(outbound(), Date.parse('2026-09-27T06:00:00Z'))).toBe('en-curso');
    expect(legPhase(outbound(), Date.parse('2026-09-27T12:00:00Z'))).toBe('terminado');
  });
  it('sin estado activo, la llegada de Aena muy pasada cuenta como terminada; un vuelo nocturno no se da por terminado antes de salir', () => {
    expect(legPhase(inbound({ sta: null, ea: null, sa: '07:10' }), now)).toBe('terminado');
    // Sale a las 23:00 y llega a las 06:00 del día siguiente: a las 13:00 del primer día está pendiente, no terminado.
    const night = { al: 'XX', n: '1', d: D, o: 'MAD', a: 'LPA', sd: '23:00', ed: null, sa: '06:00', ea: null, st: 'SCH', std: 'SCH', sta: null };
    expect(legPhase(night, now)).toBe('pendiente');
  });
});
