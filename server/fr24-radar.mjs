// Radar con Flightradar24 (fuente ÚNICA de radar/telemetría/identificación cuando FR24_API_TOKEN existe en Render):
// /radar/AL/N.json (vuelos de Aena) y /radar-adb/<vuelo>/<fecha>.json (vuelos de AeroDataBox). server/live.mjs elige este
// flujo o el antiguo de adsb.lol (que no se toca, para revertir quitando la variable). Aquí no hay adsb.lol, ni sus
// trazas, ni ADSBDB, ni VRS, ni identificación por zona, ni indicativos construidos: solo fr24Lookup (server/fr24.mjs)
// del número de vuelo. Principio: falso negativo antes que avión incorrecto, y una posición estimada nunca se pinta.
//   - Vuelo físico: el mismo que hoy (?leg=; sin él, solo si hay un único tramo elegible). Ninguna petición sin puerta.
//   - Candidato: solo los de FR24 con el MISMO origen y destino IATA que el tramo; uno (o el fr24Id ya asociado a este
//     vuelo físico, en memoria 24 h). Con varios compatibles, ninguno. Un fr24Id es de UN solo vuelo físico: si ya está
//     asociado a otro, no vale; y si hay otro tramo elegible del mismo número y ruta (p. ej. el de ayer, conservado por
//     keepDeparted), solo vale el ya asociado a este.
//   - Créditos: una respuesta por vuelo físico cada CACHE_MS = 40 s (también «sin datos» y «no disponible»; ?poll=1
//     igual), la respuesta cruda de FR24 por número consultado otros 40 s (la comparten tramos del mismo número y
//     /fr24-test) y las peticiones simultáneas comparten la misma promesa. Sin reintentos, sin temporizadores, sin trabajos
//     en segundo plano. 40 s (decisión del controlador, 21/10/2026) va con el seguimiento en vivo de la ficha
//     (js/live-tracker.js, cada 45 s): con 45 > 40 cada ciclo del navegador trae una lectura nueva y varios usuarios del
//     mismo vuelo comparten caché y promesa (≈ 1 llamada a FR24 por vuelo cada 45 s). El sondeo de «Localizando…»
//     (20/40/60/90… s) cae casi siempre dentro de la caché: como mucho una llamada cada 40–60 s, igual que con 60 s.
//   - Antigüedad al RESPONDER: desde la caché, posAgeS/seenS (y la pausa de un 429) se recalculan con el reloj del servidor
//     al servir y `checked` es esa misma hora; la posición (lat/lon/posAgeS) solo mientras tenga ≤ 180 s. La app suma
//     después su reloj monotónico, nunca el reloj civil del móvil. Sin caché HTTP en el navegador (no-store): una copia
//     guardada allí llevaría una antigüedad vieja.
// El token nunca sale de server/fr24.mjs: las respuestas y el diagnóstico (?debug=1) son listas cerradas de campos.
import { fr24Lookup, fr24Configured, FLIGHT_RE, REAL_SOURCES } from './fr24.mjs';
import { radarGateFor, plannedMinFor, distanceKm, landedAt, MAX_SEEN_S } from './radar.mjs';
import { legTimes, aenaTz, RADAR_GATE } from '../js/radar-gate.js';
import { physicalFlightKey, samePhysicalFlight } from '../js/physical-flight.js';
import { adbPhysicalKey, adbRadarGate } from '../js/adb.js';

