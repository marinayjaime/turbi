// Identificación EXCEPCIONAL de un vuelo comercial → avión físico (hex ICAO) cuando la aerolínea no emite con su
// indicativo OACI + número (p. ej. Ryanair emite indicativos alfanuméricos como «RYR12AB»). Diseño: docs/turbi-roadmap.md.
//  - Solo si falla el indicativo exacto y Aena confirma salida y tipo de avión. Si Aena no identifica la operadora,
//    se prueban juntos los prefijos OACI del grupo de códigos compartidos, sin adivinar ninguno.
//  - Un candidato solo vale si cumple TODO a la vez: operadora posible (prefijo OACI del grupo), tipo compatible con
//    el de Aena, dentro del pasillo de la ruta, rumbo hacia el destino, recorrido físicamente posible y ruta exacta
//    (origen y destino) confirmada por adsbdb o por la base VRS de ADSB.lol (se consultan las dos para todos). Si
//    ninguna la confirma (asignación antigua de un indicativo reutilizado) y el origen es de Aena, vale la traza:
//    ese indicativo despegó del origen a la hora prevista y ninguna otra salida de Aena de la misma operadora explica
//    el avión. Debe ser el ÚNICO y los demás candidatos tienen que quedar descartados por alguna prueba; si una zona,
//    una base o una traza fallan, no se elige por descarte.
//  - Después, el avión se sigue solo por /v2/hex/. Un registro en memoria por vuelo físico (compartido por los códigos
//    compartidos y por todos los usuarios) evita repetir la identificación.
//  - Nunca hay mapeos fijos de indicativos ni de hex: los indicativos operativos se reasignan cada día.
// Todas las consultas a adsb.lol pasan por el limitador global (server/adsb.mjs).
import { adsbGet, adsbLimiter } from './adsb.mjs';
import { estimatedDepartureMs, departureMs, distanceKm, airborne, landedAt, flyingResult, MAX_SEEN_S, radarGateFor, plannedMinFor } from './radar.mjs';
import { aircraftName } from '../js/plain.js';

// HEURÍSTICAS AJUSTABLES (valores razonables, no demostrados; revisar con casos reales). Todas las funciones aceptan
// un objeto `limits` para cambiarlas sin tocar el código.
export const LIMITS = {
  corridorKm: 180, // las rutas ATC reales pueden separarse bastante del círculo máximo (casos observados: 93 y ~140 km)
  alongSlackKm: 30, // margen antes del origen / después del destino a lo largo de la ruta
  maxTrackDiffDeg: 60, // diferencia máxima entre el rumbo del avión y el rumbo hacia el destino
  maxKmh: 1100, // velocidad máxima creíble respecto al suelo (con viento de cola fuerte)
  reachSlackKm: 50, // margen sobre la distancia máxima recorrible desde la salida
  minKmh: 300, // recorrido mínimo creíble a lo largo de la ruta, una vez en el aire (descarta vuelos que salieron después)
  taxiMin: 45, // tiempo desde la salida de Aena (calzos) sin exigir recorrido: rodaje, espera y ascenso
  cruiseKmh: 780, // velocidad media prevista para situar la zona de búsqueda a lo largo de la ruta
  zoneRadiusNm: 150, // radio de cada consulta por zona (adsb.lol admite hasta 250 NM)
  maxZoneCalls: 3, // consultas por zona por identificación, como mucho
  maxCandidates: 12, // candidatos que pasan los filtros gratuitos, como mucho; más → ambiguo (sin consultar adsbdb)
  maxTraceCandidates: 6, // si las bases de rutas están obsoletas, como mucho estas trazas se validan contra el origen
  traceOriginKm: 40, // una traza confirma el vuelo solo si ese indicativo apareció cerca del origen
  traceAwayKm: 20, // … y después, con el mismo indicativo, se alejó del origen al menos esto (despega, no llega)
  traceLagMin: 20, // retraso tolerado de la traza publicada; si no cubre la salida, «no» no vale como prueba
  traceDepartureWindowMin: 120, // margen alrededor de la salida de Aena para retrasos y salidas extranjeras estimadas
  adsbdbCacheMin: 360, // la ruta de un indicativo en adsbdb se guarda este tiempo (no se vuelve a pedir)
  sameRouteWindowMin: 120, // rivales de la misma ruta que se comprueban por progreso (no es un veto previo)
  cooldownMin: 10, // tras un fallo o una invalidación, sin reintentar durante este tiempo
  maxResumes: 6, // reanudaciones automáticas de una identificación cortada por un fallo temporal (429, red…)
  resumeMinSec: 30, // espera mínima antes de reanudar (si adsb.lol está en pausa, hasta que acabe la pausa)
  resumeIdleMin: 5, // sin nadie mirando el vuelo en este tiempo, no se reanuda (no se gasta cupo para nadie)
  invalidateAfter: 3, // lecturas seguidas con indicativo distinto para invalidar el hex
  contradictionCrossKm: 400, // lejos de la ruta más que esto → contradicción física clara
  groundAirportKm: 30, // en tierra a más de esto del origen y del destino → contradicción física clara
};

