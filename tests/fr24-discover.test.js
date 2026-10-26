// Descubrimiento con Flightradar24 (server/fr24-discover.mjs): la tercera vía, solo si ni Aena ni AeroDataBox tienen el
// vuelo y solo para uno que vuela ahora. Datos con la forma real de EK2518 del 26/10/2026 (Teruel → Dubái, A380,
// Flight Positions con un único resultado ADSB); FR24 siempre simulado y el token es falso.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createState } from '../server/live.mjs';
import { fr24DiscoverResponse, fr24DiscoveredRadarResponse, fr24Airport, discoverPick } from '../server/fr24-discover.mjs';
import { createMemoryStore } from '../server/adb-store.mjs';
import { normalizeFlight } from '../server/fr24.mjs';
import { fr24Key, discoveryLive, fr24HistoryDue } from '../js/fr24-discovery.js';

const TOKEN = 'tok_FALSO_solo_para_pruebas_000000';
const env = { FR24_API_TOKEN: TOKEN };
const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });
const NOW = Date.parse('2026-10-26T13:54:30Z');
const DATE = '2026-10-26';
// Respuesta real de Flight Positions (full) para EK2518, 26/10/2026 13:54 UTC.
const EK = { fr24_id: '424c145f', flight: 'EK2518', callsign: 'UAE2518', lat: 39.33298, lon: 0.41736, track: 92, alt: 32325, gspeed: 492, vspeed: 2560,
  squawk: '1450', timestamp: '2026-10-26T13:54:20Z', source: 'ADSB', hex: '896193', type: 'A388', reg: 'A6-EET', painted_as: 'UAE', operating_as: 'UAE',
  orig_iata: 'TEV', orig_icao: 'LETL', dest_iata: 'DXB', dest_icao: 'OMDB', eta: '2026-10-26T20:09:07Z' };
const KEY = fr24Key('EK2518', DATE, 'TEV', 'DXB');
// Flight Summary Light de EK2518 ya terminado (forma real de la API).
const SUMMARY = { fr24_id: '424c145f', flight: 'EK2518', callsign: 'UAE2518', operating_as: 'UAE', type: 'A388', reg: 'A6-EET', hex: '896193',
  orig_icao: 'LETL', dest_icao: 'OMDB', dest_icao_actual: 'OMDB', datetime_takeoff: '2026-10-26T12:41:10Z', datetime_landed: '2026-10-26T20:02:44Z',
  first_seen: '2026-10-26T12:20:03Z', last_seen: '2026-10-26T20:15:00Z', flight_ended: true };

function fake({ positions = () => res(200, { data: [EK] }), summary = () => res(200, { data: [SUMMARY] }, { 'x-fr24-credits-consumed': '2' }) } = {}) {
  const calls = [];
  const fetchFn = vi.fn(async (url, opts) => {
    const u = String(url);
    calls.push(u);
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    if (u.includes('/live/flight-positions/full?')) return positions(u);
    if (u.includes('/flight-summary/light?')) return summary(u);
    throw new Error(`URL inesperada ${u}`);
  });
  return { fetchFn, calls, lookups: () => calls.filter(u => u.includes('flight-positions')), summaries: () => calls.filter(u => u.includes('flight-summary')) };
}
function setup({ f = fake(), store = createMemoryStore() } = {}) {
  const state = createState();
  state.historyStore = store;
  const discover = (nowMs = NOW, number = 'EK2518', date = DATE) =>
    fr24DiscoverResponse(state, `/discover-fr24/${number}/${date}.json`, { fetchFn: f.fetchFn, nowMs, airports, env }).then(r => JSON.parse(r.body));
  const radar = (nowMs = NOW, key = KEY) =>
    fr24DiscoveredRadarResponse(state, `/radar-fr24/EK2518/${DATE}.json?leg=${encodeURIComponent(key)}`, { fetchFn: f.fetchFn, nowMs, env }).then(r => JSON.parse(r.body));
  return { state, store, f, discover, radar };
}

