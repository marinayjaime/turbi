// Identificación EXCEPCIONAL de un vuelo comercial → avión físico (hex ICAO) cuando la aerolínea no emite con su
// indicativo OACI + número (p. ej. Ryanair emite indicativos alfanuméricos como «RYR12AB»). Diseño: docs/turbi-roadmap.md.
//  - Solo si falla el indicativo exacto y Aena confirma salida y tipo de avión. Si Aena no identifica la operadora,
//    se prueban juntos los prefijos OACI del grupo de códigos compartidos, sin adivinar ninguno.
//  - Un candidato solo vale si cumple TODO a la vez: operadora posible (prefijo OACI del grupo), tipo compatible con
//    el de Aena, dentro del pasillo de la ruta, rumbo hacia el destino, recorrido físicamente posible y ruta exacta
//    (origen y destino) confirmada por adsbdb o por la base VRS de ADSB.lol. Si ambas están obsoletas, la traza debe
//    demostrar que ese indicativo salió del origen a la hora prevista. Debe ser el ÚNICO; si no, no se elige ninguno.
//  - Después, el avión se sigue solo por /v2/hex/. Un registro en memoria por vuelo físico (compartido por los códigos
//    compartidos y por todos los usuarios) evita repetir la identificación.
//  - Nunca hay mapeos fijos de indicativos ni de hex: los indicativos operativos se reasignan cada día.
// Todas las consultas a adsb.lol pasan por el limitador global (server/adsb.mjs).
import { adsbGet, adsbLimiter } from './adsb.mjs';
import { estimatedDepartureMs, distanceKm, airborne, landedAt, flyingResult, MAX_SEEN_S, radarGateFor, plannedMinFor } from './radar.mjs';
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
  traceDepartureWindowMin: 120, // margen alrededor de la salida de Aena para retrasos y salidas extranjeras estimadas
  adsbdbCacheMin: 360, // la ruta de un indicativo en adsbdb se guarda este tiempo (no se vuelve a pedir)
  sameRouteWindowMin: 120, // rivales de la misma ruta que se comprueban por progreso (no es un veto previo)
  cooldownMin: 10, // tras un fallo o una invalidación, sin reintentar durante este tiempo
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
  if (!leg || cancelled(leg) || !leg.ac || !operatorIcaos(leg, legs).length || estimatedDepartureMs(leg, origin, dest) === null) return false;
  return radarGateFor(leg, nowMs, { originTz, destTz, plannedMin: plannedMinFor(origin, dest) }).mode === 'identify';
}

// Ruta de un indicativo en adsbdb, con caché por indicativo (por cliente HTTP). Los fallos no se guardan.
const routeCaches = new WeakMap();
async function adsbdbRoute(callsign, fetchFn, limits) {
  const cache = routeCaches.get(fetchFn) ?? routeCaches.set(fetchFn, new Map()).get(fetchFn);
  const hit = cache.get(callsign);
  if (hit && Date.now() - hit.at < limits.adsbdbCacheMin * 60000) return hit.route;
  const route = await fetchRoute(callsign, fetchFn);
  if (route) { if (cache.size > 2000) cache.clear(); cache.set(callsign, { at: Date.now(), route }); }
  return route;
}

