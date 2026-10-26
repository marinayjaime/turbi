// Radar con Flightradar24 (server/fr24-radar.mjs): con FR24_API_TOKEN configurado, /radar/AL/N.json y
// /radar-adb/<vuelo>/<fecha>.json usan SOLO FR24 (ni adsb.lol, ni sus trazas, ni ADSBDB, ni VRS). FR24 siempre simulado;
// el token de estas pruebas es falso y se comprueba que no sale en ninguna respuesta.
// Principio: falso negativo antes que avión incorrecto; una posición estimada nunca se pinta como real.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createState, handle, radarRoute } from '../server/live.mjs';
import { fr24Pick, fr24Result } from '../server/fr24-radar.mjs';
import { adsbLimiter } from '../server/adsb.mjs';
import { createAerodatabox, normalizeFlights, entryPath } from '../server/aerodatabox.mjs';
import { createMemoryStore } from '../server/adb-store.mjs';
import { adbPhysicalKey, adbRadarGate } from '../js/adb.js';
import { physicalFlightKey } from '../js/physical-flight.js';
import { withRadar } from '../js/radar.js';
import { planeOnMap } from '../js/card-model.js';
import { flightStatus } from '../js/schedule.js';
import { flightCardHtml } from '../js/ui.js';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });

const TOKEN = 'tok_FALSO_solo_para_pruebas_000000';
const env = { FR24_API_TOKEN: TOKEN };
const FR24 = 'https://fr24api.flightradar24.com/';
const airports = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const pos = iata => [airports[iata][2], airports[iata][3]];
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });

// IB403 MAD → LHR del 21/10/2026: salida 10:00 (ed 10:05) en Madrid = 08:00Z / 08:05Z. Aena: «Puerta cerrada».
const T = hhmm => Date.parse(`2026-10-21T${hhmm}:00Z`);
const NOW = T('08:40');
const ib403 = over => ({ al: 'IB', icao: 'IBE', n: '403', d: '2026-10-21', o: 'MAD', a: 'LHR', sd: '10:00', ed: '2026-10-21T10:05',
  sa: null, ea: null, g: 'J40', st: 'CER', std: 'CER', sta: null, ac: 'A21N', ...over });
const KEY = physicalFlightKey(ib403());
const PATH = `/radar/IB/403.json?leg=${encodeURIComponent(KEY)}`;
// Un avión de FR24 (campos crudos de la API) en el aire entre MAD y LHR, posición de hace 5 s.
const item = (over = {}, nowMs = NOW) => ({ fr24_id: '3c4d5e6f', flight: 'IB403', callsign: 'IBE403', lat: 44.01234, lon: -2.54321, track: 12,
  alt: 13500, gspeed: 300, vspeed: 1500, squawk: '1000', timestamp: new Date(nowMs - 5000).toISOString(), source: 'ADSB', hex: '3423C1',
  type: 'A21N', reg: 'EC-NIA', painted_as: 'IBE', operating_as: 'IBE', orig_iata: 'MAD', orig_icao: 'LEMD', dest_iata: 'LHR',
  dest_icao: 'EGLL', eta: '2026-10-21T10:15:00Z', ...over });

// FR24 simulado: answer(flight, n) → array de vuelos | { status } | Error. Cualquier otra URL se registra (y no debería haberla).
function fake(answer = () => [item()]) {
  const calls = [];
  const fetchFn = vi.fn(async (url, opts) => {
    calls.push(String(url));
    if (!String(url).startsWith(FR24)) return res(200, { ac: [] });
    const flight = new URL(url).searchParams.get('flights');
    const a = await answer(flight, calls.filter(u => u.startsWith(FR24)).length, opts);
    if (a instanceof Error) throw a;
    if (a && !Array.isArray(a)) return res(a.status, a.body ?? { message: `error ${TOKEN}` }, a.headers);
    return res(200, { data: a });
  });
  return { fetchFn, calls, fr24: () => calls.filter(u => u.startsWith(FR24)), others: () => calls.filter(u => !u.startsWith(FR24)) };
}
function server(legs = [ib403()], answer) {
  const f = fake(answer);
  const state = createState();
  state.legs = legs;
  const raw = (t = NOW, path = PATH) => radarRoute(state, path, { fetchFn: f.fetchFn, nowMs: t, airports, env });
  const ask = (t, path) => raw(t, path).then(r => { expect(r.body).not.toContain(TOKEN); return JSON.parse(r.body); });
  return { ...f, state, ask, raw };
}

describe('1) Aena «Puerta cerrada» (CER) y FR24 lo ve en el aire', () => {
  it('/radar da «volando» con la telemetría de FR24 y la ficha dice «Volando»', async () => {
    const s = server();
    const r = await s.ask();
    expect(r).toMatchObject({ state: 'volando', source: 'fr24', match: 'fr24', fr24Id: '3c4d5e6f', callsign: 'IBE403', hex: '3423C1',
      reg: 'EC-NIA', type: 'A21N', altFt: 13500, departureConfirmed: false });
    expect(s.fr24()).toEqual([`${FR24}api/live/flight-positions/full?flights=IB403&limit=5`]);
    const card = { al: 'IB', title: 'IB 403', route: 'x', tabs: [], status: flightStatus(ib403()), o: 'MAD', a: 'LHR', duration: 140,
      dep: { date: '2026-10-21', time: '10:05', est: null, late: false, terminal: null, gate: 'J40' }, arr: null, aircraft: null, updatedAgo: 'hace 2 min', stale: false };
    expect(card.status.text).toBe('Puerta cerrada');
    const shown = withRadar(card, r);
    expect(shown.status).toMatchObject({ text: 'Volando', flying: true });
    expect(flightCardHtml(shown)).toContain('class="card now telemetry"');
  });
});

