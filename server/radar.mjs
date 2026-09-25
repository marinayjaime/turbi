// Radar (ADS-B) para vuelos cuya llegada no publica Aena (destino extranjero): ¿está el avión en el aire?
// Fuente gratuita y sin registro: adsb.lol. Solo se busca el vuelo consultado, por su indicativo exacto
// (código OACI de la aerolínea + número: EI737 → EIN737; con 1–2 cifras, también rellenado: UX15 → AEA015).
// Si la aerolínea emite con otro indicativo
// (p. ej. Aer Lingus EIN7LM), aquí no se encuentra: la identificación excepcional por ruta está en server/identify.mjs.
// Todas las consultas a adsb.lol pasan por el limitador global de server/adsb.mjs.
import { adsbGet, adsbLimiter } from './adsb.mjs';
import { buildRoute } from '../js/route.js';
import { radarGate, legTimes, aenaTz } from '../js/radar-gate.js';

export const MAX_SEEN_S = 180; // en zonas con poca cobertura las señales llegan más espaciadas
const PAUSE_MS = 1500; // espera antes de reintentar (adsb.lol responde 429 si se le pregunta demasiado seguido)
const RETRIES = 2;
const MAX_LOOKUPS = 4; // heurística: como mucho 4 indicativos por vuelo (códigos compartidos)
const WINDOW_H = 20; // se mira el radar hasta 20 h después de la salida
const CANARY = new Set(['LPA', 'TFN', 'TFS', 'ACE', 'FUE', 'SPC', 'VDE', 'GMZ']);
const DEPARTED = 'BOR'; // Aena (salida): Finalizado = ha despegado

// Hora local de Aena (en un aeropuerto español, de la península o de Canarias) → milisegundos UTC.
function aenaLocalMs(local, iata) {
  if (!local) return null;
  const guess = Date.parse(`${local}:00Z`);
  const tz = CANARY.has(iata) ? 'Atlantic/Canary' : 'Europe/Madrid';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).map(x => [x.type, x.value]));
  const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess;
  return guess - offset;
}

// Salida según Aena (solo si Aena controla el aeropuerto de origen), en UTC.
export function departureMs(leg) {
  return aenaLocalMs(leg.ed ?? (leg.sd ? `${leg.d}T${leg.sd}` : null), leg.o);
}

// Llegada según Aena (estimada o, si no, programada), en UTC.
export function arrivalMs(leg) {
  return aenaLocalMs(leg.ea ?? (leg.sa ? `${leg.d}T${leg.sa}` : null), leg.a);
}

// Salida para la coherencia temporal de la identificación por ruta: la de Aena si existe; si no (origen extranjero),
// ESTIMADA = llegada de Aena − duración estimada de la ruta (la misma que usa la app para «Salida estimada»).
// Solo de uso interno: nunca se presenta como hora oficial. origin/dest: [lat, lon].
export function estimatedDepartureMs(leg, origin, dest) {
  const dep = departureMs(leg);
  if (dep !== null) return dep;
  const arr = arrivalMs(leg);
  if (arr === null || !origin || !dest) return null;
  return arr - plannedMinFor(origin, dest) * 60000;
}

// ¿Se mira el radar? La regla está en js/radar-gate.js (compartida con la app): Aena no es el guardián del radar.
// originTz/destTz: zona de cada aeropuerto (por defecto, la de Aena: península o Canarias). plannedMin: duración
// estimada de la ruta (para calcular lo que Aena no publica); sin ella, solo cuentan las horas de Aena.
export function plannedMinFor(origin, dest) {
  return origin && dest ? buildRoute({ lat: origin[0], lon: origin[1] }, { lat: dest[0], lon: dest[1] }, 0).durationMin : null;
}
export function radarGateFor(leg, nowMs, { originTz = aenaTz(leg.o), destTz = aenaTz(leg.a), plannedMin = null } = {}) {
  return radarGate({ leg, nowMs, ...legTimes(leg, { originTz, destTz }), plannedMin });
}
export function needsRadar(leg, nowMs, opts = {}) {
  return Boolean(leg.icao) && radarGateFor(leg, nowMs, opts).mode !== 'none';
}

