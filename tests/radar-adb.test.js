// Radar para vuelos de AeroDataBox (server/radar-adb.mjs): transpondedor → indicativo → nada. Falso negativo antes que
// avión incorrecto. Cada caso comprueba el número EXACTO de consultas a adsb.lol y que AeroDataBox no se consulta nunca.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { findAdbOnRadar, adbRadarResponse } from '../server/radar-adb.mjs';
import { createAerodatabox, normalizeFlights, entryPath } from '../server/aerodatabox.mjs';
import { createMemoryStore } from '../server/adb-store.mjs';
import { adbPhysicalKey, adbRadarGate } from '../js/adb.js';
import { createState, handle } from '../server/live.mjs';
import { adsbLimiter } from '../server/adsb.mjs';

beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity }); });

const AIRPORTS = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const pos = iata => [AIRPORTS[iata][2], AIRPORTS[iata][3]];
const rad = d => (d * Math.PI) / 180, deg = r => (r * 180) / Math.PI;
// Punto a una fracción f del círculo máximo y rumbo hacia el destino (geometría, no valores fijados).
function along([la1, lo1], [la2, lo2], f) {
  const φ1 = rad(la1), λ1 = rad(lo1), φ2 = rad(la2), λ2 = rad(lo2);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2), y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return [deg(Math.atan2(z, Math.sqrt(x * x + y * y))), deg(Math.atan2(y, x))];
}
function bearing([la1, lo1], [la2, lo2]) {
  const φ1 = rad(la1), φ2 = rad(la2), Δλ = rad(lo2 - lo1);
  return (deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ))) + 360) % 360;
}

// GA89 AMS → CGK: salida 12:35 (+02:00) = 10:35Z; ahora 3 h después; AeroDataBox «EnRoute» consultado hace 5 min.
const NOW = Date.parse('2026-09-26T13:35Z');
const raw = (over = {}) => ({
  number: 'GA 89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' }, callSign: 'GIA89',
  departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: '2026-09-26 10:35Z', local: '2026-09-26 12:35+02:00' } },
  arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: '2026-09-27 03:00Z', local: '2026-09-27 10:00+07:00' } },
  aircraft: { model: 'Boeing 777', reg: 'PK-GIK', modeS: '8A04C1' }, ...over });
const entryOf = (r = raw(), fetchedAt = new Date(NOW - 5 * 60000).toISOString()) =>
  ({ status: 'found', source: 'aerodatabox', number: 'GA89', date: '2026-09-26', fetchedAt, legs: normalizeFlights([r]) });
// Avión en el aire a 2.100 km de AMS sobre la ruta (3 h de vuelo) y con rumbo al destino.
function plane({ hex = '8a04c1', flight = 'GIA89', r = 'PK-GIK', from = 'AMS', to = 'CGK', km = 2100, trackOffset = 0, ...over } = {}) {
  const o = pos(from), d = pos(to);
  const total = 6371 * 2 * Math.asin(Math.sqrt(Math.sin(rad(d[0] - o[0]) / 2) ** 2 + Math.cos(rad(o[0])) * Math.cos(rad(d[0])) * Math.sin(rad(d[1] - o[1]) / 2) ** 2));
  const [lat, lon] = along(o, d, km / total);
  return { hex, flight: flight && `${flight}  `, r, alt_baro: 37000, gs: 490, baro_rate: 0, lat, lon, track: (bearing([lat, lon], d) + trackOffset) % 360, seen: 2, seen_pos: 2, ...over };
}
// adsb.lol simulado: { '/hex/8a04c1': [aviones] | 429 | 500 }; registra cada consulta.
function adsb(routes) {
  const calls = [];
  const fetchFn = vi.fn(async url => {
    const path = url.replace('https://api.adsb.lol/v2', '');
    calls.push(path);
    const r = routes[path] ?? [];
    if (r === 429) return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) };
    if (r === 500) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ac: r }) };
  });
  return { fetchFn, calls };
}
const find = (entry, routes, extra = {}) => {
  const a = adsb(routes);
  return findAdbOnRadar({ leg: entry.legs[0], origin: pos(entry.legs[0].o), dest: pos(entry.legs[0].a), nowMs: NOW, fetchFn: a.fetchFn, ...extra }).then(r => ({ ...r, calls: a.calls }));
};