const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
const VRS_ROUTES = 'https://vrs-standing-data.adsb.lol/routes';
const TRACE_BASE = 'https://adsb.lol/data/traces';
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const R_KM = 6371;
const rad = d => (d * Math.PI) / 180, deg = r => (r * 180) / Math.PI;

function bearingDeg([la1, lo1], [la2, lo2]) {
  const φ1 = rad(la1), φ2 = rad(la2), Δλ = rad(lo2 - lo1);
  return (deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ))) + 360) % 360;
}
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function pointAlong([la1, lo1], brgDeg, km) {
  const δ = km / R_KM, φ1 = rad(la1), λ1 = rad(lo1), θ = rad(brgDeg);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [deg(φ2), deg(λ2)];
}

// ¿Puede ser el avión de esta ruta? Posición respecto al círculo máximo origen → destino (distancia lateral con signo
// y recorrido a lo largo), recorrido físicamente posible desde la salida (ni más de lo que se puede volar ni tan poco
// que sería un vuelo que salió después) y rumbo hacia el destino.
export function corridor({ origin, dest, lat, lon, track, elapsedMin }, limits = LIMITS) {
  const p = [lat, lon];
  const total = distanceKm(origin, dest);
  const d13 = distanceKm(origin, p) / R_KM;
  const θ = rad(bearingDeg(origin, p) - bearingDeg(origin, dest));
  const crossKm = Math.asin(Math.sin(d13) * Math.sin(θ)) * R_KM;
  const alongKm = Math.sign(Math.cos(θ)) * Math.acos(Math.min(1, Math.cos(d13) / Math.cos(crossKm / R_KM))) * R_KM;
  const out = { crossKm, alongKm };
  if (alongKm < -limits.alongSlackKm || alongKm > total + limits.alongSlackKm) return { ...out, ok: false, reason: 'fuera-de-tramo' };
  if (Math.abs(crossKm) > limits.corridorKm) return { ...out, ok: false, reason: 'lateral' };
  if (d13 * R_KM > (limits.maxKmh * elapsedMin) / 60 + limits.reachSlackKm) return { ...out, ok: false, reason: 'demasiado-lejos' };
  const minAlong = Math.min(total, (limits.minKmh * (elapsedMin - limits.taxiMin)) / 60) - limits.reachSlackKm;
  if (alongKm < minAlong) return { ...out, ok: false, reason: 'demasiado-atras' };
  if (!Number.isFinite(track) || angleDiff(track, bearingDeg(p, dest)) > limits.maxTrackDiffDeg) return { ...out, ok: false, reason: 'rumbo' };
  return { ...out, ok: true };
}

// Tipo de Aena (IATA, p. ej. 738W / 73H) frente al de ADS-B (OACI, p. ej. B738): mismo modelo en la tabla de la app.
// Un tipo desconocido nunca es compatible.
export function typeCompatible(aena, adsb) {
  if (!aena || !adsb) return false;
  const a = aircraftName(aena), b = aircraftName(adsb);
  return !a.startsWith('modelo ') && a === b;
}

const cancelled = leg => [leg.st, leg.std, leg.sta].some(f => f === 'CAN' || f === 'DES');
// Mismo vuelo físico: misma salida de Aena o, sin ella (origen extranjero), misma llegada.
const physOf = l => l.sd ?? `L${l.sa}`;
const samePhysical = (a, b) => a.d === b.d && a.o === b.o && a.a === b.a && physOf(a) === physOf(b);