describe('2) vuelo de AeroDataBox sin modeS ni indicativo', () => {
  // GA89 AMS → CGK: salida 12:35 (+02:00) = 10:35Z; ahora 3 h después; AeroDataBox «EnRoute» consultado hace 5 min.
  const ADB_NOW = Date.parse('2026-09-26T13:35Z');
  const raw = (over = {}) => ({ number: 'GA 89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' },
    departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: '2026-09-26 10:35Z', local: '2026-09-26 12:35+02:00' } },
    arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: '2026-09-27 03:00Z', local: '2026-09-27 10:00+07:00' } },
    aircraft: { model: 'Boeing 777' }, ...over });
  const entry = { status: 'found', source: 'aerodatabox', number: 'GA89', date: '2026-09-26', fetchedAt: new Date(ADB_NOW - 5 * 60000).toISOString(), legs: normalizeFlights([raw()]) };
  const ga = (over = {}) => item({ fr24_id: '4a4a4a4a', flight: 'GA89', callsign: 'GIA89', orig_iata: 'AMS', dest_iata: 'CGK', lat: 45.1, lon: 40.2,
    alt: 37000, gspeed: 490, vspeed: 0, hex: '8A04C1', reg: 'PK-GIK', type: 'B77W', ...over }, ADB_NOW);
  function render(answer = () => [ga()]) {
    const f = fake(answer);
    const state = createState();
    const adbApi = vi.fn(async () => { throw new Error('AeroDataBox no debe consultarse'); });
    state.adb = createAerodatabox({ key: 'k', store: createMemoryStore({ [entryPath(entry.number, entry.date)]: entry }), fetchFn: adbApi, now: () => ADB_NOW });
    const leg = adbPhysicalKey(entry, entry.legs[0]);
    const ask = (q = '', t = ADB_NOW) => radarRoute(state, `/radar-adb/GA89/2026-09-26.json?leg=${encodeURIComponent(leg)}${q}`, { fetchFn: f.fetchFn, nowMs: t, airports, env })
      .then(r => { expect(r.body).not.toContain(TOKEN); return JSON.parse(r.body); });
    return { ...f, state, adbApi, ask };
  }
  it('la puerta de AeroDataBox no exige identificador en el flujo FR24 (y sí en el antiguo)', () => {
    const [l] = entry.legs;
    expect([l.modeS, l.callSign]).toEqual([null, null]);
    expect(adbRadarGate(l, entry, ADB_NOW, {}).mode).toBe('none');
    expect(adbRadarGate(l, entry, ADB_NOW, { requireIdentifier: true })).toMatchObject({ mode: 'none', reason: 'sin-identificador' });
    expect(adbRadarGate(l, entry, ADB_NOW, { requireIdentifier: false }).mode).toBe('direct');
  });
  it('FR24 lo encuentra por su número comercial: volando · 1 consulta a FR24, 0 a AeroDataBox', async () => {
    const r = render();
    expect(await r.ask()).toMatchObject({ state: 'volando', source: 'fr24', fr24Id: '4a4a4a4a', callsign: 'GIA89', hex: '8A04C1', altFt: 37000 });
    expect(r.fr24()).toEqual([`${FR24}api/live/flight-positions/full?flights=GA89&limit=5`]);
    expect(r.others()).toEqual([]);
    expect(r.adbApi).not.toHaveBeenCalled();
  });
  it('otra ruta → sin-datos; caché de 60 s por vuelo físico y sondeo incluido', async () => {
    const r = render(() => [ga({ orig_iata: 'CGK', dest_iata: 'AMS' })]);
    expect(await r.ask()).toMatchObject({ state: 'sin-datos' });
    await r.ask('&poll=1', ADB_NOW + 30000);
    expect(r.fr24()).toHaveLength(1);
    await r.ask('', ADB_NOW + 61000);
    expect(r.fr24()).toHaveLength(2);
  });
});

