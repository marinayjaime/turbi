// Vuelo físico: definición única (js/physical-flight.js) para el radar (phys y códigos compartidos), la identificación
// y la asignación de operadora. Regresión: con «sd === sd», las llegadas desde el extranjero (sd: null) agrupaban
// TODOS los vuelos de la ruta del día (FR4586 OPO → BCN: 21 «códigos compartidos», entre ellos otros Ryanair) y la
// búsqueda directa probaba indicativos de otros vuelos. Datos simulados; FR4586 solo como nombre de regresión.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { physicalFlightKey, samePhysicalFlight } from '../js/physical-flight.js';
import { operatorIcaos } from '../server/identify.mjs';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';

// Llegadas OPO → BCN del mismo día (Aena no publica la salida de Oporto: sd = null).
const arr = over => ({ d: '2026-09-26', o: 'OPO', a: 'BCN', sd: null, ed: null, st: null, std: null, sta: 'FLY', ac: '738W', ...over });
const fr4586 = arr({ al: 'FR', icao: 'RYR', n: '4586', sa: '01:15', ea: '2026-09-26T01:20', op: 'FR' });
const fr4546 = arr({ al: 'FR', icao: 'RYR', n: '4546', sa: '09:05', ea: '2026-09-26T09:05', op: 'FR' }); // otro vuelo, otra hora
const vy8481 = arr({ al: 'VY', icao: 'VLG', n: '8481', sa: '01:15', ea: '2026-09-26T01:20' }); // código compartido de FR4586
const ib5645 = arr({ al: 'IB', icao: 'IBE', n: '5645', sa: '14:40', ea: '2026-09-26T14:40' }); // otro vuelo
// Salidas desde un aeropuerto de Aena: se agrupan por la salida, como siempre.
const dep = over => ({ d: '2026-09-26', o: 'MAD', a: 'LIS', sd: '10:40', ed: '2026-09-26T10:40', st: 'BOR', std: 'BOR', ac: '32N', ...over });

describe('una sola definición de vuelo físico', () => {
  it('dos llegadas de la misma ruta y día con sd null pero distinta llegada NO son el mismo vuelo', () => {
    expect(samePhysicalFlight(fr4586, fr4546)).toBe(false);
    expect(samePhysicalFlight(fr4586, ib5645)).toBe(false);
    expect(physicalFlightKey(fr4586)).not.toBe(physicalFlightKey(fr4546));
  });
  it('códigos compartidos con la misma llegada sí son el mismo vuelo', () => {
    expect(samePhysicalFlight(fr4586, vy8481)).toBe(true);
  });
  it('con salida de Aena se agrupa por la salida, como hasta ahora (aunque la llegada difiera)', () => {
    const ux = dep({ al: 'UX', icao: 'AEA', n: '1155', sa: '11:05' }), sk = dep({ al: 'SK', icao: 'SAS', n: '8371', sa: '11:10' });
    expect(samePhysicalFlight(ux, sk)).toBe(true);
    expect(samePhysicalFlight(ux, dep({ al: 'TP', icao: 'TAP', n: '1017', sd: '12:00' }))).toBe(false);
    expect(physicalFlightKey(ux)).toBe('2026-09-26|MAD|LIS|10:40'); // la misma clave que ya usaban phys y el reparto de operadora
    expect(physicalFlightKey(fr4586)).toBe('2026-09-26|OPO|BCN|L01:15');
  });
  it('sin salida ni llegada, un vuelo solo es igual a sí mismo (nunca se agrupa por la ruta)', () => {
    const a = arr({ al: 'FR', icao: 'RYR', n: '1', sa: null }), b = arr({ al: 'FR', icao: 'RYR', n: '2', sa: null });
    expect(samePhysicalFlight(a, b)).toBe(false);
    expect(samePhysicalFlight(a, { ...a })).toBe(true);
  });
  it('la identificación por ruta no cambia: sus operadoras son las del mismo vuelo físico, como antes', () => {
    const legs = [fr4586, fr4546, vy8481, ib5645];
    expect(operatorIcaos({ ...fr4586, op: undefined }, legs).sort()).toEqual(['RYR', 'VLG']);
    expect(operatorIcaos(fr4586, legs)).toEqual(['RYR']);
  });
});