// Si Aena conoce la operadora, solo se admite su OACI. Si no, todos los OACI distintos del mismo vuelo físico
// (códigos compartidos) se evalúan contra una única instantánea de zona. No se inventa ni se fija ninguna aerolínea.
export function operatorIcaos(leg, legs = []) {
  if (!leg) return [];
  if (leg.op) {
    const own = leg.op === leg.al ? leg.icao : null;
    const matched = legs.find(l => l.al === leg.op && l.icao)?.icao;
    return [...new Set([own, matched].filter(Boolean))];
  }
  return [...new Set([leg, ...legs.filter(l => samePhysical(l, leg))].map(l => l.icao).filter(Boolean))];
}

// ¿Se puede intentar? radarGate (js/radar-gate.js) lo permite ('identify': Aena confirma, o sin confirmar pasados
// 15 min de la salida más reciente), Aena da la operadora (y su código OACI) y el tipo de avión, y hay una hora de
// salida: la suya o, si el origen es extranjero, la ESTIMADA desde su llegada. tz: zonas de origen y destino.
export function canIdentify(leg, legs = [], { origin = null, dest = null, nowMs = Date.now(), originTz, destTz } = {}) {
  // Mismo aeropuerto de origen y destino: no hay ruta ni pasillo en el que buscar.
  if (!leg || leg.o === leg.a || cancelled(leg) || !leg.ac || !operatorIcaos(leg, legs).length || estimatedDepartureMs(leg, origin, dest) === null) return false;
  return radarGateFor(leg, nowMs, { originTz, destTz, plannedMin: plannedMinFor(origin, dest) }).mode === 'identify';
}

// Ruta de un indicativo según una base pública: { status: 'ok', route: { o, a } } | { status: 'desconocida' } (la
// base no conoce el indicativo: 404) | { status: 'fallo' } (red, 5xx, respuesta rara: no se sabe nada).
// Caché por indicativo y base (por cliente HTTP) para lo que la base sabe o no sabe; los fallos no se guardan.
const routeCaches = new WeakMap();
async function cachedRoute(source, callsign, fetchFn, limits) {
  const cache = routeCaches.get(fetchFn) ?? routeCaches.set(fetchFn, new Map()).get(fetchFn);
  const key = `${source}|${callsign}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < limits.adsbdbCacheMin * 60000) return hit.value;
  const value = await (source === 'adsbdb' ? fetchAdsbdbRoute : fetchVrsRoute)(callsign, fetchFn);
  if (value.status !== 'fallo') { if (cache.size > 4000) cache.clear(); cache.set(key, { at: Date.now(), value }); }
  return value;
}

const routeOf = (o, a) => (o && a ? { status: 'ok', route: { o, a } } : { status: 'fallo' });

async function fetchAdsbdbRoute(callsign, fetchFn) {
  try {
    const res = await fetchFn(`${ADSBDB}${callsign}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (res.status === 404) return { status: 'desconocida' };
    if (!res.ok) return { status: 'fallo' };
    const body = (await res.json())?.response;
    if (body === 'unknown callsign') return { status: 'desconocida' };
    return routeOf(body?.flightroute?.origin?.iata_code, body?.flightroute?.destination?.iata_code);
  } catch {
    return { status: 'fallo' };
  }
}