describe('3–7) selección del candidato', () => {
  const c = (id, o = 'MAD', a = 'LHR') => ({ fr24Id: id, originIata: o, destinationIata: a });
  it('3) candidato único con origen y destino correctos → se acepta', () => {
    expect(fr24Pick([c('a')], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: { fr24Id: 'a' }, compatible: 1 });
  });
  it('4) candidato de otra ruta → se rechaza (otra-ruta); sin resultados → no-aparece', () => {
    expect(fr24Pick([c('a', 'LHR', 'MAD')], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: null, reason: 'otra-ruta' });
    expect(fr24Pick([c('a', null, null)], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: null, reason: 'otra-ruta' });
    expect(fr24Pick([], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: null, reason: 'no-aparece' });
  });
  it('5) varios candidatos y solo uno con la ruta correcta → ese', () => {
    expect(fr24Pick([c('x', 'LHR', 'MAD'), c('a'), c('y', 'BCN', 'LHR')], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: { fr24Id: 'a' }, compatible: 1 });
  });
  it('6) varios compatibles con la misma ruta → no se elige ninguno', () => {
    expect(fr24Pick([c('a'), c('b')], { o: 'MAD', a: 'LHR' })).toMatchObject({ chosen: null, reason: 'varios-compatibles', compatible: 2 });
  });
  it('7) fr24Id asociado antes entre varios compatibles → se mantiene', () => {
    expect(fr24Pick([c('a'), c('b')], { o: 'MAD', a: 'LHR', associated: 'b' })).toMatchObject({ chosen: { fr24Id: 'b' }, changed: false });
  });
  it('7b) el asociado ya no aparece y hay UN compatible con otro fr24Id → se acepta como cambio; con varios, no', () => {
    expect(fr24Pick([c('n')], { o: 'MAD', a: 'LHR', associated: 'a' })).toMatchObject({ chosen: { fr24Id: 'n' }, changed: true });
    expect(fr24Pick([c('n'), c('m')], { o: 'MAD', a: 'LHR', associated: 'a' })).toMatchObject({ chosen: null, reason: 'varios-compatibles' });
    // El asociado sigue en FR24 pero con otra ruta: no se cambia de avión por eso.
    expect(fr24Pick([c('a', 'LHR', 'MAD'), c('n')], { o: 'MAD', a: 'LHR', associated: 'a' })).toMatchObject({ chosen: null, reason: 'asociado-otra-ruta' });
  });
  it('por /radar: dos compatibles → sin-datos; la asociación de una consulta anterior decide; cambio de fr24Id → fr24IdChanged', async () => {
    let answer = () => [item({ fr24_id: 'a1' })];
    const s = server([ib403()], (...x) => answer(...x));
    expect(await s.ask(NOW)).toMatchObject({ state: 'volando', fr24Id: 'a1' });
    expect(s.state.fr24Assoc.get(`phys|${KEY}`)).toMatchObject({ fr24Id: 'a1' });
    answer = () => [item({ fr24_id: 'b2', lat: 50 }), item({ fr24_id: 'a1' }, NOW + 61000)];
    const kept = await s.ask(NOW + 61000);
    expect(kept).toMatchObject({ state: 'volando', fr24Id: 'a1' });
    expect(kept).not.toHaveProperty('fr24IdChanged');
    answer = () => [item({ fr24_id: 'c3' }, NOW + 122000)];
    expect(await s.ask(NOW + 122000)).toMatchObject({ state: 'volando', fr24Id: 'c3', fr24IdChanged: true });
    expect(s.state.fr24Assoc.get(`phys|${KEY}`)).toMatchObject({ fr24Id: 'c3' });
    const fresh = server([ib403()], () => [item({ fr24_id: 'a1' }), item({ fr24_id: 'b2' })]);
    const amb = await fresh.ask(NOW);
    expect(amb.state).toBe('sin-datos');
    expect(amb).not.toHaveProperty('lat');
    expect(amb).not.toHaveProperty('fr24Id');
  });
  it('7c) un fr24Id asociado a OTRO vuelo físico (24 h) no vale para este: asociado-a-otro-vuelo', async () => {
    expect(fr24Pick([c('a')], { o: 'MAD', a: 'LHR', taken: new Set(['a']) })).toMatchObject({ chosen: null, reason: 'asociado-a-otro-vuelo', compatible: 0 });
    const s = server([ib403()]);
    s.state.fr24Assoc = new Map([['phys|2026-10-20|MAD|LHR|23:30', { fr24Id: '3c4d5e6f', at: NOW - 3600000 }]]);
    const r = await s.ask(NOW, `${PATH}&debug=1`);
    expect(r.state).toBe('sin-datos');
    expect(r).not.toHaveProperty('lat');
    expect(r.diagnostic.reason).toBe('asociado-a-otro-vuelo');
    // Pasadas 24 h, esa asociación ya no cuenta.
    s.state.fr24Assoc.set('phys|2026-10-20|MAD|LHR|23:30', { fr24Id: '3c4d5e6f', at: NOW - 25 * 3600000 });
    expect((await s.ask(NOW + 61000)).state).toBe('volando');
  });
  it('7d) otro tramo elegible con el mismo número y ruta (el de ayer, conservado): solo vale el ya asociado a este vuelo', async () => {
    const yesterday = ib403({ d: '2026-10-20', sd: '23:30', ed: '2026-10-20T23:40', st: 'BOR', std: 'BOR', sta: 'FLY' });
    expect(fr24Pick([c('a')], { o: 'MAD', a: 'LHR', exclusiveOnly: true })).toMatchObject({ chosen: null, reason: 'varios-tramos-misma-ruta' });
    expect(fr24Pick([c('a'), c('b')], { o: 'MAD', a: 'LHR', associated: 'b', exclusiveOnly: true })).toMatchObject({ chosen: { fr24Id: 'b' } });
    expect(fr24Pick([c('n')], { o: 'MAD', a: 'LHR', associated: 'a', exclusiveOnly: true })).toMatchObject({ chosen: null, reason: 'varios-tramos-misma-ruta' });
    const s = server([yesterday, ib403()]);
    const r = await s.ask(NOW, `${PATH}&debug=1`);
    expect(r.state).toBe('sin-datos');
    expect(r.diagnostic.reason).toBe('varios-tramos-misma-ruta');
    const assoc = server([yesterday, ib403()]);
    assoc.state.fr24Assoc = new Map([[`phys|${KEY}`, { fr24Id: '3c4d5e6f', at: NOW - 600000 }]]);
    expect(await assoc.ask(NOW)).toMatchObject({ state: 'volando', fr24Id: '3c4d5e6f' });
  });
  it('la asociación caduca a las 24 h (en memoria, sin persistencia)', async () => {
    const s = server([ib403()]);
    await s.ask(NOW);
    s.state.fr24Assoc.set('phys|viejo', { fr24Id: 'zz', at: NOW - 25 * 3600000 });
    await s.ask(NOW + 61000);
    expect(s.state.fr24Assoc.has('phys|viejo')).toBe(false);
  });
});

