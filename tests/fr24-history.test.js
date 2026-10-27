// Cierre de vuelos históricos con FR24 Flight Summary Light (server/fr24.mjs fr24Summary, server/fr24-history.mjs) y su
// fr24Id verificado para Flight Tracks (server/fr24-track.mjs). Datos con la forma real de DE2282 del 25/10/2026
// (FRA → ZNZ); FR24 siempre simulado y el token es falso.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createState, trackRoute } from '../server/live.mjs';
import { fr24Summary, normalizeSummary } from '../server/fr24.mjs';
import { fr24HistoryResponse, pickSummary, summaryOutcome } from '../server/fr24-history.mjs';
import { createAerodatabox, entryPath } from '../server/aerodatabox.mjs';
import { createMemoryStore } from '../server/adb-store.mjs';
import { adbPhysicalKey, historyDue, withFr24Landing } from '../js/adb.js';

const TOKEN = 'tok_FALSO_solo_para_pruebas_000000';
const env = { FR24_API_TOKEN: TOKEN };
const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });
const t = (iso, off) => ({ local: new Date(Date.parse(iso) + off * 60000).toISOString().slice(0, 16), utc: Date.parse(iso), off });
// Caché de AeroDataBox de DE2282 (25/10): «Departed», sin hora de llegada real.
const LEG = { number: 'DE2282', airline: 'Condor', callSign: 'CFG282', modeS: '3c7a4b', reg: 'D-ANRK', codeshareStatus: 'IsOperator', status: 'Departed',
  aircraft: 'Airbus A330', o: 'FRA', a: 'ZNZ', estMin: 549,
  dep: { sched: t('2026-10-25T18:50:00Z', 60), revised: t('2026-10-25T18:50:00Z', 60), runway: t('2026-10-25T19:19:00Z', 60) },
  arr: { sched: t('2026-10-26T04:00:00Z', 180), revised: null, predicted: t('2026-10-26T04:45:00Z', 180), runway: null } };
const ENTRY = { status: 'found', number: 'DE2282', date: '2026-10-25', fetchedAt: '2026-10-26T10:10:00.705Z', legs: [LEG] };
const KEY = adbPhysicalKey(ENTRY, LEG);
const PATH = `/history-adb/DE2282/2026-10-25.json?leg=${encodeURIComponent(KEY)}`;
const NOW = Date.parse('2026-10-26T13:00:00Z');
// Respuesta real de Flight Summary Light para DE2282 (el tramo FRA → ZNZ y el ZNZ → MBA del día siguiente, mismo número).
const RAW = { fr24_id: '4249d4dd', flight: 'DE2282', callsign: 'CFG282', operating_as: 'CFG', painted_as: 'CFG', type: 'A339', reg: 'D-ANRK',
  orig_icao: 'EDDF', datetime_takeoff: '2026-10-25T19:18:36Z', dest_icao: 'HTZA', dest_icao_actual: 'HTZA', datetime_landed: '2026-10-26T04:07:00Z',
  hex: '3C7A4B', first_seen: '2026-10-25T19:00:29Z', last_seen: '2026-10-26T04:20:17Z', flight_ended: true };
const NEXT_LEG = { ...RAW, fr24_id: '424b4294', orig_icao: 'HTZA', dest_icao: 'HKMO', dest_icao_actual: 'HKMO', datetime_takeoff: '2026-10-26T05:57:42Z',
  datetime_landed: '2026-10-26T06:30:33Z', first_seen: '2026-10-26T05:34:14Z' };
const norm = over => normalizeSummary({ ...RAW, ...over });
const PICK = { number: 'DE2282', origIcao: 'EDDF', destIcao: 'HTZA', depMs: LEG.dep.sched.utc, reg: 'D-ANRK', modeS: '3c7a4b' };

