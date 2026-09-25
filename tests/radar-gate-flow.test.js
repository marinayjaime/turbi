// radarGate en el servidor y en la ficha: un estado de puerta retrasado de Aena (ULL, CER…) no impide comprobar
// ADS-B; si ADS-B ve el avión en el aire, «Volando» gana. Si no lo ve, se queda el estado de Aena, sin «Sin señal».
// LS1246 IBZ → BHX (25/09/2026) solo como regresión, con sus horas reales de Aena: nada del código lo conoce.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';
import { withRadar } from '../js/radar.js';
import { flightStatus } from '../js/schedule.js';
import { flightCardHtml } from '../js/ui.js';
import { readFileSync } from 'node:fs';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });

const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const at = hhmm => Date.parse(`2026-09-25T${hhmm}:00Z`); // UTC
// LS1246 visto en Aena con «Última llamada» cuando ya volaba (sd 11:35, ed 11:42 en Ibiza = 09:35 / 09:42 UTC).
const ls1246 = over => ({ al: 'LS', icao: 'EXS', n: '1246', d: '2026-09-25', o: 'IBZ', a: 'BHX', sd: '11:35', ed: '2026-09-25T11:42',
  sa: null, ea: null, td: 'TIBZ', g: '15', st: 'ULL', std: 'ULL', sta: null, ac: '738W', op: 'LS', ...over });
const plane = over => ({ hex: '406abc', flight: 'EXS1246 ', t: 'B738', lat: 40.9, lon: 1.2, track: 350, alt_baro: 26000, gs: 420, seen: 1, seen_pos: 1, ...over });

