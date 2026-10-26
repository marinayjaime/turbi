// Descubrimiento con Flightradar24: la TERCERA vía para encontrar un vuelo, solo si ni Aena ni AeroDataBox lo tienen (la
// app lo pide después de los dos) y solo para un vuelo que está volando AHORA. Caso real: EK2518 (26/10/2026), un A380
// de Emirates de Teruel (TEV, sin vuelos regulares) a Dubái, sin horario en Aena ni en AeroDataBox.
//   /discover-fr24/<vuelo>/<fecha>.json  → identidad del vuelo físico (o por qué no)
//   /radar-fr24/<vuelo>/<fecha>.json?leg=<fr24Key>  → el radar de siempre (fr24Serve) para ese vuelo ya descubierto
// Reglas (falso negativo antes que avión equivocado):
//   - Solo la fecha de hoy (discoveryLive): Flight Positions no reconstruye vuelos de ayer; eso es Flight Summary.
//   - El fr24CachedLookup de siempre (misma caché de 40 s por número, promesa compartida, contadores, token): ningún
//     cliente nuevo. Exactamente UN candidato con ese número, de fuente real (nunca ESTIMATED), volando (fr24Result:
//     en el aire con señal de ≤ 180 s), con fr24Id y con origen y destino que Turbi conoce por su código OACI (el IATA
//     puede repetirse). Varios → ninguno.
//   - La ficha es la de lo que FR24 da de verdad: ruta, avión, matrícula, operador, posición y su ETA. Sin horario
//     programado, terminal ni puerta: no se inventan.
//   - Una vez descubierto, su seguimiento es /radar-fr24 → fr24Serve: la misma caché, asociación (fr24Id) y sondeo de la
//     app que /radar y /radar-adb. Ningún sondeo paralelo.
//   - El vuelo descubierto se recuerda (memoria y rama data, fr24/discover-…): al aterrizar o dejar de aparecer en Flight
//     Positions la ficha sigue existiendo («known») y, 1 h después de su ETA, se cierra con Flight Summary por su fr24Id
//     exacto (una consulta; lo terminado se guarda y no se vuelve a pagar).
// El token nunca sale de server/fr24.mjs: las respuestas son listas cerradas de campos.
import { readFileSync } from 'node:fs';
import { fr24Configured, fr24Summary, FLIGHT_RE, FR24_ID_RE, REAL_SOURCES } from './fr24.mjs';
import { fr24CachedLookup, fr24Result, fr24Serve, fr24StatsOf } from './fr24-radar.mjs';
import { summaryOutcome } from './fr24-history.mjs';
import { discoveryLive, discoveryKnown, fr24Key, fr24HistoryDue, FR24_MAX_FLIGHT_MS } from '../js/fr24-discovery.js';

export const DISCOVER_PATH = /^\/discover-fr24\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
export const FR24_RADAR_PATH = /^\/radar-fr24\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const ICAO = JSON.parse(readFileSync(new URL('../data/icao.json', import.meta.url), 'utf8')); // IATA → OACI (con vuelos regulares)
const EXTRA = JSON.parse(readFileSync(new URL('../data/airports-fr24.json', import.meta.url), 'utf8')); // OACI → [IATA, …] (sin ellos)
const MISS_MS = 30 * 60000, FAIL_MS = 5 * 60000, STORE_MISS_MS = 10 * 60000;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const reply = (nowMs, out) => ({ status: 200, headers: HEADERS, body: JSON.stringify({ ...out, source: 'fr24', checked: new Date(nowMs).toISOString() }) });
const isoOrNull = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

// Aeropuerto de FR24 (IATA + OACI) → el de Turbi, solo si los DOS códigos son de ese aeropuerto: el de data/airports.json
// o, si no tiene vuelos regulares, el de data/airports-fr24.json (por OACI). Sin zona horaria, no vale. → objeto o null.
export function fr24Airport(iata, icao, { airports = {}, extra = EXTRA, icaoMap = ICAO } = {}) {
  if (typeof iata !== 'string' || typeof icao !== 'string') return null;
  const main = airports[iata];
  const r = main && icaoMap[iata] === icao ? main : extra[icao]?.[0] === iata ? extra[icao].slice(1) : null;
  return r?.[4] ? { iata, icao, name: r[0], city: r[1], lat: r[2], lon: r[3], tz: r[4] } : null;
}