describe('AeroDataBox: identidad del avión guardada', () => {
  it('modeS (hex de 6 cifras, en minúsculas), matrícula e indicativo normalizados; modeS inválido → null', () => {
    const [l] = normalizeFlights([raw()]);
    expect([l.modeS, l.reg, l.callSign]).toEqual(['8a04c1', 'PK-GIK', 'GIA89']);
    const [bad] = normalizeFlights([raw({ callSign: ' gia 89 ', aircraft: { model: 'Boeing 777', modeS: 'XYZ', reg: '' } })]);
    expect([bad.modeS, bad.reg, bad.callSign]).toEqual([null, null, 'GIA89']);
  });
  it('identificador físico propio, que nunca se confunde con los de Aena («phys|…»)', () => {
    const e = entryOf();
    expect(adbPhysicalKey(e, e.legs[0])).toBe('adb|GA89|2026-09-26|AMS|CGK|2026-09-26T10:35Z');
  });
});

describe('transpondedor (modeS) primero', () => {
  it('visto, en el aire, mismo indicativo y matrícula → volando · 1 consulta', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [plane()] });
    expect(r.result).toMatchObject({ state: 'volando', callsign: 'GIA89', hex: '8a04c1', match: 'transpondedor', source: 'adsb.lol' });
    expect(r.result.remainingKm).toBeGreaterThan(9000);
    expect(r.calls).toEqual(['/hex/8a04c1']);
  });
  it('visto con OTRO indicativo (está haciendo otro vuelo) → sin datos, sin plan B · 1 consulta', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [plane({ flight: 'GIA88' })] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'indicativo' });
    expect(r.calls).toHaveLength(1);
  });
  it('visto con OTRA matrícula → sin datos · 1 consulta', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [plane({ r: 'PK-GIA' })] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'matricula' });
    expect(r.calls).toHaveLength(1);
  });
  it('contradicción física (demasiado lejos para el tiempo de vuelo) → sin datos · 1 consulta', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [plane({ km: 9000 })] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'contradiccion' });
    expect(r.calls).toHaveLength(1);
  });
  it('sin indicativo en ADS-B: exige el corredor completo (rumbo contrario → no; en ruta → sí) · 1 consulta cada una', async () => {
    const off = await find(entryOf(), { '/hex/8a04c1': [plane({ flight: null, trackOffset: 180 })] });
    expect(off).toMatchObject({ result: { state: 'sin-datos' }, reason: 'corredor-rumbo' });
    const on = await find(entryOf(), { '/hex/8a04c1': [plane({ flight: null })] });
    expect(on.result).toMatchObject({ state: 'volando', callsign: 'GIA89', match: 'transpondedor' });
    expect([off.calls.length, on.calls.length]).toEqual([1, 1]);
  });
  it('aterrizado en el destino (por transpondedor) → aterrizado · 1 consulta', async () => {
    const [lat, lon] = pos('CGK');
    const r = await find(entryOf(), { '/hex/8a04c1': [plane({ alt_baro: 'ground', lat, lon, gs: 10 })] }, { nowMs: Date.parse('2026-09-27T03:30Z') });
    expect(r.result).toMatchObject({ state: 'aterrizado', callsign: 'GIA89' });
    expect(r.calls).toHaveLength(1);
  });
  it('en tierra lejos del origen y del destino → contradicción · 1 consulta', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [plane({ alt_baro: 'ground', lat: 40.47, lon: -3.56 })] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'contradiccion' });
    expect(r.calls).toHaveLength(1);
  });
  it('no aparece y hay indicativo → UNA consulta por indicativo; otro transpondedor válido = cambio de avión · 2 consultas', async () => {
    const r = await find(entryOf(), { '/hex/8a04c1': [], '/callsign/GIA89': [plane({ hex: '8a0500', r: 'PK-GIC' })] });
    expect(r.result).toMatchObject({ state: 'volando', hex: '8a0500', match: 'indicativo', aircraftChanged: true });
    expect(r.learned).toEqual({ hex: '8a0500', callsign: 'GIA89' });
    expect(r.calls).toEqual(['/hex/8a04c1', '/callsign/GIA89']);
  });
  it('no aparece y NO hay indicativo → sin datos · 1 consulta', async () => {
    const r = await find(entryOf(raw({ callSign: null })), { '/hex/8a04c1': [] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'no-aparece' });
    expect(r.calls).toHaveLength(1);
  });
  it('429 o fallo temporal en /hex → no disponible y SIN plan B por indicativo · 1 consulta', async () => {
    const limited = await find(entryOf(), { '/hex/8a04c1': 429, '/callsign/GIA89': [plane()] });
    expect(limited).toMatchObject({ result: { state: 'no-disponible' }, reason: 'rate-limited' });
    expect(limited.calls).toEqual(['/hex/8a04c1']);
    adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0, maxPerWindow: Infinity });
    const failed = await find(entryOf(), { '/hex/8a04c1': 500, '/callsign/GIA89': [plane()] });
    expect(failed).toMatchObject({ result: { state: 'no-disponible' }, reason: 'failed' });
    expect(failed.calls).toEqual(['/hex/8a04c1']);
  });
});

