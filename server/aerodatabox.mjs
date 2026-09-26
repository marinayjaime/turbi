// AeroDataBox (RapidAPI): horario de un vuelo concreto (número + fecha) cuando Aena no lo publica.
// Solo en Render: la clave (AERODATABOX_API_KEY) nunca sale de aquí. Nunca se usa para el radar (eso es ADSB.lol).
//
// Reglas de consumo (plan gratuito: 400 unidades/mes, 2 por llamada, también las 204):
//   - Una consulta base por vuelo + fecha, guardada de forma persistente (rama «data», ver adb-store.mjs).
//   - Si la base se obtuvo antes del día del vuelo, UN refresco operativo cuando alguien abre el vuelo en las 3 h previas
//     a la salida programada. Después, nunca más para ese vuelo + fecha.
//   - 204 / sin vuelos → negativa guardada (tampoco se repite).
//   - 5xx o tiempo agotado → un solo reintento a los 2–3 s; si falla, «no disponible» (no se guarda: la app sigue con
//     ADSBDB). 401/403/429 nunca se reintentan: AeroDataBox queda en pausa (401/403 hasta reiniciar con otra clave;
//     429 hasta la renovación del cupo).
//   - Reserva final de 20 unidades y un tope de ráfaga de 15 llamadas reales al día (día de Europe/Madrid): frena fallos o
//     abusos, no reparte el cupo del mes.
//   - Fechas de −2 a +60 días. Si la caché persistente no responde, no se consulta (no se puede garantizar el máximo).

import { refreshDue, REFRESH_WINDOW_MS } from '../js/adb.js';
import { buildRoute } from '../js/route.js';

export { refreshDue, REFRESH_WINDOW_MS };
const API = 'https://aerodatabox.p.rapidapi.com';
const HOST = 'aerodatabox.p.rapidapi.com';
export const UNITS_PER_CALL = 2;
export const RESERVE_UNITS = 20;
export const DAY_CAP = 15; // llamadas reales a AeroDataBox por día (base, refrescos, negativas y reintentos)
export const RANGE_DAYS = { past: 2, future: 60 };
const RETRY_DELAY_MS = 2500;
const TIMEOUT_MS = 12000;
const DAY_MS = 86400000;
const NUMBER_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUOTA_PATH = 'adb/_quota.json';

export const flightNumberKey = n => String(n ?? '').toUpperCase().replace(/\s+/g, '');
export const entryPath = (number, date) => `adb/${date}/${number}.json`;

// «2026-09-26 10:45+02:00» → { local: '2026-09-26T10:45', utc: ms, off: minutos }; «2026-09-26 08:45Z» para utc.
function time(t) {
  if (!t?.local || !t?.utc) return null;
  const utc = Date.parse(String(t.utc).replace(' ', 'T'));
  const m = String(t.local).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?([+-]\d{2}):?(\d{2})$/);
  if (!Number.isFinite(utc) || !m) return null;
  const sign = m[3].startsWith('-') ? -1 : 1;
  return { local: `${m[1]}T${m[2]}`, utc, off: sign * (Math.abs(Number(m[3])) * 60 + Number(m[4])) };
}

// Solo lo útil, normalizado: nunca cabeceras ni URLs. Tramos sin aeropuertos o sin hora programada se descartan.
export function normalizeFlights(body) {
  if (!Array.isArray(body)) return [];
  return body.filter(f => f?.isCargo !== true).map(f => ({
    number: flightNumberKey(f.number),
    airline: f.airline?.name ?? null,
    callSign: f.callSign ?? null,
    codeshareStatus: f.codeshareStatus ?? null,
    status: f.status ?? null,
    aircraft: f.aircraft?.model ?? null,
    o: f.departure?.airport?.iata ?? null,
    a: f.arrival?.airport?.iata ?? null,
    dep: { sched: time(f.departure?.scheduledTime), revised: time(f.departure?.revisedTime), runway: time(f.departure?.runwayTime) },
    arr: { sched: time(f.arrival?.scheduledTime), revised: time(f.arrival?.revisedTime), predicted: time(f.arrival?.predictedTime), runway: time(f.arrival?.runwayTime) },
    estMin: estimatedMin(f.departure?.airport?.location, f.arrival?.airport?.location),
  })).filter(l => l.o && l.a && l.dep.sched);
}

// Duración prevista de Turbi (la de buildRoute, por distancia) si AeroDataBox da la posición de los aeropuertos; si no, null.
function estimatedMin(from, to) {
  const ok = p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
  if (!ok(from) || !ok(to)) return null;
  try { return buildRoute({ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }, 0).durationMin; } catch { return null; }
}