describe('aeropuertos de FR24 y elección del candidato', () => {
  it('Teruel (sin vuelos regulares) solo por su OACI: TEV/LETL sí; TEV con otro OACI (el aeródromo argentino) no', () => {
    expect(fr24Airport('TEV', 'LETL', { airports })).toMatchObject({ iata: 'TEV', icao: 'LETL', city: 'Teruel', tz: 'Europe/Madrid' });
    expect(fr24Airport('TEV', 'SAXX', { airports })).toBeNull();
    expect(fr24Airport('DXB', 'OMDB', { airports })).toMatchObject({ iata: 'DXB', city: 'Dubai', tz: 'Asia/Dubai' });
    expect(fr24Airport('DXB', 'OMDW', { airports })).toBeNull(); // IATA y OACI de aeropuertos distintos
    expect(fr24Airport('DXB', null, { airports })).toBeNull();
  });
  it('un único candidato real y volando → elegido; varios → ninguno; ESTIMATED → ninguno; en tierra → ninguno', () => {
    const c = normalizeFlight(EK);
    expect(discoverPick([c], 'EK2518', { airports, nowMs: NOW }).chosen?.fr24Id).toBe('424c145f');
    expect(discoverPick([c, { ...c, fr24Id: '424c9999' }], 'EK2518', { airports, nowMs: NOW })).toEqual({ reason: 'varios', count: 2 });
    expect(discoverPick([{ ...c, source: 'ESTIMATED' }], 'EK2518', { airports, nowMs: NOW })).toEqual({ reason: 'estimada' });
    expect(discoverPick([{ ...c, alt: 0, gspeed: 12 }], 'EK2518', { airports, nowMs: NOW })).toEqual({ reason: 'no-en-vuelo' });
    expect(discoverPick([{ ...c, flightNumber: 'EK2519' }], 'EK2518', { airports, nowMs: NOW })).toEqual({ reason: 'no-aparece' });
    // Ya descubierto: entre varios, solo vale el suyo.
    expect(discoverPick([{ ...c, fr24Id: '424c9999' }, c], 'EK2518', { airports, nowMs: NOW, known: '424c145f' }).chosen?.fr24Id).toBe('424c145f');
  });
  it('solo la fecha de hoy se descubre en vivo; el cierre, 1 h después de la ETA', () => {
    expect(discoveryLive(DATE, NOW)).toBe(true);
    expect(discoveryLive('2026-10-25', NOW)).toBe(false);
    expect(fr24HistoryDue({ eta: EK.eta }, Date.parse('2026-10-26T21:09:06Z'))).toBe(false);
    expect(fr24HistoryDue({ eta: EK.eta }, Date.parse('2026-10-26T21:09:08Z'))).toBe(true);
  });
});