const CACHE_MS = 40000;
export const ASSOC_MS = 24 * 3600000; // asociación vuelo físico → fr24Id: solo en memoria, purgada a las 24 h
const LOCATING_AFTER_MIN = 45; // «Localizando…» hasta la última salida conocida + 45 min (heurística)
const AIRBORNE_KT = 50; // FR24 da alt 0 en tierra; por debajo de 50 kt (rodaje, parado) no se da por volando
const FUTURE_TOLERANCE_MS = 30000; // una posición «del futuro» (reloj de FR24 o dato roto) no se toma por reciente
// Fuentes de posición REAL (REAL_SOURCES, server/fr24.mjs): cualquier otra (ESTIMATED, FAA, OTHER, vacía…) no es una medida.
export { REAL_SOURCES };
const RADAR_PATH = /^\/radar\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const ADB_RADAR_PATH = /^\/radar-adb\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
// Respuestas del radar FR24: nunca en la caché HTTP del navegador (su antigüedad es la del instante de responder).
const NO_STORE = { ...HEADERS, 'Cache-Control': 'no-store' };
const MIN = 60000;
const fin = v => Number.isFinite(v);

// Contadores de /health: solo llamadas reales a FR24 disparadas por usuarios (abrir /health no consulta FR24).
// trackRequests/trackCacheHits: Flight Tracks (estela, server/fr24-track.mjs). history…: Flight Summary (histórico,
// server/fr24-history.mjs): consultas reales, aciertos de memoria y de la rama data, resultados y créditos que dice FR24.
// discover…: resultados del descubrimiento (server/fr24-discover.mjs); sus consultas a FR24 ya cuentan en requests/cacheHits.
const freshStats = () => ({ requests: 0, cacheHits: 0, found: 0, notFound: 0, multiple: 0, unavailable: 0, estimated: 0, trackRequests: 0, trackCacheHits: 0, trackStoreHits: 0,
  historyRequests: 0, historyCacheHits: 0, historyStoreHits: 0, historyLanded: 0, historyNotFound: 0, historyMultiple: 0, historyOther: 0,
  historyUnavailable: 0, historyCredits: 0, discoverFound: 0, discoverKnown: 0, discoverNotFound: 0, discoverMultiple: 0, discoverEstimated: 0,
  discoverUnavailable: 0 });
export const fr24StatsOf = state => (state.fr24Stats ??= freshStats());
export const fr24Health = (state, env = process.env) => ({ configured: fr24Configured(env), ...freshStats(), ...state?.fr24Stats });

// Candidato de FR24 para un tramo o → a. associated: fr24Id ya aceptado para este vuelo físico; taken: fr24Id asociados
// (24 h) a OTROS vuelos físicos, que nunca valen; exclusiveOnly: hay otro tramo elegible del mismo número y ruta, así que
// solo vale el asociado. → { chosen | null, changed, reason, results, compatible }. Nunca se elige entre varios.
export function fr24Pick(candidates, { o, a, associated = null, taken = new Set(), exclusiveOnly = false }) {
  const sameRoute = candidates.filter(c => c.originIata === o && c.destinationIata === a);
  const compatible = sameRoute.filter(c => !(c.fr24Id && taken.has(c.fr24Id)));
  const out = (chosen, extra = {}) => ({ chosen, changed: false, reason: null, results: candidates.length, compatible: compatible.length, ...extra });
  if (associated) {
    const same = compatible.find(c => c.fr24Id === associated);
    if (same) return out(same);
    // El avión asociado sigue en FR24 pero con otra ruta: no se cambia de avión por eso.
    if (candidates.some(c => c.fr24Id === associated)) return out(null, { reason: 'asociado-otra-ruta' });
    if (!exclusiveOnly && compatible.length === 1) return out(compatible[0], { changed: true }); // otro fr24Id, único compatible
  } else if (!exclusiveOnly && compatible.length === 1) return out(compatible[0]);
  return out(null, { reason: exclusiveOnly && compatible.length ? 'varios-tramos-misma-ruta' : compatible.length > 1 ? 'varios-compatibles'
    : sameRoute.length ? 'asociado-a-otro-vuelo' : candidates.length ? 'otra-ruta' : 'no-aparece' });
}

