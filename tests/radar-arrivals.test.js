// Llegadas a España desde un aeropuerto extranjero: Aena solo controla la llegada. Puede publicar FLY/FNL sin conocer
// la salida (sin sd/ed). Regla: FLY/FNL basta para el radar por indicativo; la identificación por ruta usa una salida
// ESTIMADA (llegada de Aena − duración estimada de la ruta, como «Salida estimada» en la app), solo interna.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { needsRadar, departureMs, estimatedDepartureMs } from '../server/radar.mjs';
import { canIdentify } from '../server/identify.mjs';
import { wantsRadar, withRadar } from '../js/radar.js';
import { flightCardHtml } from '../js/ui.js';
import { buildRoute } from '../js/route.js';
import { localToUtcMs } from '../js/time.js';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0 }); });

const HHN = [49.9487, 7.26389], VLC = [39.4893, -0.481625];
const airports = { HHN: ['Frankfurt-Hahn', 'Hahn', ...HHN, 'Europe/Berlin'], VLC: ['Valencia', 'Valencia', ...VLC, 'Europe/Madrid'] };
// Datos reales de Aena del 25/09/2026 (Render, 09:48 UTC), más el código OACI que el servidor añade a cada tramo.
const fr8606 = { al: 'FR', icao: 'RYR', n: '8606', d: '2026-09-25', o: 'HHN', a: 'VLC', sd: null, ed: null, sa: '11:05', ea: '2026-09-25T11:55',
  td: null, ta: '1', g: null, st: 'FLY', std: null, sta: 'FLY', ac: '738W', op: 'FR' };
const now = Date.parse('2026-09-25T09:48:00Z');
const arrivalUtc = localToUtcMs('2026-09-25', '11:55', 'Europe/Madrid');
const plannedMin = buildRoute({ lat: HHN[0], lon: HHN[1] }, { lat: VLC[0], lon: VLC[1] }, 0).durationMin;

describe('origen extranjero: FLY/FNL basta para consultar el radar', () => {
  it('1. sta=FLY sin salida (sd/ed vacíos) → radar (app y servidor)', () => {
    expect(departureMs(fr8606)).toBeNull();
    expect(needsRadar(fr8606, now)).toBe(true);
    expect(wantsRadar(fr8606, 'https://x')).toBe(true);
  });
  it('2. sta=FNL → radar', () => {
    const l = { ...fr8606, sta: 'FNL', st: 'FNL' };
    expect([needsRadar(l, now), wantsRadar(l, 'https://x')]).toEqual([true, true]);
  });
  it('5. llegada final (LND, IBK, OPE, OPF, BOR) → no', () => {
    for (const sta of ['LND', 'IBK', 'OPE', 'OPF', 'BOR']) expect([needsRadar({ ...fr8606, sta, st: sta }, now), wantsRadar({ ...fr8606, sta, st: sta }, 'https://x')], sta).toEqual([false, false]);
  });
  it('6. cancelado o desviado → no', () => {
    for (const sta of ['CAN', 'DES']) expect([needsRadar({ ...fr8606, sta, st: sta }, now), wantsRadar({ ...fr8606, sta, st: sta }, 'https://x')], sta).toEqual([false, false]);
  });
  it('sin salida, la ventana de tiempo se mide con la llegada de Aena; sin ninguna hora, no', () => {
    expect(needsRadar(fr8606, Date.parse('2026-09-26T12:00:00Z'))).toBe(false); // > 20 h después de la llegada
    expect(needsRadar(fr8606, Date.parse('2026-09-24T12:00:00Z'))).toBe(false); // > 20 h antes
    expect(needsRadar({ ...fr8606, sa: null, ea: null }, now)).toBe(false);
  });
  it('una salida confirmada BOR sigue sin cambios (UX6030 / UX4024)', () => {
    const ux = { al: 'UX', icao: 'AEA', n: '6030', d: '2026-09-25', o: 'PMI', a: 'MAD', sd: '10:40', ed: '2026-09-25T10:51', sa: '12:05', ea: '2026-09-25T12:06', st: 'BOR', std: 'BOR', sta: 'INI' };
    expect(needsRadar(ux, Date.parse('2026-09-25T09:30:00Z'))).toBe(true);
    expect(needsRadar({ ...ux, n: '4024', a: 'ALC', sta: 'FLY', st: 'FLY' }, Date.parse('2026-09-25T09:30:00Z'))).toBe(true);
    expect(needsRadar(ux, Date.parse('2026-09-25T08:40:00Z'))).toBe(false); // antes de la salida
  });
});

