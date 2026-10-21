// Modelo de presentación de la ficha (js/card-model.js): solo decide cómo se muestra lo que ya calculan eta.js,
// legPhase, presentStatus, withRadar, withLanding, currentPunctuality y el pronóstico. Los `card` son literales.
import { describe, it, expect } from 'vitest';
import { flightPhase, mainTime, formatCountdown, sourceLabel, confidenceInfo, punctualityTile, summaryTiles, milestones,
  signalState, planeOnMap, positionAgeS, turbulenceBars, roughestSpan, weatherAlerts } from '../js/card-model.js';
import { adbPhase } from '../js/adb.js';
import { distanceReference, receivedRadar } from '../js/radar-distance.js';

const NOW = Date.parse('2026-10-20T08:00:00Z');
const MIN = 60000;
const dep = over => ({ date: '2026-10-20', time: '10:00', est: null, late: false, terminal: '4', gate: null, ...over });
const arr = over => ({ date: '2026-10-20', time: '11:20', est: null, late: false, terminal: '4', ...over });
const card = over => ({
  o: 'AAA', a: 'BBB', status: { text: 'Programado', tone: 'ok' }, phase: 'pendiente', source: 'aena',
  dep: dep(), arr: arr(), depFinal: false, arrFinal: false, timeConfidence: 'medium', punctuality: null,
  depMs: NOW + 120 * MIN, arrMs: NOW + 200 * MIN, ...over,
});
const turbiArr = { date: '2026-10-20', time: '11:35', estimated: true, note: 'Estimación Turbi actualizada en vuelo' };
const volando = over => ({ state: 'volando', seenS: 5, checked: new Date(NOW).toISOString(), lat: 40.1, lon: -3.2, posAgeS: 5, remainingKm: 300, kmh: 800, ...over });

describe('flightPhase', () => {
  it('cancelado y desviado', () => {
    expect(flightPhase(card({ phase: 'cancelado', status: { text: 'Cancelado', tone: 'bad' } }))).toBe('cancelado');
    expect(flightPhase(card({ phase: 'en-curso', status: { text: 'Desviado', tone: 'bad' } }))).toBe('cancelado');
  });
  it('aterrizado por ADS-B y terminado por Aena → finalizado', () => {
    expect(flightPhase(card({ phase: 'en-curso', status: { text: 'Aterrizado', tone: 'ok', landing: 'confirmed-landed' }, radar: { state: 'aterrizado' } })))
      .toBe('finalizado');
    expect(flightPhase(card({ phase: 'terminado', status: { text: 'En tierra', tone: 'ok' } }))).toBe('finalizado');
  });
  it('radar «volando» con la puerta aún en «pendiente» (estado de Aena retrasado) → en curso', () => {
    expect(flightPhase(card({ phase: 'pendiente', radar: volando() }))).toBe('en-curso');
    expect(flightPhase(card({ phase: 'pendiente', radar: { state: 'reciente', ageMin: 3 } }))).toBe('en-curso');
    expect(flightPhase(card({ phase: 'en-curso' }))).toBe('en-curso');
  });
  it('programado', () => {
    expect(flightPhase(card())).toBe('programado');
    expect(flightPhase(card({ radar: { state: 'sin-senal' } }))).toBe('programado');
  });
});

describe('formatCountdown', () => {
  it('minutos, horas y horas con minutos; nada si ya pasó', () => {
    expect(formatCountdown(42 * MIN)).toBe('42 min');
    expect(formatCountdown(135 * MIN)).toBe('2 h 15 min');
    expect(formatCountdown(60 * MIN)).toBe('1 h');
    expect(formatCountdown(0)).toBeNull();
    expect(formatCountdown(-5 * MIN)).toBeNull();
  });
  it('desde 24 h, días y horas sin minutos; con horas exactas, solo los días', () => {
    expect(formatCountdown((23 * 60 + 59) * MIN)).toBe('23 h 59 min');
    expect(formatCountdown(24 * 60 * MIN)).toBe('1 d');
    expect(formatCountdown((27 * 60 + 40) * MIN)).toBe('1 d 3 h');
    expect(formatCountdown((50 * 60 + 5) * MIN)).toBe('2 d 2 h');
    expect(formatCountdown(72 * 60 * MIN)).toBe('3 d');
  });
});