function fake({ summary = () => res(200, { data: [RAW] }, { 'x-fr24-credits-consumed': '2' }), tracks = () => res(200, { fr24_id: '4249d4dd',
  tracks: [{ timestamp: '2026-10-25T19:20:00Z', lat: 50.05, lon: 8.57, source: 'ADSB' }, { timestamp: '2026-10-26T04:05:00Z', lat: -6.22, lon: 39.22, source: 'ADSB' }] }) } = {}) {
  const calls = [];
  const fetchFn = vi.fn(async (url, opts) => {
    const u = String(url);
    calls.push(u);
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    if (u.includes('/flight-summary/light?')) return summary(u);
    if (u.includes('/flight-tracks?')) return tracks(u);
    throw new Error(`URL inesperada ${u}`);
  });
  return { fetchFn, calls, summaries: () => calls.filter(u => u.includes('flight-summary')), trackCalls: () => calls.filter(u => u.includes('flight-tracks')) };
}
function setup({ store = createMemoryStore({ [entryPath('DE2282', '2026-10-25')]: ENTRY }), f = fake() } = {}) {
  const state = createState();
  state.adb = createAerodatabox({ key: null, store });
  state.historyStore = store;
  const history = (path = PATH, nowMs = NOW) => fr24HistoryResponse(state, path, { fetchFn: f.fetchFn, nowMs, airports, env }).then(r => JSON.parse(r.body));
  const track = (nowMs = NOW, load = false) => trackRoute(state, `/track-adb/DE2282/2026-10-25.json?leg=${encodeURIComponent(KEY)}${load ? '&load=1' : ''}`,
    { fetchFn: f.fetchFn, nowMs, airports, env })
    .then(r => JSON.parse(r.body));
  return { state, store, f, history, track };
}

describe('Flight Summary Light: consulta, normalización y errores', () => {
  it('una llamada con número, ruta OACI y ventana UTC; campos cerrados (sin cuerpos crudos ni token)', async () => {
    const f = fake({ summary: () => res(200, { data: [{ ...RAW, extra: 'x', note: TOKEN }] }, { 'x-fr24-credits-consumed': '2' }) });
    const r = await fr24Summary({ flight: 'DE2282', origIcao: 'EDDF', destIcao: 'HTZA', fromMs: Date.parse('2026-10-25T15:50:00Z'), toMs: Date.parse('2026-10-26T06:50:00Z') },
      { fetchFn: f.fetchFn, env });
    expect(f.calls).toEqual(['https://fr24api.flightradar24.com/api/flight-summary/light?flights=DE2282&routes=EDDF-HTZA&flight_datetime_from=2026-10-25T15%3A50%3A00Z&flight_datetime_to=2026-10-26T06%3A50%3A00Z&limit=10']);
    expect(r).toEqual({ state: 'ok', credits: 2, flights: [{ fr24Id: '4249d4dd', flight: 'DE2282', callsign: 'CFG282', operatingAs: 'CFG', type: 'A339', reg: 'D-ANRK',
      hex: '3C7A4B', origIcao: 'EDDF', destIcao: 'HTZA', destIcaoActual: 'HTZA', takeoff: '2026-10-25T19:18:36Z', landed: '2026-10-26T04:07:00Z',
      firstSeen: '2026-10-25T19:00:29Z', lastSeen: '2026-10-26T04:20:17Z', ended: true }] });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(norm({ datetime_landed: '26/10 04:07', dest_icao: 'ZNZ', flight_ended: 'true' })).toMatchObject({ landed: null, destIcao: null, ended: false });
  });
  it('401, 403, 429 (con Retry-After) y 5xx → no disponible, una sola llamada (sin reintentos)', async () => {
    for (const [status, reason] of [[401, 'autorizacion'], [403, 'autorizacion'], [429, 'limite'], [500, 'servidor'], [503, 'servidor']]) {
      const f = fake({ summary: () => res(status, {}, { 'retry-after': '30' }) });
      const r = await fr24Summary({ flight: 'DE2282', origIcao: 'EDDF', destIcao: 'HTZA', fromMs: 0, toMs: 1 }, { fetchFn: f.fetchFn, env });
      expect(r).toMatchObject({ state: 'unavailable', reason, httpStatus: status, ...(status === 429 ? { retryAfterSec: 30 } : {}) });
      expect(f.calls).toHaveLength(1);
    }
  });
});