async function fetchRoute(callsign, fetchFn) {
  try {
    const res = await fetchFn(`${ADSBDB}${callsign}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) return null;
    const r = (await res.json())?.response?.flightroute;
    return { o: r?.origin?.iata_code ?? null, a: r?.destination?.iata_code ?? null };
  } catch {
    return null;
  }
}

// Segunda base pública de rutas, servida por ADSB.lol y actualizada cada hora. Se usa solo si adsbdb no coincide:
// los indicativos operativos se reutilizan y una de las dos bases puede conservar la asignación anterior.
async function fetchVrsRoute(callsign, fetchFn) {
  try {
    const res = await fetchFn(`${VRS_ROUTES}/${callsign.slice(0, 2)}/${callsign}.json`, {
      signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (res.status === 404) return { route: null, unavailable: false };
    if (!res.ok) return { route: null, unavailable: true };
    const data = await res.json();
    const airports = Array.isArray(data?._airports) ? data._airports.map(x => x?.iata).filter(Boolean) : [];
    const text = typeof data?._airport_codes_iata === 'string' ? data._airport_codes_iata.split('-').filter(Boolean) : [];
    const codes = airports.length >= 2 ? airports : text;
    return codes.length >= 2 ? { route: { o: codes[0], a: codes.at(-1) }, unavailable: false }
      : { route: null, unavailable: true };
  } catch {
    return { route: null, unavailable: true };
  }
}

// Los indicativos operativos se reutilizan y adsbdb puede conservar una ruta antigua. Como segunda prueba,
// tar1090 publica la traza reciente del hex: solo confirma un candidato si ESE MISMO indicativo apareció cerca del
// aeropuerto de origen y alrededor de la salida de Aena. No se acepta por estar simplemente dentro del pasillo.
async function traceStartedAtOrigin({ hex, callsign, origin, depMs, fetchFn, limits }) {
  try {
    const suffix = hex.slice(-2).toLowerCase();
    const res = await fetchFn(`${TRACE_BASE}/${suffix}/trace_full_${hex.toLowerCase()}.json`, {
      signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) return { match: false, unavailable: true };
    const data = await res.json();
    if (!Number.isFinite(data?.timestamp) || !Array.isArray(data.trace)) return { match: false, unavailable: true };
    const windowMs = limits.traceDepartureWindowMin * 60000;
    let activeCallsign = null;
    for (const point of data.trace) {
      const announced = point?.[8]?.flight?.trim();
      // Solo el inicio de cada tramo de indicativo puede confirmar el origen. Aceptar cualquier punto confundiría,
      // por ejemplo, un avión que llega a nuestro origen desde otro aeropuerto.
      if (!announced || announced === activeCallsign) continue;
      activeCallsign = announced;
      if (activeCallsign !== callsign || !Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1]) || !Number.isFinite(point?.[2])) continue;
      const at = (data.timestamp + point[0]) * 1000;
      if (Math.abs(at - depMs) > windowMs) continue;
      const originKm = distanceKm(origin, [point[1], point[2]]);
      if (originKm <= limits.traceOriginKm) return { match: true, unavailable: false, originKm, at };
    }
    return { match: false, unavailable: false };
  } catch {
    return { match: false, unavailable: true };
  }
}

// Identificación por zona. Devuelve { state: 'identificado', hex, callsign } | { state: 'ambiguo' | 'sin-datos' |
// 'no-disponible' | 'no-aplica' }. Nunca elige entre varios.
export async function identifyByZone({ leg, legs = [], origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS,
  onDiagnostic = null }) {
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
  let failed = false;
  let zoneFailed = false;
  for (const km of alongs) {
    diag.zoneCalls++;
    const [lat, lon] = pointAlong(origin, brg, km);
    const res = await adsbGet(`/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${limits.zoneRadiusNm}`, { fetchFn, limiter, priority: 'identificacion' });
    // Primer 429 (o pausa activa, o cancelada por un 429): se abandona la identificación entera en el acto.
    if (res.error === 'rate-limited') { diag.rateLimited = true; return done({ state: 'no-disponible', rateLimited: true }); }
    if (res.error) { failed = true; zoneFailed = true; continue; }
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
  const hasAmbiguousRival = ({ aircraft, operator }) => legs.some(rival => rival !== leg && rival.o === leg.o && rival.a === leg.a
    && !samePhysical(rival, leg) && operatorIcaos(rival, legs).includes(operator)
    && Math.abs((estimatedDepartureMs(rival, origin, dest) ?? Infinity) - depMs) <= limits.sameRouteWindowMin * 60000
    && (nowMs - estimatedDepartureMs(rival, origin, dest)) / 60000 > 0
    && corridor({ origin, dest, lat: aircraft.lat, lon: aircraft.lon, track: aircraft.track,
      elapsedMin: (nowMs - estimatedDepartureMs(rival, origin, dest)) / 60000 }, limits).ok);
  // Ruta exacta según adsbdb, candidato a candidato (en serie, sin prisa, con caché por indicativo).
  const matches = [];
  for (const candidate of candidates) {
    const { hex, callsign, aircraft, operator } = candidate;
    const route = await adsbdbRoute(callsign, fetchFn, limits);
    if (!route) { failed = true; continue; }
    if (route.o !== leg.o || route.a !== leg.a) continue;
    // Un vuelo próximo de la misma ruta ya no veta todo el intento. Solo bloquea este candidato si, con la hora de
    // salida de ese rival, su posición también sería físicamente compatible. Los rivales futuros se descartan solos.
    const ambiguousRival = hasAmbiguousRival({ aircraft, operator });
    if (!ambiguousRival) matches.push({ hex, callsign });
    else diag.blockedReason = 'rival-compatible';
  }
  diag.candidatesAfterRoute = matches.length;
  if (matches.length > 1) return done({ state: 'ambiguo' });
  if (matches.length) {
    if (!failed) {
      diag.identifiedBy = 'adsbdb';
      return done({ state: 'identificado', ...matches[0] });
    }
  }

  // Si adsbdb no coincide o dejó algún candidato sin respuesta, se contrasta la segunda base con TODOS. Se combinan
  // sus confirmaciones: si las dos fuentes señalan aviones distintos, el resultado es ambiguo, nunca se adivina.
  let vrsUnavailable = false;
  if (candidates.length) {
    diag.vrsCandidates = candidates.length;
    const checked = await Promise.all(candidates.map(async candidate => ({ candidate,
      vrs: await fetchVrsRoute(candidate.callsign, fetchFn) })));
    const vrsMatches = checked.filter(x => x.vrs.route?.o === leg.o && x.vrs.route?.a === leg.a)
      .filter(x => !hasAmbiguousRival(x.candidate));
    diag.vrsMatches = vrsMatches.length;
    vrsUnavailable = checked.some(x => x.vrs.unavailable);
    const confirmed = new Map(matches.map(x => [x.hex, x]));
    for (const { candidate } of vrsMatches) confirmed.set(candidate.hex, { hex: candidate.hex, callsign: candidate.callsign });
    if (confirmed.size > 1) return done({ state: 'ambiguo' });
    // Una zona que no respondió podría ocultar otro avión compatible. Aunque una ruta coincida, no elegimos por
    // descarte hasta haber visto todas las zonas previstas.
    if (confirmed.size === 1 && !vrsUnavailable && !zoneFailed) {
      const [result] = confirmed.values();
      diag.identifiedBy = matches.some(x => x.hex === result.hex) ? 'adsbdb' : 'vrs-route';
      const { hex, callsign } = result;
      return done({ state: 'identificado', hex, callsign });
    }
  }

  // Ninguna base de rutas ha dejado una confirmación segura: puede ser una asignación antigua de un indicativo
  // reutilizado. La traza reciente
  // aporta una prueba independiente y más fuerte: que el hex salió del origen a la hora de este vuelo. Se exige un
  // único candidato y que todas las trazas consultadas respondan, para no elegir por descarte tras un fallo de red.
  if (candidates.length && candidates.length <= limits.maxTraceCandidates) {
    diag.traceCandidates = candidates.length;
    const traced = await Promise.all(candidates.map(async candidate => ({ candidate,
      trace: await traceStartedAtOrigin({ hex: candidate.hex, callsign: candidate.callsign, origin, depMs, fetchFn, limits }) })));
    const unavailable = traced.some(x => x.trace.unavailable);
    const traceMatches = traced.filter(x => x.trace.match).filter(({ candidate }) => !hasAmbiguousRival(candidate));
    diag.traceMatches = traceMatches.length;
    if (traceMatches.length > 1) return done({ state: 'ambiguo' });
    if (traceMatches.length === 1 && !unavailable && !zoneFailed) {
      diag.identifiedBy = 'trace-origin';
      const { hex, callsign } = traceMatches[0].candidate;
      return done({ state: 'identificado', hex, callsign });
    }
    if (unavailable) failed = true;
  } else if (candidates.length > limits.maxTraceCandidates) {
    diag.blockedReason = 'demasiadas-trazas';
  }
  // Si algo falló, no se puede asegurar que el candidato sea el único: mejor no decir nada.
  if (failed || vrsUnavailable) return done({ state: 'no-disponible' });
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
export function createHexRegistry(limits = LIMITS) {
  const entries = new Map(); // phys → { hex, callsign, streak, diagnostic } | { until, diagnostic }
  const pending = new Map();
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
  const fail = (phys, nowMs, diagnostic = null) => entries.set(phys, { until: nowMs + limits.cooldownMin * 60000, diagnostic });

  return {
    get(phys) {
      const e = entries.get(phys);
      return e?.hex ? { state: 'identificado', hex: e.hex, callsign: e.callsign } : null;
    },
    busy: phys => pending.has(phys),
    status(phys, nowMs = Date.now()) {
      const e = entries.get(phys);
      return { busy: pending.has(phys), identified: Boolean(e?.hex), cooldownRemainingMs: e?.until && nowMs < e.until ? e.until - nowMs : 0,
        diagnostic: e?.diagnostic ?? null };
    },
    resolve(phys, attempt, nowMs) {
      const e = entries.get(phys);
      if (e?.hex) return Promise.resolve({ state: 'identificado', hex: e.hex, callsign: e.callsign });
      if (e && nowMs < e.until) return Promise.resolve(null);
      if (pending.has(phys)) return pending.get(phys);
      const p = enqueue(attempt).then(r => {
        if (r?.state === 'identificado' && r.hex) {
          entries.set(phys, { hex: r.hex, callsign: r.callsign, streak: 0, diagnostic: r.diagnostic ?? null });
          return { state: 'identificado', hex: r.hex, callsign: r.callsign };
        }
        // Un límite o fallo del proveedor es temporal y no dice nada sobre la identidad del vuelo: no se convierte
        // en diez minutos de bloqueo. Una consulta nueva podrá reintentarlo cuando acabe la pausa global.
        if (r?.state === 'no-disponible' || r?.rateLimited) entries.set(phys, { diagnostic: r?.diagnostic ?? null });
        else fail(phys, nowMs, r?.diagnostic ?? null);
        return null;
      }, () => { entries.set(phys, { diagnostic: { result: 'error-temporal' } }); return null; }).finally(() => pending.delete(phys));
      pending.set(phys, p);
      return p;
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