describe('mainTime', () => {
  it('programado con retraso → «Salida prevista» y «Sale en 2 h 15 min»', () => {
    const t = mainTime(card({ dep: dep({ est: '10:45', late: true }), depMs: NOW + 135 * MIN }), NOW);
    expect(t).toMatchObject({ time: '10:45', label: 'Salida prevista', plusDay: false, note: null });
    expect(t.aside).toEqual({ label: 'Sale en', value: '2 h 15 min' });
  });
  it('programado sin cambios → «Salida programada»; salida ya pasada → sin dato a la derecha', () => {
    expect(mainTime(card(), NOW)).toMatchObject({ time: '10:00', label: 'Salida programada' });
    expect(mainTime(card({ depMs: NOW - MIN }), NOW).aside).toBeNull();
  });
  it('programado con la salida estimada por Turbi (Aena solo da la llegada) → «Salida estimada» con su nota', () => {
    const t = mainTime(card({ dep: { date: '2026-10-20', time: '09:55', estimated: true, note: 'Estimación Turbi basada en la duración de la ruta' } }), NOW);
    expect(t).toMatchObject({ time: '09:55', label: 'Salida estimada', note: 'Estimación Turbi basada en la duración de la ruta' });
  });
  it('en curso con ETA Turbi → «Llegada estimada», la nota de la estimación y «Llega en»', () => {
    const t = mainTime(card({ phase: 'en-curso', arr: turbiArr, arrMs: NOW + 42 * MIN, timeConfidence: 'medium' }), NOW);
    expect(t).toMatchObject({ time: '11:35', label: 'Llegada estimada', note: turbiArr.note });
    expect(t.aside).toEqual({ label: 'Llega en', value: '42 min' });
  });
  it('en curso con llegada de Aena revisada → «Llegada prevista» y «+1 día» si llega al día siguiente', () => {
    const t = mainTime(card({ phase: 'en-curso', arr: arr({ date: '2026-10-21', time: '00:10', est: '00:25' }) }), NOW);
    expect(t).toMatchObject({ time: '00:25', label: 'Llegada prevista', plusDay: true, note: null });
  });
  it('finalizado con salida y llegada reales → «Llegada final» y «Duración»', () => {
    const t = mainTime(card({ phase: 'terminado', depFinal: true, arrFinal: true, arr: arr({ est: '11:05' }),
      depMs: NOW - 120 * MIN, arrMs: NOW - 35 * MIN }), NOW);
    expect(t).toMatchObject({ time: '11:05', label: 'Llegada final' });
    expect(t.aside).toEqual({ label: 'Duración', value: '1 h 25 min' });
  });
  it('AeroDataBox con horas de pista reales → el dato se rotula «Tiempo en el aire», como en el Resumen del vuelo', () => {
    const t = mainTime(card({ source: 'aerodatabox', phase: 'terminado', depFinal: true, arrFinal: true, timeConfidence: null,
      depMs: NOW - 120 * MIN, arrMs: NOW - 35 * MIN }), NOW);
    expect(t.aside).toEqual({ label: 'Tiempo en el aire', value: '1 h 25 min' });
  });
  it('aterrizado por ADS-B sin llegada final de Aena → «Aterrizado · radar ADS-B», sin duración', () => {
    const t = mainTime(card({ phase: 'en-curso', depFinal: true, status: { text: 'Aterrizado', tone: 'ok', landing: 'confirmed-landed' },
      radar: { state: 'aterrizado' }, arr: arr({ est: '11:10' }), arrMs: NOW - 5 * MIN }), NOW);
    expect(t).toMatchObject({ time: '11:10', label: 'Aterrizado · radar ADS-B', aside: null });
  });
  it('aterrizado según Flightradar24 → «Aterrizado · Flightradar24»', () => {
    const t = mainTime(card({ phase: 'en-curso', depFinal: true, status: { text: 'Aterrizado', tone: 'ok', landing: 'confirmed-landed', source: 'fr24' },
      radar: { state: 'aterrizado', source: 'fr24' }, arr: arr({ est: '11:10' }), arrMs: NOW - 5 * MIN }), NOW);
    expect(t).toMatchObject({ time: '11:10', label: 'Aterrizado · Flightradar24', aside: null });
  });
  it('cancelado → null; la fase pide un lado que no existe → null (no inventa hora)', () => {
    expect(mainTime(card({ phase: 'cancelado' }), NOW)).toBeNull();
    expect(mainTime(card({ dep: null }), NOW)).toBeNull();
    expect(mainTime(card({ phase: 'en-curso', arr: null }), NOW)).toBeNull();
  });
});