describe('identificación del vuelo físico: exactamente un candidato compatible', () => {
  it('número, ruta OACI, despegue en la ventana de su salida y matrícula/transpondedor coherentes', () => {
    expect(pickSummary([norm({}), normalizeSummary(NEXT_LEG)], PICK).fr24Id).toBe('4249d4dd'); // mismo número, otro tramo: fuera
    expect(pickSummary([norm({ flight: 'DE2283' })], PICK)).toBeNull();
    expect(pickSummary([norm({ datetime_takeoff: '2026-10-27T19:18:36Z' })], PICK)).toBeNull(); // el del día siguiente
    expect(pickSummary([norm({ reg: 'D-ANRG' })], PICK)).toBeNull(); // otra matrícula
    expect(pickSummary([norm({ hex: '3C7A47' })], PICK)).toBeNull(); // otro transpondedor
  });
  it('dos candidatos compatibles → ninguno', () => {
    expect(pickSummary([norm({}), norm({ fr24_id: '4249d4de', datetime_takeoff: '2026-10-25T21:00:00Z' })], PICK)).toEqual({ multiple: 2 });
  });
  it('solo «aterrizado» con flight_ended, despegue y aterrizaje coherentes; desviado aparte; nunca por la hora', () => {
    expect(summaryOutcome(norm({}), 'HTZA')).toMatchObject({ state: 'landed', fr24Id: '4249d4dd', takeoff: '2026-10-25T19:18:36Z', landed: '2026-10-26T04:07:00Z' });
    expect(summaryOutcome(norm({ flight_ended: false }), 'HTZA')).toEqual({ state: 'in-progress' });
    expect(summaryOutcome(norm({ datetime_landed: null }), 'HTZA')).toEqual({ state: 'in-progress' });
    expect(summaryOutcome(norm({ dest_icao_actual: 'HKMO' }), 'HTZA')).toMatchObject({ state: 'diverted', destIcaoActual: 'HKMO' });
  });
});

describe('/history-adb: cuándo, caché persistente y llamadas', () => {
  it('cerrado por FR24: 1 llamada, guardado en la rama data; repetir, simultáneas y tras reiniciar Render → 0 llamadas más', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.history(), s.history()]);
    expect(a).toMatchObject({ state: 'landed', fr24Id: '4249d4dd', takeoff: '2026-10-25T19:18:36Z', landed: '2026-10-26T04:07:00Z', type: 'A339', reg: 'D-ANRK', source: 'fr24' });
    expect(b.state).toBe('landed');
    await s.history(undefined, NOW + 86400000);
    expect(s.f.summaries()).toHaveLength(1);
    expect([...s.store.files.keys()].filter(k => k.startsWith('fr24/'))).toEqual(['fr24/DE2282_2026-10-25_FRA_ZNZ_2026-10-25T1850Z.json']);
    const again = setup({ store: s.store, f: fake() }); // Render reiniciado: misma rama data, memoria vacía
    expect((await again.history()).state).toBe('landed');
    expect(again.f.calls).toEqual([]);
    expect(s.state.fr24Stats).toMatchObject({ historyRequests: 1, historyLanded: 1, historyCredits: 2 });
  });
  it('antes de 1 h tras la llegada más tardía conocida, cancelado o sin token → no-aplica sin llamar', async () => {
    const s = setup();
    expect((await s.history(PATH, LEG.arr.predicted.utc + 59 * 60000)).state).toBe('no-aplica');
    expect(historyDue({ ...LEG, status: 'Canceled' }, NOW)).toBe(false);
    expect(JSON.parse((await fr24HistoryResponse(s.state, PATH, { fetchFn: s.f.fetchFn, nowMs: NOW, airports, env: {} })).body).state).toBe('no-aplica');
    expect(s.f.calls).toEqual([]);
  });
  it('no encontrado o varios: no se afirma nada, se recuerda 30 min (sin guardar) y después se puede volver a preguntar', async () => {
    const s = setup({ f: fake({ summary: () => res(200, { data: [] }) }) });
    expect((await s.history()).state).toBe('not-found');
    expect((await s.history(PATH, NOW + 29 * 60000)).state).toBe('not-found');
    expect(s.f.summaries()).toHaveLength(1);
    await s.history(PATH, NOW + 31 * 60000);
    expect(s.f.summaries()).toHaveLength(2);
    expect([...s.store.files.keys()].some(k => k.startsWith('fr24/'))).toBe(false);
    const two = setup({ f: fake({ summary: () => res(200, { data: [RAW, { ...RAW, fr24_id: '4249d4de', datetime_takeoff: '2026-10-25T21:00:00Z' }] }) }) });
    expect((await two.history()).state).toBe('multiple');
  });
  it('FR24 falla (429): no disponible, sin guardar; la caché de AeroDataBox no se toca', async () => {
    const s = setup({ f: fake({ summary: () => res(429, {}) }) });
    expect(await s.history()).toMatchObject({ state: 'unavailable', reason: 'limite' });
    expect(s.store.files.get(entryPath('DE2282', '2026-10-25')).data).toEqual(ENTRY);
    expect([...s.store.files.keys()].some(k => k.startsWith('fr24/'))).toBe(false);
  });
});