// Segunda base pública de rutas (VRS standing data, publicada por ADSB.lol en GitHub Pages; no es la API limitada).
// Los indicativos operativos se reutilizan y cualquiera de las dos bases puede conservar la asignación anterior.
async function fetchVrsRoute(callsign, fetchFn) {
  try {
    const res = await fetchFn(`${VRS_ROUTES}/${callsign.slice(0, 2)}/${callsign}.json`, {
      signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (res.status === 404) return { status: 'desconocida' };
    if (!res.ok) return { status: 'fallo' };
    const data = await res.json();
    const airports = Array.isArray(data?._airports) ? data._airports.map(x => x?.iata).filter(Boolean) : [];
    const text = typeof data?._airport_codes_iata === 'string' ? data._airport_codes_iata.split('-').filter(Boolean) : [];
    const codes = airports.length >= 2 ? airports : text;
    return routeOf(codes[0], codes.length >= 2 ? codes.at(-1) : null);
  } catch {
    return { status: 'fallo' };
  }
}

// Traza pública del hex en ADSB.lol (tar1090), pedida a través del limitador global como cualquier otra consulta.
// Resultado: 'si' (con ESE indicativo, el último punto cerca del origen —el despegue— cae a la hora de este vuelo y
// después se aleja), 'no' (la traza cubre la salida y no lo muestra) o 'desconocido' (sin traza, fallo, o la traza aún
// no llega a la salida). Un avión que llega al origen se acerca y se queda: nunca pasa por uno que despega.
async function traceFromOrigin({ hex, callsign, origin, depMs, nowMs, fetchFn, limiter, limits }) {
  const url = `${TRACE_BASE}/${hex.slice(-2).toLowerCase()}/trace_full_${hex.toLowerCase()}.json`;
  const res = await adsbGet(url, { fetchFn, limiter, priority: 'identificacion' });
  if (res.error === 'rate-limited') return { trace: 'desconocido', rateLimited: true };
  const data = res.data;
  if (res.error || !Number.isFinite(data?.timestamp) || !Array.isArray(data.trace)) return { trace: 'desconocido' };
  const windowMs = limits.traceDepartureWindowMin * 60000;
  let active = null, near = null;
  let lastAt = -Infinity;
  for (const point of data.trace) {
    if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1]) || !Number.isFinite(point?.[2])) continue;
    const at = (data.timestamp + point[0]) * 1000;
    lastAt = Math.max(lastAt, at);
    const announced = point[8]?.flight?.trim();
    if (announced && announced !== active) { active = announced; near = null; } // otro tramo de indicativo
    if (active !== callsign) continue;
    const km = distanceKm(origin, [point[1], point[2]]);
    if (km <= limits.traceOriginKm) near = { km, at };
    else if (near && km >= near.km + limits.traceAwayKm && Math.abs(near.at - depMs) <= windowMs) return { trace: 'si' };
  }
  // Si la traza publicada aún no llega al final de la ventana de salida (se publica con retraso), no demuestra nada.
  return { trace: lastAt >= Math.min(nowMs, depMs + windowMs) - limits.traceLagMin * 60000 ? 'no' : 'desconocido' };
}