describe('8–13) posición, fuente y unidades', () => {
  const ctx = { dest: pos('LHR'), origin: pos('MAD'), depMs: T('08:05'), nowMs: NOW };
  const norm = over => {
    const i = item(over);
    return { fr24Id: i.fr24_id, callsign: i.callsign, lat: i.lat, lon: i.lon, track: i.track, alt: i.alt, gspeed: i.gspeed, vspeed: i.vspeed,
      timestamp: i.timestamp, source: i.source, hex: i.hex, type: i.type, reg: i.reg, originIata: i.orig_iata, destinationIata: i.dest_iata };
  };
  it('8) posición real reciente → lat/lon/posAgeS presentes (y remainingKm)', () => {
    const r = fr24Result(norm(), ctx);
    expect(r).toMatchObject({ state: 'volando', lat: 44.0123, lon: -2.5432, posAgeS: 5, seenS: 5, track: 12 });
    expect(r.remainingKm).toBeGreaterThan(700);
    expect(planeOnMap(r, NOW, NOW)).toEqual({ lat: 44.0123, lon: -2.5432, heading: 12, fresh: true });
  });
  // Ventana de 180 s (decisión del controlador, 21/10/2026; antes 60 s): la posición real sigue llegando y la app la pinta
  // quieta y atenuada como «última posición conocida» (planeOnMap fresh: false), nunca como medición nueva.
  it('9) posición de hace más de 60 s (90 s) → volando CON lat/lon/posAgeS; la app la pinta como última posición conocida', () => {
    const r = fr24Result(norm({ timestamp: new Date(NOW - 90000).toISOString() }), ctx);
    expect(r).toMatchObject({ state: 'volando', seenS: 90, posAgeS: 90, lat: 44.0123, lon: -2.5432 });
    expect(planeOnMap(r, NOW, NOW)).toEqual({ lat: 44.0123, lon: -2.5432, heading: 12, fresh: false });
    expect(fr24Result(norm({ timestamp: new Date(NOW - 180000).toISOString() }), ctx)).toMatchObject({ state: 'volando', posAgeS: 180 });
  });
  it('9c) señal de hace más de 180 s (181 s, 20 min) → sin-datos sin telemetría: no tapa a Aena', () => {
    for (const ago of [181000, 1200000]) {
      const r = fr24Result(norm({ timestamp: new Date(NOW - ago).toISOString() }), ctx);
      expect(r).toEqual({ state: 'sin-datos' });
    }
  });
  it('9d) hora de la posición en el futuro (> 30 s) → sin-datos: no se toma por reciente', () => {
    expect(fr24Result(norm({ timestamp: new Date(NOW + 120000).toISOString() }), ctx)).toEqual({ state: 'sin-datos' });
    expect(fr24Result(norm({ timestamp: new Date(NOW + 10000).toISOString() }), ctx)).toMatchObject({ state: 'volando', posAgeS: 0 });
  });
  it('9b) sin hora válida de la posición → no se inventa antigüedad: ni volando ni posición', () => {
    for (const timestamp of [null, 'ayer', '']) {
      const r = fr24Result(norm({ timestamp }), ctx);
      expect(r.state).toBe('sin-datos');
      for (const k of ['lat', 'lon', 'posAgeS', 'altFt', 'kmh']) expect(r).not.toHaveProperty(k);
    }
  });
  it('10) fuente ESTIMATED o desconocida → nunca lat/lon ni «volando»; se marca fr24Estimated', () => {
    for (const source of ['ESTIMATED', 'FAA', 'OTHER', 'XYZ', null, '']) {
      const r = fr24Result(norm({ source }), ctx);
      expect(r, String(source)).toMatchObject({ state: 'sin-datos', fr24Estimated: true, fr24Id: '3c4d5e6f' });
      for (const k of ['lat', 'lon', 'posAgeS', 'altFt', 'altM', 'kmh', 'vRateFpm', 'remainingKm']) expect(r).not.toHaveProperty(k);
    }
    for (const source of ['ADSB', 'MLAT', 'SATELLITE', 'UAT', 'FLARM', 'adsb']) expect(fr24Result(norm({ source }), ctx).state, source).toBe('volando');
  });
  it('10b) por /radar: una estimación da «sin-datos» y contabiliza estimated en /health', async () => {
    const s = server([ib403()], () => [item({ source: 'ESTIMATED' })]);
    const r = await s.ask();
    expect(r).toMatchObject({ state: 'sin-datos', fr24Estimated: true, departureConfirmed: false });
    expect(r).not.toHaveProperty('lat');
    expect(JSON.parse(handle(s.state, '/health', { env }).body).fr24).toMatchObject({ estimated: 1 });
  });
  it('11) nudos → km/h; 12) pies → metros; 13) vspeed → vRateFpm', () => {
    const r = fr24Result(norm({ gspeed: 300, alt: 13500, vspeed: -1216 }), ctx);
    expect([r.kmh, r.altFt, r.altM, r.vRateFpm]).toEqual([556, 13500, 4115, -1216]);
    expect(fr24Result(norm({ vspeed: null }), ctx).vRateFpm).toBeNull();
  });
  it('en tierra en el origen (rodando) → sin-datos; en tierra en el destino tras el tiempo mínimo → aterrizado', () => {
    const taxi = fr24Result(norm({ alt: 0, gspeed: 15, lat: pos('MAD')[0], lon: pos('MAD')[1] }), ctx);
    expect(taxi.state).toBe('sin-datos');
    expect(taxi).not.toHaveProperty('lat');
    const landed = fr24Result(norm({ alt: 0, gspeed: 12, lat: pos('LHR')[0] + 0.01, lon: pos('LHR')[1], timestamp: new Date(T('10:30') - 20000).toISOString() }),
      { ...ctx, nowMs: T('10:30') });
    expect(landed).toMatchObject({ state: 'aterrizado', source: 'fr24', callsign: 'IBE403', seenS: 20, fr24Id: '3c4d5e6f' });
    // Ya en el destino pero demasiado pronto para haber volado: un avión de ayer aparcado allí no lo confirma.
    expect(fr24Result(norm({ alt: 0, gspeed: 12, lat: pos('LHR')[0], lon: pos('LHR')[1] }), ctx).state).toBe('sin-datos');
    // Lento pero alto (o velocidad desconocida): ni volando ni aterrizado.
    expect(fr24Result(norm({ gspeed: null }), ctx).state).toBe('sin-datos');
    // 2.000 ft a 40 kt junto al destino y pasado el tiempo mínimo: nunca «aterrizado» (se guardaría 7 días).
    const late = { ...ctx, nowMs: T('10:30') }, ts = new Date(T('10:30') - 20000).toISOString();
    expect(fr24Result(norm({ alt: 2000, gspeed: 40, lat: pos('LHR')[0], lon: pos('LHR')[1], timestamp: ts }), late)).toEqual({ state: 'sin-datos' });
    for (const over of [{ alt: 0, gspeed: null }, { alt: null, gspeed: 10 }, { alt: 0, gspeed: 60 }]) {
      expect(fr24Result(norm({ ...over, lat: pos('LHR')[0], lon: pos('LHR')[1], timestamp: ts }), late).state, JSON.stringify(over)).toBe('sin-datos');
    }
  });
});

