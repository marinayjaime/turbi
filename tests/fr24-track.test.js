// Estela real del vuelo (FR24 Flight Tracks): server/fr24.mjs (fr24Track) y server/fr24-track.mjs (/track y /track-adb).
// Solo el fr24Id que el servidor ya asoció a ESE vuelo físico (server/fr24-radar.mjs); nunca uno arbitrario del usuario.
// Solo posiciones reales (ADSB, MLAT, SATELLITE, UAT, FLARM). FR24 siempre simulado; el token es falso y nunca sale.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createState, handle, radarRoute, trackRoute } from '../server/live.mjs';
import { fr24Track, FR24_BASE } from '../server/fr24.mjs';
import { createAerodatabox, normalizeFlights, entryPath } from '../server/aerodatabox.mjs';
import { createMemoryStore } from '../server/adb-store.mjs';
import { adbPhysicalKey } from '../js/adb.js';
import { physicalFlightKey } from '../js/physical-flight.js';
import { adsbLimiter } from '../server/adsb.mjs';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });

const TOKEN = 'tok_FALSO_solo_para_pruebas_000000';
const env = { FR24_API_TOKEN: TOKEN };
const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });

const T = hhmm => Date.parse(`2026-10-21T${hhmm}:00Z`);
const NOW = T('08:40');
const ib403 = over => ({ al: 'IB', icao: 'IBE', n: '403', d: '2026-10-21', o: 'MAD', a: 'LHR', sd: '10:00', ed: '2026-10-21T10:05',
  sa: null, ea: null, g: 'J40', st: 'CER', std: 'CER', sta: null, ac: 'A21N', ...over });
const KEY = physicalFlightKey(ib403());
const RADAR = `/radar/IB/403.json?leg=${encodeURIComponent(KEY)}`;
const TRACK = `/track/IB/403.json?leg=${encodeURIComponent(KEY)}`;
const item = (over = {}, nowMs = NOW) => ({ fr24_id: '3c4d5e6f', flight: 'IB403', callsign: 'IBE403', lat: 44.01234, lon: -2.54321, track: 12,
  alt: 13500, gspeed: 300, vspeed: 1500, timestamp: new Date(nowMs - 5000).toISOString(), source: 'ADSB', hex: '3423C1', type: 'A21N',
  reg: 'EC-NIA', orig_iata: 'MAD', dest_iata: 'LHR', ...over });
// Puntos de la traza: cada minuto desde las 08:05, de MAD hacia el norte.
const pt = (i, over = {}, base = T('08:05')) => ({ timestamp: new Date(base + i * 60000).toISOString(), lat: 40.5 + i * 0.1, lon: -3.6 + i * 0.03,
  alt: 1000 * i, gspeed: 300, vspeed: 0, track: 10, squawk: '1000', callsign: 'IBE403', source: 'ADSB', ...over });
const trackBody = (points = [pt(0), pt(1), pt(2)], id = '3c4d5e6f') => ({ fr24_id: id, tracks: points });

// FR24 simulado: posiciones en vivo (live) y Flight Tracks (tracks(fr24Id, n) → cuerpo | { status } | Error).
function fake({ live = () => [item()], tracks = () => trackBody() } = {}) {
  const calls = [];
  const fetchFn = vi.fn(async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (!u.startsWith(FR24_BASE)) return res(200, {});
    if (u.includes('/flight-tracks')) {
      const a = await tracks(new URL(u).searchParams.get('flight_id'), calls.filter(c => c.includes('/flight-tracks')).length, opts);
      if (a instanceof Error) throw a;
      if (a?.status) return res(a.status, a.body ?? { message: `error ${TOKEN}` });
      return res(200, a);
    }
    const a = await live();
    return a?.status ? res(a.status, {}) : res(200, { data: a });
  });
  return { fetchFn, calls, trackCalls: () => calls.filter(c => c.includes('/flight-tracks')), liveCalls: () => calls.filter(c => c.includes('/live/')) };
}
function server(opts = {}, legs = [ib403()]) {
  const f = fake(opts);
  const state = createState();
  state.legs = legs;
  const radar = (t = NOW, path = RADAR) => radarRoute(state, path, { fetchFn: f.fetchFn, nowMs: t, airports, env }).then(r => JSON.parse(r.body));
  const rawTrack = (t = NOW, path = TRACK, e = env) => trackRoute(state, path, { fetchFn: f.fetchFn, nowMs: t, airports, env: e });
  const track = (t, path, e) => rawTrack(t, path, e).then(r => { expect(r.body).not.toContain(TOKEN); return JSON.parse(r.body); });
  return { ...f, state, radar, track, rawTrack };
}

