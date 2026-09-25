// Las cuatro condiciones añadidas a la identificación vuelo → hex (docs/turbi-roadmap.md, 25/09/2026):
// 1) el hex no se invalida por una sola lectura; 2) identificación asíncrona; 3) limitador global de adsb.lol;
// 4) heurísticas documentadas y ajustables. FR2311 solo aparece como datos de regresión.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { corridor, identifyByZone, createHexRegistry, trackByHex, LIMITS } from '../server/identify.mjs';
import { findOnRadar } from '../server/radar.mjs';
import { createState, radarResponse } from '../server/live.mjs';
import { adsbLimiter, createLimiter } from '../server/adsb.mjs';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0 }); });

const PMI = [39.5517, 2.73881], LBA = [53.8659, -1.66057];
const MIN = 60000;
const dep = Date.parse('2026-09-25T07:27:00Z');
const now = dep + 30 * MIN;
const leg = { al: 'FR', icao: 'RYR', n: '2311', d: '2026-09-25', o: 'PMI', a: 'LBA', sd: '09:25', ed: '2026-09-25T09:27', st: 'BOR', std: 'BOR', sta: null, ac: '738W', op: 'FR' };
const entry = { state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' };
const plane = over => ({ hex: '4d225e', flight: 'RYR19HB ', t: 'B738', lat: 40.94, lon: 1.28, track: 338, alt_baro: 35500, gs: 450, seen: 1, seen_pos: 1, ...over });
const hexApi = ac => vi.fn(async () => ({ ok: true, json: async () => ({ ac: ac ? [ac] : [] }) }));
const track = ac => trackByHex({ entry, leg, origin: PMI, dest: LBA, nowMs: now, fetchFn: hexApi(ac) });

describe('1) el hex no se invalida por una sola lectura incompleta o incompatible', () => {
  it('clasifica cada lectura: mismo indicativo, otro, sin indicativo, sin señal, físicamente imposible', async () => {
    expect(await track(plane())).toMatchObject({ observation: 'compatible', result: { state: 'volando', callsign: 'RYR19HB', hex: '4d225e', match: 'ruta' } });
    expect(await track(plane({ flight: 'RYR44AB' }))).toEqual({ observation: 'incompatible', result: null });
    expect(await track(plane({ flight: '' }))).toEqual({ observation: 'incompleta', result: null });
    expect(await track(null)).toEqual({ observation: 'incompleta', result: null });
    expect(await track(plane({ lat: 50.5, lon: 6.5 }))).toMatchObject({ observation: 'contradiccion' }); // 1.200 km en 30 min
    expect(await track(plane({ alt_baro: 'ground', lat: 41.3, lon: 2.08 }))).toMatchObject({ observation: 'contradiccion' }); // en tierra en otro aeropuerto
  });
  it('una lectura con otro indicativo o sin él no invalida; tres seguidas con otro indicativo sí', () => {
    const reg = createHexRegistry();
    const phys = 'p';
    return reg.resolve(phys, async () => entry, now).then(() => {
      expect(reg.observe(phys, 'incompatible', now)).toBe(false);
      expect(reg.observe(phys, 'incompleta', now)).toBe(false);
      expect(reg.observe(phys, 'compatible', now)).toBe(false); // vuelve a cuadrar: la cuenta se reinicia
      expect(reg.observe(phys, 'incompatible', now)).toBe(false);
      expect(reg.observe(phys, 'incompatible', now)).toBe(false);
      expect(reg.get(phys)).toMatchObject({ hex: '4d225e' });
      expect(reg.observe(phys, 'incompatible', now)).toBe(true);
      expect(reg.get(phys)).toBeNull();
    });
  });
  it('una contradicción física clara invalida en el acto', async () => {
    const reg = createHexRegistry();
    await reg.resolve('p', async () => entry, now);
    expect(reg.observe('p', 'contradiccion', now)).toBe(true);
    expect(reg.get('p')).toBeNull();
  });
});

// Servidor con el vuelo en sus datos de Aena: el indicativo exacto (RYR2311) no aparece; la zona y el hex sí.
function server({ holdZone = false } = {}) {
  let release = () => {};
  const gate = holdZone ? new Promise(r => { release = r; }) : Promise.resolve();
  const calls = [];
  const fetchFn = vi.fn(async url => {
    calls.push(url);
    const ok = body => ({ ok: true, json: async () => body });
    if (url.includes('/v2/callsign/')) return ok({ ac: [] });
    if (url.includes('/v2/point/')) { await gate; return ok({ ac: [plane()] }); }
    if (url.includes('/v2/hex/4d225e')) return ok({ ac: [plane()] });
    if (url.includes('adsbdb')) return ok({ response: { flightroute: { origin: { iata_code: 'PMI' }, destination: { iata_code: 'LBA' } } } });
    return { ok: false, status: 404 };
  });
  const state = createState();
  state.legs = [leg];
  const airports = { PMI: ['', '', ...PMI], LBA: ['', '', ...LBA] };
  const ask = nowMs => radarResponse(state, '/radar/FR/2311.json', { fetchFn, nowMs, pauseMs: 0, airports }).then(r => JSON.parse(r.body));
  return { ask, calls, release: () => release(), state };
}

describe('2) identificación asíncrona: nunca retrasa la respuesta', () => {
  it('la respuesta llega sin esperar a la identificación (en curso), y la siguiente ya sigue el avión por su hex', async () => {
    const s = server({ holdZone: true });
    const first = await s.ask(now); // la consulta por zona está retenida: si se esperase, esto no terminaría
    expect(first).toMatchObject({ state: 'sin-datos', identifying: true });
    s.release();
    await vi.waitFor(() => expect(s.state.hexes.get('phys|2026-09-25|PMI|LBA|09:25')).toMatchObject({ hex: '4d225e' }));
    const second = await s.ask(now + 20000); // la respuesta «identificando» no se guarda: la app puede volver a mirar
    expect(second).toMatchObject({ state: 'volando', callsign: 'RYR19HB', hex: '4d225e', match: 'ruta' });
    expect(s.calls.filter(u => u.includes('/v2/hex/'))).toHaveLength(1);
  });
  it('fuera de la franja de espera, la identificación fallida no se repite (10 min) ni se anuncia', async () => {
    const s = server();
    s.state.legs = [{ ...leg, ac: null }]; // Aena no da el tipo: no se intenta
    expect(await s.ask(now)).toEqual(expect.not.objectContaining({ identifying: true }));
    expect(s.calls.some(u => u.includes('/v2/point/'))).toBe(false);
  });
});

describe('3) un único limitador global para todas las consultas a adsb.lol', () => {
  it('indicativo, zona y hex, pedidos a la vez desde sitios distintos, salen de uno en uno y separados', async () => {
    // Reloj simulado: con el reloj real, el momento anotado dentro de fetch lleva un retraso variable y la medida
    // fallaba a veces en la CI (35 ms en vez de ≥ 40) aunque el limitador respetaba la separación.
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00Z') });
    try {
      const limiter = createLimiter(40, { identifyIntervalMs: 40 });
      const starts = [];
      let open = 0, maxOpen = 0;
      const fetchFn = vi.fn(async url => {
        if (url.startsWith('https://api.adsb.lol/')) starts.push(Date.now());
        open++; maxOpen = Math.max(maxOpen, open);
        await new Promise(r => setTimeout(r, 5));
        open--;
        return { ok: true, json: async () => ({ ac: url.includes('/hex/') ? [plane()] : [] }) };
      });
      let done = false;
      const all = Promise.all([
        findOnRadar({ leg, fetchFn, pauseMs: 0, limiter }),
        identifyByZone({ leg, legs: [leg], origin: PMI, dest: LBA, nowMs: now, fetchFn, limiter }),
        trackByHex({ entry, leg, origin: PMI, dest: LBA, nowMs: now, fetchFn, limiter }),
      ]).then(() => { done = true; });
      for (let t = 0; t < 5000 && !done; t += 5) await vi.advanceTimersByTimeAsync(5);
      await all;
      const adsb = fetchFn.mock.calls.filter(c => c[0].startsWith('https://api.adsb.lol/'));
      expect(new Set(adsb.map(c => c[0].split('/')[4]))).toEqual(new Set(['callsign', 'point', 'hex']));
      expect(maxOpen).toBe(1);
      for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(40);
    } finally { vi.useRealTimers(); }
  });
  it('el limitador por defecto es el mismo objeto para el radar y la identificación', async () => {
    const spy = vi.spyOn(adsbLimiter, 'schedule');
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ ac: [] }) }));
    await findOnRadar({ leg, fetchFn, pauseMs: 0 });
    await trackByHex({ entry, leg, origin: PMI, dest: LBA, nowMs: now, fetchFn });
    await identifyByZone({ leg, legs: [leg], origin: PMI, dest: LBA, nowMs: now, fetchFn });
    expect(spy.mock.calls.length).toBe(fetchFn.mock.calls.filter(c => c[0].startsWith('https://api.adsb.lol/')).length);
    spy.mockRestore();
  });
});