describe('14–18) FR24 falla o no lo ve: sin reintentos', () => {
  it.each([[401], [403], [429], [500], [503]])('HTTP %i → no-disponible · 1 llamada', async status => {
    const s = server([ib403()], () => ({ status, headers: { 'retry-after': '30' } }));
    const raw = await s.raw();
    expect(raw.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(raw.body)).toMatchObject({ state: 'no-disponible' });
    expect(raw.body).not.toContain(TOKEN);
    expect(s.fr24()).toHaveLength(1);
    // Una respuesta fallida también cuesta: dentro de 60 s, ni una llamada más.
    await s.ask(NOW + 30000);
    expect(s.fr24()).toHaveLength(1);
  });
  it('17) tiempo agotado y error de red → no-disponible · 1 llamada cada uno', async () => {
    for (const err of [Object.assign(new Error('aborted'), { name: 'TimeoutError' }), new TypeError(`fetch failed ${TOKEN}`)]) {
      const s = server([ib403()], () => err);
      expect(await s.ask()).toMatchObject({ state: 'no-disponible' });
      expect(s.fr24()).toHaveLength(1);
    }
  });
  it('18) respuesta vacía → sin-datos (cerca de la salida, «localizando» con phase fr24) · 1 llamada', async () => {
    const s = server([ib403()], () => []);
    const r = await s.ask();
    expect(r).toMatchObject({ state: 'sin-datos', identifying: true, phase: 'fr24', departureConfirmed: false });
    expect(s.fr24()).toHaveLength(1);
  });
  it('fuera de la ventana de salida (última salida + 45 min) → sin-datos sin identifying', async () => {
    const s = server([ib403()], () => []);
    const r = await s.ask(T('08:55'));
    expect(r.state).toBe('sin-datos');
    expect(r).not.toHaveProperty('identifying');
  });
  it('el token no aparece en ninguna respuesta ni en el diagnóstico (?debug=1)', async () => {
    for (const answer of [() => [item()], () => [], () => ({ status: 401 }), () => ({ status: 429 }), () => new Error(TOKEN), () => [item(), item({ fr24_id: 'b' })]]) {
      const s = server([ib403()], answer);
      const r = await s.raw(NOW, `${PATH}&debug=1`);
      expect(r.body).not.toContain(TOKEN);
      expect(JSON.parse(r.body).diagnostic).toMatchObject({ number: 'IB403' });
    }
  });
  it('?debug=1: número consultado, resultados, compatibles, fr24Id elegido y motivo', async () => {
    const s = server([ib403()], () => [item(), item({ fr24_id: 'zz', orig_iata: 'LHR', dest_iata: 'MAD' })]);
    const r = await s.ask(NOW, `${PATH}&debug=1`);
    expect(r.diagnostic).toMatchObject({ number: 'IB403', results: 2, compatible: 1, fr24Id: '3c4d5e6f', reason: null, gate: expect.any(String) });
  });
});