// Candidato normalizado (normalizeFlight) → respuesta del radar con el contrato que ya usa js/radar.js.
// ctx: { dest, origin: [lat, lon] | null, depMs: salida más reciente conocida (UTC) | null, nowMs }.
export function fr24Result(c, { dest = null, origin = null, depMs = null, nowMs = Date.now() } = {}) {
  const id = c.fr24Id ? { fr24Id: c.fr24Id } : {};
  // Estimada o de fuente desconocida: no es evidencia física; sin posición ni telemetría (Aena no queda tapada).
  if (!REAL_SOURCES.has(String(c.source ?? '').toUpperCase())) return { state: 'sin-datos', fr24Estimated: true, ...id };
  // Sin hora válida de la posición no se inventa su antigüedad: no se afirma nada.
  const tsMs = typeof c.timestamp === 'string' ? Date.parse(c.timestamp) : NaN;
  if (!fin(tsMs) || tsMs > nowMs + FUTURE_TOLERANCE_MS) return { state: 'sin-datos' };
  const posAgeS = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  const hasPos = fin(c.lat) && fin(c.lon);
  if (fin(c.alt) && c.alt > 0 && fin(c.gspeed) && c.gspeed >= AIRBORNE_KT) {
    // Señal de hace más de 180 s (el mismo tope que adsb.lol): no se afirma «volando» con datos viejos que taparían a
    // Aena; la app usa su último avistamiento («Última señal: volando hace X min»).
    if (posAgeS > MAX_SEEN_S) return { state: 'sin-datos' };
    const out = { state: 'volando', ...id, callsign: c.callsign ?? null, hex: c.hex ?? null, reg: c.reg ?? null, type: c.type ?? null,
      altFt: c.alt, altM: Math.round(c.alt * 0.3048), kmh: Math.round(c.gspeed * 1.852), vRateFpm: fin(c.vspeed) ? c.vspeed : null,
      track: fin(c.track) ? c.track : null, seenS: posAgeS, source: 'fr24', match: 'fr24' };
    if (dest && hasPos) out.remainingKm = Math.round(distanceKm([c.lat, c.lon], dest));
    // Posición medida, tal cual (los tres campos juntos), mientras tenga ≤ 180 s (MAX_SEEN_S, ya garantizado arriba): la
    // app la pinta fresca hasta 60 s y como «última posición conocida», quieta y atenuada, hasta 180 s (js/card-model.js).
    if (hasPos) Object.assign(out, { lat: Math.round(c.lat * 1e4) / 1e4, lon: Math.round(c.lon * 1e4) / 1e4, posAgeS });
    return out;
  }
  // En tierra (altitud 0 Y menos de 50 kt, las dos conocidas): aterrizado solo con las reglas de siempre (landedAt: en el
  // destino, señal reciente y tiempo físico mínimo desde la salida); rodando en el origen, alto y lento, datos a medias…
  // → no se afirma nada.
  const ground = fin(c.alt) && c.alt <= 0 && fin(c.gspeed) && c.gspeed < AIRBORNE_KT;
  if (ground && hasPos) {
    const landed = landedAt({ alt_baro: 'ground', seen: posAgeS, seen_pos: posAgeS, flight: c.callsign ?? '', lat: c.lat, lon: c.lon },
      c.callsign ?? null, { dest, origin, depMs, nowMs, byHex: true });
    if (landed) return { ...landed, source: 'fr24', ...id, hex: c.hex ?? null };
  }
  return { state: 'sin-datos' };
}

// Ventana de «Localizando…»: desde la primera salida conocida − 5 min hasta la última + 45 min.
const locating = (firstDep, latestDep, nowMs) => fin(firstDep) && fin(latestDep)
  && nowMs >= firstDep - RADAR_GATE.earlyMin * MIN && nowMs <= latestDep + LOCATING_AFTER_MIN * MIN;