describe('solo indicativo (sin modeS): corredor obligatorio aunque haya un único resultado', () => {
  const noHex = () => entryOf(raw({ aircraft: { model: 'Boeing 777' } }));
  it('un avión en el corredor → volando · 1 consulta', async () => {
    const r = await find(noHex(), { '/callsign/GIA89': [plane()] });
    expect(r.result).toMatchObject({ state: 'volando', match: 'indicativo' });
    expect(r.result.aircraftChanged).toBeUndefined();
    expect(r.calls).toEqual(['/callsign/GIA89']);
  });
  it('un ÚNICO avión pero fuera del corredor → sin datos (más estricto que Aena) · 1 consulta', async () => {
    const r = await find(noHex(), { '/callsign/GIA89': [plane({ trackOffset: 180 })] });
    expect(r).toMatchObject({ result: { state: 'sin-datos' }, reason: 'fuera-del-corredor' });
    expect(r.calls).toHaveLength(1);
  });
  it('indicativo ambiguo: dos aviones compatibles → nada; uno compatible y otro fuera → ese · 1 consulta cada una', async () => {
    const two = await find(noHex(), { '/callsign/GIA89': [plane({ hex: 'aaaaaa' }), plane({ hex: 'bbbbbb', km: 2000 })] });
    expect(two).toMatchObject({ result: { state: 'sin-datos' }, reason: 'ambiguo' });
    const one = await find(noHex(), { '/callsign/GIA89': [plane({ hex: 'aaaaaa' }), plane({ hex: 'bbbbbb', trackOffset: 180 })] });
    expect(one.result).toMatchObject({ state: 'volando', hex: 'aaaaaa' });
    expect([two.calls.length, one.calls.length]).toEqual([1, 1]);
  });
  it('sin transpondedor ni indicativo → sin radar · 0 consultas', async () => {
    const r = await find(entryOf(raw({ callSign: null, aircraft: { model: 'Boeing 777' } })), {});
    expect(r).toMatchObject({ result: { state: 'no-aplica' }, reason: 'sin-identificador' });
    expect(r.calls).toEqual([]);
  });
});