// Caché de 40 s (antes 60 s; decisión del controlador para el seguimiento en vivo de 45 s).
describe('19–20) créditos: caché de 40 s y peticiones simultáneas', () => {
  it('19) la segunda petición en 40 s no llama a FR24 (tampoco un sondeo); pasados 40 s, sí', async () => {
    const s = server();
    await s.ask(NOW);
    await s.ask(NOW + 30000);
    await s.ask(NOW + 39000, `${PATH}&poll=1`);
    expect(s.fr24()).toHaveLength(1);
    await s.ask(NOW + 41000);
    expect(s.fr24()).toHaveLength(2);
    expect(JSON.parse(handle(s.state, '/health', { env }).body).fr24).toMatchObject({ configured: true, requests: 2, cacheHits: 2, found: 2 });
  });
  it('20) dos peticiones simultáneas al mismo vuelo físico → 1 llamada (la misma promesa)', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const s = server([ib403()], async () => { await gate; return [item()]; });
    const both = Promise.all([s.ask(NOW), s.ask(NOW + 10), s.ask(NOW + 20, `${PATH}&poll=1`)]);
    release();
    const rs = await both;
    expect(rs.map(r => r.state)).toEqual(['volando', 'volando', 'volando']);
    expect(s.fr24()).toHaveLength(1);
  });
  it('códigos compartidos: el mismo vuelo físico se consulta UNA vez, con el número de la operadora que da Aena', async () => {
    const legs = [ib403({ op: 'IB' }), ib403({ al: 'AA', icao: 'AAL', n: '7777', op: 'IB' })];
    const s = server(legs);
    await s.ask(NOW, `/radar/AA/7777.json?leg=${encodeURIComponent(KEY)}`);
    await s.ask(NOW + 1000);
    expect(s.fr24()).toEqual([`${FR24}api/live/flight-positions/full?flights=IB403&limit=5`]);
  });
  it('dos tramos del mismo número a la vez: nunca se mezclan (cada uno con su ruta)', async () => {
    const legs = [ib403(), ib403({ o: 'LHR', a: 'MAD', sd: '07:30', ed: '2026-10-21T07:30' })];
    const s = server(legs, () => [item({ fr24_id: 'ida' }), item({ fr24_id: 'vuelta', orig_iata: 'LHR', dest_iata: 'MAD' })]);
    expect(await s.ask(NOW)).toMatchObject({ state: 'volando', fr24Id: 'ida' });
    const other = physicalFlightKey(legs[1]);
    expect(await s.ask(NOW, `/radar/IB/403.json?leg=${encodeURIComponent(other)}`)).toMatchObject({ state: 'volando', fr24Id: 'vuelta' });
    // Sin ?leg y con dos tramos elegibles: no se escoge ninguno. La respuesta cruda de FR24 del mismo número se comparte
    // 60 s entre los dos tramos: 1 sola llamada.
    expect((await s.ask(NOW, '/radar/IB/403.json')).state).toBe('no-aplica');
    expect(s.fr24()).toHaveLength(1);
    await s.ask(NOW + 61000, `/radar/IB/403.json?leg=${encodeURIComponent(other)}`);
    expect(s.fr24()).toHaveLength(2);
  });
  it('sin operadora segura: un «sin datos» de un código comercial no se sirve a otro código del mismo vuelo físico', async () => {
    const legs = [ib403(), ib403({ al: 'AA', icao: 'AAL', n: '7777' })]; // Aena no dice quién opera
    const s = server(legs, flight => (flight === 'IB403' ? [item()] : []));
    expect((await s.ask(NOW, `/radar/AA/7777.json?leg=${encodeURIComponent(KEY)}`)).state).toBe('sin-datos');
    expect(await s.ask(NOW + 1000)).toMatchObject({ state: 'volando', fr24Id: '3c4d5e6f' });
    expect(s.fr24().map(u => new URL(u).searchParams.get('flights'))).toEqual(['AA7777', 'IB403']);
  });
});

describe('21) Aena manda: cancelado, desviado o llegada final', () => {
  it('no se consulta FR24 y nunca se contradice', async () => {
    for (const over of [{ st: 'CAN', std: 'CAN' }, { sta: 'DES' }, { std: 'BOR', st: 'BOR', sta: 'LND' }, { std: 'BOR', st: 'BOR', sta: 'IBK' }]) {
      const s = server([ib403(over)]);
      const r = await s.ask();
      expect(r.state, JSON.stringify(over)).toBe('no-aplica');
      expect(s.calls).toEqual([]);
    }
  });
  it('antes de la hora de salida − 5 min, tampoco', async () => {
    const s = server();
    expect((await s.ask(T('07:50'))).state).toBe('no-aplica');
    expect(s.calls).toEqual([]);
  });
  it('tramo desconocido → no-aplica, 0 llamadas', async () => {
    const s = server();
    expect((await s.ask(NOW, '/radar/IB/403.json?leg=2026-10-21%7CMAD%7CJFK%7C10%3A00')).state).toBe('no-aplica');
    expect(s.calls).toEqual([]);
  });
});

describe('/fr24-test con caché', () => {
  it('dos peticiones en 40 s → 1 llamada (y simultáneas, también); cuentan en /health.fr24; pasados 40 s, otra', async () => {
    const { fr24TestRoute } = await import('../server/live.mjs');
    const f = fake();
    const state = createState();
    const get = t => fr24TestRoute(state, '/fr24-test/IB403.json', { fetchFn: f.fetchFn, env, nowMs: t }).then(r => { expect(r.body).not.toContain(TOKEN); return JSON.parse(r.body); });
    expect((await Promise.all([get(NOW), get(NOW)])).map(r => r.state)).toEqual(['found', 'found']);
    await get(NOW + 39000);
    expect(f.fr24()).toHaveLength(1);
    expect(JSON.parse(handle(state, '/health', { env }).body).fr24).toMatchObject({ requests: 1, cacheHits: 2, found: 1 });
    await get(NOW + 41000);
    expect(f.fr24()).toHaveLength(2);
    // La misma respuesta cruda la aprovecha el radar del mismo número dentro de los 40 s.
    state.legs = [ib403()];
    await radarRoute(state, PATH, { fetchFn: f.fetchFn, nowMs: NOW + 42000, airports, env });
    expect(f.fr24()).toHaveLength(2);
  });
});