describe('la búsqueda directa nunca prueba el indicativo de otro vuelo de la misma ruta', () => {
  const OPO = [41.2481, -8.68139], BCN = [41.2971, 2.07846];
  const airports = { OPO: ['', '', ...OPO, 'Europe/Lisbon'], BCN: ['', '', ...BCN, 'Europe/Madrid'] };
  const T0 = Date.parse('2026-09-25T22:50:00Z'); // FR4586 en el aire (llega a las 01:20 locales)
  beforeEach(() => { vi.useFakeTimers({ now: T0 }); adsbLimiter.reset(); }); // limitador de producción (3/min)
  afterEach(() => { adsbLimiter.reset(); vi.useRealTimers(); });

  it('FR4586: solo prueba RYR4586 (y los códigos de SU vuelo); RYR4546 en el aire no se toma por él', async () => {
    const state = createState();
    state.legs = [fr4586, fr4546, { ...vy8481 }, ib5645];
    // Otro Ryanair de la misma ruta emite su indicativo comercial; el nuestro emite uno operativo (no aparece).
    const other = { hex: '4ca111', flight: 'RYR4546 ', t: 'B738', lat: 41.6, lon: -3.0, track: 80, alt_baro: 36000, gs: 450, seen: 1, seen_pos: 1 };
    const calls = [];
    const fetchFn = vi.fn(async url => {
      calls.push({ t: Date.now(), url });
      const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
      if (url.includes('/v2/callsign/RYR4546')) return ok({ ac: [other] });
      if (url.includes('/v2/callsign/')) return ok({ ac: [] });
      if (url.includes('/v2/point/')) return ok({ ac: [] });
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
    });
    let out;
    radarResponse(state, '/radar/FR/4586.json', { fetchFn, nowMs: T0, pauseMs: 0, airports }).then(r => { out = JSON.parse(r.body); });
    for (let i = 0; i < 300 && !out; i++) await vi.advanceTimersByTimeAsync(1000);
    const direct = calls.filter(c => c.url.includes('/v2/callsign/')).map(c => c.url.split('/').pop());
    expect(direct).toEqual(['RYR4586']); // la operadora es FR: solo su indicativo; nunca RYR4546 ni los de otros vuelos
    expect(out.state).not.toBe('volando');
    expect(out.callsign).not.toBe('RYR4546');
    const starts = calls.filter(c => c.url.includes('api.adsb.lol')).map(c => c.t);
    for (const t of starts) expect(starts.filter(u => u >= t && u < t + 60000).length).toBeLessThanOrEqual(3); // 3/min
  });
  it('sin operadora conocida: prueba los códigos compartidos de SU vuelo (misma llegada) y ninguno de otro', async () => {
    const state = createState();
    const legs = [{ ...fr4586, op: undefined }, { ...fr4546, op: undefined }, vy8481, ib5645];
    state.legs = legs;
    const calls = [];
    const fetchFn = vi.fn(async url => {
      calls.push(url);
      const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
      if (url.includes('/v2/')) return ok({ ac: [] });
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
    });
    let out;
    radarResponse(state, '/radar/FR/4586.json', { fetchFn, nowMs: T0, pauseMs: 0, airports }).then(r => { out = r; });
    for (let i = 0; i < 300 && !out; i++) await vi.advanceTimersByTimeAsync(1000);
    const direct = calls.filter(u => u.includes('/v2/callsign/')).map(u => u.split('/').pop());
    expect(direct).toEqual(['RYR4586', 'VLG8481']);
  });
});