// Identificación por zona. Devuelve { state: 'identificado', hex, callsign } | { state: 'ambiguo' | 'sin-datos' |
// 'no-disponible' | 'no-aplica' }. Nunca elige entre varios.
// coordsOf(iata) → [lat, lon] | null: coordenadas de otros aeropuertos, para comprobar rivales con otro destino.
export async function identifyByZone({ leg, legs = [], origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS,
  onDiagnostic = null, coordsOf = null }) {
  const diag = { attempted: true, blockedReason: null, operatorPrefixes: operatorIcaos(leg, legs), zoneCalls: 0,
    candidatesBeforeRoute: 0, candidatesAfterRoute: 0, traceCandidates: 0, traceMatches: 0, identifiedBy: null, rateLimited: false };
  const done = result => { onDiagnostic?.({ ...diag, result: result.state }); return result; };
  if (!origin || !dest) { diag.blockedReason = 'sin-coordenadas'; return done({ state: 'no-aplica' }); }
  if (!canIdentify(leg, legs, { origin, dest, nowMs })) {
    diag.blockedReason = !leg?.ac ? 'sin-tipo' : !diag.operatorPrefixes.length ? 'sin-operadora' : 'fuera-de-ventana';
    return done({ state: 'no-aplica' });
  }
  const depMs = estimatedDepartureMs(leg, origin, dest);
  const elapsedMin = (nowMs - depMs) / 60000;
  if (elapsedMin <= 0) { diag.blockedReason = 'antes-de-salida'; return done({ state: 'no-aplica' }); }

  // Zonas a lo largo de la ruta: primero donde debería ir, después delante y detrás (sin pasar de lo físicamente posible).
  const icaos = diag.operatorPrefixes;
  const total = distanceKm(origin, dest);
  const reach = Math.min(total, (limits.maxKmh * elapsedMin) / 60 + limits.reachSlackKm);
  const expected = Math.min(reach, (limits.cruiseKmh * elapsedMin) / 60);
  const step = limits.zoneRadiusNm * 1.852 * 1.6;
  const brg = bearingDeg(origin, dest);
  // `expected` supone crucero desde el minuto cero. En la realidad hay rodaje, espera y ascenso: cuando
  // expected-step cae antes del origen no se descarta esa tercera zona, se centra en el propio origen. Así un vuelo
  // retrasado respecto a la progresión teórica no desaparece justo después de despegar.
  const alongs = [expected, Math.min(reach, expected + step), Math.max(0, expected - step)]
    .filter((x, i, all) => all.indexOf(x) === i).slice(0, limits.maxZoneCalls);
  const found = new Map();
  let zoneFailed = false;
  for (const km of alongs) {
    diag.zoneCalls++;
    const [lat, lon] = pointAlong(origin, brg, km);
    const res = await adsbGet(`/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${limits.zoneRadiusNm}`, { fetchFn, limiter, priority: 'identificacion' });
    // Primer 429 (o pausa activa, o cancelada por un 429): se abandona la identificación entera en el acto.
    if (res.error === 'rate-limited') { diag.rateLimited = true; return done({ state: 'no-disponible', rateLimited: true }); }
    if (res.error) { zoneFailed = true; continue; }
    for (const a of res.data.ac ?? []) {
      const cs = a.flight?.trim();
      const operator = icaos.find(icao => cs?.startsWith(icao));
      if (!operator || !a.hex || !airborne(a) || (a.seen_pos ?? a.seen ?? Infinity) > MAX_SEEN_S) continue;
      if (!typeCompatible(leg.ac, a.t)) continue;
      if (!corridor({ origin, dest, lat: a.lat, lon: a.lon, track: a.track, elapsedMin }, limits).ok) continue;
      found.set(a.hex, { callsign: cs, aircraft: a, operator });
    }
  }
  diag.candidatesBeforeRoute = found.size;
  // Los candidatos salen solo de las consultas por zona; adsbdb es el filtro semántico (ruta exacta) posterior.
  if (found.size > limits.maxCandidates) { diag.blockedReason = 'demasiados-candidatos'; return done({ state: 'ambiguo' }); }
  const candidates = [...found].map(([hex, candidate]) => ({ hex, ...candidate }));
  // Otro vuelo de Aena de la MISMA operadora que ya ha salido cerca de nuestra hora y cuya propia ruta también
  // explicaría la posición y el rumbo del avión. sameRoute: solo los del mismo origen y destino (basta para una ruta
  // confirmada por una base); si no, todos los que salen de nuestro origen hacia cualquier destino (la traza solo
  // demuestra el origen). Un destino sin coordenadas conocidas cuenta como rival: no se puede descartar.
  const rivalFor = ({ aircraft, operator }, { sameRoute, windowMin }) => legs.some(rival => {
    if (rival === leg || rival.o !== leg.o || (sameRoute && rival.a !== leg.a) || samePhysical(rival, leg) || cancelled(rival)) return false;
    if (!operatorIcaos(rival, legs).includes(operator)) return false;
    const rivalDest = rival.a === leg.a ? dest : coordsOf?.(rival.a) ?? null;
    const rivalDep = estimatedDepartureMs(rival, origin, rivalDest);
    if (rivalDep === null || Math.abs(rivalDep - depMs) > windowMin * 60000 || nowMs <= rivalDep) return false;
    if (!rivalDest) return true;
    return corridor({ origin, dest: rivalDest, lat: aircraft.lat, lon: aircraft.lon, track: aircraft.track,
      elapsedMin: (nowMs - rivalDep) / 60000 }, limits).ok;
  });

  // 1) Ruta exacta según las DOS bases públicas, para TODOS los candidatos (en serie, con caché por indicativo). Una
  //    base obsoleta que da otra ruta no impide que la otra confirme; si confirman aviones distintos, es ambiguo.
  const ours = r => r.o === leg.o && r.a === leg.a;
  const evidence = [];
  for (const c of candidates) {
    const sources = { adsbdb: await cachedRoute('adsbdb', c.callsign, fetchFn, limits), vrs: await cachedRoute('vrs', c.callsign, fetchFn, limits) };
    const routes = Object.values(sources).filter(x => x.status === 'ok').map(x => x.route);
    const matchedBy = Object.keys(sources).filter(k => sources[k].status === 'ok' && ours(sources[k].route));
    const routeFailed = Object.values(sources).some(x => x.status === 'fallo');
    evidence.push({ ...c, matchedBy, routeFailed,
      // Descartado por ruta solo si ninguna base falló: la que no respondió podría haber confirmado este avión.
      otherRoute: !matchedBy.length && routes.length > 0 && !routeFailed,
      // Otra salida de NUESTRO aeropuerto hacia otro destino: la traza nunca puede convertirlo en nuestro vuelo.
      sameOriginElsewhere: routes.some(r => r.o === leg.o && r.a !== leg.a),
      sameRouteRival: rivalFor(c, { sameRoute: true, windowMin: limits.sameRouteWindowMin }) });
  }
  const confirmed = evidence.filter(e => e.matchedBy.length && !e.sameRouteRival);
  if (evidence.some(e => e.matchedBy.length && e.sameRouteRival)) diag.blockedReason = 'rival-compatible';
  diag.candidatesAfterRoute = confirmed.length;
  diag.routeSources = evidence.map(e => ({ callsign: e.callsign, matchedBy: e.matchedBy, otherRoute: e.otherRoute, routeFailed: e.routeFailed }));
  if (confirmed.length > 1) return done({ state: 'ambiguo' });
  // Una zona que no respondió podría ocultar otro avión compatible: nunca se elige por descarte.
  if (zoneFailed) return done({ state: 'no-disponible' });

  // 2) Trazas (a través del limitador): para los candidatos de los que ninguna base sabe nada y, si no hay ruta
  //    confirmada, para todos. Cada candidato no elegido debe quedar descartado por alguna prueba; si no, no se elige.
  const unresolved = evidence.filter(e => !e.matchedBy.length && !e.otherRoute);
  // Sin ruta confirmada, la traza solo puede confirmar si Aena publica las salidas de ese origen (conocemos todos los
  // rivales posibles); en un origen extranjero sería elegir por descarte entre vuelos que no vemos.
  const traceConfirms = !confirmed.length && departureMs(leg) !== null;
  // Sin ruta confirmada y sin poder confirmar por traza, ninguna traza cambiaría el resultado: no se piden.
  const toTrace = confirmed.length ? unresolved : traceConfirms ? evidence : [];
  if (toTrace.length > limits.maxTraceCandidates) { diag.blockedReason = 'demasiadas-trazas'; return done({ state: 'no-disponible' }); }
  diag.traceCandidates = toTrace.length;
  for (const e of toTrace) {
    const t = await traceFromOrigin({ hex: e.hex, callsign: e.callsign, origin, depMs, nowMs, fetchFn, limiter, limits });
    if (t.rateLimited) { diag.rateLimited = true; return done({ state: 'no-disponible', rateLimited: true }); }
    e.trace = t.trace;
  }
  const departedHere = toTrace.filter(e => e.trace === 'si');
  diag.traceMatches = departedHere.length;
  const traceUnknown = toTrace.some(e => e.trace === 'desconocido');

  if (confirmed.length === 1) {
    // Otro avión sin ruta conocida que también salió de nuestro origen a nuestra hora: dos candidatos válidos.
    if (departedHere.length) return done({ state: 'ambiguo' });
    if (traceUnknown) return done({ state: 'no-disponible' });
    const [c] = confirmed;
    diag.identifiedBy = c.matchedBy.includes('adsbdb') ? 'adsbdb' : 'vrs-route';
    return done({ state: 'identificado', hex: c.hex, callsign: c.callsign });
  }
  if (traceConfirms) {
    const valid = departedHere.filter(e => !e.sameOriginElsewhere && !e.sameRouteRival
      && !rivalFor(e, { sameRoute: false, windowMin: limits.traceDepartureWindowMin }));
    if (departedHere.length > valid.length) diag.blockedReason = 'rival-mismo-origen';
    if (valid.length > 1) return done({ state: 'ambiguo' });
    if (valid.length === 1 && !traceUnknown) {
      diag.identifiedBy = 'trace-origin';
      return done({ state: 'identificado', hex: valid[0].hex, callsign: valid[0].callsign });
    }
    // Salió de aquí pero otra salida de Aena también lo explica: podría ser cualquiera de las dos.
    if (departedHere.some(e => !e.sameOriginElsewhere)) return done({ state: traceUnknown ? 'no-disponible' : 'ambiguo' });
  }
  // Si algo falló, no se puede asegurar que no haya un candidato: mejor no decir nada.
  if (traceUnknown || evidence.some(e => e.routeFailed && !e.matchedBy.length)) return done({ state: 'no-disponible' });
  return done(diag.blockedReason === 'rival-compatible' ? { state: 'ambiguo' } : { state: 'sin-datos' });
}

