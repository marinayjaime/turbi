// Trabajo de radar por vuelo físico (phys → job): hex conocido, indicativos exactos, identificación por ruta y
// pausa. Caso real FR4586 (26/09/2026): la identificación funcionaba, pero con 3 peticiones/min los 4 indicativos
// exactos tardan más que los 20 s del navegador; un poll=1 llegaba en plena búsqueda directa, no veía trabajo en
// curso, respondía «sin-datos» y la app dejaba de mirar. FR4586 solo como nombre de regresión: ruta y avión simulados.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';

const ALC = [38.2822, -0.558156], BRS = [51.3827, -2.71909];
const airports = { ALC: ['', '', ...ALC, 'Europe/Madrid'], BRS: ['', '', ...BRS, 'Europe/London'] };
const dep = Date.parse('2026-09-26T06:10:00Z');
const T0 = dep + 30 * 60000;
const base = { d: '2026-09-26', o: 'ALC', a: 'BRS', sd: '08:05', ed: '2026-09-26T08:10', st: 'BOR', std: 'BOR', sta: 'FLY', ac: '738W' }; // sin operadora: se prueban los códigos compartidos
// El vuelo y tres códigos compartidos del mismo avión: 4 indicativos exactos que probar, y ninguno emite.
const legs = [
  { ...base, al: 'FR', icao: 'RYR', n: '4586' },
  { ...base, al: 'EI', icao: 'EIN', n: '8586' },
  { ...base, al: 'UX', icao: 'AEA', n: '7586' },
  { ...base, al: 'VY', icao: 'VLG', n: '6586' },
];
const PHYS = 'phys|2026-09-26|ALC|BRS|08:05';
const plane = () => ({ hex: '4d221d', flight: 'RYR12EV ', t: 'B738', lat: 41.9, lon: -1.05, track: 352, alt_baro: 34550, gs: 474, seen: 1, seen_pos: 1 });
const ok = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });

beforeEach(() => { vi.useFakeTimers({ now: T0 }); adsbLimiter.reset(); }); // limitador de producción: 5/8 s, 3/min (identificación 2)
afterEach(() => { adsbLimiter.reset(); vi.useRealTimers(); });