describe('sourceLabel', () => {
  it('las cinco salidas', () => {
    expect(sourceLabel(card())).toBe('Aena');
    expect(sourceLabel(card({ source: 'aerodatabox', timeConfidence: null }))).toBe('AeroDataBox');
    expect(sourceLabel(card({ phase: 'en-curso', radar: volando() }))).toBe('Radar + Aena');
    expect(sourceLabel(card({ source: 'aerodatabox', radar: { state: 'aterrizado' }, status: { text: 'Aterrizado', landing: 'confirmed-landed' } })))
      .toBe('Radar + AeroDataBox');
    expect(sourceLabel(card({ phase: 'en-curso', arr: turbiArr }))).toBe('Estimación Turbi');
  });
  it('finalizado con la llegada estimada por Turbi (estimated-landed) → «Estimación Turbi», no «Aena»', () => {
    const landed = card({ phase: 'en-curso', arr: turbiArr, status: { text: 'Aterrizado', tone: 'ok', landing: 'estimated-landed' } });
    expect(sourceLabel(landed)).toBe('Estimación Turbi');
    expect(sourceLabel(card({ phase: 'terminado', arr: turbiArr }))).toBe('Estimación Turbi');
    // Programado con la llegada aún estimada: la hora que se ve es la salida de Aena.
    expect(sourceLabel(card({ arr: turbiArr }))).toBe('Aena');
  });
  it('Aena sin llegada publicada en curso, con el radar viéndolo → «Radar + Aena»', () => {
    expect(sourceLabel(card({ phase: 'en-curso', arr: turbiArr, radar: volando() }))).toBe('Radar + Aena');
  });
});

describe('confidenceInfo', () => {
  it('los cuatro niveles, con «limitada» en baja y muy baja', () => {
    expect(confidenceInfo('high')).toEqual({ text: 'Alta', tone: 'ok', limited: false });
    expect(confidenceInfo('medium')).toEqual({ text: 'Media', tone: 'warn', limited: false });
    expect(confidenceInfo('low')).toEqual({ text: 'Baja', tone: 'bad', limited: true });
    expect(confidenceInfo('very-low')).toEqual({ text: 'Muy baja', tone: 'bad', limited: true });
  });
  it('sin confianza → null', () => {
    expect(confidenceInfo(null)).toBeNull();
    expect(confidenceInfo(undefined)).toBeNull();
  });
});

describe('punctualityTile', () => {
  const p = (state, band, arrDelay, depDelay = null) => ({ state, band, basis: 'arr', dep: { delay: depDelay, final: false }, arr: { delay: arrDelay, final: false } });
  it('retraso, adelanto, en hora, cancelado y desviado', () => {
    expect(punctualityTile(p('retrasado', 'warn', 22))).toEqual({ text: '+22 min', band: 'warn' });
    expect(punctualityTile(p('puntual', 'ok', -7))).toEqual({ text: '7 min antes', band: 'ok' });
    expect(punctualityTile(p('sin-cambios', 'ok', null))).toEqual({ text: 'En hora', band: 'ok' });
    expect(punctualityTile({ state: 'cancelado', band: 'bad' })).toEqual({ text: 'Cancelado', band: 'bad' });
    expect(punctualityTile({ state: 'desviado', band: 'bad' })).toEqual({ text: 'Desviado', band: 'bad' });
  });
  it('salida retrasada con la llegada aún sin actualizar → el retraso de la salida', () => {
    expect(punctualityTile(p('retrasado', 'late', null, 40))).toEqual({ text: '+40 min', band: 'late' });
  });
  it('sin datos → null', () => {
    expect(punctualityTile(null)).toBeNull();
    expect(punctualityTile({ state: 'sin-datos', band: null })).toBeNull();
  });
});