describe('cuándo se activa (adbRadarGate, la misma regla en la app y en Render)', () => {
  const gate = (e, nowMs) => adbRadarGate(e.legs[0], e, nowMs);
  it('en el aire según AeroDataBox (reciente) → direct y confirmado; nunca «identify»', () => {
    expect(gate(entryOf(), NOW)).toMatchObject({ mode: 'direct', confirmed: true });
  });
  it('estado viejo (> 30 min): no confirma, mandan las horas', () => {
    expect(gate(entryOf(raw(), new Date(NOW - 3 * 3600000).toISOString()), NOW)).toMatchObject({ mode: 'direct', confirmed: false });
  });
  it('antes de salida − 5 min, cancelado, con hora de pista de llegada o pasada la llegada + 60 min → none', () => {
    const future = entryOf(raw({ status: 'Expected' }), new Date(NOW - 5 * 60000).toISOString());
    expect(gate(future, Date.parse('2026-09-26T10:25Z')).mode).toBe('none');
    expect(gate(entryOf(raw({ status: 'Canceled' })), NOW).mode).toBe('none');
    expect(gate(entryOf(raw({ arrival: { ...raw().arrival, runwayTime: { utc: '2026-09-27 02:50Z', local: '2026-09-27 09:50+07:00' } } })), NOW).mode).toBe('none');
    expect(gate(entryOf(raw({ status: 'Expected' }), '2026-09-25T10:00:00.000Z'), Date.parse('2026-09-27T04:01Z')).mode).toBe('none');
  });
  it('sin transpondedor ni indicativo → none (sin-identificador)', () => {
    expect(gate(entryOf(raw({ callSign: null, aircraft: {} })), NOW)).toMatchObject({ mode: 'none', reason: 'sin-identificador' });
  });
});