describe('/discover-fr24 y /radar-fr24', () => {
  it('EK2518: ni Aena ni AeroDataBox → FR24 lo encuentra (TEV → DXB, A380, A6-EET) con UNA consulta; su radar sale de la misma caché', async () => {
    const { discover, radar, f, state, store } = setup();
    const r = await discover();
    expect(r).toMatchObject({ state: 'found', key: KEY, number: 'EK2518', fr24Id: '424c145f', reg: 'A6-EET', type: 'A388', operatingAs: 'UAE',
      eta: '2026-10-26T20:09:07.000Z', origin: { iata: 'TEV', icao: 'LETL', city: 'Teruel' }, destination: { iata: 'DXB', icao: 'OMDB' } });
    expect(f.lookups()).toEqual(['https://fr24api.flightradar24.com/api/live/flight-positions/full?flights=EK2518&limit=5']);
    const live = await radar(NOW + 2000);
    expect(live).toMatchObject({ state: 'volando', source: 'fr24', fr24Id: '424c145f', altFt: 32325, kmh: 911, lat: 39.333, lon: 0.4174, reg: 'A6-EET' });
    expect(f.lookups()).toHaveLength(1); // el radar no vuelve a pagar: misma caché de 40 s por número
    expect(state.fr24Stats).toMatchObject({ requests: 1, discoverFound: 1 });
    await state.historyWrites;
    expect(store.files.get('fr24/discover-EK2518_2026-10-26.json').data).toMatchObject({ fr24Id: '424c145f', key: KEY });
    expect(JSON.stringify(r) + JSON.stringify(live)).not.toContain(TOKEN);
  });
  it('seguimiento: el radar de la ficha cada 45 s es 1 consulta a FR24 por ciclo (la del /radar de siempre), nunca un sondeo aparte', async () => {
    const { discover, radar, f } = setup();
    await discover();
    for (let i = 1; i <= 4; i++) await radar(NOW + i * 45000);
    expect(f.lookups()).toHaveLength(5); // 1 del descubrimiento + 1 por cada ciclo de 45 s (caché de 40 s)
    await radar(NOW + 4 * 45000 + 5000); // otro usuario o «Actualizar» dentro de la caché: 0
    expect(f.lookups()).toHaveLength(5);
  });
  it('varios EK2518 a la vez → «multiple», nada recordado y su radar no consulta', async () => {
    const { discover, radar, f, state } = setup({ f: fake({ positions: () => res(200, { data: [EK, { ...EK, fr24_id: '424c9999', reg: 'A6-EEU' }] }) }) });
    expect(await discover()).toMatchObject({ state: 'multiple', count: 2 });
    expect(state.fr24Discovered?.size ?? 0).toBe(0);
    expect(await radar()).toMatchObject({ state: 'no-aplica' });
    expect(f.lookups()).toHaveLength(1);
  });
  it('posición ESTIMATED → «estimated»: no se afirma un vuelo real', async () => {
    const { discover } = setup({ f: fake({ positions: () => res(200, { data: [{ ...EK, source: 'ESTIMATED' }] }) }) });
    expect(await discover()).toMatchObject({ state: 'estimated' });
  });
  it.each([[401, 'autorizacion'], [403, 'autorizacion'], [429, 'limite'], [503, 'servidor']])('FR24 %i → «unavailable» (%s), sin ficha ni error', async (status, reason) => {
    const { discover, state } = setup({ f: fake({ positions: () => res(status, {}, { 'retry-after': '30' }) }) });
    const r = await discover();
    expect(r).toMatchObject({ state: 'unavailable', reason });
    expect(state.fr24Discovered?.size ?? 0).toBe(0);
  });
  it('fecha que no es hoy, sin token o número no válido → ninguna consulta a FR24', async () => {
    const { discover, f } = setup();
    expect((await discover(NOW, 'EK2518', '2026-10-25')).state).toBe('not-found');
    expect((await discover(NOW, 'EK2518', '2026-10-30')).state).toBe('no-aplica');
    const noToken = await fr24DiscoverResponse(createState(), `/discover-fr24/EK2518/${DATE}.json`, { fetchFn: f.fetchFn, nowMs: NOW, airports, env: {} });
    expect(JSON.parse(noToken.body).state).toBe('no-aplica');
    expect(f.calls).toHaveLength(0);
  });
  it('aterriza y deja de aparecer: la ficha sigue («known») y 1 h después de la ETA se cierra con Flight Summary por su fr24Id (una vez)', async () => {
    let gone = false;
    const { discover, f, store, state } = setup({ f: fake({ positions: () => res(200, { data: gone ? [] : [EK] }) }) });
    await discover();
    gone = true;
    const later = Date.parse('2026-10-26T20:30:00Z');
    expect(await discover(later)).toMatchObject({ state: 'known', fr24Id: '424c145f', key: KEY });
    expect(f.summaries()).toHaveLength(0); // aún no toca cerrarlo: nunca se da por aterrizado por la hora
    const due = Date.parse('2026-10-26T21:15:00Z');
    const closed = await discover(due);
    expect(closed).toMatchObject({ state: 'known', history: { state: 'landed', takeoff: '2026-10-26T12:41:10Z', landed: '2026-10-26T20:02:44Z' } });
    const q = new URL(f.summaries()[0]).searchParams;
    expect(q.get('flights')).toBe('EK2518');
    expect(q.get('routes')).toBe('LETL-OMDB');
    await discover(due + 60000);
    await discover(Date.parse('2026-10-27T09:00:00Z'), 'EK2518', DATE); // al día siguiente, la misma ficha
    expect(f.summaries()).toHaveLength(1); // terminado: guardado, no se vuelve a pagar
    expect(store.files.get('fr24/discover-EK2518_2026-10-26-cierre.json').data).toMatchObject({ state: 'landed' });
    expect(state.fr24Stats).toMatchObject({ historyRequests: 1, historyLanded: 1, historyCredits: 2 });
  });
  it('Flight Summary con otro fr24Id (otro avión con ese número) → no se cierra como aterrizado', async () => {
    let gone = false;
    const { discover } = setup({ f: fake({ positions: () => res(200, { data: gone ? [] : [EK] }), summary: () => res(200, { data: [{ ...SUMMARY, fr24_id: '42400000' }] }) }) });
    await discover();
    gone = true;
    expect(await discover(Date.parse('2026-10-26T21:15:00Z'))).toMatchObject({ state: 'known', history: { state: 'not-found' } });
  });
  it('tras reiniciar Render, el vuelo descubierto sigue en la rama data', async () => {
    const store = createMemoryStore();
    const first = setup({ store });
    await first.discover();
    await first.state.historyWrites;
    const again = setup({ store, f: fake({ positions: () => res(200, { data: [] }) }) });
    expect(await again.discover(NOW + 60000)).toMatchObject({ state: 'known', fr24Id: '424c145f' });
    expect(await again.radar(NOW + 60000)).toMatchObject({ source: 'fr24' }); // su radar sigue funcionando
  });
  it('/radar-fr24 con una clave que no es la del vuelo descubierto → «no-aplica» sin consultar', async () => {
    const { discover, radar, f } = setup();
    await discover();
    expect(await radar(NOW, fr24Key('EK2518', DATE, 'TEV', 'MAD'))).toMatchObject({ state: 'no-aplica' });
    expect(f.lookups()).toHaveLength(1);
  });
});