describe('summaryTiles', () => {
  it('Aena: puntualidad, fuente y confianza', () => {
    const tiles = summaryTiles(card({ timeConfidence: 'low', punctuality: { state: 'retrasado', band: 'warn', basis: 'arr', dep: null, arr: { delay: 20, final: false } } }));
    expect(tiles.map(t => t.key)).toEqual(['punctuality', 'source', 'confidence']);
    expect(tiles[0]).toMatchObject({ label: 'Puntualidad', value: '+20 min', tone: 'warn' });
    expect(tiles[1]).toMatchObject({ label: 'Fuente', value: 'Aena' });
    expect(tiles[2]).toMatchObject({ label: 'Confianza', value: 'Baja', tone: 'bad', limited: true });
  });
  it('AeroDataBox sin puntualidad ni confianza → solo la fuente', () => {
    const tiles = summaryTiles(card({ source: 'aerodatabox', punctuality: null, timeConfidence: null }));
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ key: 'source', value: 'AeroDataBox' });
  });
});

describe('milestones', () => {
  it('salida real con llegada estimada por Turbi: la llegada programada no existe (no se rotula la de Turbi como programada)', () => {
    const m = milestones(card({ dep: dep({ est: '10:12', late: true }), depFinal: true, arr: turbiArr }));
    expect(m.map(x => x.key)).toEqual(['dep-sched', 'dep-real', 'arr-sched', 'arr-best']);
    expect(m.map(x => x.kind)).toEqual(['sched', 'real', 'pending', 'turbi']);
    expect(m.map(x => x.time)).toEqual(['10:00', '10:12', '--:--', '11:35']);
    expect(m[3].caption).toBe('Estimada');
  });
  it('previstas por Aena y llegada final', () => {
    expect(milestones(card({ dep: dep({ est: '10:20' }), arr: arr({ est: '11:40' }) })).map(x => [x.kind, x.time, x.caption]))
      .toEqual([['sched', '10:00', 'Programada'], ['aena-est', '10:20', 'Prevista'], ['sched', '11:20', 'Programada'], ['aena-est', '11:40', 'Prevista']]);
    const fin = milestones(card({ depFinal: true, arrFinal: true, arr: arr({ est: '11:05' }) }));
    expect(fin[1]).toMatchObject({ kind: 'real', time: '10:00' });
    expect(fin[3]).toMatchObject({ kind: 'real', time: '11:05', caption: 'Final' });
  });
  it('sin llegada (arr: null) → «--:--» y «pending» en los dos hitos de llegada', () => {
    const m = milestones(card({ arr: null }));
    expect(m[2]).toEqual({ key: 'arr-sched', time: '--:--', caption: 'Pendiente', kind: 'pending' });
    expect(m[3]).toEqual({ key: 'arr-best', time: '--:--', caption: 'Pendiente', kind: 'pending' });
    expect(m[1]).toMatchObject({ kind: 'pending', time: '--:--' });
  });
  it('salida estimada por Turbi (Aena solo da la llegada): sin programada, la salida como estimación', () => {
    const m = milestones(card({ dep: { date: '2026-10-20', time: '09:55', estimated: true, note: 'x' } }));
    expect(m[0]).toMatchObject({ kind: 'pending', time: '--:--' });
    expect(m[1]).toMatchObject({ kind: 'turbi', time: '09:55', caption: 'Estimada' });
  });
});