// Seguimiento de un hex ya identificado. observation: 'compatible' (mismo indicativo y coherente), 'incompatible'
// (indicativo distinto), 'incompleta' (sin indicativo, sin señal o consulta fallida: no cuenta ni a favor ni en contra)
// o 'contradiccion' (físicamente imposible para este vuelo). result: lo que se muestra, o null.
export async function trackByHex({ entry, leg, origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS }) {
  const res = await adsbGet(`/hex/${entry.hex}`, { fetchFn, limiter }); // prioridad de radar: es el seguimiento normal
  if (res.error === 'rate-limited') return { observation: 'incompleta', result: { state: 'no-disponible' } };
  const ac = res.data?.ac ?? [];
  const a = ac.find(x => x.hex === entry.hex) ?? ac[0];
  if (!a) return { observation: 'incompleta', result: null };
  const depMs = estimatedDepartureMs(leg, origin, dest);
  const cs = a.flight?.trim();
  if (a.alt_baro === 'ground') {
    const pos = Number.isFinite(a.lat) && Number.isFinite(a.lon) ? [a.lat, a.lon] : null;
    if (pos && distanceKm(pos, dest) > limits.groundAirportKm && distanceKm(pos, origin) > limits.groundAirportKm) {
      return { observation: 'contradiccion', result: null };
    }
    if (cs && cs !== entry.callsign) return { observation: 'incompatible', result: null };
    const landed = landedAt(a, entry.callsign, { dest, origin, depMs, nowMs, byHex: true });
    return { observation: cs ? 'compatible' : 'incompleta', result: landed && { ...landed, callsign: entry.callsign, hex: entry.hex, match: 'ruta' } };
  }
  if (!airborne(a) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return { observation: 'incompleta', result: null };
  const c = corridor({ origin, dest, lat: a.lat, lon: a.lon, track: a.track, elapsedMin: (nowMs - depMs) / 60000 }, limits);
  if (c.reason === 'demasiado-lejos' || Math.abs(c.crossKm) > limits.contradictionCrossKm) return { observation: 'contradiccion', result: null };
  if (!cs) return { observation: 'incompleta', result: null };
  if (cs !== entry.callsign) return { observation: 'incompatible', result: null };
  return { observation: 'compatible', result: { ...flyingResult(a, cs, dest), hex: entry.hex, match: 'ruta' } };
}

// Registro en memoria vuelo físico → hex. Una sola identificación en curso por vuelo; las de vuelos distintos, una
// detrás de otra; tras un fallo o una invalidación, cooldownMin sin reintentar.
// Un fallo TEMPORAL (429 de adsb.lol, zona o traza sin respuesta: resultado 'no-disponible') no es definitivo: el
// vuelo queda «interrumpido» y el propio registro reanuda la identificación cuando acaba la pausa (resumeAt), como
// mucho maxResumes veces y solo si alguien ha mirado el vuelo hace poco (touch). Mientras, busy() sigue siendo true:
// ninguna consulta, sondeo ni usuario arranca otra identificación del mismo vuelo.
// opts.resumeAt(result) → ms (reloj real) en que se puede reanudar; opts.setTimer/clearTimer: para las pruebas.
export function createHexRegistry(limits = LIMITS, {
  // Nunca antes de que acabe la pausa global de adsb.lol (+2 s de margen) ni antes de resumeMinSec.
  resumeAt = () => Math.max(adsbLimiter.blockedUntil + 2000, Date.now() + limits.resumeMinSec * 1000),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
  const entries = new Map(); // phys → { hex, callsign, streak, diagnostic } | { until, diagnostic } | { interrupted, … }
  const pending = new Map();
  const interest = new Map(); // phys → última vez (reloj real) que alguien pidió el radar de ese vuelo
  let running = false;
  const waiting = [];
  // Cola en serie que arranca la tarea en el acto si no hay otra en marcha.
  const enqueue = task => new Promise((resolve, reject) => {
    const queuedAt = Date.now();
    const run = () => {
      running = true;
      let p;
      try { p = Promise.resolve(task({ queueWaitMs: Math.max(0, Date.now() - queuedAt) })); } catch (err) { p = Promise.reject(err); }
      p.then(resolve, reject).finally(() => { running = false; waiting.shift()?.(); });
    };
    if (running) waiting.push(run); else run();
  });
  const clearResume = phys => { const e = entries.get(phys); if (e?.timer) clearTimer(e.timer); };
  const fail = (phys, nowMs, diagnostic = null) => { clearResume(phys); entries.set(phys, { until: nowMs + limits.cooldownMin * 60000, diagnostic }); };
  const watched = phys => Date.now() - (interest.get(phys) ?? -Infinity) <= limits.resumeIdleMin * 60000;

  // attempt({ queueWaitMs, sinceMs }): sinceMs = tiempo real desde la primera petición (para su reloj en las reanudaciones).
  function start(phys, attempt, nowMs, firstAt, resumes) {
    const p = enqueue(({ queueWaitMs }) => attempt({ queueWaitMs, sinceMs: Date.now() - firstAt })).then(r => {
      if (r?.state === 'identificado' && r.hex) {
        entries.set(phys, { hex: r.hex, callsign: r.callsign, streak: 0, diagnostic: r.diagnostic ?? null });
        return { state: 'identificado', hex: r.hex, callsign: r.callsign };
      }
      if (r?.state === 'no-disponible' || r?.rateLimited) {
        // Temporal: se reanuda sola tras la pausa. Agotadas las reanudaciones, queda como antes (sin cooldown: una
        // consulta normal posterior puede volver a intentarlo).
        if (resumes < limits.maxResumes) {
          const at = Math.max(resumeAt(r), Date.now() + 1000);
          const timer = setTimer(() => {
            const e = entries.get(phys);
            if (!e?.interrupted || e.timer !== timer) return;
            if (!watched(phys)) { entries.set(phys, { diagnostic: e.diagnostic }); return; }
            start(phys, attempt, nowMs, firstAt, resumes + 1);
          }, at - Date.now());
          entries.set(phys, { interrupted: true, resumeAt: at, resumes: resumes + 1, timer, rateLimited: Boolean(r?.rateLimited),
            diagnostic: r?.diagnostic ?? null });
        } else entries.set(phys, { diagnostic: r?.diagnostic ?? null });
        return null;
      }
      fail(phys, nowMs, r?.diagnostic ?? null);
      return null;
    }, () => { entries.set(phys, { diagnostic: { result: 'error-temporal' } }); return null; }).finally(() => pending.delete(phys));
    pending.set(phys, p);
    return p;
  }

  return {
    get(phys) {
      const e = entries.get(phys);
      return e?.hex ? { state: 'identificado', hex: e.hex, callsign: e.callsign } : null;
    },
    // En curso o interrumpida a la espera de reanudarse: en ambos casos, nadie arranca otra.
    busy: phys => pending.has(phys) || Boolean(entries.get(phys)?.interrupted),
    // Alguien ha pedido el radar de este vuelo (las reanudaciones solo siguen si alguien mira).
    touch(phys) { interest.set(phys, Date.now()); if (interest.size > 2000) interest.clear(); },
    status(phys, nowMs = Date.now()) {
      const e = entries.get(phys);
      return { busy: pending.has(phys) || Boolean(e?.interrupted), identified: Boolean(e?.hex),
        cooldownRemainingMs: e?.until && nowMs < e.until ? e.until - nowMs : 0,
        interrupted: Boolean(e?.interrupted) && !pending.has(phys),
        retryAfterSec: e?.interrupted && !pending.has(phys) ? Math.max(0, Math.ceil((e.resumeAt - Date.now()) / 1000)) : 0,
        resumes: e?.resumes ?? 0, diagnostic: e?.diagnostic ?? null };
    },
    resolve(phys, attempt, nowMs) {
      const e = entries.get(phys);
      if (e?.hex) return Promise.resolve({ state: 'identificado', hex: e.hex, callsign: e.callsign });
      if (e?.until && nowMs < e.until) return Promise.resolve(null);
      if (pending.has(phys)) return pending.get(phys);
      if (e?.interrupted) return Promise.resolve(null); // ya hay una reanudación programada
      return start(phys, attempt, nowMs, Date.now(), 0);
    },
    invalidate(phys, nowMs) { fail(phys, nowMs); },
    // Una sola lectura nunca invalida: hacen falta invalidateAfter seguidas con indicativo distinto, o una
    // contradicción física clara. Devuelve true si el hex queda invalidado.
    observe(phys, observation, nowMs) {
      const e = entries.get(phys);
      if (!e?.hex) return false;
      if (observation === 'compatible') e.streak = 0;
      else if (observation === 'incompatible') e.streak++;
      if (observation === 'contradiccion' || e.streak >= limits.invalidateAfter) { fail(phys, nowMs); return true; }
      return false;
    },
    get size() { return entries.size; },
  };
}