function setup({ callsignError = null } = {}) {
  const state = createState();
  state.legs = legs;
  const calls = [];
  const fetchFn = vi.fn(async url => {
    calls.push({ t: Date.now(), url });
    if (url.includes('/v2/callsign/')) {
      const n = calls.filter(c => c.url.includes('/v2/callsign/')).length;
      return callsignError?.(n) ?? ok({ ac: [] });
    }
    if (url.includes('/v2/point/')) return ok({ ac: [plane()] });
    if (url.includes('/v2/hex/4d221d')) return ok({ ac: [plane()] });
    if (url.includes('adsbdb') || url.includes('vrs-standing-data')) {
      return url.includes('adsbdb') ? ok({ response: { flightroute: { origin: { iata_code: 'ALC' }, destination: { iata_code: 'BRS' } } } })
        : ok({ _airport_codes_iata: 'ALC-BRS' });
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
  });
  const findSpy = vi.spyOn(state.hexes, 'resolve');
  const req = (path, nowMs = Date.now()) => radarResponse(state, path, { fetchFn, nowMs, pauseMs: 0, airports }).then(r => JSON.parse(r.body));
  const kind = k => calls.filter(c => c.url.includes(`/v2/${k}/`));
  // adsb.lol limitado: la API y las trazas (la base VRS es GitHub Pages, fuera del límite)
  return { state, calls, req, kind, findSpy, adsb: () => calls.filter(c => /^https:\/\/(api\.)?adsb\.lol\//.test(c.url)) };
}
// Una consulta puede esperar su turno en el limitador: se avanza el reloj simulado hasta que responda.
async function settled(promise) {
  let done = false, value;
  promise.then(v => { done = true; value = v; });
  for (let i = 0; i < 600 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  return value;
}
async function until(check, maxS = 600) {
  for (let i = 0; i < maxS && !check(); i++) await vi.advanceTimersByTimeAsync(1000);
  return check();
}

// Minutos de reloj simulado segundo a segundo: más tiempo real que los 5 s por defecto.
describe('FR4586 (regresión): el navegador abandona a los 20 s y el sondeo llega en plena búsqueda directa', { timeout: 30000 }, () => {
  it('poll=1 → identifying (fase direct), ni un findOnRadar más, una sola identificación, y el sondeo posterior ve el avión', async () => {
    const s = setup();
    let firstDone = false;
    const first = s.req('/radar/FR/4586.json').then(r => { firstDone = true; return r; }); // el navegador no lo espera
    await vi.advanceTimersByTimeAsync(20000);
    expect(firstDone).toBe(false); // > 20 s: la app ya recibió null por timeout
    expect(s.kind('callsign').length).toBeLessThan(4); // la búsqueda directa sigue (3/min)
    await vi.advanceTimersByTimeAsync(20000); // 40 s: llega el sondeo
    const poll = await settled(s.req('/radar/FR/4586.json?poll=1'));
    expect(poll).toMatchObject({ state: 'sin-datos', identifying: true, phase: 'direct' }); // nunca «sin-datos» definitivo
    // Un segundo usuario abre el mismo vuelo: comparte la búsqueda en curso, no lanza otra.
    const other = s.req('/radar/EI/8586.json');
    expect(await until(() => s.state.hexes.get(PHYS))).toBeTruthy(); // termina la directa, arranca la identificación y la resuelve
    expect(s.kind('callsign')).toHaveLength(4); // una sola secuencia de indicativos
    expect(s.findSpy).toHaveBeenCalledTimes(1); // una sola identificación por ruta
    await settled(first); await settled(other);
    expect(await settled(s.req('/radar/FR/4586.json?poll=1'))).toMatchObject({ state: 'volando', callsign: 'RYR12EV', hex: '4d221d', match: 'ruta' });
    const starts = s.adsb().map(c => c.t);
    for (const t of starts) expect(starts.filter(u => u >= t && u < t + 60000).length).toBeLessThanOrEqual(3); // 3/min
  });
  it('dos usuarios durante la fase directa → una sola secuencia de indicativos y ambos reciben el mismo resultado', async () => {
    const s = setup();
    const a = s.req('/radar/FR/4586.json');
    await vi.advanceTimersByTimeAsync(3000);
    const b = s.req('/radar/UX/7586.json');
    await until(() => s.state.hexes.busy(PHYS) || s.state.hexes.get(PHYS));
    const [ra, rb] = await settled(Promise.all([a, b]));
    expect(s.kind('callsign')).toHaveLength(4);
    expect(ra).toMatchObject({ identifying: true });
    expect(rb).toMatchObject({ identifying: true });
  });
  it('sondeos durante toda la fase directa: ninguna llamada propia a adsb.lol', async () => {
    const s = setup();
    s.req('/radar/FR/4586.json');
    await vi.advanceTimersByTimeAsync(2000);
    const before = s.adsb().length;
    for (let i = 0; i < 3; i++) {
      const r = await s.req('/radar/FR/4586.json?poll=1'); // responde en el acto, sin esperar turno
      expect(r).toMatchObject({ identifying: true });
    }
    expect(s.adsb()).toHaveLength(before);
  });
  it('429 durante la búsqueda directa: estado temporal (pausa), nada definitivo, y el servidor la repite solo', async () => {
    const tooMany = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
    const s = setup({ callsignError: n => (n === 2 ? tooMany : null) });
    const first = s.req('/radar/FR/4586.json');
    await until(() => adsbLimiter.isBlocked());
    const paused = await settled(s.req('/radar/FR/4586.json?poll=1'));
    expect(paused).toMatchObject({ identifying: true, phase: 'pausa', temporary: true });
    expect(paused.retryAfterSec).toBeGreaterThan(0);
    expect(await settled(first)).toMatchObject({ identifying: true, phase: 'pausa' });
    expect(await until(() => s.state.hexes.get(PHYS))).toBeTruthy(); // tras la pausa: indicativos otra vez, ruta, identificado
    expect(s.findSpy).toHaveBeenCalledTimes(1);
    expect(await settled(s.req('/radar/FR/4586.json?poll=1'))).toMatchObject({ state: 'volando', hex: '4d221d' });
  });
});