describe('24) /health', () => {
  it('no llama a FR24 (fetch espiado) y no contiene el token', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no debe llamarse'); });
    try {
      const body = handle(createState(), '/health', { env }).body;
      // trackRequests/trackCacheHits: la estela (Flight Tracks, server/fr24-track.mjs); history…: el histórico (Flight Summary,
      // server/fr24-history.mjs). Todo a cero sin uso.
      expect(JSON.parse(body).fr24).toEqual({ configured: true, requests: 0, cacheHits: 0, found: 0, notFound: 0, multiple: 0, unavailable: 0, estimated: 0,
        trackRequests: 0, trackCacheHits: 0, trackStoreHits: 0, historyRequests: 0, historyCacheHits: 0, historyStoreHits: 0, historyLanded: 0, historyNotFound: 0,
        historyMultiple: 0, historyOther: 0, historyUnavailable: 0, historyCredits: 0 });
      expect(body).not.toContain(TOKEN);
      expect(JSON.parse(handle(createState(), '/health', { env: {} }).body).fr24).toMatchObject({ configured: false });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('25) con FR24 configurado, ninguna ruta de radar llama a adsb.lol, ADSBDB, VRS ni trazas', () => {
  it('todas las URLs pedidas son de fr24api.flightradar24.com (encontrado, no encontrado, varios, sondeos, BOR)', async () => {
    const answers = [() => [item()], () => [], () => [item(), item({ fr24_id: 'b' })], () => [item({ orig_iata: 'BCN' })], () => ({ status: 500 })];
    for (const answer of answers) {
      for (const leg of [ib403(), ib403({ st: 'BOR', std: 'BOR', sta: 'FLY' })]) {
        const s = server([leg], answer);
        await s.ask(NOW);
        await s.ask(NOW + 20000, `${PATH}&poll=1`);
        await s.ask(NOW + 61000);
        await s.ask(NOW + 125000, `${PATH}&poll=1`);
        await new Promise(r => setTimeout(r, 20)); // nada en segundo plano después
        expect(s.others()).toEqual([]);
        expect(s.calls.every(u => u.startsWith(FR24))).toBe(true);
        expect(s.state.radarJobs?.size ?? 0).toBe(0);
      }
    }
  });
  it('/radar-adb: todas las URLs pedidas son de fr24api (varias respuestas, sondeos y caché pasada)', async () => {
    const ADB_NOW = Date.parse('2026-09-26T13:35Z');
    const raw = { number: 'GA 89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' }, callSign: 'GIA89',
      departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: '2026-09-26 10:35Z', local: '2026-09-26 12:35+02:00' } },
      arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: '2026-09-27 03:00Z', local: '2026-09-27 10:00+07:00' } },
      aircraft: { model: 'Boeing 777', reg: 'PK-GIK', modeS: '8A04C1' } };
    const entry = { status: 'found', source: 'aerodatabox', number: 'GA89', date: '2026-09-26', fetchedAt: new Date(ADB_NOW - 5 * 60000).toISOString(), legs: normalizeFlights([raw]) };
    const ga = over => item({ fr24_id: '4a', orig_iata: 'AMS', dest_iata: 'CGK', alt: 37000, gspeed: 490, ...over }, ADB_NOW);
    const answers = [() => [ga()], () => [], () => [ga(), ga({ fr24_id: '4b' })], () => [ga({ orig_iata: 'CGK', dest_iata: 'AMS' })], () => ({ status: 429 }), () => [ga({ source: 'ESTIMATED' })]];
    for (const answer of answers) {
      const f = fake(answer);
      const state = createState();
      state.adb = createAerodatabox({ key: 'k', store: createMemoryStore({ [entryPath(entry.number, entry.date)]: entry }), fetchFn: f.fetchFn, now: () => ADB_NOW });
      const path = `/radar-adb/GA89/2026-09-26.json?leg=${encodeURIComponent(adbPhysicalKey(entry, entry.legs[0]))}`;
      const ask = (t, q = '') => radarRoute(state, `${path}${q}`, { fetchFn: f.fetchFn, nowMs: t, airports, env });
      await ask(ADB_NOW);
      await ask(ADB_NOW + 20000, '&poll=1');
      await ask(ADB_NOW + 61000);
      await ask(ADB_NOW + 125000, '&poll=1');
      await new Promise(r => setTimeout(r, 20));
      expect(f.others()).toEqual([]);
      expect(f.fr24()).toHaveLength(3);
      expect(state.adbRadarJobs?.size ?? 0).toBe(0);
    }
  });
  it('sin FR24 configurado, /radar sigue siendo el flujo de adsb.lol (para revertir quitando la variable)', async () => {
    const f = fake();
    const state = createState();
    state.legs = [ib403()];
    await radarRoute(state, PATH, { fetchFn: f.fetchFn, nowMs: NOW, airports, env: {}, pauseMs: 0 });
    expect(f.fr24()).toEqual([]);
    expect(f.others().some(u => u.startsWith('https://api.adsb.lol/'))).toBe(true);
  });
});