// Antigüedad SIN el reloj civil del móvil (decisión del controlador, 21/10/2026): la radar de la tarjeta lleva la antigüedad
// del instante en que el servidor respondió (posAgeS / seenS; con FR24 el servidor la recalcula también desde su caché) y
// la app solo le suma lo transcurrido en su reloj MONOTÓNICO (performance.now: radarReceivedMono y el «ahora» monotónico).
// receivedRadar: con adsb.lol (flujo antiguo, sin recalcular en su caché) se suma una vez, al recibirla, el tiempo que pasó
// en la caché del servidor (recepción − checked), como siempre; con FR24, nada (el servidor ya lo hizo).
describe('antigüedad al recibir (radar-distance.js: receivedRadar)', () => {
  it('FR24: la lectura tal cual (posAgeS/seenS ya son los del instante de responder), aunque checked sea «viejo» para el móvil', () => {
    const r = volando({ source: 'fr24', seenS: 7, posAgeS: 7, checked: new Date(NOW - 5 * MIN).toISOString() });
    expect(receivedRadar(r, NOW)).toBe(r);
    expect(receivedRadar({ ...r, checked: new Date(NOW + 5 * MIN).toISOString() }, NOW).posAgeS).toBe(7);
  });
  it('adsb.lol: suma una vez el tiempo en la caché del servidor (checked 20 s antes → +20 s) a seenS y posAgeS', () => {
    const r = receivedRadar(volando({ seenS: 7, posAgeS: 4, checked: new Date(NOW - 20000).toISOString() }), NOW);
    expect([r.seenS, r.posAgeS]).toEqual([27, 24]);
    expect(distanceReference(r, 0).ageAtReceiptS).toBe(27); // la distancia usa la misma cuenta
    expect(receivedRadar(volando({ seenS: 3, checked: new Date(NOW + 9000).toISOString() }), NOW).seenS).toBe(3); // checked futuro: nada
    expect(receivedRadar(volando({ seenS: 3, posAgeS: undefined, checked: 'x' }), NOW)).toMatchObject({ seenS: 3 });
    expect(receivedRadar(null, NOW)).toBeNull();
  });
});

describe('signalState (reloj monotónico)', () => {
  const M = 5000; // instante monotónico de recepción (performance.now: no es una hora)
  it('seenS 5 recibido ahora → live, «5 s»', () => {
    expect(signalState(volando(), M, M)).toEqual({ ageS: 5, level: 'live', text: '5 s' });
  });
  it('6 min después → old; 13 min después → stale', () => {
    expect(signalState(volando(), M, M + 6 * MIN)).toMatchObject({ level: 'old', text: '6 min' });
    expect(signalState(volando(), M, M + 13 * MIN)).toMatchObject({ level: 'stale', text: '13 min' });
  });
  it('RELOJ 29) envejece solo con el reloj monotónico: checked (hora del servidor) no se resta del reloj del móvil', () => {
    expect(signalState(volando({ checked: new Date(NOW - 50000).toISOString() }), M, M).ageS).toBe(5);
    expect(signalState(volando({ checked: new Date(NOW + 5 * MIN).toISOString() }), M, M + 2000).ageS).toBe(7);
  });
  it('sin remainingKm también; y fuera de «volando», null', () => {
    expect(signalState(volando({ remainingKm: null }), M, M + 10000).ageS).toBe(15);
    expect(signalState({ state: 'reciente', ageMin: 3 }, M, M)).toBeNull();
    expect(signalState(null, M, M)).toBeNull();
  });
  it('sin instante de recepción (undefined o NaN) → null, nunca «NaN min»', () => {
    const r = volando({ seenS: 400 });
    expect(signalState(r, undefined, M)).toBeNull();
    expect(signalState(r, NaN, M)).toBeNull();
  });
  it('un «ahora» anterior a la recepción (no debería ocurrir con un reloj monotónico) no resta', () => {
    expect(signalState(volando(), M, M - 3000).ageS).toBe(5);
  });
});

describe('positionAgeS (reloj monotónico)', () => {
  const M = 1000;
  it('posAgeS (al responder el servidor) + lo transcurrido desde que se recibió', () => {
    expect(positionAgeS(volando({ posAgeS: 5 }), M, M)).toBe(5);
    expect(positionAgeS(volando({ posAgeS: 5 }), M, M + 7000)).toBe(12);
    expect(positionAgeS(volando({ posAgeS: 5, checked: new Date(NOW - 30000).toISOString() }), M, M + 2000)).toBe(7);
  });
  it('no usa seenS: con seenS 40 y posAgeS 5 cuenta 5', () => {
    expect(positionAgeS(volando({ seenS: 40, posAgeS: 5 }), M, M)).toBe(5);
  });
  it('null sin posAgeS finito, sin instante de recepción o fuera de «volando»', () => {
    expect(positionAgeS(volando({ posAgeS: undefined }), M, M)).toBeNull();
    expect(positionAgeS(volando({ posAgeS: NaN }), M, M)).toBeNull();
    expect(positionAgeS(volando(), undefined, M)).toBeNull();
    expect(positionAgeS(volando(), NaN, M)).toBeNull();
    expect(positionAgeS(volando({ state: 'reciente' }), M, M)).toBeNull();
    expect(positionAgeS(null, M, M)).toBeNull();
  });
});