// Candidatos de fr24Lookup → { chosen, origin, destination, radar } o { reason[, count] }. known: fr24Id del vuelo ya
// descubierto (solo vale ese, esté o no en el aire). Sin él: un único candidato, de fuente real y volando.
export function discoverPick(candidates, number, { known = null, nowMs = Date.now(), ...places } = {}) {
  const same = candidates.filter(c => c && (!c.flightNumber || c.flightNumber === number));
  const one = known ? same.find(c => c.fr24Id === known) : same.length === 1 ? same[0] : null;
  if (!one) return known ? { reason: 'ya-no-aparece' } : same.length > 1 ? { reason: 'varios', count: same.length } : { reason: 'no-aparece' };
  if (!FR24_ID_RE.test(one.fr24Id ?? '')) return { reason: 'sin-id' };
  if (!REAL_SOURCES.has(String(one.source ?? '').toUpperCase())) return { reason: 'estimada' };
  const origin = fr24Airport(one.originIata, one.origIcao, places), destination = fr24Airport(one.destinationIata, one.destIcao, places);
  if (!origin || !destination) return { reason: 'aeropuerto-desconocido' };
  if (origin.iata === destination.iata) return { reason: 'ruta-no-valida' };
  const radar = fr24Result(one, { origin: [origin.lat, origin.lon], dest: [destination.lat, destination.lon], nowMs });
  if (!known && radar.state !== 'volando') return { reason: 'no-en-vuelo' };
  return { chosen: one, origin, destination, radar };
}

const discoverPath = (number, date) => `fr24/discover-${number}_${date}.json`;
const closePath = (number, date) => `fr24/discover-${number}_${date}-cierre.json`;
const validRecord = (r, number, date) => r && r.number === number && r.date === date && FR24_ID_RE.test(r.fr24Id ?? '')
  && r.origin?.tz && r.destination?.tz && r.key === fr24Key(number, date, r.origin.iata, r.destination.iata);

// El vuelo ya descubierto de ese número y fecha: memoria o rama data (un «no hay» de la rama, 10 min en memoria).
async function knownRecord(state, number, date, nowMs) {
  const memory = state.fr24Discovered ??= new Map();
  const id = `${number}|${date}`;
  if (memory.has(id)) return memory.get(id);
  const store = state.historyStore ?? null;
  const misses = state.fr24DiscoverMiss ??= new Map();
  if (!store || nowMs - (misses.get(id) ?? -Infinity) < STORE_MISS_MS) return null;
  const saved = await store.get(discoverPath(number, date)).catch(() => null);
  if (!validRecord(saved?.data, number, date)) { misses.set(id, nowMs); return null; }
  memory.set(id, saved.data);
  return saved.data;
}

// Descubierto: en memoria (con la ETA más reciente), asociado a su vuelo físico para fr24Serve y, la primera vez, en la
// rama data (inmutable: si ya estaba, manda lo guardado). La escritura no retrasa la respuesta.
function remember(state, rec, isNew, nowMs) {
  (state.fr24Discovered ??= new Map()).set(`${rec.number}|${rec.date}`, rec);
  (state.fr24Assoc ??= new Map()).set(rec.key, { fr24Id: rec.fr24Id, at: nowMs });
  const store = state.historyStore ?? null;
  if (!isNew || !store) return;
  const q = state.historyWrites ?? Promise.resolve();
  state.historyWrites = q.then(() => store.update(discoverPath(rec.number, rec.date), cur => (cur ? null : rec))).catch(() => {});
}