function server(legs, { callsignAc = [], pointAc = [], routes = {} } = {}) {
  const calls = [];
  const fetchFn = vi.fn(async url => {
    calls.push(url);
    const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
    if (url.includes('/v2/callsign/')) return ok({ ac: callsignAc });
    if (url.includes('/v2/point/')) return ok({ ac: pointAc });
    if (url.includes('/v2/hex/')) return ok({ ac: pointAc.filter(a => url.endsWith(a.hex)) });
    if (url.includes('adsbdb')) {
      const r = routes[url.split('/').pop()];
      return ok({ response: r ? { flightroute: { origin: { iata_code: r[0] }, destination: { iata_code: r[1] } } } : 'unknown callsign' });
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
  });
  const state = createState();
  state.legs = legs;
  const ask = (t, path = '/radar/LS/1246.json') => radarResponse(state, path, { fetchFn, nowMs: t, pauseMs: 0, airports }).then(r => JSON.parse(r.body));
  return { ask, calls, state, adsb: () => calls.filter(u => u.startsWith('https://api.adsb.lol/')) };
}

describe('servidor: estado de puerta retrasado', () => {
  it('ULL antes de la hora de salida (− 5 min) → no-aplica, cero consultas', async () => {
    const s = server([ls1246()]);
    expect((await s.ask(at('09:25'))).state).toBe('no-aplica');
    expect(s.calls).toHaveLength(0);
  });
  it('ULL pasada la salida: solo búsqueda barata (indicativo); sin identificación por ruta todavía', async () => {
    const s = server([ls1246()], { pointAc: [plane({ flight: 'EXS12AB ' })], routes: { EXS12AB: ['IBZ', 'BHX'] } });
    const r = await s.ask(at('09:45'));
    expect(r).toMatchObject({ state: 'sin-datos', departureConfirmed: false });
    expect(r.identifying).toBeUndefined();
    expect(s.adsb().map(u => u.split('/')[4])).toEqual(['callsign']);
  });
  it('pasada la salida más reciente + 15 min: ya puede identificarse por ruta (con los filtros de siempre)', async () => {
    const s = server([ls1246()], { pointAc: [plane({ flight: 'EXS12AB ', lat: 40.2, lon: 1.25, track: 355 })], routes: { EXS12AB: ['IBZ', 'BHX'] } });
    expect(await s.ask(at('09:58'))).toMatchObject({ identifying: true });
    await vi.waitFor(() => expect(s.state.hexes.get('phys|2026-09-25|IBZ|BHX|11:35')).toMatchObject({ callsign: 'EXS12AB' }));
  });
  it('ULL + ADS-B lo ve volando con su indicativo → volando', async () => {
    const s = server([ls1246()], { callsignAc: [plane()] });
    expect(await s.ask(at('09:50'))).toMatchObject({ state: 'volando', callsign: 'EXS1246', departureConfirmed: false });
  });
  it('sin confirmación de Aena y pasada la llegada prevista + 60 min → no-aplica', async () => {
    const s = server([ls1246()]);
    expect((await s.ask(at('14:30'))).state).toBe('no-aplica'); // 09:42 + ~2 h 40 min de ruta + 60 min
    expect(s.calls).toHaveLength(0);
  });
  it('BOR, como hasta ahora: identificación permitida en el acto (sin esperar los 15 min)', async () => {
    const s = server([ls1246({ st: 'BOR', std: 'BOR' })], { pointAc: [plane({ flight: 'EXS12AB ', lat: 39.3, lon: 1.4, track: 355 })], routes: { EXS12AB: ['IBZ', 'BHX'] } });
    const r = await s.ask(at('09:47'));
    expect(r.identifying).toBe(true);
    expect(r.departureConfirmed).toBeUndefined();
  });
  it('cancelado, desviado o llegada final → jamás', async () => {
    for (const over of [{ st: 'CAN', std: 'CAN' }, { sta: 'DES' }, { std: 'BOR', sta: 'LND' }, { std: 'BOR', sta: 'IBK' }]) {
      const s = server([ls1246(over)], { callsignAc: [plane()] });
      expect((await s.ask(at('09:50'))).state, JSON.stringify(over)).toBe('no-aplica');
      expect(s.calls).toHaveLength(0);
    }
  });
});

describe('ficha: ADS-B corrige los estados de puerta retrasados', () => {
  const base = leg => ({ al: 'LS', title: 'LS 1246', route: 'y', tabs: [], status: flightStatus(leg), o: 'IBZ', a: 'BHX', duration: 160,
    dep: { date: '2026-09-25', time: '11:42', est: null, late: false, terminal: null, gate: '15' }, arr: null, aircraft: null, updatedAgo: 'hace 6 min', stale: false });
  const flying = { state: 'volando', callsign: 'EXS1246', altM: 8000, altFt: 26247, kmh: 780, seenS: 1, remainingKm: 1200, source: 'adsb.lol', departureConfirmed: false };
  it('ULL pasada la salida + ADS-B sin datos → sigue «Última llamada», sin «Sin señal ADS-B»', () => {
    const c = base(ls1246());
    expect(c.status.text).toBe('Última llamada');
    for (const radar of [{ state: 'sin-datos', departureConfirmed: false }, { state: 'no-disponible', departureConfirmed: false }]) {
      const html = flightCardHtml(withRadar(c, radar));
      expect(html).toContain('Última llamada');
      expect(html).not.toMatch(/Sin señal ADS-B|radar no responde|telemetry/);
    }
  });
  it('ULL + ADS-B volando a 8.000 m → «Volando» y panel completo', () => {
    const html = flightCardHtml(withRadar(base(ls1246()), flying));
    expect(html).toContain('class="telemetry"');
    expect(html).toMatch(/tm-flying">Volando/);
    expect(html).not.toContain('Última llamada');
  });
  it('CER («Puerta cerrada») + ADS-B volando → «Volando»', () => {
    const c = base(ls1246({ st: 'CER', std: 'CER' }));
    expect(c.status.text).toBe('Puerta cerrada');
    expect(withRadar(c, flying).status).toMatchObject({ text: 'Volando', flying: true });
  });
  it('con la salida confirmada (BOR) y sin datos, se sigue diciendo «Sin señal ADS-B» como antes', () => {
    const c = base(ls1246({ st: 'BOR', std: 'BOR' }));
    expect(flightCardHtml(withRadar(c, { state: 'sin-datos' }))).toContain('Sin señal ADS-B reciente para este vuelo.');
  });
});