// Avión en el mapa (decisión del controlador, 21/10/2026): fresco con ≤ 60 s de posición (puede animarse y prolongar la
// estela); «última posición conocida» entre 60 y 180 s (quieto y atenuado, fresh: false); más de 180 s, sin avión.
// heading: el `track` real de FR24 (0 = norte) o null si no viene.
describe('planeOnMap', () => {
  const M = 2000;
  it('sin lat → null', () => {
    expect(planeOnMap(volando({ lat: undefined }), M, M)).toBeNull();
  });
  it('posAgeS 5 recibido ahora → la posición recibida, tal cual, fresca; con su rumbo real', () => {
    expect(planeOnMap(volando({ posAgeS: 5 }), M, M)).toEqual({ lat: 40.1, lon: -3.2, heading: null, fresh: true });
    expect(planeOnMap(volando({ posAgeS: 5, track: 271 }), M, M)).toEqual({ lat: 40.1, lon: -3.2, heading: 271, fresh: true });
    expect(planeOnMap(volando({ track: 'x' }), M, M).heading).toBeNull();
  });
  it('posAgeS 55: a los 5 s sigue fresca; 6 s después (61 s) → última posición conocida (fresh: false), la MISMA posición', () => {
    expect(planeOnMap(volando({ posAgeS: 55 }), M, M + 5000)).toMatchObject({ lat: 40.1, lon: -3.2, fresh: true });
    expect(planeOnMap(volando({ posAgeS: 55 }), M, M + 6000)).toEqual({ lat: 40.1, lon: -3.2, heading: null, fresh: false });
  });
  it('FALLOS 23) con más de 180 s desaparece (null); a los 180 s aún es la última posición conocida', () => {
    expect(planeOnMap(volando({ posAgeS: 170 }), M, M + 10000)).toMatchObject({ fresh: false });
    expect(planeOnMap(volando({ posAgeS: 170 }), M, M + 11000)).toBeNull();
    expect(planeOnMap(volando({ posAgeS: 181 }), M, M)).toBeNull();
  });
  it('seenS 1 y posAgeS 55: deja de ser fresca a los ~5 s, no a los ~59 (manda la posición, no el último mensaje)', () => {
    const r = volando({ seenS: 1, posAgeS: 55 });
    expect(planeOnMap(r, M, M + 4000).fresh).toBe(true);
    expect(planeOnMap(r, M, M + 6000).fresh).toBe(false);
  });
  it('sin posAgeS pero con seenS → null (seenS nunca sustituye)', () => {
    expect(planeOnMap(volando({ seenS: 1, posAgeS: undefined }), M, M)).toBeNull();
  });
  it('RELOJ 27–28) checked de ±5 min respecto al móvil no cambia nada: solo cuentan posAgeS y el reloj monotónico', () => {
    for (const off of [5 * MIN, -5 * MIN]) {
      const r = volando({ source: 'fr24', posAgeS: 5, checked: new Date(NOW + off).toISOString() });
      expect(planeOnMap(r, M, M + 1000)).toMatchObject({ fresh: true });
      expect(positionAgeS(r, M, M + 1000)).toBe(6);
    }
  });
  it('sin instante de recepción (undefined o NaN) → null: un avión de antigüedad desconocida no se pinta', () => {
    expect(planeOnMap(volando({ lat: 1, lon: 2 }), undefined, M)).toBeNull();
    expect(planeOnMap(volando(), NaN, M)).toBeNull();
  });
  it('estado «reciente» → null', () => {
    expect(planeOnMap(volando({ state: 'reciente' }), M, M)).toBeNull();
  });
});