const today = nowMs => new Date(nowMs).toISOString().slice(0, 10);
// Día del contador en la zona IANA Europe/Madrid (con su horario de verano e invierno), nunca con un desfase fijo.
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
export const madridDay = nowMs => MADRID_DAY.format(nowMs);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);

// store (adb-store.mjs): get(path) → { data, sha } | null (lanza si falla); update(path, next) → lo guardado (con la
// relectura y los reintentos ante 409/422). Las escrituras se hacen de una en una (nunca en paralelo): primero la consulta del
// vuelo y después el contador del cupo. Una consulta no se da por completada hasta que está guardada; si GitHub falla,
// se sirve igualmente (ya se pagó) y se vuelve a intentar guardar en la siguiente petición de ese vuelo.
export function createAerodatabox({ key, store, fetchFn = fetch, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} }) {
  const memory = new Map(); // número|fecha → entrada (encontrado o negativa)
  const inflight = new Map();
  const quota = { limit: null, remaining: null, resetAt: null, day: null, dayCalls: 0, loaded: false };
  const stats = { lookups: 0, memoryHits: 0, storeHits: 0, calls: 0, retries: 0, found: 0, notFound: 0, refreshes: 0, unavailable: {}, disabledUntil: null, disabledReason: null,
    saved: 0, saveFailures: 0 };
  let writes = Promise.resolve(); // cola: una escritura en GitHub cada vez
  const serial = fn => { const p = writes.then(fn, fn); writes = p.catch(() => {}); return p; };
  const unsaved = new Set(); // claves en memoria que aún no están en la rama data
  const unavailable = reason => { stats.unavailable[reason] = (stats.unavailable[reason] ?? 0) + 1; return { status: 'unavailable', reason }; };
  const publicEntry = e => ({ status: e.status, source: 'aerodatabox', number: e.number, date: e.date, fetchedAt: e.fetchedAt,
    ...(e.refreshedAt ? { refreshedAt: e.refreshedAt } : {}), legs: e.legs ?? [] });

  async function loadQuota() {
    if (quota.loaded) return;
    const q = await store.get(QUOTA_PATH).catch(() => null);
    if (q?.data) Object.assign(quota, { limit: q.data.limit ?? null, remaining: q.data.remaining ?? null, resetAt: q.data.resetAt ?? null,
      day: q.data.day ?? null, dayCalls: q.data.dayCalls ?? 0 });
    quota.loaded = true;
  }
  // Siempre en la cola y después de guardar la consulta del vuelo.
  async function saveQuota() {
    const data = { limit: quota.limit, remaining: quota.remaining, resetAt: quota.resetAt, day: quota.day, dayCalls: quota.dayCalls,
      dayCap: DAY_CAP, updatedAt: new Date(now()).toISOString() };
    try { await serial(() => store.update(QUOTA_PATH, () => data)); } catch { /* el contador es orientativo: nunca bloquea una respuesta */ }
  }
  // Guarda una entrada (en la cola). Si ya hay una guardada, manda la guardada, salvo que la nuestra traiga el único
  // refresco y la guardada no: así nunca se pierde ni se repite el refresco.
  async function persist(k, path, entry) {
    try {
      const kept = await serial(() => store.update(path, cur => (!cur || (entry.refreshedAt && !cur.refreshedAt) ? entry : null)));
      unsaved.delete(k);
      stats.saved++;
      return kept ?? entry;
    } catch {
      unsaved.add(k);
      stats.saveFailures++;
      return entry;
    }
  }

  // Cupo: reserva final de 20 unidades y tope de ráfaga diario (día de Europe/Madrid, persistido en adb/_quota.json).
  function canCall() {
    const t = now();
    if (stats.disabledUntil && t < stats.disabledUntil) return stats.disabledReason;
    if (quota.resetAt && t >= quota.resetAt) Object.assign(quota, { remaining: quota.limit, resetAt: null });
    if (quota.remaining !== null && quota.remaining - UNITS_PER_CALL < RESERVE_UNITS) return 'reserva';
    const d = madridDay(t);
    if (quota.day !== d) Object.assign(quota, { day: d, dayCalls: 0 });
    return quota.dayCalls >= DAY_CAP ? 'tope-diario' : null;
  }
  function readQuota(res) {
    const num = k => { const v = res.headers?.get?.(k); return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
    const remaining = num('x-ratelimit-api-units-remaining'), limit = num('x-ratelimit-api-units-limit'), reset = num('x-ratelimit-api-units-reset');
    if (remaining !== null) quota.remaining = remaining;
    if (limit !== null) quota.limit = limit;
    if (reset !== null) quota.resetAt = now() + reset * 1000;
  }
  function disable(reason, untilMs) {
    stats.disabledReason = reason;
    stats.disabledUntil = untilMs;
    log(`AeroDataBox en pausa (${reason}) hasta ${Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : 'reiniciar con otra clave'}`);
  }

  // Una llamada (con un reintento solo para 5xx o tiempo agotado). → { kind: 'found' | 'not_found' | 'fail', legs, reason }
  async function call(number, date) {
    const url = `${API}/flights/number/${encodeURIComponent(number)}/${date}?dateLocalRole=Departure&withAircraftImage=false&withFlightPlan=false&withLocation=false`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      quota.dayCalls++;
      stats.calls++;
      if (attempt === 2) stats.retries++;
      let res;
      try {
        res = await fetchFn(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': HOST, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        if (attempt === 1) { await sleep(RETRY_DELAY_MS); continue; }
        return { kind: 'fail', reason: 'tiempo-o-red' };
      }
      readQuota(res);
      if (res.status === 204 || res.status === 404) return { kind: 'not_found' };
      if (res.status === 401 || res.status === 403) { disable(`http-${res.status}`, Infinity); return { kind: 'fail', reason: `http-${res.status}` }; }
      if (res.status === 429) { disable('http-429', quota.resetAt ?? now() + 3600000); return { kind: 'fail', reason: 'http-429' }; }
      if (res.status >= 500) {
        if (attempt === 1) { await sleep(RETRY_DELAY_MS); continue; }
        return { kind: 'fail', reason: `http-${res.status}` };
      }
      if (!res.ok) return { kind: 'fail', reason: `http-${res.status}` };
      let body;
      try { body = await res.json(); } catch { return { kind: 'fail', reason: 'respuesta-invalida' }; }
      const legs = normalizeFlights(body);
      return legs.length ? { kind: 'found', legs } : { kind: 'not_found' };
    }
    return { kind: 'fail', reason: 'tiempo-o-red' };
  }

  async function resolve(number, date) {
    const k = `${number}|${date}`;
    const path = entryPath(number, date);
    let cached = memory.get(k);
    if (cached) {
      stats.memoryHits++;
      if (unsaved.has(k)) { cached = await persist(k, path, cached); memory.set(k, cached); } // guardado pendiente
    } else {
      let stored;
      try { stored = await store.get(path); } catch { return unavailable('cache'); } // sin caché fiable, no se llama
      if (stored?.data) { cached = stored.data; memory.set(k, cached); stats.storeHits++; }
    }
    const refreshing = cached && refreshDue(cached, now());
    if (cached && !refreshing) return publicEntry(cached);
    if (!key) return cached ? publicEntry(cached) : unavailable('sin-clave');
    await loadQuota();
    const blocked = canCall();
    if (blocked) return cached ? publicEntry(cached) : unavailable(blocked);

    const r = await call(number, date);
    if (r.kind === 'fail') { await saveQuota(); return cached ? publicEntry(cached) : unavailable(r.reason); }
    const at = new Date(now()).toISOString();
    // El refresco sustituye los datos si trae el vuelo; una negativa tardía no borra el horario ya conocido.
    const fresh = refreshing
      ? { ...cached, ...(r.kind === 'found' ? { legs: r.legs } : {}), refreshedAt: at }
      : r.kind === 'found' ? { status: 'found', number, date, fetchedAt: at, legs: r.legs } : { status: 'not_found', number, date, fetchedAt: at, legs: [] };
    if (refreshing) stats.refreshes++;
    const entry = await persist(k, path, fresh); // 1.º la consulta del vuelo…
    await saveQuota(); // …2.º el contador (nunca en paralelo)
    if (entry.status === 'found') stats.found++; else stats.notFound++;
    memory.set(k, entry);
    return publicEntry(entry);
  }

  return {
    async lookup(rawNumber, date) {
      stats.lookups++;
      const number = flightNumberKey(rawNumber);
      if (!NUMBER_RE.test(number) || !DATE_RE.test(date)) return unavailable('formato');
      const diff = dayDiff(date, today(now()));
      if (diff < -RANGE_DAYS.past || diff > RANGE_DAYS.future) return unavailable('fuera-de-rango');
      const k = `${number}|${date}`;
      if (!inflight.has(k)) inflight.set(k, resolve(number, date).finally(() => inflight.delete(k)));
      return inflight.get(k);
    },
    // Para /health: sin clave ni datos sensibles.
    health() {
      return { configured: Boolean(key), ...stats, quota: { limit: quota.limit, remaining: quota.remaining,
        resetAt: quota.resetAt ? new Date(quota.resetAt).toISOString() : null, day: quota.day, dayCalls: quota.dayCalls, dayCap: DAY_CAP } };
    },
  };
}