describe('recorrido mínimo: un avión que salió mucho después por la misma ruta no es el buscado', () => {
  it('3 h después de la salida, un avión a 170 km del origen va demasiado atrás (sería un vuelo posterior)', () => {
    expect(corridor({ origin: PMI, dest: LBA, lat: 40.94, lon: 1.28, track: 338, elapsedMin: 180 }).reason).toBe('demasiado-atras');
    expect(corridor({ origin: PMI, dest: LBA, lat: 40.94, lon: 1.28, track: 338, elapsedMin: 30 }).ok).toBe(true);
  });
  it('y no se identifica aunque adsbdb confirme la misma ruta', async () => {
    const fetchFn = vi.fn(async url => ({ ok: true, json: async () => (url.includes('adsbdb')
      ? { response: { flightroute: { origin: { iata_code: 'PMI' }, destination: { iata_code: 'LBA' } } } }
      : { ac: [plane()] }) }));
    expect((await identifyByZone({ leg, legs: [leg], origin: PMI, dest: LBA, nowMs: dep + 180 * MIN, fetchFn })).state).toBe('sin-datos');
  });
});

describe('FR2311 con el tráfico real del 25/09/2026 (09:02 UTC): regresión, sin ninguna excepción en el código', () => {
  // Respuestas reales de adsb.lol (solo los aviones de Ryanair, los únicos que mira el filtro) y de adsbdb.
  const fx = JSON.parse(readFileSync('tests/fixtures/fr2311-2026-09-25.json', 'utf8'));
  const replay = (routeOverride = {}) => {
    const points = fx.responses.filter(r => r.url.includes('/v2/point/'));
    let i = 0;
    return vi.fn(async url => {
      if (url.includes('/v2/point/')) { const r = points[i++]; return { ok: true, status: 200, json: async () => r.body }; }
      if (url.includes('adsbdb')) {
        const cs = url.split('/').pop();
        const r = fx.responses.find(x => x.url.endsWith(`/callsign/${cs}`) && x.url.includes('adsbdb'));
        const body = routeOverride[cs] ? { response: { flightroute: { origin: { iata_code: routeOverride[cs][0] }, destination: { iata_code: routeOverride[cs][1] } } } } : r?.body;
        return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404, json: async () => null };
      }
      return { ok: false, status: 404, json: async () => null };
    });
  };
  const run = fetchFn => identifyByZone({ leg: fx.leg, legs: [fx.leg], origin: PMI, dest: LBA, nowMs: fx.nowMs, fetchFn });
  it('varios Ryanair pasan los filtros gratuitos; adsbdb deja uno solo (PMI→LBA) → ese hex', async () => {
    const f = replay();
    expect(await run(f)).toEqual({ state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' });
    const asked = f.mock.calls.map(c => c[0]).filter(u => u.includes('adsbdb'));
    expect(asked.length).toBeGreaterThan(1); // la geometría sola no bastaba
    expect(asked.length).toBeLessThanOrEqual(LIMITS.maxCandidates);
    expect(f.mock.calls.filter(c => c[0].includes('/v2/point/')).length).toBeLessThanOrEqual(LIMITS.maxZoneCalls);
  });
  it('si dos candidatos tuvieran la ruta exacta → ambiguo, ninguno', async () => {
    expect((await run(replay({ RYR6PG: ['PMI', 'LBA'] }))).state).toBe('ambiguo');
  });
  it('si ninguno la tiene → no se elige ninguno', async () => {
    expect((await run(replay({ RYR19HB: ['PMI', 'EMA'] }))).state).not.toBe('identificado');
  });
});

describe('4) heurísticas documentadas y ajustables', () => {
  it('pasillo, rumbo y velocidad se pueden cambiar sin tocar el código', () => {
    const p = { origin: PMI, dest: LBA, lat: 40.94, lon: 1.28, track: 338, elapsedMin: 30 };
    expect(corridor(p).ok).toBe(true);
    expect(corridor(p, { ...LIMITS, corridorKm: 80 }).reason).toBe('lateral'); // FR2311 iba a 93 km
    expect(corridor({ ...p, track: 300 }, { ...LIMITS, maxTrackDiffDeg: 30 }).reason).toBe('rumbo');
    expect(corridor(p, { ...LIMITS, maxKmh: 200, reachSlackKm: 0 }).reason).toBe('demasiado-lejos');
  });
  it('los valores por defecto son los del diseño aprobado', () => {
    expect(LIMITS).toMatchObject({ corridorKm: 120, maxTrackDiffDeg: 60, maxKmh: 1100, reachSlackKm: 50, maxCandidates: 12, maxZoneCalls: 3, cooldownMin: 10 });
    expect(LIMITS.zoneRadiusNm).toBeLessThanOrEqual(250);
  });
  it('nada del código conoce FR2311, su indicativo ni su hex', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['server/identify.mjs', 'server/radar.mjs', 'server/live.mjs', 'server/adsb.mjs']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/2311|RYR19HB|4d225e/i);
    }
  });
});
