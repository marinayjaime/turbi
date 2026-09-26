// AeroDataBox en Render (server/aerodatabox.mjs): consumo mínimo de unidades, caché persistente, errores y cupo.
import { describe, it, expect, vi } from 'vitest';
import { createAerodatabox, normalizeFlights, refreshDue, entryPath, RESERVE_UNITS } from '../server/aerodatabox.mjs';
import { createMemoryStore, createGithubStore } from '../server/adb-store.mjs';
import { createState, scheduleResponse, handle } from '../server/live.mjs';

const KEY = 'clave-secreta-de-prueba-123';
const T0 = Date.parse('2026-09-26T08:00:00Z');
// Respuesta con la forma real de AeroDataBox (TO3416 del 26/09/2026, NTE → AYT).
const TO3416 = [{
  number: 'TO 3416', callSign: 'TVF93ZL', status: 'Departed', codeshareStatus: 'IsOperator', isCargo: false,
  airline: { name: 'Transavia France', iata: 'TO', icao: 'TVF' },
  departure: { airport: { icao: 'LFRS', iata: 'NTE', name: 'Nantes' }, scheduledTime: { utc: '2026-09-26 10:30Z', local: '2026-09-26 12:30+02:00' },
    revisedTime: { utc: '2026-09-26 10:23Z', local: '2026-09-26 12:23+02:00' }, runwayTime: { utc: '2026-09-26 10:34Z', local: '2026-09-26 12:34+02:00' }, quality: ['Basic', 'Live'] },
  arrival: { airport: { icao: 'LTAI', iata: 'AYT', name: 'Antalya' }, scheduledTime: { utc: '2026-09-26 14:30Z', local: '2026-09-26 17:30+03:00' },
    predictedTime: { utc: '2026-09-26 14:21Z', local: '2026-09-26 17:21+03:00' }, quality: ['Basic'] },
  aircraft: { reg: 'F-HTVC', model: 'Boeing 737-800' },
}];
const headers = (units = 300) => ({ get: k => ({ 'x-ratelimit-api-units-remaining': String(units), 'x-ratelimit-api-units-limit': '400', 'x-ratelimit-api-units-reset': String(20 * 86400) })[k.toLowerCase()] ?? null });
const ok = (body, units) => ({ ok: true, status: 200, headers: headers(units), json: async () => body });
const empty = units => ({ ok: true, status: 204, headers: headers(units), json: async () => { throw new Error('sin cuerpo'); } });
const err = (status, units) => ({ ok: false, status, headers: headers(units), json: async () => ({ message: 'x' }) });
// fetch simulado: responde en orden con la lista dada y registra las URL y cabeceras.
function api(...responses) {
  const f = vi.fn(async (url, opts) => {
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return r;
  });
  return f;
}
function make({ fetchFn, store = createMemoryStore(), nowMs = T0, key = KEY } = {}) {
  let t = nowMs;
  const adb = createAerodatabox({ key, store, fetchFn, now: () => t, sleep: vi.fn(async () => {}) });
  return { adb, store, setNow: ms => { t = ms; } };
}

describe('normalizeFlights', () => {
  it('solo datos normalizados: aeropuertos, horas (local, UTC, desfase), estado, aeronave; sin matrícula, cabeceras ni URL', () => {
    const [l] = normalizeFlights(TO3416);
    expect(l).toEqual({
      number: 'TO3416', airline: 'Transavia France', callSign: 'TVF93ZL', codeshareStatus: 'IsOperator', status: 'Departed', aircraft: 'Boeing 737-800',
      o: 'NTE', a: 'AYT',
      dep: { sched: { local: '2026-09-26T12:30', utc: Date.parse('2026-09-26T10:30Z'), off: 120 }, revised: { local: '2026-09-26T12:23', utc: Date.parse('2026-09-26T10:23Z'), off: 120 },
        runway: { local: '2026-09-26T12:34', utc: Date.parse('2026-09-26T10:34Z'), off: 120 } },
      arr: { sched: { local: '2026-09-26T17:30', utc: Date.parse('2026-09-26T14:30Z'), off: 180 }, revised: null,
        predicted: { local: '2026-09-26T17:21', utc: Date.parse('2026-09-26T14:21Z'), off: 180 }, runway: null },
    });
  });
  it('descarta carga y tramos sin aeropuertos u hora programada', () => {
    expect(normalizeFlights([{ ...TO3416[0], isCargo: true }])).toEqual([]);
    expect(normalizeFlights([{ ...TO3416[0], arrival: { airport: {} } }])).toEqual([]);
    expect(normalizeFlights({ message: 'x' })).toEqual([]);
  });
});

