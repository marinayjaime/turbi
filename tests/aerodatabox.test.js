// AeroDataBox en Render (server/aerodatabox.mjs): consumo mínimo de unidades, caché persistente, errores y cupo.
import { describe, it, expect, vi } from 'vitest';
import { createAerodatabox, normalizeFlights, refreshDue, entryPath, RESERVE_UNITS, DAY_CAP, madridDay } from '../server/aerodatabox.mjs';
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

// API Contents de GitHub simulada: cada PUT lee la punta de la rama al empezar y la confirma al terminar (tras una
// espera); si otra escritura movió la rama entre medias → 409, como GitHub. Crear sin sha un archivo existente → 422.
function fakeGithub({ always409 = false, status500 = false, put500 = false, invalid = () => false } = {}) {
  const files = new Map();
  let head = 0, n = 0, inFlight = 0;
  const gh = {
    requests: [], committed: [], conflicts409: 0, maxConcurrentPuts: 0, status500, put500, beforeFirstPut: null,
    write(path, data) { files.set(path, { data, sha: `x${++n}` }); head++; },
    read(path) { return files.get(path)?.data; },
    fetch: vi.fn(async (url, opts = {}) => {
      const path = decodeURIComponent(new URL(url).pathname.replace('/repos/marinayjaime/turbi/contents/', ''));
      const method = opts.method ?? 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      gh.requests.push({ method, url: url.split('?')[0], body: body && { branch: body.branch, message: body.message }, auth: opts.headers?.authorization });
      const reply = (status, json = {}) => ({ ok: status < 300, status, json: async () => json });
      if (gh.status500) return reply(500);
      if (method === 'GET') {
        const f = files.get(path);
        return f ? reply(200, { sha: f.sha, content: Buffer.from(JSON.stringify(f.data)).toString('base64') }) : reply(404);
      }
      if (gh.put500) return reply(500);
      if (gh.beforeFirstPut) { const f = gh.beforeFirstPut; gh.beforeFirstPut = null; f(); }
      inFlight++;
      gh.maxConcurrentPuts = Math.max(gh.maxConcurrentPuts, inFlight);
      const start = head;
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      if (invalid(path)) return reply(422, { message: 'Invalid request.' });
      if (always409 || head !== start) { gh.conflicts409++; return reply(409, { message: 'is at abc but expected def' }); }
      const cur = files.get(path);
      if (cur && !body.sha) return reply(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if (body.sha && cur?.sha !== body.sha) { gh.conflicts409++; return reply(409, { message: 'does not match' }); }
      files.set(path, { data: JSON.parse(Buffer.from(body.content, 'base64').toString()), sha: `x${++n}` });
      head++;
      gh.committed.push(path);
      return reply(201, { content: { sha: `x${n}` } });
    }),
  };
  return gh;
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
      estMin: null, // sin posición de los aeropuertos en la respuesta
    });
  });
  it('duración prevista de Turbi (por distancia) si la respuesta trae la posición de los aeropuertos', () => {
    const withLoc = structuredClone(TO3416);
    withLoc[0].departure.airport.location = { lat: 47.1532, lon: -1.6107 };
    withLoc[0].arrival.airport.location = { lat: 36.8987, lon: 30.8005 };
    expect(normalizeFlights(withLoc)[0].estMin).toBeGreaterThan(200);
    expect(normalizeFlights(withLoc)[0].estMin).toBeLessThan(270);
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
  it('escritura concurrente (otro proceso guardó el mismo vuelo antes): se relee y manda lo guardado', async () => {
    const gh = fakeGithub();
    const other = { status: 'found', number: 'TO3416', date: '2026-09-26', fetchedAt: '2026-09-26T07:59:00.000Z', legs: normalizeFlights(TO3416) };
    gh.beforeFirstPut = () => gh.write(entryPath('TO3416', '2026-09-26'), other); // otro escritor se adelanta
    const { adb } = make({ fetchFn: api(ok(TO3416)), store: createGithubStore({ token: 't', fetchFn: gh.fetch }) });
    expect((await adb.lookup('TO3416', '2026-09-26')).fetchedAt).toBe('2026-09-26T07:59:00.000Z');
    expect(gh.read(entryPath('TO3416', '2026-09-26')).fetchedAt).toBe('2026-09-26T07:59:00.000Z');
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

describe('refresco operativo: uno solo, de 3 h antes de la salida a 2 h después de la llegada, si la base era de antes del día', () => {
  const base = { status: 'found', number: 'TO3416', date: '2026-09-26', fetchedAt: '2026-09-24T09:00:00.000Z', legs: normalizeFlights(TO3416) };
  const dep = Date.parse('2026-09-26T10:30Z'), arr = Date.parse('2026-09-26T14:30Z'); // programadas (NTE → AYT)
  const H = 3600000;
  it('abrir 2 h antes de la salida → sí', () => expect(refreshDue(base, dep - 2 * H)).toBe(true));
  it('abrir durante el vuelo → sí', () => expect(refreshDue(base, dep + 2 * H)).toBe(true));
  it('abrir 1 h después de la llegada → sí', () => expect(refreshDue(base, arr + H)).toBe(true));
  it('fuera de la ventana → no (más de 3 h antes de salir, más de 2 h después de llegar)', () => {
    expect(refreshDue(base, dep - 3 * H - 60000)).toBe(false);
    expect(refreshDue(base, arr + 2 * H + 60000)).toBe(false);
    expect(refreshDue(base, dep - 3 * H)).toBe(true); // bordes incluidos
    expect(refreshDue(base, arr + 2 * H)).toBe(true);
  });
  it('sin hora de llegada: salida + duración prevista + 2 h (sin duración: salida + 2 h)', () => {
    const noArr = l => ({ ...l, arr: { ...l.arr, sched: null } });
    const est = { ...base, legs: base.legs.map(l => ({ ...noArr(l), estMin: 240 })) };
    expect(refreshDue(est, dep + 5 * H)).toBe(true);
    expect(refreshDue(est, dep + 6 * H + 60000)).toBe(false);
    const none = { ...base, legs: base.legs.map(noArr) };
    expect(refreshDue(none, dep + 2 * H)).toBe(true);
    expect(refreshDue(none, dep + 2 * H + 60000)).toBe(false);
  });
  it('otras condiciones: base del mismo día, ya refrescado o negativa → no', () => {
    expect(refreshDue({ ...base, fetchedAt: '2026-09-26T05:00:00.000Z' }, dep - 3600000)).toBe(false); // base del mismo día (hora local de NTE)
    expect(refreshDue({ ...base, refreshedAt: '2026-09-26T08:00:00.000Z' }, dep - 3600000)).toBe(false);
    expect(refreshDue({ ...base, status: 'not_found', legs: [] }, dep - 3600000)).toBe(false);
  });
  it('un segundo refresco nunca ocurre: ni en la ventana, ni durante el vuelo, ni tras reiniciar Render', async () => {
    const store = createMemoryStore({ [entryPath('TO3416', '2026-09-26')]: base });
    const fetchFn = api(ok(TO3416));
    await make({ fetchFn, store, nowMs: dep - 2 * H }).adb.lookup('TO3416', '2026-09-26');
    for (const t of [dep - H, dep + 2 * H, arr + H]) await make({ fetchFn, store, nowMs: t }).adb.lookup('TO3416', '2026-09-26');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.files.get(entryPath('TO3416', '2026-09-26')).data.refreshedAt).toBe(new Date(dep - 2 * H).toISOString());
  });
  it('abrir durante el vuelo sin refresco previo → ese es el único refresco', async () => {
    const store = createMemoryStore({ [entryPath('TO3416', '2026-09-26')]: base });
    const fetchFn = api(ok(TO3416));
    const { adb } = make({ fetchFn, store, nowMs: dep + 2 * H });
    expect((await adb.lookup('TO3416', '2026-09-26')).refreshedAt).toBe(new Date(dep + 2 * H).toISOString());
    await adb.lookup('TO3416', '2026-09-26');
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
  it('health: estado y cupo sin la clave', async () => {
    const { adb } = make({ fetchFn: api(ok(TO3416, 300)) });
    await adb.lookup('TO3416', '2026-09-26');
    const h = adb.health();
    expect(h).toMatchObject({ configured: true, calls: 1, found: 1, quota: { limit: 400, remaining: 300 } });
    expect(JSON.stringify(h)).not.toContain(KEY);
  });
});

describe('caché en GitHub (rama data): conflictos como en GitHub', () => {
  it('dos escrituras concurrentes sobre la rama: la segunda recibe 409, relee, reintenta y las dos quedan guardadas', async () => {
    const gh = fakeGithub();
    const s = createGithubStore({ token: 't0k3n', fetchFn: gh.fetch });
    await Promise.all([s.update('adb/2026-09-27/LH400.json', () => ({ status: 'found' })), s.update('adb/_quota.json', () => ({ remaining: 306 }))]);
    expect(gh.conflicts409).toBeGreaterThanOrEqual(1); // el mismo 409 que dio GitHub en producción
    expect(gh.read('adb/2026-09-27/LH400.json')).toEqual({ status: 'found' });
    expect(gh.read('adb/_quota.json')).toEqual({ remaining: 306 });
    const put = gh.requests.find(r => r.method === 'PUT');
    expect(put.url).toBe('https://api.github.com/repos/marinayjaime/turbi/contents/adb/2026-09-27/LH400.json');
    expect(put.body).toMatchObject({ branch: 'data', message: 'AeroDataBox: adb/2026-09-27/LH400.json' });
    expect(put.auth).toBe('Bearer t0k3n');
  });
  it('422 al crear porque el archivo ya existe: se relee y manda lo guardado (sin sobrescribir)', async () => {
    const gh = fakeGithub();
    const s = createGithubStore({ token: 't', fetchFn: gh.fetch });
    gh.beforeFirstPut = () => gh.write('adb/x.json', { v: 'otro' });
    expect(await s.update('adb/x.json', cur => (cur ? null : { v: 'mío' }))).toEqual({ v: 'otro' });
    expect(gh.read('adb/x.json')).toEqual({ v: 'otro' });
  });
  it('un 422 que no es «archivo existente» no se toma por conflicto: error sin insistir', async () => {
    const gh = fakeGithub({ invalid: path => path.includes('mal') });
    const s = createGithubStore({ token: 't', fetchFn: gh.fetch });
    await expect(s.update('adb/mal.json', () => ({ a: 1 }))).rejects.toThrow('GitHub 422');
    expect(gh.requests.filter(r => r.method === 'PUT')).toHaveLength(1);
  });
  it('máximo 3 intentos: 409 continuos → error', async () => {
    const gh = fakeGithub({ always409: true });
    const s = createGithubStore({ token: 't', fetchFn: gh.fetch });
    await expect(s.update('adb/y.json', () => ({ a: 1 }))).rejects.toThrow('3 conflictos');
    expect(gh.requests.filter(r => r.method === 'PUT')).toHaveLength(3);
  });
  it('otros errores (500) lanzan', async () => {
    const gh = fakeGithub({ status500: true });
    await expect(createGithubStore({ token: 't', fetchFn: gh.fetch }).update('adb/z.json', () => ({ a: 1 }))).rejects.toThrow('GitHub 500');
  });
});

describe('persistencia en producción (GitHub simulado): la consulta queda guardada antes de responder', () => {
  const setup = (fetchFn, gh = fakeGithub(), nowMs = T0) => ({ gh, ...make({ fetchFn, store: createGithubStore({ token: 't', fetchFn: gh.fetch }), nowMs }) });
  it('escrituras en serie: primero adb/<fecha>/<vuelo>.json, después adb/_quota.json; nunca dos a la vez', async () => {
    const { adb, gh } = setup(api(ok(TO3416, 308)));
    await adb.lookup('LH400', '2026-09-27');
    expect(gh.read('adb/2026-09-27/LH400.json')).toMatchObject({ status: 'found', number: 'LH400', date: '2026-09-27' });
    expect(gh.committed).toEqual(['adb/2026-09-27/LH400.json', 'adb/_quota.json']);
    expect(gh.maxConcurrentPuts).toBe(1);
    expect(gh.conflicts409).toBe(0);
  });
  it('varias búsquedas distintas a la vez: todas guardadas, escrituras de una en una', async () => {
    const { adb, gh } = setup(vi.fn(async () => ok(TO3416, 300)));
    await Promise.all(['AA1', 'AA2', 'AA3'].map(n => adb.lookup(n, '2026-09-27')));
    for (const n of ['AA1', 'AA2', 'AA3']) expect(gh.read(`adb/2026-09-27/${n}.json`)).toMatchObject({ status: 'found' });
    expect(gh.maxConcurrentPuts).toBe(1);
  });
  it('encontrado y negativa: tras «reiniciar Render» (instancia nueva, misma rama) 0 llamadas nuevas', async () => {
    const gh = fakeGithub();
    const fetchFn = vi.fn(async url => (url.includes('LH400') ? ok(TO3416, 308) : empty(306)));
    // (misma fecha que el vuelo simulado: la base es del propio día, así que no hay refresco operativo en juego)
    await setup(fetchFn, gh).adb.lookup('LH400', '2026-09-26');
    await setup(fetchFn, gh).adb.lookup('KE1201', '2026-09-26');
    expect(gh.read('adb/2026-09-26/LH400.json')).toMatchObject({ status: 'found' });
    expect(gh.read('adb/2026-09-26/KE1201.json')).toMatchObject({ status: 'not_found' });
    const restarted = setup(fetchFn, gh).adb;
    expect((await restarted.lookup('LH400', '2026-09-26')).status).toBe('found');
    expect((await restarted.lookup('KE1201', '2026-09-26')).status).toBe('not_found');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it('si GitHub falla al guardar: se sirve lo obtenido y se guarda en la siguiente petición (sin volver a pagar)', async () => {
    const gh = fakeGithub({ put500: true });
    const fetchFn = api(ok(TO3416));
    const { adb } = setup(fetchFn, gh);
    expect((await adb.lookup('LH400', '2026-09-26')).status).toBe('found');
    expect(adb.health().saveFailures).toBe(1);
    gh.put500 = false;
    await adb.lookup('LH400', '2026-09-26');
    expect(gh.read('adb/2026-09-26/LH400.json')).toMatchObject({ status: 'found' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('tope de ráfaga: 15 llamadas reales al día (día de Europe/Madrid) + reserva de 20', () => {
  const nums = n => Array.from({ length: n }, (_, i) => `ZZ${100 + i}`);
  const many = (remaining = 300) => vi.fn(async () => ok(TO3416, remaining));
  it('llamadas 1–15 permitidas; la 16 bloqueada (con 300 unidades: el saldo ya no se reparte)', async () => {
    expect(DAY_CAP).toBe(15);
    const fetchFn = many();
    const { adb } = make({ fetchFn });
    for (const n of nums(15)) expect((await adb.lookup(n, '2026-09-27')).status).toBe('found');
    expect(await adb.lookup('ZZ999', '2026-09-27')).toMatchObject({ status: 'unavailable', reason: 'tope-diario' });
    expect(fetchFn).toHaveBeenCalledTimes(15);
    expect(adb.health().quota).toMatchObject({ dayCalls: 15, dayCap: 15, remaining: 300 });
    expect(adb.health().quota.dayBudget).toBeUndefined();
  });
  it('lo que sale de caché (memoria o rama data) no suma', async () => {
    const store = createMemoryStore();
    const fetchFn = many();
    const { adb } = make({ fetchFn, store }); // (fecha del vuelo simulado: sin refresco operativo en juego)
    await adb.lookup('ZZ1', '2026-09-26');
    for (let i = 0; i < 5; i++) await adb.lookup('ZZ1', '2026-09-26'); // memoria
    await make({ fetchFn, store }).adb.lookup('ZZ1', '2026-09-26'); // rama data (otro proceso)
    expect(adb.health()).toMatchObject({ memoryHits: 5, quota: { dayCalls: 1 } });
    expect(store.files.get('adb/_quota.json').data).toMatchObject({ dayCalls: 1, dayCap: 15 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('los reintentos reales y las negativas cuentan', async () => {
    const fetchFn = api(err(503), ok(TO3416), empty());
    const { adb } = make({ fetchFn });
    await adb.lookup('ZZ1', '2026-09-27'); // 503 + reintento
    await adb.lookup('ZZ2', '2026-09-27'); // 204
    expect(adb.health().quota.dayCalls).toBe(3);
  });
  it('reiniciar Render conserva el contador (adb/_quota.json)', async () => {
    const store = createMemoryStore();
    const fetchFn = many();
    const first = make({ fetchFn, store }).adb;
    for (const n of nums(10)) await first.lookup(n, '2026-09-27');
    expect(store.files.get('adb/_quota.json').data).toMatchObject({ day: '2026-09-26', dayCalls: 10 });
    const restarted = make({ fetchFn, store }).adb;
    for (const n of nums(15).slice(10)) expect((await restarted.lookup(n, '2026-09-27')).status).toBe('found');
    expect(await restarted.lookup('ZZ999', '2026-09-27')).toMatchObject({ status: 'unavailable', reason: 'tope-diario' });
    expect(fetchFn).toHaveBeenCalledTimes(15);
  });
  it('cambio de día en Europe/Madrid (no en UTC): a las 00:00 de Madrid se reinicia', async () => {
    // 26/09 23:59 en Madrid (CEST, UTC+2) = 21:59Z; 00:00 del 27 en Madrid = 22:00Z, aún 26 en UTC.
    const store = createMemoryStore({ 'adb/_quota.json': { limit: 400, remaining: 300, resetAt: Date.parse('2026-10-26T13:15Z'), day: '2026-09-26', dayCalls: 15 } });
    const fetchFn = many();
    const { adb, setNow } = make({ fetchFn, store, nowMs: Date.parse('2026-09-26T21:59Z') });
    expect(await adb.lookup('ZZ1', '2026-09-27')).toMatchObject({ status: 'unavailable', reason: 'tope-diario' });
    setNow(Date.parse('2026-09-26T22:00Z'));
    expect((await adb.lookup('ZZ2', '2026-09-27')).status).toBe('found');
    expect(adb.health().quota).toMatchObject({ day: '2026-09-27', dayCalls: 1 });
  });
  it('horario de invierno y de verano: la medianoche de Madrid cambia de hora UTC', () => {
    // 25/10/2026 fin del horario de verano: la medianoche del 26 en Madrid es 23:00Z (CET, UTC+1).
    expect(madridDay(Date.parse('2026-10-25T22:30Z'))).toBe('2026-10-25'); // con +2 fijo sería ya el 26
    expect(madridDay(Date.parse('2026-10-25T23:00Z'))).toBe('2026-10-26');
    // 28/03/2027 inicio del horario de verano: la medianoche del 29 en Madrid es 22:00Z (CEST, UTC+2).
    expect(madridDay(Date.parse('2027-03-28T21:59Z'))).toBe('2027-03-28');
    expect(madridDay(Date.parse('2027-03-28T22:30Z'))).toBe('2027-03-29'); // con +1 fijo seguiría siendo el 28
  });
  it('cambio de día justo tras el cambio a horario de invierno: el contador se reinicia a las 23:00Z', async () => {
    const store = createMemoryStore({ 'adb/_quota.json': { limit: 400, remaining: 300, resetAt: Date.parse('2026-11-20T00:00Z'), day: '2026-10-25', dayCalls: 15 } });
    const { adb, setNow } = make({ fetchFn: many(), store, nowMs: Date.parse('2026-10-25T22:30Z') });
    expect(await adb.lookup('ZZ1', '2026-10-26')).toMatchObject({ status: 'unavailable', reason: 'tope-diario' });
    setNow(Date.parse('2026-10-25T23:00Z'));
    expect((await adb.lookup('ZZ1', '2026-10-26')).status).toBe('found');
  });
  it('la reserva de 20 manda aunque el tope diario permita más', async () => {
    const store = createMemoryStore({ 'adb/_quota.json': { limit: 400, remaining: 23, resetAt: Date.parse('2026-10-26T13:15Z'), day: '2026-09-26', dayCalls: 0 } });
    const fetchFn = vi.fn(async () => ok(TO3416, 21));
    const { adb } = make({ fetchFn, store });
    expect((await adb.lookup('ZZ1', '2026-09-27')).status).toBe('found'); // 23 − 2 = 21 ≥ 20
    expect(await adb.lookup('ZZ2', '2026-09-27')).toMatchObject({ status: 'unavailable', reason: 'reserva' }); // 21 − 2 < 20
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
