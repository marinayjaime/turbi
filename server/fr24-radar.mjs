// Radar con Flightradar24 (fuente ÚNICA de radar/telemetría/identificación cuando FR24_API_TOKEN existe en Render):
// /radar/AL/N.json (vuelos de Aena) y /radar-adb/<vuelo>/<fecha>.json (vuelos de AeroDataBox). server/live.mjs elige este
// flujo o el antiguo de adsb.lol (que no se toca, para revertir quitando la variable). Aquí no hay adsb.lol, ni sus
// trazas, ni ADSBDB, ni VRS, ni identificación por zona, ni indicativos construidos: solo fr24Lookup (server/fr24.mjs)
// del número de vuelo. Principio: falso negativo antes que avión incorrecto, y una posición estimada nunca se pinta.
//   - Vuelo físico: el mismo que hoy (?leg=; sin él, solo si hay un único tramo elegible). Ninguna petición sin puerta.
//   - Candidato: solo los de FR24 con el MISMO origen y destino IATA que el tramo; uno (o el fr24Id ya asociado a este
//     vuelo físico, en memoria 24 h). Con varios compatibles, ninguno.
//   - Créditos: una respuesta por vuelo físico cada 60 s (también «sin datos» y «no disponible»; ?poll=1 igual) y las
//     peticiones simultáneas comparten la misma promesa. Sin reintentos, sin temporizadores, sin trabajos en segundo plano.
// El token nunca sale de server/fr24.mjs: las respuestas y el diagnóstico (?debug=1) son listas cerradas de campos.
import { fr24Lookup, fr24Configured, FLIGHT_RE } from './fr24.mjs';
import { radarGateFor, plannedMinFor, distanceKm, landedAt, POSITION_MAX_AGE_S } from './radar.mjs';
import { legTimes, aenaTz, RADAR_GATE } from '../js/radar-gate.js';
import { physicalFlightKey, samePhysicalFlight } from '../js/physical-flight.js';
import { adbPhysicalKey, adbRadarGate } from '../js/adb.js';

const CACHE_MS = 60000;
const ASSOC_MS = 24 * 3600000; // asociación vuelo físico → fr24Id: solo en memoria, purgada a las 24 h
const LOCATING_AFTER_MIN = 45; // «Localizando…» hasta la última salida conocida + 45 min (heurística)
const AIRBORNE_KT = 50; // FR24 da alt 0 en tierra; por debajo de 50 kt (rodaje, parado) no se da por volando
// Fuentes de posición REAL (decisión conservadora): cualquier otra (ESTIMATED, FAA, OTHER, vacía…) no es una medida.
export const REAL_SOURCES = new Set(['ADSB', 'MLAT', 'SATELLITE', 'UAT', 'FLARM']);
const RADAR_PATH = /^\/radar\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const ADB_RADAR_PATH = /^\/radar-adb\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };
const NO_STORE = { ...HEADERS, 'Cache-Control': 'no-store' };
const MIN = 60000;
const fin = v => Number.isFinite(v);

// Contadores de /health: solo llamadas reales a FR24 disparadas por usuarios (abrir /health no consulta FR24).
const freshStats = () => ({ requests: 0, cacheHits: 0, found: 0, notFound: 0, multiple: 0, unavailable: 0, estimated: 0 });
export const fr24Health = (state, env = process.env) => ({ configured: fr24Configured(env), ...freshStats(), ...state?.fr24Stats });

// Candidato de FR24 para un tramo o → a. associated: fr24Id ya aceptado para este vuelo físico.
// → { chosen | null, changed, reason, results, compatible }. Nunca se elige entre varios compatibles.
export function fr24Pick(candidates, { o, a, associated = null }) {
  const compatible = candidates.filter(c => c.originIata === o && c.destinationIata === a);
  const out = (chosen, extra = {}) => ({ chosen, changed: false, reason: null, results: candidates.length, compatible: compatible.length, ...extra });
  if (associated) {
    const same = compatible.find(c => c.fr24Id === associated);
    if (same) return out(same);
    // El avión asociado sigue en FR24 pero con otra ruta: no se cambia de avión por eso.
    if (candidates.some(c => c.fr24Id === associated)) return out(null, { reason: 'asociado-otra-ruta' });
    if (compatible.length === 1) return out(compatible[0], { changed: true }); // otro fr24Id, único compatible
  } else if (compatible.length === 1) return out(compatible[0]);
  return out(null, { reason: compatible.length > 1 ? 'varios-compatibles' : candidates.length ? 'otra-ruta' : 'no-aparece' });
}