describe('Flight Tracks con el fr24Id que verificó el histórico: solo bajo demanda (~40 créditos)', () => {
  it('abrir la ficha no la descarga; pedirla (load=1) hace 1 llamada y la guarda; reabrir y tras reiniciar → 0 llamadas', async () => {
    const s = setup();
    expect((await s.track()).state).toBe('no-aplica'); // nada verificado todavía: ni siquiera se llama
    await s.history();
    expect((await s.track()).state).toBe('on-demand'); // abrir la ficha histórica: sin Flight Tracks
    expect(s.f.trackCalls()).toEqual([]);
    const [a, b] = await Promise.all([s.track(NOW, true), s.track(NOW, true)]); // dos usuarios a la vez
    expect(a).toMatchObject({ state: 'found', fr24Id: '4249d4dd', points: [[50.05, 8.57], [-6.22, 39.22]] });
    expect(b.state).toBe('found');
    expect(s.f.trackCalls()).toEqual(['https://fr24api.flightradar24.com/api/flight-tracks?flight_id=4249d4dd']);
    const again = setup({ store: s.store, f: fake() }); // Render reiniciado: misma rama data
    await again.history();
    expect((await again.track()).state).toBe('found'); // ya guardada: también sin pedirla
    expect(again.f.calls).toEqual([]);
    again.state.fr24Assoc = new Map([[KEY, { fr24Id: 'otro1234', at: NOW }]]);
    expect((await again.track(NOW, true)).state).toBe('no-aplica'); // el radar asoció otro avión: ninguno
  });
});

describe('estela guardada con altitud y estelas guardadas antes (sin ella)', () => {
  const withAlt = () => res(200, { fr24_id: '4249d4dd', tracks: [{ timestamp: '2026-10-25T19:20:00Z', lat: 50.05, lon: 8.57, alt: 1200, source: 'ADSB' },
    { timestamp: '2026-10-26T04:05:00Z', lat: -6.22, lon: 39.22, alt: 900, source: 'ADSB' }] });
  it('la estela nueva se guarda con su altitud (alts) y se sirve con ella', async () => {
    const s = setup({ f: fake({ tracks: withAlt }) });
    await s.history();
    expect(await s.track(NOW, true)).toMatchObject({ state: 'found', alts: [1200, 900] });
    const saved = [...s.store.files].find(([k]) => k === 'fr24/track-4249d4dd.json')[1].data;
    expect(saved).toMatchObject({ points: [[50.05, 8.57], [-6.22, 39.22]], times: [Date.parse('2026-10-25T19:20:00Z') / 1000, Date.parse('2026-10-26T04:05:00Z') / 1000], alts: [1200, 900] });
  });
  it('una guardada antes de conservar la altitud: se sirve igual (sin alts), sin volver a descargarla', async () => {
    const store = createMemoryStore({ [entryPath('DE2282', '2026-10-25')]: ENTRY,
      'fr24/track-4249d4dd.json': { state: 'found', fr24Id: '4249d4dd', points: [[50.05, 8.57], [-6.22, 39.22]], times: [1, 2], lastAt: '2026-10-26T04:05:00.000Z' } });
    const s = setup({ store });
    await s.history();
    const r = await s.track(NOW, true);
    expect(r).toMatchObject({ state: 'found', points: [[50.05, 8.57], [-6.22, 39.22]], times: [1, 2] });
    expect(r).not.toHaveProperty('alts');
    expect(s.f.trackCalls()).toEqual([]); // 0 créditos: no se descarga otra vez para colorearla
  });
});