describe('Render: /radar-adb/{número}/{fecha}.json', () => {
  // Estado de Render con AeroDataBox real (caché en memoria con la entrada guardada) y una API de AeroDataBox espía.
  function render(entry = entryOf()) {
    const adbApi = vi.fn(async () => { throw new Error('AeroDataBox no debe consultarse'); });
    const state = createState();
    state.adb = createAerodatabox({ key: 'k', store: createMemoryStore({ [entryPath(entry.number, entry.date)]: entry }), fetchFn: adbApi, now: () => NOW });
    const leg = adbPhysicalKey(entry, entry.legs[0]);
    return { state, adbApi, url: q => `/radar-adb/GA89/2026-09-26.json?leg=${encodeURIComponent(leg)}${q ?? ''}` };
  }
  const call = (r, a, q, nowMs = NOW) => adbRadarResponse(r.state, r.url(q), { fetchFn: a.fetchFn, nowMs, airports: AIRPORTS }).then(x => JSON.parse(x.body));
  it('GA89 AMS → CGK: volando por transpondedor · 1 consulta a adsb.lol, 0 a AeroDataBox', async () => {
    const r = render(), a = adsb({ '/hex/8a04c1': [plane()] });
    expect(await call(r, a)).toMatchObject({ state: 'volando', callsign: 'GIA89', hex: '8a04c1' });
    expect(a.calls).toEqual(['/hex/8a04c1']);
    expect(r.adbApi).not.toHaveBeenCalled();
  });
  it('caché de 60 s por vuelo físico, sondeo (?poll=1) y consultas simultáneas: 1 consulta en total', async () => {
    const r = render(), a = adsb({ '/hex/8a04c1': [plane()] });
    await Promise.all([call(r, a), call(r, a)]);
    await call(r, a, undefined, NOW + 59000);
    await call(r, a, '&poll=1', NOW + 30000);
    expect(a.calls).toHaveLength(1);
    await call(r, a, undefined, NOW + 61000);
    expect(a.calls).toHaveLength(2);
  });
  it('cambio de avión aceptado por indicativo: después se sigue por ese hex · 2 consultas y luego 1', async () => {
    const r = render(), a = adsb({ '/hex/8a04c1': [], '/callsign/GIA89': [plane({ hex: '8a0500', r: 'PK-GIC' })], '/hex/8a0500': [plane({ hex: '8a0500', r: 'PK-GIC' })] });
    expect(await call(r, a)).toMatchObject({ state: 'volando', hex: '8a0500', aircraftChanged: true });
    expect(await call(r, a, undefined, NOW + 61000)).toMatchObject({ state: 'volando', hex: '8a0500', match: 'transpondedor' });
    expect(a.calls).toEqual(['/hex/8a04c1', '/callsign/GIA89', '/hex/8a0500']);
  });
  it('tramo desconocido, sin identificador o fuera de ventana → no aplica · 0 consultas', async () => {
    const r = render(), a = adsb({});
    const wrong = await adbRadarResponse(r.state, '/radar-adb/GA89/2026-09-26.json?leg=phys%7C2026-09-26%7CAMS%7CCGK%7C12%3A35', { fetchFn: a.fetchFn, nowMs: NOW, airports: AIRPORTS });
    expect(JSON.parse(wrong.body).state).toBe('no-aplica');
    const none = render(entryOf(raw({ callSign: null, aircraft: { model: 'Boeing 777' } })));
    expect((await call(none, a)).state).toBe('no-aplica');
    expect((await call(r, a, undefined, Date.parse('2026-09-26T09:00Z'))).state).toBe('no-aplica');
    expect(a.calls).toEqual([]);
  });
  it('sin horario de AeroDataBox guardado → no aplica, sin consultar AeroDataBox ni adsb.lol', async () => {
    const state = createState();
    const adbApi = vi.fn();
    state.adb = createAerodatabox({ key: 'k', store: createMemoryStore(), fetchFn: adbApi, now: () => NOW });
    const a = adsb({});
    const res = JSON.parse((await adbRadarResponse(state, '/radar-adb/GA89/2026-09-26.json', { fetchFn: a.fetchFn, nowMs: NOW, airports: AIRPORTS })).body);
    expect(res.state).toBe('no-aplica');
    expect(adbApi).not.toHaveBeenCalled();
    expect(a.calls).toEqual([]);
  });
  it('estado de AeroDataBox no reciente → «departureConfirmed: false» (la app no dice «sin señal»)', async () => {
    const r = render(entryOf(raw(), new Date(NOW - 3 * 3600000).toISOString())), a = adsb({ '/hex/8a04c1': [] });
    expect(await call(r, a)).toMatchObject({ state: 'sin-datos', departureConfirmed: false });
    expect(a.calls).toEqual(['/hex/8a04c1', '/callsign/GIA89']);
  });
  it('DL106 JFK → FRA (otro vuelo, otra geometría): por indicativo en su corredor · 1 consulta', async () => {
    const dl = { ...raw(), number: 'DL 106', callSign: 'DAL106', airline: { name: 'Delta Air Lines' },
      departure: { airport: { iata: 'JFK' }, scheduledTime: { utc: '2026-09-26 10:35Z', local: '2026-09-26 06:35-04:00' } },
      arrival: { airport: { iata: 'FRA' }, scheduledTime: { utc: '2026-09-26 18:30Z', local: '2026-09-26 20:30+02:00' } }, aircraft: { model: 'Airbus A330-200' } };
    const e = { ...entryOf(dl), number: 'DL106' };
    const a = adsb({ '/callsign/DAL106': [plane({ hex: 'a1b2c3', flight: 'DAL106', r: null, from: 'JFK', to: 'FRA' })] });
    const r = await findAdbOnRadar({ leg: e.legs[0], origin: pos('JFK'), dest: pos('FRA'), nowMs: NOW, fetchFn: a.fetchFn });
    expect(r.result).toMatchObject({ state: 'volando', callsign: 'DAL106' });
    expect(a.calls).toEqual(['/callsign/DAL106']);
  });
  it('/health: contadores del radar de AeroDataBox', async () => {
    const r = render(), a = adsb({ '/hex/8a04c1': [plane()] });
    await call(r, a);
    expect(JSON.parse(handle(r.state, '/health').body).radar.adb).toMatchObject({ requests: 1, adsbRequests: 1, found: 1 });
  });
});
