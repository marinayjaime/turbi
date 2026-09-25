// radarGate(): función pura, compartida por la app y el servidor, que decide si se mira el radar.
//   none     → cero radar
//   direct   → solo búsqueda barata (hex ya conocido, indicativo y variantes seguras)
//   identify → direct + identificación por ruta (zona + adsbdb) si lo anterior falla
// Aena no es el guardián del radar: con un estado de puerta retrasado (ULL, EMB, CER…) también se comprueba ADS-B
// dentro de la ventana; Aena manda para cancelado, desviado y llegada final.
import { describe, it, expect } from 'vitest';
import { radarGate, legTimes, RADAR_GATE } from '../js/radar-gate.js';
import { localToUtcMs } from '../js/time.js';

const MIN = 60000;
const MAD = 'Europe/Madrid';
const at = hhmm => localToUtcMs('2026-09-25', hhmm, MAD); // hora de Ibiza/Madrid
const PLANNED = 150; // duración estimada de la ruta (min)
// Vuelo desde un aeropuerto de Aena a uno extranjero: Aena no publica la llegada.
const leg = over => ({ d: '2026-09-25', o: 'IBZ', a: 'BHX', sd: '11:35', ed: '2026-09-25T11:42', sa: null, ea: null, st: 'ULL', std: 'ULL', sta: null, ...over });
const gate = (l, nowMs, plannedMin = PLANNED) => radarGate({ leg: l, nowMs, ...legTimes(l, { originTz: MAD, destTz: MAD }), plannedMin });
const mode = (l, t, p) => gate(l, t, p).mode;

describe('márgenes (heurísticas ajustables)', () => {
  it('−5 min antes de la primera salida, +15 min tras la más reciente para identificar, llegada +60 sin confirmación, 20 h con confirmación', () => {
    expect(RADAR_GATE).toEqual({ earlyMin: 5, identifyDelayMin: 15, afterArrivalMin: 60, confirmedWindowH: 20 });
  });
});

describe('estado de puerta retrasado (sin confirmación de Aena): ventana alrededor del despegue', () => {
  it('antes de la salida − 5 min → none', () => {
    expect(mode(leg(), at('11:29'))).toBe('none');
    expect(mode(leg(), at('11:31'))).toBe('direct');
  });
  it('desde la salida − 5 min → solo búsqueda barata (direct)', () => {
    expect(gate(leg(), at('11:40'))).toMatchObject({ mode: 'direct', confirmed: false });
  });
  it('identificación por ruta solo desde la salida MÁS RECIENTE + 15 min (11:42 + 15)', () => {
    expect(mode(leg(), at('11:56'))).toBe('direct');
    expect(mode(leg(), at('11:57'))).toBe('identify');
  });
  it('sin llegada de Aena: llegada prevista = salida más reciente + duración; después de +60 min → none', () => {
    const arr = at('11:42') + PLANNED * MIN;
    expect(mode(leg(), arr + 59 * MIN)).toBe('identify');
    expect(mode(leg(), arr + 61 * MIN)).toBe('none');
  });
  it('sd y ed distintos (11:35 programada, 12:10 estimada): empieza con la programada; la ventana final se calcula con la estimada', () => {
    const l = leg({ ed: '2026-09-25T12:10' });
    expect(mode(l, at('11:31'))).toBe('direct'); // primera salida conocida − 5 min
    expect(mode(l, at('12:24'))).toBe('direct'); // 12:10 + 15 aún no
    expect(mode(l, at('12:25'))).toBe('identify');
    const endIfSd = at('11:35') + PLANNED * MIN + 60 * MIN;
    const endWithEd = at('12:10') + PLANNED * MIN + 60 * MIN;
    expect(mode(l, endIfSd + 5 * MIN)).toBe('identify'); // con la programada ya se habría cerrado
    expect(mode(l, endWithEd - MIN)).toBe('identify');
    expect(mode(l, endWithEd + MIN)).toBe('none');
  });
  it('con llegada de Aena se usa esa (no la calculada)', () => {
    const l = leg({ a: 'MAD', sa: '12:45', ea: '2026-09-25T12:50' });
    expect(mode(l, at('12:50') + 59 * MIN)).toBe('identify');
    expect(mode(l, at('12:50') + 61 * MIN)).toBe('none');
  });
  it('sin lista cerrada: cualquier estado no final de puerta o intermedio (EMB, ULL, CER, NPT, NPR, BTR, INI, SCH, HOR, TMA, desconocido)', () => {
    for (const s of ['EMB', 'ULL', 'CER', 'NPT', 'NPR', 'BTR', 'INI', 'SCH', 'HOR', 'TMA', 'XYZ', null]) {
      expect(mode(leg({ st: s, std: s }), at('11:40')), String(s)).toBe('direct');
    }
  });
  it('sin ninguna hora (ni salida ni llegada) → none', () => {
    expect(mode(leg({ sd: null, ed: null }), at('11:40'))).toBe('none');
  });
  it('origen extranjero sin salida y con un estado de llegada intermedio: salida estimada = llegada de Aena − duración', () => {
    const l = { d: '2026-09-25', o: 'HHN', a: 'VLC', sd: null, ed: null, sa: '11:05', ea: '2026-09-25T11:55', st: 'SCH', std: null, sta: 'SCH' };
    const dep = at('11:55') - PLANNED * MIN;
    expect(mode(l, dep - 6 * MIN)).toBe('none');
    expect(mode(l, dep)).toBe('direct');
    expect(mode(l, dep + 15 * MIN)).toBe('identify');
  });
});

describe('con confirmación de Aena: como ahora', () => {
  it('salida BOR → identify desde la salida y durante 20 h', () => {
    const l = leg({ st: 'BOR', std: 'BOR' });
    expect(gate(l, at('11:43'))).toMatchObject({ mode: 'identify', confirmed: true });
    expect(mode(l, at('11:42') + 19 * 3600000)).toBe('identify');
    expect(mode(l, at('11:42') + 21 * 3600000)).toBe('none');
  });
  it('llegada FLY / FNL → identify (también sin salida de Aena, con la ventana medida con la llegada)', () => {
    for (const sta of ['FLY', 'FNL']) {
      expect(mode(leg({ st: sta, std: 'BOR', sta, sa: '14:00', ea: '2026-09-25T14:10' }), at('12:00')), sta).toBe('identify');
      expect(mode({ d: '2026-09-25', o: 'HHN', a: 'VLC', sd: null, ed: null, sa: '11:05', ea: '2026-09-25T11:55', st: sta, std: null, sta }, at('11:30')), sta).toBe('identify');
    }
  });
});

describe('nunca', () => {
  it('cancelado o desviado, en cualquier momento', () => {
    for (const over of [{ st: 'CAN', std: 'CAN' }, { sta: 'CAN' }, { sta: 'DES' }, { std: 'DES' }]) expect(mode(leg(over), at('11:50')), JSON.stringify(over)).toBe('none');
  });
  it('llegada final (LND, IBK, OPE, OPF, BOR de llegada), aunque ADS-B pudiera ver algo', () => {
    for (const sta of ['LND', 'IBK', 'OPE', 'OPF', 'BOR']) expect(mode(leg({ sta, std: 'BOR' }), at('11:50')), sta).toBe('none');
  });
});