describe('número del vuelo para FR24: el del tramo de AeroDataBox, nunca una conversión inventada', () => {
  // AFR132 (búsqueda con código OACI): AeroDataBox da para ESE vuelo number AF132, que es como lo indexa FR24.
  const AF = { ...LEG, number: 'AF132', callSign: 'AFR132', reg: null, modeS: null, o: 'CDG', a: 'LOS',
    dep: { sched: t('2026-10-20T14:05:00Z', 120), revised: null, runway: null }, arr: { sched: t('2026-10-20T20:30:00Z', 60), revised: null, predicted: null, runway: null } };
  const afSummary = { ...RAW, fr24_id: '42301234', flight: 'AF132', callsign: 'AFR132', operating_as: 'AFR', orig_icao: 'LFPG', dest_icao: 'DNMM', dest_icao_actual: 'DNMM',
    reg: 'F-HZUA', hex: '39CF00', datetime_takeoff: '2026-10-20T14:31:00Z', datetime_landed: '2026-10-20T20:12:00Z', first_seen: '2026-10-20T14:10:00Z' };
  const run = async leg => {
    const entry = { ...ENTRY, number: 'AFR132', date: '2026-10-20', legs: [leg] };
    const s = setup({ store: createMemoryStore({ [entryPath('AFR132', '2026-10-20')]: entry }),
      f: fake({ summary: u => res(200, { data: new URL(u).searchParams.get('flights') === 'AF132' ? [afSummary] : [] }) }) });
    const r = await s.history(`/history-adb/AFR132/2026-10-20.json?leg=${encodeURIComponent(adbPhysicalKey(entry, leg))}`, NOW);
    return { r, flights: s.f.summaries().map(u => new URL(u).searchParams.get('flights')) };
  };
  it('AFR132 buscado: se pregunta por AF132 (el número que dio AeroDataBox) y se cierra', async () => {
    expect(await run(AF)).toMatchObject({ flights: ['AF132'], r: { state: 'landed', fr24Id: '42301234' } });
  });
  it('si el tramo no trae un número válido, el buscado tal cual: nada de convertir AFR → AF', async () => {
    expect(await run({ ...AF, number: '' })).toEqual({ flights: ['AFR132'], r: expect.objectContaining({ state: 'not-found' }) });
  });
});

describe('app: tramo de AeroDataBox cerrado por Flightradar24', () => {
  it('las horas de FR24 pasan a ser las de pista (con el desfase de cada aeropuerto), con la procedencia marcada', () => {
    const leg = withFr24Landing(LEG, { state: 'landed', fr24Id: '4249d4dd', takeoff: '2026-10-25T19:18:36Z', landed: '2026-10-26T04:07:00Z', type: 'A339', reg: 'D-ANRK' });
    expect(leg).toMatchObject({ status: 'Arrived', closedBy: 'fr24', fr24: { fr24Id: '4249d4dd', type: 'A339', reg: 'D-ANRK' },
      dep: { runway: { local: '2026-10-25T20:18', off: 60 } }, arr: { runway: { local: '2026-10-26T07:07', off: 180 } } });
    expect(withFr24Landing(LEG, { state: 'in-progress' })).toBe(LEG);
    expect(withFr24Landing(LEG, null)).toBe(LEG);
  });
});