describe('turbulenceBars', () => {
  const route = n => Array.from({ length: n }, (_, i) => ({ lat: 0, lon: i, level: i % 4 }));
  const view = { durationMin: 119, route: route(120), segments: [
    { level: 0, startMin: 0, endMin: 40 }, { level: 2, startMin: 40, endMin: 80 }, { level: 1, startMin: 80, endMin: 119 }] };
  it('120 puntos → como mucho 56 barras, con el tramo correcto en los extremos', () => {
    const bars = turbulenceBars(view);
    expect(bars.length).toBeLessThanOrEqual(56);
    expect(bars.length).toBe(40); // uno de cada ceil(120 / 56) = 3
    expect(bars[0]).toEqual({ level: 0, seg: 0 });
    expect(bars.at(-1).seg).toBe(2);
    expect(bars.find((_, k) => k * 3 === 42).seg).toBe(1); // minuto 42
  });
  it('cada barra toma el nivel del TRAMO que la contiene, no el del punto (§9 bis)', () => {
    const bars = turbulenceBars(view);
    const levels = [0, 2, 1];
    for (const b of bars) expect(b.level).toBe(levels[b.seg]);
    expect(bars.find((_, k) => k * 3 === 45).level).toBe(2); // el punto 45 dice nivel 1, pero su tramo es moderado
    expect(bars.find((_, k) => k * 3 === 3).level).toBe(0); // el punto 3 dice nivel 3, pero su tramo es nulo
  });
  it('punto sin datos → level null', () => {
    const r = route(10);
    r[3].level = null;
    const bars = turbulenceBars({ durationMin: 90, route: r, segments: [{ level: 0, startMin: 0, endMin: 90 }] });
    expect(bars).toHaveLength(10);
    expect(bars[3]).toEqual({ level: null, seg: 0 });
  });
});

describe('roughestSpan', () => {
  const view = over => ({ depMs: Date.parse('2026-10-20T16:00:00Z'), originTz: 'Europe/Madrid', destinationTz: 'Europe/Madrid',
    summary: { maxLevel: 2, moments: [{ startMin: 35, endMin: 48 }, { startMin: 70, endMin: 75 }] }, ...over });
  it('misma zona horaria → horas locales', () => {
    expect(roughestSpan(view())).toEqual({ text: '18:35 – 18:48' });
  });
  it('zonas distintas → minutos desde el despegue', () => {
    expect(roughestSpan(view({ destinationTz: 'Atlantic/Canary' }))).toEqual({ text: 'min 35–48' });
  });
  it('sin turbulencia → null', () => {
    expect(roughestSpan(view({ summary: { maxLevel: 0, moments: [] } }))).toBeNull();
  });
});

describe('weatherAlerts', () => {
  it('sin datos o vacíos → []', () => {
    expect(weatherAlerts(null)).toEqual([]);
    expect(weatherAlerts({ sigmets: null, pireps: [] })).toEqual([]);
  });
  it('2 SIGMET, uno cruza la ruta → «2 avisos oficiales (SIGMET)» con crosses; PIREP aparte', () => {
    const out = weatherAlerts({
      sigmets: [{ label: 'Turbulencia fuerte', crosses: false }, { label: 'Tormentas', crosses: true }],
      pireps: [{ label: 'moderada' }],
    });
    expect(out).toEqual([
      { kind: 'sigmet', text: '2 avisos oficiales (SIGMET)', label: 'Turbulencia fuerte', crosses: true },
      { kind: 'pirep', text: '1 informe de pilotos cerca de la ruta', label: 'moderada', crosses: false },
    ]);
  });
  it('un solo SIGMET, en singular; varios PIREP en plural', () => {
    const out = weatherAlerts({ sigmets: [{ label: 'Engelamiento', crosses: false }], pireps: [{ label: 'ligera' }, { label: 'moderada' }] });
    expect(out[0]).toMatchObject({ text: '1 aviso oficial (SIGMET)', crosses: false });
    expect(out[1].text).toBe('2 informes de pilotos cerca de la ruta');
  });
});

describe('adbPhase (fase del card de AeroDataBox, traducción directa de su estado)', () => {
  it('Arrived, Canceled*, Diverted, en vuelo y el resto', () => {
    expect(adbPhase('Arrived')).toBe('terminado');
    for (const s of ['Canceled', 'CanceledUncertain', 'Diverted']) expect(adbPhase(s)).toBe('cancelado');
    for (const s of ['Departed', 'EnRoute', 'Approaching']) expect(adbPhase(s)).toBe('en-curso');
    for (const s of ['Expected', 'Delayed', 'Boarding', null]) expect(adbPhase(s)).toBe('pendiente');
  });
});
