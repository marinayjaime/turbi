import { describe, it, expect, vi } from 'vitest';
import { wantsRadar, fetchRadar, withRadar, departedText, endedNote, radarNote, ENDED_ESTIMATED, rememberSighting, recallSighting } from '../js/radar.js';

const leg = over => ({ d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
const card = { status: { text: 'Ha salido · Aena no informa de la llegada a Dublín', tone: 'info' }, stale: false };

describe('cuándo pregunta la app al radar', () => {
  it('ha salido y Aena no informa de la llegada; con servicio en directo', () => {
    expect(wantsRadar(leg(), 'https://x')).toBe(true);
    expect(wantsRadar(leg({ sta: 'FLY' }), 'https://x')).toBe(false);
    expect(wantsRadar(leg({ std: 'EMB' }), 'https://x')).toBe(false);
    expect(wantsRadar(leg(), null)).toBe(false);
  });
});

describe('texto cuando Aena no publica la llegada', () => {
  it('lo dice en vez de dejar solo «Ha salido»', () => {
    expect(departedText(leg(), 'Dublín')).toBe('Ha salido · Aena no informa de la llegada a Dublín');
    expect(departedText(leg({ sa: '23:35' }), 'Dublín')).toBeNull();
  });
});

describe('aviso de vuelo terminado', () => {
  it('solo dice «ha aterrizado» si lo confirma Aena; si no, habla de la hora prevista', () => {
    expect(endedNote(leg({ sa: '19:25', sta: 'LND' }))).toBe('Este vuelo ya ha aterrizado.');
    expect(endedNote(leg())).toBe('La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.');
  });
});

describe('llegada pasada según una estimación Turbi', () => {
  it('no se redacta como hora prevista oficial', () => {
    expect(endedNote(leg(), { estimated: true })).toBe('Según la estimación de Turbi, el vuelo ya habría aterrizado: no se muestra la previsión de turbulencias.');
    expect(ENDED_ESTIMATED).toBe(endedNote(leg(), { estimated: true }));
  });
  it('si el radar confirma que sigue volando, el aviso se sustituye (sin contradicción)', () => {
    expect(radarNote({ state: 'volando' })).toBe('El radar indica que el avión sigue en el aire: la previsión de turbulencias no se muestra con el vuelo en curso.');
    expect(radarNote({ state: 'sin-datos' })).toBeNull();
    expect(radarNote(null)).toBeNull();
  });
});

describe('respuesta del radar en la ficha', () => {
  const MIN = 60000, now = Date.parse('2026-09-25T01:30:00Z');
  const ago = min => now - min * MIN; // última vez que el radar vio el avión volando
  it('radar activo → «Volando» (animado) y panel', () => {
    const c = withRadar(card, { state: 'volando', callsign: 'AEA039', seenS: 0 }, ago(40), now);
    expect(c.status).toEqual({ text: 'Volando', tone: 'info', flying: true });
    expect(c.radar).toMatchObject({ state: 'volando', callsign: 'AEA039' });
  });
  it('radar perdido hace 5 min → «Última señal: volando hace 5 min» (no es tiempo real: sin animación)', () => {
    for (const radar of [{ state: 'sin-datos', callsign: 'AEA39' }, { state: 'no-disponible' }]) {
      const c = withRadar(card, radar, ago(5), now);
      expect(c.status).toEqual({ text: 'Última señal: volando hace 5 min', tone: 'info' });
      expect(c.radar).toEqual({ state: 'reciente', ageMin: 5 });
    }
    expect(withRadar(card, { state: 'sin-datos' }, now - 20000, now).status.text).toBe('Última señal: volando hace menos de 1 min');
  });
  it('radar perdido hace más de 12 min → vuelve el estado de Aena («Ha salido») y «sin señal ADS-B reciente»', () => {
    for (const min of [12, 25, 300]) {
      const c = withRadar(card, { state: 'sin-datos', callsign: 'AEA39' }, ago(min), now);
      expect(c.status).toBe(card.status);
      expect(c.radar).toEqual({ state: 'sin-senal' });
    }
  });
  it('nunca visto: estado de Aena; sin señal o sin respuesta del radar, sin exponer un indicativo', () => {
    expect(withRadar(card, { state: 'sin-datos', callsign: 'AEA39' }, null, now)).toEqual({ ...card, radar: { state: 'sin-senal' } });
    expect(withRadar(card, { state: 'no-disponible' }, null, now)).toEqual({ ...card, radar: { state: 'no-disponible' } });
    expect(withRadar(card, null, null, now)).toBe(card);
    expect(withRadar(card, { state: 'no-aplica' }, ago(5), now)).toBe(card);
  });
  it('perder el radar nunca se convierte en «aterrizado»', () => {
    for (const min of [0.2, 5, 11, 12, 30, 600]) {
      const c = withRadar(card, { state: 'sin-datos' }, ago(min), now);
      expect(JSON.stringify(c)).not.toMatch(/aterriz|llegado|en tierra/i);
    }
  });
});

import { estimateArrival, etaSide } from '../js/eta.js';
import { localToUtcMs } from '../js/time.js';
describe('coherencia entre el estado y la ETA conservada (mismo umbral de 12 min, misma observación)', () => {
  const MIN = 60000, dep = t => localToUtcMs('2026-09-25', t, 'Europe/Madrid');
  const obs = dep('02:30');
  const intl = { d: '2026-09-25', o: 'MAD', a: 'GYE', sd: '01:30', ed: '2026-09-25T01:56', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null };
  const prev = { ms: dep('13:05'), at: obs, method: 'estimated-inflight', remainingKm: 8411, confidence: 'medium' };
  const both = min => {
    const now = obs + min * MIN;
    const eta = estimateArrival({ leg: intl, depUtcMs: dep('01:56'), plannedMin: 655, tz: 'America/Guayaquil', nowMs: now, radar: { state: 'sin-datos' }, prev });
    return { status: withRadar(card, { state: 'sin-datos' }, obs, now).status.text, eta: etaSide(eta).note };
  };
  it('5 min: «Última señal: volando…» y la ETA sigue siendo la actualizada en vuelo', () => {
    expect(both(5)).toEqual({ status: 'Última señal: volando hace 5 min', eta: 'Estimación Turbi actualizada en vuelo' });
  });
  it('en el borde (11,6 min) ambos cambian a la vez: ninguno dice «reciente» mientras el otro dice «sin señal»', () => {
    expect(both(11.6)).toEqual({ status: card.status.text, eta: 'Última estimación Turbi disponible (hace 12 min, sin señal de radar desde entonces)' });
    expect(both(11.4)).toEqual({ status: 'Última señal: volando hace 11 min', eta: 'Estimación Turbi actualizada en vuelo' });
  });
  it('25 min: estado de Aena y la ETA dice que es la última disponible, sin señal', () => {
    expect(both(25)).toEqual({ status: card.status.text, eta: 'Última estimación Turbi disponible (hace 25 min, sin señal de radar desde entonces)' });
  });
});

describe('consulta al servicio', () => {
  it('pide /radar/AL/N.json y, si falla, null', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ state: 'volando' }) }));
    expect(await fetchRadar('EI', '737', f, 'https://live')).toEqual({ state: 'volando' });
    expect(f.mock.calls[0][0]).toBe('https://live/radar/EI/737.json');
    expect(await fetchRadar('EI', '737', vi.fn(async () => { throw new TypeError('x'); }), 'https://live')).toBeNull();
  });
});