// Candidato normalizado (normalizeFlight) → respuesta del radar con el contrato que ya usa js/radar.js.
// ctx: { dest, origin: [lat, lon] | null, depMs: salida más reciente conocida (UTC) | null, nowMs }.
export function fr24Result(c, { dest = null, origin = null, depMs = null, nowMs = Date.now() } = {}) {
  const id = c.fr24Id ? { fr24Id: c.fr24Id } : {};
  // Estimada o de fuente desconocida: no es evidencia física; sin posición ni telemetría (Aena no queda tapada).
  if (!REAL_SOURCES.has(String(c.source ?? '').toUpperCase())) return { state: 'sin-datos', fr24Estimated: true, ...id };
  // Sin hora válida de la posición no se inventa su antigüedad: no se afirma nada.
  const tsMs = typeof c.timestamp === 'string' ? Date.parse(c.timestamp) : NaN;
  if (!fin(tsMs)) return { state: 'sin-datos' };
  const posAgeS = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  const hasPos = fin(c.lat) && fin(c.lon);
  if (fin(c.alt) && c.alt > 0 && fin(c.gspeed) && c.gspeed >= AIRBORNE_KT) {
    const out = { state: 'volando', ...id, callsign: c.callsign ?? null, hex: c.hex ?? null, reg: c.reg ?? null, type: c.type ?? null,
      altFt: c.alt, altM: Math.round(c.alt * 0.3048), kmh: Math.round(c.gspeed * 1.852), vRateFpm: fin(c.vspeed) ? c.vspeed : null,
      track: fin(c.track) ? c.track : null, seenS: posAgeS, source: 'fr24', match: 'fr24' };
    if (dest && hasPos) out.remainingKm = Math.round(distanceKm([c.lat, c.lon], dest));
    // Posición medida de hace ≤ 60 s, tal cual (los tres campos juntos); si es más antigua, no existen (regla del frontend).
    if (hasPos && posAgeS <= POSITION_MAX_AGE_S) Object.assign(out, { lat: Math.round(c.lat * 1e4) / 1e4, lon: Math.round(c.lon * 1e4) / 1e4, posAgeS });
    return out;
  }
  // En tierra: aterrizado solo con las reglas de siempre (landedAt: en el destino, señal reciente y tiempo físico mínimo
  // desde la salida); rodando en el origen u otra cosa → no se afirma nada.
  const ground = (fin(c.alt) && c.alt <= 0) || (fin(c.gspeed) && c.gspeed < AIRBORNE_KT);
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

// Consulta (o caché) de un vuelo físico. q: { phys, number, o, a, ctx, pending, firstDep, latestDep, diagnostic, debug }.
async function serve(state, q, { fetchFn, env, nowMs }) {
  const stats = state.fr24Stats ??= freshStats();
  const cache = state.fr24Radar ??= new Map();
  const jobs = state.fr24Jobs ??= new Map();
  const send = ({ payload, diag }, extra = {}) => ({ status: 200,
    headers: payload.identifying || payload.state === 'no-disponible' ? NO_STORE : HEADERS,
    body: JSON.stringify(q.debug ? { ...payload, diagnostic: { ...q.diagnostic, ...diag, ...extra } } : payload) });
  const hit = cache.get(q.phys);
  if (hit && nowMs - hit.at < CACHE_MS) { stats.cacheHits++; return send(hit, { cached: true }); }
  if (jobs.has(q.phys)) { stats.cacheHits++; return send(await jobs.get(q.phys), { shared: true }); }
  const job = (async () => {
    stats.requests++;
    const r = await fr24Lookup(q.number, { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error' }));
    const key = { found: 'found', multiple: 'multiple', 'not-found': 'notFound' }[r.state] ?? 'unavailable';
    stats[key]++;
    let result, diag;
    if (key === 'unavailable') {
      result = { state: 'no-disponible' };
      diag = { lookup: 'unavailable', lookupReason: r.reason ?? null, ...(fin(r.httpStatus) ? { httpStatus: r.httpStatus } : {}), results: 0, compatible: 0, fr24Id: null, reason: 'no-disponible' };
    } else {
      const candidates = r.state === 'multiple' ? r.candidates ?? [] : r.state === 'found' ? [r] : [];
      const assoc = state.fr24Assoc ??= new Map();
      const known = assoc.get(q.phys);
      const pick = fr24Pick(candidates, { o: q.o, a: q.a, associated: known && nowMs - known.at <= ASSOC_MS ? known.fr24Id : null });
      result = pick.chosen ? fr24Result(pick.chosen, { ...q.ctx, nowMs }) : { state: 'sin-datos' };
      if (pick.chosen?.fr24Id) {
        for (const [k, v] of assoc) if (nowMs - v.at > ASSOC_MS) assoc.delete(k);
        assoc.set(q.phys, { fr24Id: pick.chosen.fr24Id, at: nowMs });
        if (pick.changed) result = { ...result, fr24IdChanged: true }; // el mapa coloca el avión sin animar
      }
      if (result.fr24Estimated) stats.estimated++;
      diag = { lookup: r.state, results: pick.results, compatible: pick.compatible, fr24Id: pick.chosen?.fr24Id ?? null,
        reason: pick.reason ?? (result.fr24Estimated ? 'estimada' : result.state === 'sin-datos' ? 'sin-posicion-en-vuelo' : null) };
    }
    // Aún sin avión cerca de la salida: la app sigue con su sondeo (la caché de 60 s lo deja en ~1 llamada/min).
    const identifying = result.state === 'sin-datos' && locating(q.firstDep, q.latestDep, nowMs) ? { identifying: true, phase: 'fr24' } : {};
    const payload = { ...result, ...identifying, ...q.pending, checked: new Date(nowMs).toISOString() };
    if (cache.size > 500) cache.clear();
    cache.set(q.phys, { at: nowMs, payload, diag });
    return { payload, diag };
  })().finally(() => jobs.delete(q.phys));
  jobs.set(q.phys, job);
  return send(await job);
}

const notApplicable = (nowMs, debug, diagnostic) => ({ status: 200, headers: HEADERS,
  body: JSON.stringify({ state: 'no-aplica', checked: new Date(nowMs).toISOString(), ...(debug ? { diagnostic } : {}) }) });

// GET /radar/AL/N.json?leg=<physicalFlightKey>[&poll=1][&debug=1] — vuelos de Aena.
export async function fr24RadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const debug = url.searchParams.get('debug') === '1';
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const tzs = l => ({ originTz: airports[l.o]?.[4] ?? aenaTz(l.o), destTz: airports[l.a]?.[4] ?? aenaTz(l.a) });
  const gateOf = l => radarGateFor(l, nowMs, { ...tzs(l), plannedMin: plannedMinFor(coords(l.o), coords(l.a)) });
  // Qué vuelo físico: exactamente como el flujo de adsb.lol (server/live.mjs), con la puerta ≠ none. La espera de
  // 15 min de «identify» no limita a FR24, y FR24 no necesita el código OACI (no se construyen indicativos).
  const legParam = url.searchParams.get('leg');
  const sameNumber = (state.legs ?? []).filter(l => l.al === m[1] && l.n === m[2]);
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
  const legDiag = legParam !== null ? { leg: legParam.slice(0, 64) } : {};
  if (!leg) return notApplicable(nowMs, debug, { source: 'fr24', gate: 'none', gateReason: legReason ?? 'vuelo-no-encontrado', ...legDiag });
  const gate = gateOf(leg);
  // Número: el de la operadora entre los códigos compartidos de Aena (el que vuela el avión), o el consultado.
  const operator = leg.op && leg.op !== leg.al ? (state.legs ?? []).find(l => l.al === leg.op && samePhysicalFlight(l, leg)) : null;
  const number = `${(operator ?? leg).al}${(operator ?? leg).n}`;
  const diagnostic = { source: 'fr24', gate: gate.mode, gateReason: gate.reason, ...legDiag, number, departureConfirmed: gate.confirmed };
  if (!FLIGHT_RE.test(number)) return notApplicable(nowMs, debug, { ...diagnostic, reason: 'numero-no-valido' });
  const origin = coords(leg.o), dest = coords(leg.a);
  const planned = plannedMinFor(origin, dest);
  const { schedDepMs, estDepMs, arrMs } = legTimes(leg, tzs(leg));
  let firstDep = fin(schedDepMs) && fin(estDepMs) ? Math.min(schedDepMs, estDepMs) : fin(schedDepMs) ? schedDepMs : fin(estDepMs) ? estDepMs : null;
  let latestDep = fin(estDepMs) ? estDepMs : fin(schedDepMs) ? schedDepMs : null;
  if (latestDep === null && fin(arrMs) && planned > 0) firstDep = latestDep = arrMs - planned * MIN; // origen extranjero
  return serve(state, { phys: `phys|${physicalFlightKey(leg)}`, number, o: leg.o, a: leg.a, ctx: { origin, dest, depMs: latestDep },
    pending: gate.confirmed ? {} : { departureConfirmed: false }, firstDep, latestDep, diagnostic, debug }, { fetchFn, env, nowMs });
}

// GET /radar-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey>[&poll=1][&debug=1] — vuelos de AeroDataBox (sin Aena). Lee
// solo la caché de AeroDataBox (peek: 0 unidades) y busca en FR24 por el número comercial, sin exigir modeS ni indicativo.
export async function fr24AdbRadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(ADB_RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const debug = url.searchParams.get('debug') === '1';
  const legParam = url.searchParams.get('leg');
  const entry = state.adb ? await state.adb.peek(m[1], m[2]) : null;
  if (entry?.status !== 'found') return notApplicable(nowMs, debug, { source: 'fr24', reason: 'sin-horario-aerodatabox' });
  const legs = entry.legs ?? [];
  const leg = legParam !== null ? legs.find(l => adbPhysicalKey(entry, l) === legParam) : legs.length === 1 ? legs[0] : null;
  if (!leg) return notApplicable(nowMs, debug, { source: 'fr24', reason: legParam !== null ? 'tramo-desconocido' : 'varios-tramos-sin-elegir' });
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const origin = coords(leg.o), dest = coords(leg.a);
  const gate = adbRadarGate(leg, entry, nowMs, { plannedMin: plannedMinFor(origin, dest), requireIdentifier: false });
  const number = String(entry.number ?? '');
  const diagnostic = { source: 'fr24', gate: gate.mode, gateReason: gate.reason, number, departureConfirmed: gate.confirmed };
  if (gate.mode === 'none') return notApplicable(nowMs, debug, diagnostic);
  if (!FLIGHT_RE.test(number)) return notApplicable(nowMs, debug, { ...diagnostic, reason: 'numero-no-valido' });
  const sched = leg.dep?.sched?.utc, est = (leg.dep?.runway ?? leg.dep?.revised)?.utc;
  const firstDep = fin(est) && fin(sched) ? Math.min(est, sched) : fin(sched) ? sched : null;
  const latestDep = fin(est) ? est : fin(sched) ? sched : null;
  return serve(state, { phys: adbPhysicalKey(entry, leg), number, o: leg.o, a: leg.a, ctx: { origin, dest, depMs: latestDep },
    pending: gate.confirmed ? {} : { departureConfirmed: false }, firstDep, latestDep, diagnostic, debug }, { fetchFn, env, nowMs });
}