// Seguimiento en vivo de la ficha (js/live-tracker.js, decisión del controlador 21/10/2026): el navegador vuelve a pedir
// /radar cada 45 s con el vuelo en curso; el servidor guarda la respuesta por vuelo físico 40 s (y la cruda por número,
// otros 40 s). Con 45 > 40 cada ciclo trae una lectura nueva de FR24 y varios usuarios del mismo vuelo comparten caché y
// promesa en curso. La antigüedad (posAgeS, seenS) es la del instante en que el servidor responde (también desde la
// caché), con `checked` = la hora del servidor al responder: la app nunca usa el reloj civil del móvil.
describe('seguimiento en vivo: caché de 40 s, antigüedad al responder y motivos de «no disponible»', () => {
  // FR24 en el instante de cada llamada: la posición siempre de hace 5 s respecto a esa llamada.
  const moving = () => { let t = NOW; return { at: v => { t = v; }, answer: () => [item({}, t)] }; };
  it('LIVE 20) cadencia del navegador 45 s y TTL 40 s: cada ciclo es una llamada real a FR24 con una lectura nueva', async () => {
    const m = moving();
    const s = server([ib403()], m.answer);
    const ages = [];
    for (let k = 0; k < 4; k++) {
      m.at(NOW + k * 45000);
      const r = await s.ask(NOW + k * 45000);
      ages.push([r.state, r.posAgeS, r.checked]);
    }
    expect(s.fr24()).toHaveLength(4); // 4 ciclos → 4 llamadas reales
    expect(ages.map(a => a[1])).toEqual([5, 5, 5, 5]); // siempre la lectura nueva, no la de la caché
    expect(ages.map(a => a[2])).toEqual([0, 1, 2, 3].map(k => new Date(NOW + k * 45000).toISOString()));
    // Otro usuario del mismo vuelo dentro de los 40 s comparte la caché: ninguna llamada más.
    await s.ask(NOW + 3 * 45000 + 20000);
    expect(s.fr24()).toHaveLength(4);
    expect(JSON.parse(handle(s.state, '/health', { env }).body).fr24).toMatchObject({ requests: 4, cacheHits: 1 });
  });
  it('TTL 40 s: a los 39 s (también un sondeo) sale de la caché; a los 41 s, otra llamada', async () => {
    const s = server();
    await s.ask(NOW);
    await s.ask(NOW + 39000, `${PATH}&poll=1`);
    expect(s.fr24()).toHaveLength(1);
    await s.ask(NOW + 41000);
    expect(s.fr24()).toHaveLength(2);
  });
  it('LIVE 19) dos peticiones simultáneas (el ciclo y «Actualizar», o dos usuarios) → 1 llamada a FR24', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const s = server([ib403()], async () => { await gate; return [item()]; });
    const both = Promise.all([s.ask(NOW), s.ask(NOW + 5)]);
    release();
    expect((await both).map(r => r.state)).toEqual(['volando', 'volando']);
    expect(s.fr24()).toHaveLength(1);
  });
  it('desde la caché, posAgeS y seenS son los del instante de responder y `checked` la hora del servidor al responder', async () => {
    const s = server();
    const a = await s.ask(NOW);
    expect([a.posAgeS, a.seenS, a.checked]).toEqual([5, 5, new Date(NOW).toISOString()]);
    const b = await s.ask(NOW + 30000);
    expect(s.fr24()).toHaveLength(1);
    expect([b.posAgeS, b.seenS, b.checked]).toEqual([35, 35, new Date(NOW + 30000).toISOString()]);
    // La hora de la posición (checked − posAgeS, la del corte de la estela) es la misma: la medición no cambia.
    expect(Date.parse(b.checked) - b.posAgeS * 1000).toBe(Date.parse(a.checked) - a.posAgeS * 1000);
    expect([b.lat, b.lon]).toEqual([a.lat, a.lon]);
  });
  it('posición real hasta 180 s; servida desde la caché con más de 180 s → «sin-datos» sin telemetría (como fr24Result)', async () => {
    const s = server([ib403()], () => [item({ timestamp: new Date(NOW - 170000).toISOString() })]);
    const a = await s.ask(NOW);
    expect(a).toMatchObject({ state: 'volando', lat: 44.0123, lon: -2.5432, posAgeS: 170 });
    const b = await s.ask(NOW + 20000);
    expect(s.fr24()).toHaveLength(1);
    expect(b).toEqual({ state: 'sin-datos', source: 'fr24', departureConfirmed: false, checked: new Date(NOW + 20000).toISOString() });
  });
  it('la antigüedad desde la caché sale del instante EXACTO de la posición (sin oscilar ±1 s por redondeos)', async () => {
    const s = server([ib403()], () => [item({ timestamp: new Date(NOW - 4600).toISOString() })]); // 4,6 s → 5
    expect((await s.ask(NOW)).posAgeS).toBe(5);
    // 4,6 + 0,6 = 5,2 s → 5 (sumar 1 s redondeado a los 5 daría 6); 4,6 + 30,4 = 35 s.
    expect((await s.ask(NOW + 600)).posAgeS).toBe(5);
    expect((await s.ask(NOW + 30400)).posAgeS).toBe(35);
    expect(s.fr24()).toHaveLength(1);
  });
  it('las respuestas del radar FR24 no se guardan en el navegador (no-store): la caché es la del servidor', async () => {
    const s = server();
    expect((await s.raw()).headers['Cache-Control']).toBe('no-store');
    expect((await s.raw(NOW + 10000)).headers['Cache-Control']).toBe('no-store');
  });
  it.each([
    [{ status: 401 }, { reason: 'autorizacion' }], [{ status: 403 }, { reason: 'autorizacion' }],
    [{ status: 429, headers: { 'retry-after': '120' } }, { reason: 'limite', retryAfterSec: 120 }], [{ status: 429 }, { reason: 'limite' }],
    [{ status: 500 }, { reason: 'servidor' }], [{ status: 503 }, { reason: 'servidor' }], [{ status: 404 }, { reason: 'http' }],
    [Object.assign(new Error('aborted'), { name: 'TimeoutError' }), { reason: 'timeout' }], [new TypeError(`fetch failed ${TOKEN}`), { reason: 'red' }],
  ])('no-disponible distingue el motivo (%#) sin datos sensibles', async (answer, want) => {
    const s = server([ib403()], () => answer);
    const raw = await s.raw();
    expect(raw.body).not.toContain(TOKEN);
    const r = JSON.parse(raw.body);
    expect(r).toMatchObject({ state: 'no-disponible', source: 'fr24', ...want });
    if (!('retryAfterSec' in want)) expect(r).not.toHaveProperty('retryAfterSec');
    expect(Object.keys(r).sort()).toEqual(['checked', 'departureConfirmed', 'reason', 'source', 'state', ...('retryAfterSec' in want ? ['retryAfterSec'] : [])].sort());
  });
  it('429 desde la caché: retryAfterSec es lo que QUEDA de la pausa al responder', async () => {
    const s = server([ib403()], () => ({ status: 429, headers: { 'retry-after': '120' } }));
    await s.ask(NOW);
    expect(await s.ask(NOW + 30000)).toMatchObject({ state: 'no-disponible', reason: 'limite', retryAfterSec: 90 });
    expect(s.fr24()).toHaveLength(1);
  });
  it('CRÉDITOS 31) /health durante el seguimiento: solo cuenta, nunca llama a FR24', async () => {
    const s = server();
    await s.ask(NOW);
    const n = s.fr24().length;
    for (let k = 0; k < 3; k++) handle(s.state, '/health', { env });
    expect(s.fr24()).toHaveLength(n);
  });
});