describe('fr24Track (Flight Tracks)', () => {
  const call = (body, o = {}) => fr24Track('3c4d5e6f', { fetchFn: vi.fn(async () => (body?.status ? res(body.status, {}) : res(200, body))), env, nowMs: NOW, ...o });
  it('pide exactamente el endpoint oficial con las cabeceras de siempre', async () => {
    const fetchFn = vi.fn(async () => res(200, trackBody()));
    await fr24Track('3c4d5e6f', { fetchFn, env, nowMs: NOW });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe(`${FR24_BASE}/flight-tracks?flight_id=3c4d5e6f`);
    expect(opts.headers).toEqual({ Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${TOKEN}` });
    expect(opts.signal).toBeDefined();
  });
  it('1) puntos reales ordenados por tiempo, redondeados, con su hora y la del último', async () => {
    const r = await call(trackBody([pt(2), pt(0), pt(1)]));
    expect(r).toEqual({ state: 'found', fr24Id: '3c4d5e6f', points: [[40.5, -3.6], [40.6, -3.57], [40.7, -3.54]],
      times: [T('08:05') / 1000, T('08:06') / 1000, T('08:07') / 1000], alts: [0, 1000, 2000], lastAt: new Date(T('08:07')).toISOString() });
  });
  it('altitud: `alt` de FR24 (pies, según la especificación) tal cual; no válida → null sin inventar y la posición se queda; ESTIMATED sigue fuera', async () => {
    const r = await call(trackBody([pt(0, { alt: 0 }), pt(1, { alt: null }), pt(2, { alt: '35000' }), pt(3, { alt: 999999 }), pt(4, { alt: 37012 }),
      pt(5, { alt: 36000, source: 'ESTIMATED' }), pt(6, {})]));
    expect(r.alts).toEqual([0, null, null, null, 37012, 6000]); // ESTIMATED (5) fuera, también su altitud
    expect(r.points).toHaveLength(6);
    expect(r.times).toHaveLength(6);
    expect((await call(trackBody([pt(0, { alt: undefined }), pt(1, { alt: -150 })]))).alts).toEqual([null, -150]); // bajo cero: presión estándar
  });
  it('acepta también la respuesta como lista (el cliente oficial la tipa así)', async () => {
    expect((await call([trackBody()])).points).toHaveLength(3);
  });
  it('7) ESTIMATED, fuente desconocida o vacía, lat/lon no finitos, hora inválida o futura (> 30 s) → fuera de la estela', async () => {
    const r = await call(trackBody([pt(0), pt(1, { source: 'ESTIMATED' }), pt(2, { source: 'OTHER' }), pt(3, { source: null }), pt(4, { lat: null }),
      pt(5, { lon: 'x' }), pt(6, { timestamp: 'no' }), pt(7, { timestamp: new Date(NOW + 31000).toISOString() }), pt(8, { source: 'mlat' })]));
    expect(r.points).toEqual([[40.5, -3.6], [41.3, -3.36]]);
  });
  it('solo estimadas (o ninguna real) → not-found; otro fr24_id en la respuesta → not-found (nunca se mezclan vuelos)', async () => {
    expect(await call(trackBody([pt(0, { source: 'ESTIMATED' })]))).toEqual({ state: 'not-found' });
    expect(await call(trackBody([]))).toEqual({ state: 'not-found' });
    expect(await call(trackBody(undefined, 'ffff0000'))).toEqual({ state: 'not-found' });
    expect(await call({ tracks: [pt(0)] })).toEqual({ state: 'not-found' });
  });
  it('simplifica a como mucho 600 puntos, conservando el primero y el último, sin interpolar', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ ...pt(0), timestamp: new Date(T('05:00') + i * 5000).toISOString(), lat: 40 + i * 0.001, lon: -3, alt: i * 10 }));
    const r = await call(trackBody(many));
    expect(r.points.length).toBeLessThanOrEqual(600);
    expect(r.points.length).toBeGreaterThan(500);
    expect(r.points[0]).toEqual([40, -3]);
    expect(r.points.at(-1)).toEqual([41.999, -3]);
    const all = new Set(many.map(p => `${Math.round(p.lat * 1e4) / 1e4}`));
    expect(r.points.every(([lat]) => all.has(String(lat)))).toBe(true); // todos son puntos reales recibidos
    expect(r.times).toHaveLength(r.points.length);
    // Cada punto conserva SU altitud (la del mismo punto físico): alt = índice × 10 y lat = 40 + índice × 0,001.
    expect(r.alts).toHaveLength(r.points.length);
    expect(r.points.every(([lat], k) => r.alts[k] === Math.round((lat - 40) / 0.001) * 10)).toBe(true);
  });
  it('18) 401/403/429/5xx, red, tiempo agotado y JSON inválido → unavailable (sin reintentos); 404 → not-found', async () => {
    for (const [status, reason] of [[401, 'autorizacion'], [403, 'autorizacion'], [429, 'limite'], [500, 'servidor'], [503, 'servidor']]) {
      const fetchFn = vi.fn(async () => res(status, { message: TOKEN }));
      const r = await fr24Track('3c4d5e6f', { fetchFn, env, nowMs: NOW });
      expect(r).toEqual({ state: 'unavailable', reason, httpStatus: status });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
    expect(await call({ status: 404 })).toEqual({ state: 'not-found' });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(await fr24Track('3c4d5e6f', { fetchFn: vi.fn(async () => { throw timeout; }), env, nowMs: NOW })).toEqual({ state: 'unavailable', reason: 'timeout' });
    expect(await fr24Track('3c4d5e6f', { fetchFn: vi.fn(async () => { throw new TypeError('red'); }), env, nowMs: NOW })).toEqual({ state: 'unavailable', reason: 'red' });
    const bad = { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('x'); } };
    expect(await fr24Track('3c4d5e6f', { fetchFn: vi.fn(async () => bad), env, nowMs: NOW })).toEqual({ state: 'unavailable', reason: 'respuesta-invalida' });
  });
  it('fr24Id no válido o sin token → no se construye ninguna URL', async () => {
    const fetchFn = vi.fn();
    for (const id of ['', 'a', '../live', '3c4d5e6f&x=1', 'x'.repeat(17), null, 123]) {
      expect((await fr24Track(id, { fetchFn, env, nowMs: NOW })).state).toBe('unavailable');
    }
    expect(await fr24Track('3c4d5e6f', { fetchFn, env: {}, nowMs: NOW })).toEqual({ state: 'unavailable', reason: 'sin-configurar' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('/track/AL/N.json?leg=: solo el fr24Id asociado a ese vuelo físico', () => {
  it('1) tras el radar (asociación) → found con la estela real · 1 llamada a Flight Tracks del fr24Id asociado', async () => {
    const s = server();
    expect((await s.radar()).fr24Id).toBe('3c4d5e6f');
    const r = await s.track();
    expect(r).toMatchObject({ state: 'found', fr24Id: '3c4d5e6f', source: 'fr24', points: [[40.5, -3.6], [40.6, -3.57], [40.7, -3.54]],
      alts: [0, 1000, 2000] }); // la altitud de cada punto llega a la app, alineada con points y times
    expect(s.trackCalls()).toEqual([`${FR24_BASE}/flight-tracks?flight_id=3c4d5e6f`]);
    expect(s.liveCalls()).toHaveLength(1); // /track no vuelve a pedir posiciones en vivo
  });
  it('2) sin asociación (el radar aún no eligió avión, o eligió ninguno) → no-aplica sin llamar a FR24', async () => {
    const s = server();
    expect((await s.track()).state).toBe('no-aplica');
    expect(s.calls).toEqual([]);
    const two = server({ live: () => [item(), item({ fr24_id: '99aa99aa' })] }); // dos compatibles: ninguno
    await two.radar();
    expect((await two.track()).state).toBe('no-aplica');
    expect(two.trackCalls()).toEqual([]);
  });
  it('leg desconocido, sin ?leg o de otro número → no-aplica sin llamar; nunca un fr24Id del usuario', async () => {
    const s = server();
    await s.radar();
    for (const p of ['/track/IB/403.json', '/track/IB/403.json?leg=x', `/track/IB/404.json?leg=${encodeURIComponent(KEY)}`,
      `/track/IB/403.json?leg=x&fr24Id=3c4d5e6f`, `/track/IB/403.json?flight_id=3c4d5e6f`]) {
      expect((await s.track(NOW, p)).state, p).toBe('no-aplica');
    }
    expect(s.trackCalls()).toEqual([]);
    expect((await s.rawTrack(NOW, '/track/../live.json')).status).toBe(404);
  });
  it('sin FR24 configurado → no-aplica sin llamar a nada', async () => {
    const s = server();
    await s.radar();
    expect((await s.track(NOW, TRACK, {})).state).toBe('no-aplica');
    expect(s.trackCalls()).toEqual([]);
  });
  // Ruta realizada (requisito de Jaime): con la asociación vigente (≤ 24 h) y el tramo conocido, la estela se sirve aunque
  // la puerta del radar ya esté cerrada (aterrizado hace horas). El coste lo limita la caché por fr24Id.
  it('aterrizado hace 3 h (Aena LND, puerta cerrada) con asociación → found; sin asociación → no-aplica y 0 llamadas', async () => {
    const s = server();
    await s.radar();
    s.state.legs = [ib403({ std: 'BOR', st: 'BOR', sta: 'LND', sa: '12:20', ea: '2026-10-21T12:20' })];
    expect((await s.radar(T('13:20'))).state).toBe('no-aplica'); // /radar ya no aplica
    expect((await s.track(T('13:20'))).state).toBe('found');
    expect(s.trackCalls()).toHaveLength(1);
    const none = server({}, [ib403({ std: 'BOR', st: 'BOR', sta: 'LND' })]);
    expect((await none.track(T('13:20'))).state).toBe('no-aplica');
    expect(none.calls).toEqual([]);
  });
  it('cancelado o desviado (aunque hubiera asociación) → no-aplica sin llamar', async () => {
    for (const over of [{ st: 'CAN', std: 'CAN' }, { sta: 'DES' }, { std: 'DES' }]) {
      const s = server();
      await s.radar();
      s.state.legs = [ib403(over)];
      expect((await s.track()).state, JSON.stringify(over)).toBe('no-aplica');
      expect(s.trackCalls()).toEqual([]);
    }
  });
  it('asociación de hace más de 24 h → no-aplica sin llamar', async () => {
    const s = server();
    await s.radar();
    expect((await s.track(NOW + 24 * 3600000 + 60000)).state).toBe('no-aplica');
    expect(s.trackCalls()).toEqual([]);
  });
  it('8) vuelo aterrizado según FR24 (asociado): la trayectoria realizada se sirve', async () => {
    const s = server({ live: () => [item({ alt: 0, gspeed: 5, lat: 51.47, lon: -0.4543 }, T('10:20'))] });
    expect((await s.radar(T('10:20'))).state).toBe('aterrizado');
    expect((await s.track(T('10:21'))).state).toBe('found');
  });
  it('3) caché por fr24Id: found 10 min; pasada, otra llamada', async () => {
    const s = server();
    await s.radar();
    await s.track();
    await s.track(NOW + 9 * 60000);
    expect(s.trackCalls()).toHaveLength(1);
    await s.track(NOW + 10 * 60000 + 1000);
    expect(s.trackCalls()).toHaveLength(2);
  });
  it('not-found y unavailable: 2 min de caché (no-store para unavailable)', async () => {
    let answer = { status: 500 };
    const s = server({ tracks: () => answer });
    await s.radar();
    const first = await s.rawTrack();
    expect(JSON.parse(first.body)).toMatchObject({ state: 'unavailable' });
    expect(first.headers['Cache-Control']).toBe('no-store');
    await s.track(NOW + 60000);
    expect(s.trackCalls()).toHaveLength(1);
    answer = trackBody([pt(0, { source: 'ESTIMATED' })]);
    await s.track(NOW + 121000);
    expect(s.trackCalls()).toHaveLength(2);
    expect((await s.track(NOW + 122000)).state).toBe('not-found');
    expect(s.trackCalls()).toHaveLength(2);
    const ok = server();
    await ok.radar();
    expect((await ok.rawTrack()).headers['Cache-Control']).toMatch(/^public, max-age=\d+$/);
  });
  it('peticiones simultáneas al mismo fr24Id → 1 llamada (la misma promesa)', async () => {
    let release;
    const s = server({ tracks: () => new Promise(r => { release = () => r(trackBody()); }) });
    await s.radar();
    const both = Promise.all([s.track(), s.track()]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await both).map(r => r.state)).toEqual(['found', 'found']);
    expect(s.trackCalls()).toHaveLength(1);
  });
  it('18) Flight Tracks falla (401/403/429/5xx/timeout) → unavailable, sin reintentos y sin romper /radar', async () => {
    for (const a of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 502 }, Object.assign(new Error('t'), { name: 'TimeoutError' })]) {
      const s = server({ tracks: () => a });
      await s.radar();
      expect((await s.track()).state).toBe('unavailable');
      expect(s.trackCalls()).toHaveLength(1);
      expect((await s.radar(NOW + 61000)).state).toBe('volando');
    }
  });
  it('17) el token nunca aparece (ni en errores con el token en el cuerpo)', async () => {
    const s = server({ tracks: () => ({ status: 401, body: { message: TOKEN } }) });
    await s.radar();
    const r = await s.rawTrack();
    expect(r.body).not.toContain(TOKEN);
    expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
  });
  it('5) el radar cambia de fr24Id (único compatible nuevo) → /track pide el del nuevo, no el anterior', async () => {
    let id = '3c4d5e6f';
    const s = server({ live: () => [item({ fr24_id: id })], tracks: fid => trackBody(undefined, fid) });
    await s.radar();
    await s.track();
    id = '7a8b9c0d';
    expect((await s.radar(NOW + 61000)).fr24IdChanged).toBe(true);
    expect((await s.track(NOW + 62000)).fr24Id).toBe('7a8b9c0d');
    expect(s.trackCalls()).toEqual([`${FR24_BASE}/flight-tracks?flight_id=3c4d5e6f`, `${FR24_BASE}/flight-tracks?flight_id=7a8b9c0d`]);
  });
  it('la asociación de OTRO vuelo físico no sirve a este (dos tramos del mismo número)', async () => {
    const other = ib403({ o: 'LHR', a: 'MAD', sd: '09:50', ed: '2026-10-21T09:55' });
    const s = server({}, [ib403(), other]);
    await s.radar(); // asocia MAD → LHR
    const p = `/track/IB/403.json?leg=${encodeURIComponent(physicalFlightKey(other))}`;
    expect((await s.track(NOW, p)).state).toBe('no-aplica');
    expect(s.trackCalls()).toEqual([]);
  });
});

describe('/track-adb/<vuelo>/<fecha>.json?leg=: vuelos de AeroDataBox', () => {
  const ADB_NOW = Date.parse('2026-09-26T13:35Z');
  const raw = { number: 'GA 89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' },
    departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: '2026-09-26 10:35Z', local: '2026-09-26 12:35+02:00' } },
    arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: '2026-09-27 03:00Z', local: '2026-09-27 10:00+07:00' } }, aircraft: { model: 'Boeing 777' } };
  const entry = { status: 'found', source: 'aerodatabox', number: 'GA89', date: '2026-09-26', fetchedAt: new Date(ADB_NOW - 5 * 60000).toISOString(), legs: normalizeFlights([raw]) };
  const leg = adbPhysicalKey(entry, entry.legs[0]);
  const ga = item({ fr24_id: '4a4a4a4a', flight: 'GA89', callsign: 'GIA89', orig_iata: 'AMS', dest_iata: 'CGK', lat: 45.1, lon: 40.2, alt: 37000, gspeed: 490 }, ADB_NOW);
  function adb() {
    const f = fake({ live: () => [ga], tracks: fid => trackBody([pt(0, {}, ADB_NOW - 3 * 3600000), pt(1, {}, ADB_NOW - 3 * 3600000)], fid) });
    const state = createState();
    const adbApi = vi.fn(async () => { throw new Error('AeroDataBox no debe consultarse'); });
    state.adb = createAerodatabox({ key: 'k', store: createMemoryStore({ [entryPath(entry.number, entry.date)]: entry }), fetchFn: adbApi, now: () => ADB_NOW });
    const q = `?leg=${encodeURIComponent(leg)}`;
    const radar = () => radarRoute(state, `/radar-adb/GA89/2026-09-26.json${q}`, { fetchFn: f.fetchFn, nowMs: ADB_NOW, airports, env }).then(r => JSON.parse(r.body));
    const track = (p = `/track-adb/GA89/2026-09-26.json${q}`, t = ADB_NOW) => trackRoute(state, p, { fetchFn: f.fetchFn, nowMs: t, airports, env })
      .then(r => { expect(r.body).not.toContain(TOKEN); return JSON.parse(r.body); });
    return { ...f, adbApi, radar, track, state };
  }
  it('con la asociación del radar → found · 0 unidades de AeroDataBox', async () => {
    const s = adb();
    expect((await s.radar()).fr24Id).toBe('4a4a4a4a');
    expect(await s.track()).toMatchObject({ state: 'found', fr24Id: '4a4a4a4a' });
    expect(s.trackCalls()).toEqual([`${FR24_BASE}/flight-tracks?flight_id=4a4a4a4a`]);
    expect(s.adbApi).not.toHaveBeenCalled();
  });
  it('aterrizado hace horas (puerta cerrada) con asociación → found; desviado o cancelado → no-aplica sin llamar', async () => {
    const s = adb();
    await s.radar();
    const later = ADB_NOW + 20 * 3600000;
    expect((await s.track(undefined, later)).state).toBe('found');
    expect(s.trackCalls()).toHaveLength(1);
    for (const status of ['Diverted', 'Canceled', 'CanceledUncertain']) {
      const d = adb();
      await d.radar();
      d.state.adb = createAerodatabox({ key: 'k', store: createMemoryStore({ [entryPath(entry.number, entry.date)]: { ...entry, legs: normalizeFlights([{ ...raw, status }]) } }),
        fetchFn: d.adbApi, now: () => ADB_NOW });
      expect((await d.track()).state, status).toBe('no-aplica');
      expect(d.trackCalls()).toEqual([]);
    }
  });
  it('sin asociación o leg desconocido → no-aplica sin llamar', async () => {
    const s = adb();
    expect((await s.track()).state).toBe('no-aplica');
    await s.radar();
    expect((await s.track('/track-adb/GA89/2026-09-26.json?leg=otro')).state).toBe('no-aplica');
    expect((await s.track('/track-adb/GA89/2026-09-26.json')).state).toBe('no-aplica');
    expect(s.trackCalls()).toEqual([]);
  });
});

describe('16) /health.fr24: trackRequests y trackCacheHits, sin llamar a FR24', () => {
  it('cuenta llamadas reales y aciertos de caché; abrir /health no llama a nada', async () => {
    const s = server();
    await s.radar();
    await Promise.all([s.track(), s.track()]);
    await s.track(NOW + 1000);
    const n = s.calls.length;
    const h = JSON.parse(handle(s.state, '/health', { env }).body).fr24;
    expect(h).toMatchObject({ trackRequests: 1, trackCacheHits: 2 });
    expect(s.calls.length).toBe(n);
    expect(JSON.parse(handle(createState(), '/health', { env }).body).fr24).toMatchObject({ trackRequests: 0, trackCacheHits: 0 });
  });
});