export function distanceKm([la1, lo1], [la2, lo2]) {
  const rad = x => (x * Math.PI) / 180;
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const wait = ms => (ms ? new Promise(r => setTimeout(r, ms)) : null);

// { data } o { error }: 'failed' = la consulta ha fallado (red, 5xx…): no se sabe nada, que no es lo mismo que «no
// está en el aire»; se reintenta. 'rate-limited' (429 o pausa global): nunca se reintenta dentro de la operación.
async function lookup(fetchFn, callsign, pauseMs, limiter) {
  let r;
  for (let i = 0; i <= RETRIES; i++) {
    if (i) await wait(pauseMs);
    r = await adsbGet(`/callsign/${callsign}`, { fetchFn, limiter });
    if (r.data || r.error === 'rate-limited') return r;
  }
  return r;
}

export const airborne = a => typeof a.alt_baro === 'number' && (a.seen ?? 0) <= MAX_SEEN_S;

// Aterrizaje confirmado por ADS-B (conservador; heurísticas documentadas):
//  - adsb.lol/readsb marca el avión en tierra con alt_baro === 'ground' (comprobado con datos reales, 25/09/2026);
//    poca altitud o poca velocidad NO cuentan;
//  - señal y posición recientes (seen y seen_pos ≤ LANDED_MAX_SEEN_S);
//  - posición válida a ≤ LANDED_MAX_KM del punto de referencia del aeropuerto de destino;
//  - mismo indicativo que se busca (o, si se sigue por hex ya identificado, ese mismo avión: byHex);
//  - y ya ha pasado el tiempo mínimo físico desde la salida (distancia en línea recta a MAX_KMH): así un avión que
//    llegó ayer y sigue aparcado en el destino con el mismo indicativo no confirma el vuelo de hoy.
const LANDED_MAX_SEEN_S = 120;
const LANDED_MAX_KM = 8;
const MAX_KMH = 950;
export function landedAt(a, callsign, { dest, origin, depMs, nowMs, byHex = false }) {
  if (a.alt_baro !== 'ground' || (!byHex && a.flight?.trim() !== callsign)) return null;
  if ((a.seen ?? Infinity) > LANDED_MAX_SEEN_S || (a.seen_pos ?? a.seen ?? Infinity) > LANDED_MAX_SEEN_S) return null;
  if (!dest || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
  const km = distanceKm([a.lat, a.lon], dest);
  if (km > LANDED_MAX_KM) return null;
  if (!origin || depMs === null || nowMs - depMs < (distanceKm(origin, dest) / MAX_KMH) * 3600000) return null;
  return { state: 'aterrizado', callsign, seenS: Math.round(a.seen ?? 0), distanceKm: Math.round(km), source: 'adsb.lol' };
}

// siblings: el mismo vuelo con otros números (códigos compartidos); el avión emite con el de la operadora.
// dest: [lat, lon] del destino, para calcular cuánto le queda (cálculo de Turbi, no una hora oficial).
export async function findOnRadar({ leg, siblings = [], fetchFn = fetch, pauseMs = PAUSE_MS, dest = null, origin = null, nowMs = Date.now(), limiter = adsbLimiter }) {
  // Indicativo = OACI + número. Si el número tiene 1 o 2 cifras, se prueba después la variante con ceros a la izquierda
  // (Air Europa UX15 emite «AEA015»). No se cambia el número original ni se prueba ninguna otra transformación.
  const variants = l => [`${l.icao}${l.n}`, ...(/^\d{1,2}$/.test(l.n) ? [`${l.icao}${l.n.padStart(3, '0')}`] : [])];
  // Límite de adsb.lol (~1 petición/s): si Aena dice quién opera, solo su indicativo; si no, el número buscado primero
  // y sus códigos compartidos, como mucho MAX_LOOKUPS consultas.
  const group = [leg, ...siblings].filter(l => l.icao);
  const operator = leg.op ? group.filter(l => l.al === leg.op) : [];
  const callsigns = [...new Set((operator.length ? operator : group).flatMap(variants))].slice(0, MAX_LOOKUPS);
  let failed = false, a = null, landed = null, callsign = callsigns[0];
  const ctx = { dest, origin, depMs: departureMs(leg), nowMs };
  for (const [i, cs] of callsigns.entries()) {
    if (i) await wait(pauseMs);
    const res = await lookup(fetchFn, cs, pauseMs, limiter);
    if (res.error === 'rate-limited') return { state: 'no-disponible' }; // adsb.lol en pausa: ni una consulta más
    if (res.error) { failed = true; continue; }
    const r = res.data;
    a = (r.ac ?? []).find(airborne);
    if (a) { callsign = cs; break; }
    landed ??= (r.ac ?? []).map(x => landedAt(x, cs, ctx)).find(Boolean) ?? null;
  }
  if (!a && landed) return landed; // en vuelo gana; si no, tierra confirmada en el destino
  if (!a) return failed ? { state: 'no-disponible' } : { state: 'sin-datos', callsign };
  return flyingResult(a, callsign, dest);
}

// Datos medidos del avión en el aire (sin ninguna estimación).
export function flyingResult(a, callsign, dest) {
  const kmh = Number.isFinite(a.gs) ? Math.round(a.gs * 1.852) : null;
  // Velocidad vertical directa de ADS-B (pies/min): barométrica y, si falta, geométrica.
  const vRate = Number.isFinite(a.baro_rate) ? a.baro_rate : Number.isFinite(a.geom_rate) ? a.geom_rate : null;
  const out = { state: 'volando', callsign, altFt: a.alt_baro, altM: Math.round(a.alt_baro * 0.3048), kmh, vRateFpm: vRate,
    seenS: Math.round(a.seen ?? 0), source: 'adsb.lol' };
  // Solo datos medidos: la llegada estimada la calcula la app (js/eta.js), con suavizado y sin tomar la velocidad
  // instantánea como velocidad media hasta el destino.
  if (dest && Number.isFinite(a.lat) && Number.isFinite(a.lon)) out.remainingKm = Math.round(distanceKm([a.lat, a.lon], dest));
  return out;
}