// Cierre del vuelo descubierto con Flight Summary Light, por su fr24Id exacto: el número y la ruta OACI que vio FR24 y
// first_seen en las 20 h anteriores a verlo volando. Lo terminado se guarda (memoria y rama data); lo demás, 30 min en
// memoria (un fallo, 5). → { state: 'landed', takeoff, landed } | { state: 'diverted', destIcaoActual } | { state }.
async function closeKnown(state, rec, { fetchFn, env, nowMs }) {
  const stats = fr24StatsOf(state);
  const memory = state.fr24DiscoverClose ??= new Map();
  const hit = memory.get(rec.key);
  const final = r => r?.state === 'landed' || r?.state === 'diverted';
  if (hit && (final(hit.r) || nowMs - hit.at < (hit.r.state === 'unavailable' ? FAIL_MS : MISS_MS))) { stats.historyCacheHits++; return hit.r; }
  const store = state.historyStore ?? null, path = closePath(rec.number, rec.date);
  if (store) {
    const saved = await store.get(path).catch(() => null);
    if (final(saved?.data)) { memory.set(rec.key, { at: nowMs, r: saved.data }); stats.historyStoreHits++; return saved.data; }
  }
  const seen = Date.parse(rec.discoveredAt);
  stats.historyRequests++;
  const res = await fr24Summary({ flight: rec.number, origIcao: rec.origin.icao, destIcao: rec.destination.icao, fromMs: seen - FR24_MAX_FLIGHT_MS,
    toMs: Math.min(seen, nowMs) }, { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error' }));
  let r;
  if (res.state !== 'ok') { stats.historyUnavailable++; r = { state: 'unavailable' }; }
  else {
    if (Number.isFinite(res.credits)) stats.historyCredits += res.credits;
    const own = res.flights.filter(f => f.fr24Id === rec.fr24Id && f.flight === rec.number);
    const o = own.length === 1 ? summaryOutcome(own[0], rec.destination.icao) : { state: own.length ? 'multiple' : 'not-found' };
    r = o.state === 'landed' ? { state: 'landed', takeoff: o.takeoff, landed: o.landed }
      : o.state === 'diverted' ? { state: 'diverted', destIcaoActual: o.destIcaoActual } : { state: o.state };
    stats[r.state === 'landed' ? 'historyLanded' : r.state === 'not-found' ? 'historyNotFound' : r.state === 'multiple' ? 'historyMultiple' : 'historyOther']++;
  }
  memory.set(rec.key, { at: nowMs, r });
  if (final(r) && store) {
    const q = state.historyWrites ?? Promise.resolve();
    state.historyWrites = q.then(() => store.update(path, cur => (cur ? null : r))).catch(() => {});
    await state.historyWrites;
  }
  return r;
}

const STATE_OF = { varios: 'multiple', estimada: 'estimated' };
const UNAVAILABLE = { autorizacion: 'autorizacion', 'sin-configurar': 'autorizacion', limite: 'limite', servidor: 'servidor' };

// GET /discover-fr24/<vuelo>/<fecha>.json → { state: 'found' | 'known', key, number, date, fr24Id, origin, destination,
// reg, type, hex, callsign, operatingAs, eta, discoveredAt[, history] } | { state: 'not-found' | 'multiple' | 'estimated'
// | 'unavailable' | 'no-aplica', reason? }.
export async function fr24DiscoverResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env, extra = EXTRA, icaoMap = ICAO } = {}) {
  const m = new URL(path, 'http://turbi.local').pathname.match(DISCOVER_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const [, number, date] = m;
  if (!fr24Configured(env) || !FLIGHT_RE.test(number) || !discoveryKnown(date, nowMs)) return reply(nowMs, { state: 'no-aplica' });
  const stats = fr24StatsOf(state);
  let rec = state.fr24Discovered?.get(`${number}|${date}`) ?? null;
  let outcome = null;
  if (discoveryLive(date, nowMs)) {
    const r = await fr24CachedLookup(state, number, { fetchFn, env, nowMs });
    if (['found', 'multiple', 'not-found'].includes(r.state)) {
      const candidates = r.state === 'multiple' ? r.candidates ?? [] : r.state === 'found' ? [r] : [];
      const opts = { nowMs, airports, extra, icaoMap };
      let pick = discoverPick(candidates, number, { ...opts, known: rec?.fr24Id ?? null });
      // Render se reinició: el vuelo puede estar ya descubierto en la rama data (y entonces solo vale su fr24Id).
      if (!pick.chosen && !rec && (rec = await knownRecord(state, number, date, nowMs))) pick = discoverPick(candidates, number, { ...opts, known: rec.fr24Id });
      if (pick.chosen) {
        const c = pick.chosen;
        const fresh = { key: fr24Key(number, date, pick.origin.iata, pick.destination.iata), number, date, fr24Id: c.fr24Id,
          origin: pick.origin, destination: pick.destination, reg: c.reg ?? null, type: c.type ?? null, hex: c.hex ?? null,
          callsign: c.callsign ?? null, operatingAs: c.operatingAs ?? null, eta: isoOrNull(c.eta), discoveredAt: new Date(nowMs).toISOString() };
        rec = rec ? { ...rec, eta: fresh.eta ?? rec.eta } : fresh;
        remember(state, rec, rec === fresh, nowMs);
        stats.discoverFound++;
        return reply(nowMs, { state: 'found', ...rec });
      }
      outcome = { state: STATE_OF[pick.reason] ?? 'not-found', reason: pick.reason, ...(pick.count ? { count: pick.count } : {}) };
    } else outcome = { state: 'unavailable', reason: UNAVAILABLE[r.reason] ?? 'red', ...(Number.isFinite(r.retryAfterSec) ? { retryAfterSec: r.retryAfterSec } : {}) };
  }
  rec ??= await knownRecord(state, number, date, nowMs);
  if (!rec) {
    stats[outcome?.state === 'multiple' ? 'discoverMultiple' : outcome?.state === 'estimated' ? 'discoverEstimated' : outcome?.state === 'unavailable' ? 'discoverUnavailable' : 'discoverNotFound']++;
    return reply(nowMs, outcome ?? { state: 'not-found', reason: 'no-es-de-hoy' });
  }
  // Ya descubierto y FR24 ya no lo da en vivo (o ya no es hoy): lo que se vio y, si toca, cómo terminó.
  stats.discoverKnown++;
  const history = fr24HistoryDue(rec, nowMs) && fr24Configured(env) ? await closeKnown(state, rec, { fetchFn, env, nowMs }) : null;
  return reply(nowMs, { state: 'known', ...rec, ...(history ? { history } : {}) });
}

// GET /radar-fr24/<vuelo>/<fecha>.json?leg=<fr24Key>[&poll=1][&debug=1] — solo para un vuelo ya descubierto (su clave
// exacta). Es fr24Serve con el fr24Id asociado: la misma caché, la misma respuesta y el mismo sondeo que /radar-adb.
export async function fr24DiscoveredRadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(FR24_RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const [, number, date] = m;
  const debug = url.searchParams.get('debug') === '1';
  const none = reason => reply(nowMs, { state: 'no-aplica', ...(debug ? { diagnostic: { source: 'fr24', reason } } : {}) });
  if (!fr24Configured(env) || !discoveryKnown(date, nowMs)) return none('fuera-de-fecha');
  const rec = await knownRecord(state, number, date, nowMs);
  if (!rec || rec.key !== url.searchParams.get('leg')) return none('no-descubierto');
  const assoc = state.fr24Assoc ??= new Map();
  if (!assoc.has(rec.key)) assoc.set(rec.key, { fr24Id: rec.fr24Id, at: nowMs });
  const origin = [rec.origin.lat, rec.origin.lon], dest = [rec.destination.lat, rec.destination.lon];
  // depMs: la hora a la que FR24 lo vio volando (cota segura de la salida) para la regla del tiempo mínimo de aterrizaje.
  return fr24Serve(state, { phys: rec.key, cacheKey: rec.key, number, o: rec.origin.iata, a: rec.destination.iata,
    ctx: { origin, dest, depMs: Date.parse(rec.discoveredAt) }, exclusiveOnly: false, pending: {}, firstDep: null, latestDep: null,
    diagnostic: { source: 'fr24', discovered: true, number }, debug }, { fetchFn, env, nowMs });
}