// fr24Lookup con caché de 40 s por número consultado y promesa compartida en curso (la usan el radar y /fr24-test).
// Los contadores de /health son de llamadas reales; una respuesta fallida también se guarda (también cuesta).
export async function fr24CachedLookup(state, number, { fetchFn = fetch, env = process.env, nowMs = Date.now() } = {}) {
  const stats = state.fr24Stats ??= freshStats();
  const cache = state.fr24Raw ??= new Map();
  const jobs = state.fr24RawJobs ??= new Map();
  const hit = cache.get(number);
  if (hit && nowMs - hit.at < CACHE_MS) { stats.cacheHits++; return hit.r; }
  if (jobs.has(number)) { stats.cacheHits++; return jobs.get(number); }
  const job = (async () => {
    stats.requests++;
    const r = await fr24Lookup(number, { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error', flight: number }));
    stats[{ found: 'found', multiple: 'multiple', 'not-found': 'notFound' }[r.state] ?? 'unavailable']++;
    if (cache.size > 500) cache.clear();
    cache.set(number, { at: nowMs, r });
    return r;
  })().finally(() => jobs.delete(number));
  jobs.set(number, job);
  return job;
}

// Motivo de «no disponible» para la app (js/live-tracker.js decide con él: 401/403 para, 429 espera, el resto con
// espera creciente). Lista cerrada; un motivo desconocido es 'http'.
const UNAVAILABLE_REASON = { autorizacion: 'autorizacion', 'sin-configurar': 'autorizacion', limite: 'limite', servidor: 'servidor',
  'respuesta-invalida': 'servidor', red: 'red', error: 'red', timeout: 'timeout', http: 'http' };

// La respuesta guardada (en `at`) tal como es en nowMs, con el reloj del servidor y `checked` = nowMs. posMs: instante
// EXACTO de la posición de FR24 (para «volando»): posAgeS y seenS salen de él (sin acumular redondeos de ±1 s). Si al
// servirla la posición ya pasa de 180 s (MAX_SEEN_S), es lo que fr24Result diría ahora: «sin-datos» sin telemetría. La
// pausa de un 429 (retryAfterSec) es la que queda.
export function agedPayload(payload, at, nowMs, posMs = null) {
  const checked = new Date(nowMs).toISOString();
  if (payload.state === 'volando' && fin(posMs)) {
    const ageS = Math.max(0, Math.round((nowMs - posMs) / 1000));
    if (ageS > MAX_SEEN_S) {
      return { state: 'sin-datos', source: payload.source, ...(payload.departureConfirmed === false ? { departureConfirmed: false } : {}), checked };
    }
    const out = { ...payload, seenS: ageS, checked };
    if (fin(out.posAgeS)) out.posAgeS = ageS;
    return out;
  }
  const out = { ...payload, checked };
  if (fin(out.retryAfterSec)) out.retryAfterSec = Math.max(0, Math.round(out.retryAfterSec - Math.max(0, nowMs - at) / 1000));
  return out;
}

// Consulta (o caché) de un vuelo físico. q: { phys (asociación), cacheKey, number, o, a, ctx, pending, firstDep, latestDep,
// exclusiveOnly, diagnostic, debug }. También la usa /radar-fr24 (server/fr24-discover.mjs).
export async function fr24Serve(state, q, { fetchFn, env, nowMs }) {
  const stats = state.fr24Stats ??= freshStats();
  const cache = state.fr24Radar ??= new Map();
  const jobs = state.fr24Jobs ??= new Map();
  const send = ({ payload: stored, diag, at, posMs }, extra = {}) => {
    const payload = agedPayload(stored, at, nowMs, posMs);
    return { status: 200, headers: NO_STORE,
      body: JSON.stringify(q.debug ? { ...payload, diagnostic: { ...q.diagnostic, ...diag, ...extra } } : payload) };
  };
  const hit = cache.get(q.cacheKey);
  if (hit && nowMs - hit.at < CACHE_MS) { stats.cacheHits++; return send(hit, { cached: true }); }
  if (jobs.has(q.cacheKey)) { stats.cacheHits++; return send(await jobs.get(q.cacheKey), { shared: true }); }
  const job = (async () => {
    const r = await fr24CachedLookup(state, q.number, { fetchFn, env, nowMs });
    let result, diag, posMs = null;
    if (!['found', 'multiple', 'not-found'].includes(r.state)) {
      result = { state: 'no-disponible', reason: UNAVAILABLE_REASON[r.reason] ?? 'http',
        ...(r.reason === 'limite' && fin(r.retryAfterSec) && r.retryAfterSec >= 0 ? { retryAfterSec: Math.round(r.retryAfterSec) } : {}) };
      diag = { lookup: 'unavailable', lookupReason: r.reason ?? null, ...(fin(r.httpStatus) ? { httpStatus: r.httpStatus } : {}), results: 0, compatible: 0, fr24Id: null, reason: 'no-disponible' };
    } else {
      const candidates = r.state === 'multiple' ? r.candidates ?? [] : r.state === 'found' ? [r] : [];
      const assoc = state.fr24Assoc ??= new Map();
      for (const [k, v] of assoc) if (nowMs - v.at > ASSOC_MS) assoc.delete(k);
      const taken = new Set([...assoc].filter(([k]) => k !== q.phys).map(([, v]) => v.fr24Id));
      const pick = fr24Pick(candidates, { o: q.o, a: q.a, associated: assoc.get(q.phys)?.fr24Id ?? null, taken, exclusiveOnly: q.exclusiveOnly });
      result = pick.chosen ? fr24Result(pick.chosen, { ...q.ctx, nowMs }) : { state: 'sin-datos' };
      if (result.state === 'volando') posMs = Date.parse(pick.chosen.timestamp); // ya validada por fr24Result
      if (pick.chosen?.fr24Id) {
        assoc.set(q.phys, { fr24Id: pick.chosen.fr24Id, at: nowMs });
        if (pick.changed) result = { ...result, fr24IdChanged: true }; // el mapa coloca el avión sin animar
      }
      if (result.fr24Estimated) stats.estimated++;
      diag = { lookup: r.state, results: pick.results, compatible: pick.compatible, fr24Id: pick.chosen?.fr24Id ?? null,
        reason: pick.reason ?? (result.fr24Estimated ? 'estimada' : result.state === 'sin-datos' ? 'sin-posicion-en-vuelo' : null) };
    }
    // Aún sin avión cerca de la salida: la app sigue con su sondeo (la caché de 40 s lo deja en ≤ 1 llamada cada 40–60 s).
    const identifying = result.state === 'sin-datos' && locating(q.firstDep, q.latestDep, nowMs) ? { identifying: true, phase: 'fr24' } : {};
    // source: 'fr24' en todas las respuestas, para que la ficha atribuya bien también «sin señal» y «aterrizado».
    const payload = { ...result, source: 'fr24', ...identifying, ...q.pending, checked: new Date(nowMs).toISOString() };
    if (cache.size > 500) cache.clear();
    cache.set(q.cacheKey, { at: nowMs, payload, diag, posMs });
    return { payload, diag, at: nowMs, posMs };
  })().finally(() => jobs.delete(q.cacheKey));
  jobs.set(q.cacheKey, job);
  return send(await job);
}

const notApplicable = (nowMs, debug, diagnostic) => ({ status: 200, headers: HEADERS,
  body: JSON.stringify({ state: 'no-aplica', checked: new Date(nowMs).toISOString(), ...(debug ? { diagnostic } : {}) }) });

// GET /radar/AL/N.json?leg=<physicalFlightKey>[&poll=1][&debug=1] — vuelos de Aena.
// Vuelo físico de Aena: el que pide la app (?leg=<physicalFlightKey>, solo entre los tramos de este número) o, sin ?leg,
// el único elegible; siempre con la puerta ≠ none. Exactamente como el flujo de adsb.lol (server/live.mjs); la espera de
// 15 min de «identify» no limita a FR24, y FR24 no necesita el código OACI. Lo usan /radar y /track (server/fr24-track.mjs).
export function fr24AenaLeg(state, al, n, legParam, { nowMs, airports = {} }) {
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const tzs = l => ({ originTz: airports[l.o]?.[4] ?? aenaTz(l.o), destTz: airports[l.a]?.[4] ?? aenaTz(l.a) });
  const gateOf = l => radarGateFor(l, nowMs, { ...tzs(l), plannedMin: plannedMinFor(coords(l.o), coords(l.a)) });
  const sameNumber = (state.legs ?? []).filter(l => l.al === al && l.n === n);
  let leg = null, legReason = null;
  if (legParam !== null) {
    const chosen = legParam.length <= 64 ? sameNumber.find(l => physicalFlightKey(l) === legParam) : null;
    if (!chosen) legReason = 'tramo-desconocido';
    else if (gateOf(chosen).mode === 'none') legReason = 'tramo-sin-radar';
    else leg = chosen;
  } else {
    const eligible = new Map();
    for (const l of sameNumber) if (gateOf(l).mode !== 'none' && !eligible.has(physicalFlightKey(l))) eligible.set(physicalFlightKey(l), l);
    if (eligible.size === 1) [leg] = eligible.values();
    else if (eligible.size > 1) legReason = 'varios-tramos-sin-elegir';
  }
  return { leg, legReason, coords, tzs, gateOf };
}

// GET /radar/AL/N.json?leg=<physicalFlightKey>[&poll=1][&debug=1] — vuelos de Aena.
export async function fr24RadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const debug = url.searchParams.get('debug') === '1';
  const legParam = url.searchParams.get('leg');
  const { leg, legReason, coords, tzs, gateOf } = fr24AenaLeg(state, m[1], m[2], legParam, { nowMs, airports });
  const legDiag = legParam !== null ? { leg: legParam.slice(0, 64) } : {};
  if (!leg) return notApplicable(nowMs, debug, { source: 'fr24', gate: 'none', gateReason: legReason ?? 'vuelo-no-encontrado', ...legDiag });
  const gate = gateOf(leg);
  // Número: el de la operadora entre los códigos compartidos de Aena (el que vuela el avión), o el consultado.
  const operator = leg.op && leg.op !== leg.al ? (state.legs ?? []).find(l => l.al === leg.op && samePhysicalFlight(l, leg)) : null;
  const number = `${(operator ?? leg).al}${(operator ?? leg).n}`;
  // Caché por vuelo físico solo si el número es seguro (el de la operadora); si no, también por número consultado: un
  // «sin datos» de un código comercial no se sirve a otro código del mismo vuelo.
  const phys = `phys|${physicalFlightKey(leg)}`;
  const cacheKey = operator || leg.op === leg.al ? phys : `${phys}|${number}`;
  // Otro tramo elegible con el mismo número y la misma ruta (p. ej. el de ayer): solo vale el fr24Id ya asociado.
  const exclusiveOnly = (state.legs ?? []).some(l => l.o === leg.o && l.a === leg.a && !samePhysicalFlight(l, leg)
    && ((l.al === leg.al && l.n === leg.n) || `${l.al}${l.n}` === number) && gateOf(l).mode !== 'none');
  const diagnostic = { source: 'fr24', gate: gate.mode, gateReason: gate.reason, ...legDiag, number, departureConfirmed: gate.confirmed };
  if (!FLIGHT_RE.test(number)) return notApplicable(nowMs, debug, { ...diagnostic, reason: 'numero-no-valido' });
  const origin = coords(leg.o), dest = coords(leg.a);
  const planned = plannedMinFor(origin, dest);
  const { schedDepMs, estDepMs, arrMs } = legTimes(leg, tzs(leg));
  let firstDep = fin(schedDepMs) && fin(estDepMs) ? Math.min(schedDepMs, estDepMs) : fin(schedDepMs) ? schedDepMs : fin(estDepMs) ? estDepMs : null;
  let latestDep = fin(estDepMs) ? estDepMs : fin(schedDepMs) ? schedDepMs : null;
  if (latestDep === null && fin(arrMs) && planned > 0) firstDep = latestDep = arrMs - planned * MIN; // origen extranjero
  return fr24Serve(state, { phys, cacheKey, number, o: leg.o, a: leg.a, ctx: { origin, dest, depMs: latestDep }, exclusiveOnly,
    pending: gate.confirmed ? {} : { departureConfirmed: false }, firstDep, latestDep, diagnostic, debug }, { fetchFn, env, nowMs });
}

// Vuelo físico de AeroDataBox: el que pide la app (?leg=<adbPhysicalKey>) o, sin ?leg, el único tramo. Lee solo la caché
// de AeroDataBox (peek: 0 unidades). gate: la puerta de siempre (sin exigir identificador). Lo usan /radar-adb y /track-adb.
export async function fr24AdbLeg(state, number, date, legParam, { nowMs, airports = {} }) {
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const entry = state.adb ? await state.adb.peek(number, date) : null;
  if (entry?.status !== 'found') return { leg: null, reason: 'sin-horario-aerodatabox', coords };
  const legs = entry.legs ?? [];
  const leg = legParam !== null ? legs.find(l => adbPhysicalKey(entry, l) === legParam) : legs.length === 1 ? legs[0] : null;
  if (!leg) return { entry, leg: null, reason: legParam !== null ? 'tramo-desconocido' : 'varios-tramos-sin-elegir', coords };
  const gate = adbRadarGate(leg, entry, nowMs, { plannedMin: plannedMinFor(coords(leg.o), coords(leg.a)), requireIdentifier: false });
  return { entry, leg, gate, coords };
}

// GET /radar-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey>[&poll=1][&debug=1] — vuelos de AeroDataBox (sin Aena). Lee
// solo la caché de AeroDataBox (peek: 0 unidades) y busca en FR24 por el número comercial, sin exigir modeS ni indicativo.
export async function fr24AdbRadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(ADB_RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const debug = url.searchParams.get('debug') === '1';
  const legParam = url.searchParams.get('leg');
  const { entry, leg, gate, reason, coords } = await fr24AdbLeg(state, m[1], m[2], legParam, { nowMs, airports });
  if (!leg) return notApplicable(nowMs, debug, { source: 'fr24', reason });
  const legs = entry.legs ?? [];
  const origin = coords(leg.o), dest = coords(leg.a);
  const number = String(entry.number ?? '');
  const diagnostic = { source: 'fr24', gate: gate.mode, gateReason: gate.reason, number, departureConfirmed: gate.confirmed };
  if (gate.mode === 'none') return notApplicable(nowMs, debug, diagnostic);
  if (!FLIGHT_RE.test(number)) return notApplicable(nowMs, debug, { ...diagnostic, reason: 'numero-no-valido' });
  const sched = leg.dep?.sched?.utc, est = (leg.dep?.runway ?? leg.dep?.revised)?.utc;
  const firstDep = fin(est) && fin(sched) ? Math.min(est, sched) : fin(sched) ? sched : null;
  const latestDep = fin(est) ? est : fin(sched) ? sched : null;
  const phys = adbPhysicalKey(entry, leg);
  const exclusiveOnly = legs.some(l => l !== leg && l.o === leg.o && l.a === leg.a && adbPhysicalKey(entry, l) !== phys
    && adbRadarGate(l, entry, nowMs, { plannedMin: plannedMinFor(coords(l.o), coords(l.a)), requireIdentifier: false }).mode !== 'none');
  return fr24Serve(state, { phys, cacheKey: phys, number, o: leg.o, a: leg.a, ctx: { origin, dest, depMs: latestDep }, exclusiveOnly,
    pending: gate.confirmed ? {} : { departureConfirmed: false }, firstDep, latestDep, diagnostic, debug }, { fetchFn, env, nowMs });
}