describe('última vez que el radar vio el avión volando (memoria y almacenamiento del móvil)', () => {
  const fake = () => { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } }; };
  it('se guarda la hora de la observación (consulta − seenS) y sobrevive a reabrir la app', () => {
    const st = fake();
    rememberSighting('UX39|2026-09-25', { state: 'volando', seenS: 30 }, 1000000, st);
    expect(recallSighting('UX39|2026-09-25', st)).toBe(1000000 - 30000);
    const st2 = fake();
    st2.setItem('turbi-radar-seen', JSON.stringify({ 'AY1|2026-09-25': 5000 }));
    expect(recallSighting('AY1|2026-09-25', st2)).toBe(5000);
  });
  it('solo se guarda cuando el radar lo ve volando', () => {
    const st = fake();
    rememberSighting('X|d', { state: 'sin-datos' }, 1000, st);
    expect(recallSighting('X|d', st)).toBeNull();
  });
});

import { arrivalNote, NO_ARRIVAL_NOTE } from '../js/radar.js';
import { turbiEstimate } from '../js/eta.js';
describe('una sola fuente de verdad para la llegada: el aviso solo usa la llegada que la ficha muestra', () => {
  const MIN = 60000, dep = t => localToUtcMs('2026-09-24', t, 'Europe/Madrid');
  const now = localToUtcMs('2026-09-25', '10:00', 'Europe/Madrid');
  const ei737 = over => ({ d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, past: true, ...over });
  const ctx = { depUtcMs: dep('21:10'), plannedMin: 155, tz: 'Europe/Dublin', nowMs: now };
  const view = (leg, prev, officialMs = null) => {
    const eta = turbiEstimate({ leg, ...ctx, prev });
    return { side: etaSide(eta), note: arrivalNote({ leg, officialMs, eta, departureMs: ctx.depUtcMs, nowMs: now }) };
  };
  it('1. vuelo internacional pasado con última ETA Turbi en vuelo guardada: se muestra y el aviso se basa en ella', () => {
    const prev = { ms: dep('23:35'), at: dep('23:10'), method: 'estimated-inflight', remainingKm: 60, confidence: 'medium' };
    const v = view(ei737(), prev);
    expect(v.side).toMatchObject({ estimated: true, time: '22:35' }); // hora de Dublín
    expect(v.side.note).toMatch(/^Última estimación Turbi disponible · sin datos recientes/);
    expect(v.note).toBe(ENDED_ESTIMATED);
  });
  it('2. vuelo pasado sin ETA en vuelo (nunca se vio en el radar): «Llegada —» y ningún aviso basado en una estimación', () => {
    const v = view(ei737(), null);
    expect(v.side).toBeNull();
    expect(v.note).toBe(NO_ARRIVAL_NOTE);
    expect(v.note).not.toMatch(/estimación/i);
  });
  it('3. llegada oficial de Aena: manda Aena (ni ETA Turbi ni aviso de estimación)', () => {
    const leg = ei737({ a: 'MAD', sa: '19:25', ea: '2026-09-24T20:10', sta: 'LND' });
    const v = view(leg, null, localToUtcMs('2026-09-24', '20:10', 'Europe/Madrid'));
    expect(v.side).toBeNull(); // la ficha usa la hora de Aena tal cual
    expect(v.note).toBe('Este vuelo ya ha aterrizado.');
    const onlySched = ei737({ a: 'MAD', sa: '19:25', sta: null });
    expect(view(onlySched, null, localToUtcMs('2026-09-24', '19:25', 'Europe/Madrid')).note)
      .toBe('La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.');
  });
  it('4. nunca «Llegada —» a la vez que un aviso basado en una ETA Turbi oculta', () => {
    const prevs = [null, { ms: dep('23:35'), at: dep('23:10'), method: 'estimated-inflight', confidence: 'low' },
      { ms: dep('23:35'), at: now - 25 * 3600000, method: 'estimated-inflight' }, { ms: dep('23:35'), at: dep('20:00'), method: 'estimated-preflight' }];
    for (const past of [true, false]) for (const prev of prevs) {
      const v = view(ei737({ past }), prev);
      if (v.side === null) expect(v.note).not.toBe(ENDED_ESTIMATED);
    }
  });
  it('cancelado sin llegada visible: este aviso no se pone (la ficha dice «Vuelo cancelado.»)', () => {
    expect(arrivalNote({ leg: ei737({ past: false, st: 'CAN', std: 'CAN' }), eta: null, departureMs: now - 3600000, nowMs: now })).toBeNull();
  });
  it('vuelo que aún no ha salido, sin llegada visible: sin aviso', () => {
    expect(arrivalNote({ leg: ei737({ past: false }), officialMs: null, eta: null, departureMs: now + 3600000, nowMs: now })).toBeNull();
  });
});