describe('consulta base: una por vuelo + fecha', () => {
  it('la URL lleva exactamente los parámetros acordados y la clave solo va en la cabecera', async () => {
    const fetchFn = api(ok(TO3416));
    const { adb } = make({ fetchFn });
    const r = await adb.lookup('to 3416', '2026-09-26');
    expect(r).toMatchObject({ status: 'found', source: 'aerodatabox', number: 'TO3416', date: '2026-09-26', legs: [{ o: 'NTE', a: 'AYT' }] });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://aerodatabox.p.rapidapi.com/flights/number/TO3416/2026-09-26?dateLocalRole=Departure&withAircraftImage=false&withFlightPlan=false&withLocation=false');
    expect(opts.headers).toMatchObject({ 'x-rapidapi-key': KEY, 'x-rapidapi-host': 'aerodatabox.p.rapidapi.com' });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
  it('segunda consulta (memoria) y tras un reinicio de Render (misma caché persistente): 0 llamadas', async () => {
    const fetchFn = api(ok(TO3416));
    const store = createMemoryStore();
    const { adb } = make({ fetchFn, store });
    await adb.lookup('TO3416', '2026-09-26');
    await adb.lookup('TO3416', '2026-09-26');
    const restarted = make({ fetchFn, store }).adb;
    expect(await restarted.lookup('TO3416', '2026-09-26')).toMatchObject({ status: 'found' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const saved = JSON.stringify([...store.files.values()]);
    expect(saved).not.toContain(KEY);
    expect(saved).not.toContain('rapidapi');
    expect(store.files.has(entryPath('TO3416', '2026-09-26'))).toBe(true);
  });
  it('204 → negativa guardada y nunca repetida', async () => {
    const fetchFn = api(empty());
    const store = createMemoryStore();
    const { adb } = make({ fetchFn, store });
    expect(await adb.lookup('XX1234', '2026-09-27')).toMatchObject({ status: 'not_found', legs: [] });
    expect(await make({ fetchFn, store }).adb.lookup('XX1234', '2026-09-27')).toMatchObject({ status: 'not_found' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('dos consultas simultáneas del mismo vuelo: una sola llamada', async () => {
    const fetchFn = api(ok(TO3416));
    const { adb } = make({ fetchFn });
    const [a, b] = await Promise.all([adb.lookup('TO3416', '2026-09-26'), adb.lookup('TO3416', '2026-09-26')]);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('escritura concurrente (otro proceso guardó antes): se usa lo guardado', async () => {
    const store = createMemoryStore();
    const other = { status: 'found', number: 'TO3416', date: '2026-09-26', fetchedAt: '2026-09-26T07:59:00.000Z', legs: normalizeFlights(TO3416) };
    const realPut = store.put;
    store.put = async (path, data, sha) => { if (path.includes('TO3416') && !store.files.has(path)) await realPut(path, other); return realPut(path, data, sha); };
    const { adb } = make({ fetchFn: api(ok(TO3416)), store });
    expect((await adb.lookup('TO3416', '2026-09-26')).fetchedAt).toBe('2026-09-26T07:59:00.000Z');
  });
  it('fuera de −2…+60 días o formato inválido: sin llamada', async () => {
    const fetchFn = api(ok(TO3416));
    const { adb } = make({ fetchFn });
    expect(await adb.lookup('TO3416', '2026-09-23')).toMatchObject({ status: 'unavailable', reason: 'fuera-de-rango' });
    expect(await adb.lookup('TO3416', '2026-11-26')).toMatchObject({ status: 'unavailable', reason: 'fuera-de-rango' });
    expect(await adb.lookup('hola', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: 'formato' });
    expect((await adb.lookup('TO3416', '2026-09-24')).status).toBe('found'); // −2 días sí
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('si la caché persistente no responde, no se llama (no se podría garantizar el máximo)', async () => {
    const fetchFn = api(ok(TO3416));
    const store = { get: async () => { throw new Error('GitHub 503'); }, put: async () => ({ ok: true }) };
    const { adb } = make({ fetchFn, store });
    expect(await adb.lookup('TO3416', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: 'cache' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('errores: un solo reintento para 5xx o tiempo agotado; nunca para 401/403/429', () => {
  it('500 y después 200 → un reintento y encontrado', async () => {
    const fetchFn = api(err(500), ok(TO3416));
    const { adb } = make({ fetchFn });
    expect((await adb.lookup('TO3416', '2026-09-26')).status).toBe('found');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('tiempo agotado dos veces → no disponible, sin guardar (la app sigue con ADSBDB)', async () => {
    const fetchFn = api(new DOMException('t', 'TimeoutError'));
    const { adb, store } = make({ fetchFn });
    expect(await adb.lookup('TO3416', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: 'tiempo-o-red' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(store.files.has(entryPath('TO3416', '2026-09-26'))).toBe(false);
  });
  for (const code of [401, 403, 429]) {
    it(`${code} → sin reintento y AeroDataBox en pausa (la siguiente consulta no llama)`, async () => {
      const fetchFn = api(err(code));
      const { adb } = make({ fetchFn });
      expect(await adb.lookup('TO3416', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: `http-${code}` });
      expect(await adb.lookup('VY1234', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: `http-${code}` });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  }
  it('429: la pausa dura hasta la renovación del cupo indicada por la cabecera', async () => {
    const fetchFn = api(err(429, 0), ok(TO3416));
    const { adb, setNow } = make({ fetchFn });
    await adb.lookup('TO3416', '2026-09-26');
    setNow(T0 + 20 * 86400000 + 60000);
    expect((await adb.lookup('TO3416', '2026-10-16')).status).toBe('found');
  });
});

describe('refresco operativo: uno solo, en las 3 h previas a la salida, si la base era de antes del día', () => {
  const base = { status: 'found', number: 'TO3416', date: '2026-09-26', fetchedAt: '2026-09-24T09:00:00.000Z', legs: normalizeFlights(TO3416) };
  const dep = Date.parse('2026-09-26T10:30Z');
  it('refreshDue: ventana y condiciones', () => {
    expect(refreshDue(base, dep - 2 * 3600000)).toBe(true);
    expect(refreshDue(base, dep - 4 * 3600000)).toBe(false); // demasiado pronto
    expect(refreshDue(base, dep + 60000)).toBe(false); // ya salió
    expect(refreshDue({ ...base, fetchedAt: '2026-09-26T05:00:00.000Z' }, dep - 3600000)).toBe(false); // base del mismo día (hora local de NTE)
    expect(refreshDue({ ...base, refreshedAt: '2026-09-26T08:00:00.000Z' }, dep - 3600000)).toBe(false);
    expect(refreshDue({ ...base, status: 'not_found', legs: [] }, dep - 3600000)).toBe(false);
  });
  it('dentro de la ventana: 1 llamada de refresco; después, ninguna (ni tras reiniciar)', async () => {
    const store = createMemoryStore({ [entryPath('TO3416', '2026-09-26')]: base });
    const fetchFn = api(ok(TO3416));
    const { adb } = make({ fetchFn, store, nowMs: dep - 2 * 3600000 });
    const r = await adb.lookup('TO3416', '2026-09-26');
    expect(r).toMatchObject({ status: 'found', fetchedAt: base.fetchedAt, refreshedAt: new Date(dep - 2 * 3600000).toISOString() });
    await adb.lookup('TO3416', '2026-09-26');
    await make({ fetchFn, store, nowMs: dep - 3600000 }).adb.lookup('TO3416', '2026-09-26');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('fuera de la ventana: se sirve la base guardada sin llamar', async () => {
    const store = createMemoryStore({ [entryPath('TO3416', '2026-09-26')]: base });
    const fetchFn = api(ok(TO3416));
    expect((await make({ fetchFn, store, nowMs: dep - 5 * 3600000 }).adb.lookup('TO3416', '2026-09-26')).fetchedAt).toBe(base.fetchedAt);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('si el refresco falla, se sirve la base (y no cuenta como hecho)', async () => {
    const store = createMemoryStore({ [entryPath('TO3416', '2026-09-26')]: base });
    const r = await make({ fetchFn: api(err(503)), store, nowMs: dep - 3600000 }).adb.lookup('TO3416', '2026-09-26');
    expect(r).toMatchObject({ status: 'found', fetchedAt: base.fetchedAt });
    expect(r.refreshedAt).toBeUndefined();
  });
});

describe('cupo: reserva final de 20 unidades y reparto diario', () => {
  it('con 21 unidades restantes no se llama (quedarían menos de 20)', async () => {
    const store = createMemoryStore({ 'adb/_quota.json': { limit: 400, remaining: RESERVE_UNITS + 1, resetAt: T0 + 10 * 86400000 } });
    const fetchFn = api(ok(TO3416));
    expect(await make({ fetchFn, store }).adb.lookup('TO3416', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: 'reserva' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('tope diario: lo restante repartido entre los días hasta la renovación', async () => {
    // (60 − 20) / 2 = 20 llamadas en 10 días → 2 al día.
    const store = createMemoryStore({ 'adb/_quota.json': { limit: 400, remaining: 60, resetAt: T0 + 10 * 86400000 } });
    const fetchFn = vi.fn(async () => ok(TO3416, 58));
    const { adb } = make({ fetchFn, store });
    await adb.lookup('AA1', '2026-09-26'); await adb.lookup('AA2', '2026-09-26');
    expect(await adb.lookup('AA3', '2026-09-26')).toMatchObject({ status: 'unavailable', reason: 'tope-diario' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(store.files.get('adb/_quota.json').data).toMatchObject({ remaining: 58, dayCalls: 2, dayBudget: 2 });
  });
  it('health: estado y cupo sin la clave', async () => {
    const { adb } = make({ fetchFn: api(ok(TO3416, 300)) });
    await adb.lookup('TO3416', '2026-09-26');
    const h = adb.health();
    expect(h).toMatchObject({ configured: true, calls: 1, found: 1, quota: { limit: 400, remaining: 300 } });
    expect(JSON.stringify(h)).not.toContain(KEY);
  });
});

describe('caché en GitHub (rama data)', () => {
  const gh = (...responses) => vi.fn(async () => responses.shift());
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  it('get: 404 → null; 200 → datos decodificados y sha', async () => {
    const data = { status: 'not_found' };
    const fetchFn = gh(json(404), json(200, { sha: 'abc', content: Buffer.from(JSON.stringify(data)).toString('base64') }));
    const s = createGithubStore({ token: 't0k3n', fetchFn });
    expect(await s.get('adb/2026-09-26/XX1.json')).toBeNull();
    expect(await s.get('adb/2026-09-26/XX1.json')).toEqual({ data, sha: 'abc' });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/marinayjaime/turbi/contents/adb/2026-09-26/XX1.json?ref=data');
    expect(opts.headers.authorization).toBe('Bearer t0k3n');
  });
  it('put: crear sin sha; 422/409 → conflicto (otro escritor); otros errores lanzan', async () => {
    const fetchFn = gh(json(201, { content: { sha: 'n1' } }), json(422, {}), json(409, {}), json(500, {}));
    const s = createGithubStore({ token: 't', fetchFn });
    expect(await s.put('adb/x.json', { a: 1 })).toEqual({ ok: true, sha: 'n1' });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body).toMatchObject({ branch: 'data', message: 'AeroDataBox: adb/x.json' });
    expect(body.sha).toBeUndefined();
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString())).toEqual({ a: 1 });
    expect(await s.put('adb/x.json', { a: 2 })).toEqual({ ok: false, conflict: true });
    expect(await s.put('adb/x.json', { a: 2 }, 'viejo')).toEqual({ ok: false, conflict: true });
    await expect(s.put('adb/x.json', { a: 2 })).rejects.toThrow('GitHub 500');
  });
});

describe('Render: /schedule/{número}/{fecha}.json', () => {
  it('responde la entrada normalizada; sin configurar → no disponible; nunca la clave', async () => {
    const state = createState();
    expect(JSON.parse((await scheduleResponse(state, '/schedule/TO3416/2026-09-26.json')).body)).toEqual({ status: 'unavailable', reason: 'sin-configurar' });
    state.adb = make({ fetchFn: api(ok(TO3416)) }).adb;
    const r = await scheduleResponse(state, '/schedule/TO3416/2026-09-26.json');
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(JSON.parse(r.body)).toMatchObject({ status: 'found', legs: [{ o: 'NTE', a: 'AYT' }] });
    expect(r.body).not.toContain(KEY);
    expect((await scheduleResponse(state, '/schedule/../x.json')).status).toBe(404);
    const health = handle(state, '/health').body;
    expect(JSON.parse(health).aerodatabox).toMatchObject({ configured: true, calls: 1 });
    expect(health).not.toContain(KEY);
  });
});