describe('salida estimada (solo interna, para la identificación por ruta)', () => {
  it('llegada de Aena − duración estimada de la ruta (la misma que usa la app para «Salida estimada»)', () => {
    expect(estimatedDepartureMs(fr8606, HHN, VLC)).toBe(arrivalUtc - plannedMin * 60000);
    // FR8606: la app muestra «Salida estimada 09:45» (hora de Hahn); esto es 09:4x, sin redondear
    expect(new Date(estimatedDepartureMs(fr8606, HHN, VLC)).toISOString().slice(11, 15)).toBe('07:4');
  });
  it('si Aena tiene la salida, se usa esa (nunca la estimada); sin llegada ni salida, nada', () => {
    const withDep = { ...fr8606, sd: '09:40', ed: '2026-09-25T09:50', std: 'BOR' };
    expect(estimatedDepartureMs(withDep, HHN, VLC)).toBe(departureMs(withDep));
    expect(estimatedDepartureMs({ ...fr8606, sa: null, ea: null }, HHN, VLC)).toBeNull();
  });
  it('con FLY y salida estimada se puede identificar; sin confirmación, solo pasados 15 min de la salida estimada', () => {
    const o = t => ({ origin: HHN, dest: VLC, nowMs: t });
    const estDep = arrivalUtc - plannedMin * 60000;
    expect(canIdentify(fr8606, [fr8606], o(now))).toBe(true);
    const sch = { ...fr8606, sta: 'SCH', st: 'SCH' };
    expect(canIdentify(sch, [sch], o(estDep + 10 * 60000))).toBe(false);
    expect(canIdentify(sch, [sch], o(estDep + 16 * 60000))).toBe(true);
    expect(canIdentify({ ...fr8606, sa: null, ea: null }, [fr8606], o(now))).toBe(false);
  });
});

// Servidor con el tramo de Aena; adsb.lol y adsbdb simulados.
function server({ callsignAc = [], pointAc = [], routes = {}, legs = [fr8606] } = {}) {
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
  const ask = t => radarResponse(state, '/radar/FR/8606.json', { fetchFn, nowMs: t, pauseMs: 0, airports }).then(r => JSON.parse(r.body));
  return { ask, calls, state };
}
// A ~75 % de la ruta, rumbo a Valencia: coherente con la salida estimada (07:4x UTC) a las 09:48 UTC.
const plane = over => ({ hex: '4ca7b6', flight: 'RYR8KX  ', t: 'B738', lat: 42.3, lon: 1.3, track: 222, alt_baro: 36000, gs: 440, seen: 1, seen_pos: 1, ...over });

describe('radar de una llegada desde el extranjero', () => {
  it('3. indicativo directo encontrado (RYR8606) → volando y panel ADS-B, sin identificación', async () => {
    const s = server({ callsignAc: [plane({ flight: 'RYR8606 ' })] });
    const r = await s.ask(now);
    expect(r).toMatchObject({ state: 'volando', callsign: 'RYR8606' });
    expect(r.identifying).toBeUndefined();
    expect(s.calls.some(u => u.includes('/v2/point/'))).toBe(false);
    const card = { al: 'FR', title: 'x', route: 'y', tabs: [], status: { text: 'En vuelo', tone: 'info', flying: true }, o: 'HHN', a: 'VLC', duration: 130,
      dep: null, arr: { date: '2026-09-25', time: '11:55' }, aircraft: null, updatedAgo: 'hace 1 min', stale: false };
    expect(flightCardHtml(withRadar(card, r))).toContain('class="telemetry"');
  });
  it('4. emite con otro indicativo → identificación por ruta con la salida estimada, y después seguimiento por hex', async () => {
    const s = server({ pointAc: [plane()], routes: { RYR8KX: ['HHN', 'VLC'] } });
    expect(await s.ask(now)).toMatchObject({ state: 'sin-datos', identifying: true });
    await vi.waitFor(() => expect(s.state.hexes.get('phys|2026-09-25|HHN|VLC|L11:05')).toMatchObject({ hex: '4ca7b6', callsign: 'RYR8KX' }));
    expect(await s.ask(now + 20000)).toMatchObject({ state: 'volando', callsign: 'RYR8KX', hex: '4ca7b6', match: 'ruta' });
  });
  it('con la salida estimada se mantienen los filtros: un avión que salió mucho después no es el buscado', async () => {
    // mismo avión y ruta en adsbdb, pero a 150 km de Hahn: con la salida estimada hace 2 h, va demasiado atrás
    const s = server({ pointAc: [plane({ lat: 48.8, lon: 6.4 })], routes: { RYR8KX: ['HHN', 'VLC'] } });
    await s.ask(now);
    await vi.waitFor(() => expect(s.state.hexes.busy('phys|2026-09-25|HHN|VLC|L11:05')).toBe(false));
    expect(s.state.hexes.get('phys|2026-09-25|HHN|VLC|L11:05')).toBeNull();
  });
  it('dos llegadas de la misma operadora y ruta, ambas sin salida, a menos de 2 h → no se intenta (no son el mismo vuelo)', async () => {
    const other = { ...fr8606, n: '8608', sa: '12:30', ea: '2026-09-25T12:40' };
    const s = server({ pointAc: [plane()], routes: { RYR8KX: ['HHN', 'VLC'] }, legs: [fr8606, other] });
    await s.ask(now);
    await vi.waitFor(() => expect(s.state.hexes.busy('phys|2026-09-25|HHN|VLC|L11:05')).toBe(false));
    expect(s.state.hexes.get('phys|2026-09-25|HHN|VLC|L11:05')).toBeNull();
    expect(s.calls.some(u => u.includes('/v2/point/'))).toBe(false);
  });
});

describe('7. FR8606 (regresión con los datos reales de Aena, sin código específico)', () => {
  it('antes: sin salida → sin radar (successCount 0 en /health). Ahora: se consulta', async () => {
    const s = server();
    const r = await s.ask(now);
    expect(r.state).not.toBe('no-aplica');
    expect(s.calls[0]).toBe('https://api.adsb.lol/v2/callsign/RYR8606');
  });
});
