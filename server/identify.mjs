// Identificación EXCEPCIONAL de un vuelo comercial → avión físico (hex ICAO) cuando la aerolínea no emite con su
// indicativo OACI + número (p. ej. Ryanair emite indicativos alfanuméricos como «RYR12AB»). Diseño: docs/turbi-roadmap.md.
//  - Solo si falla el indicativo exacto y Aena confirma salida, operadora y tipo de avión.
//  - Un candidato solo vale si cumple TODO a la vez: misma operadora (prefijo OACI del indicativo), tipo compatible con
//    el de Aena, dentro del pasillo de la ruta, rumbo hacia el destino, recorrido físicamente posible y ruta exacta
//    (origen y destino) según adsbdb. Debe ser el ÚNICO; si no, no se elige ninguno.
//  - Después, el avión se sigue solo por /v2/hex/. Un registro en memoria por vuelo físico (compartido por los códigos
//    compartidos y por todos los usuarios) evita repetir la identificación.
//  - Nunca hay mapeos fijos de indicativos ni de hex: los indicativos operativos se reasignan cada día.
// Todas las consultas a adsb.lol pasan por el limitador global (server/adsb.mjs).
import { adsbGet, adsbLimiter } from './adsb.mjs';
import { departureMs, distanceKm, airborne, landedAt, flyingResult, MAX_SEEN_S } from './radar.mjs';
import { aircraftName } from '../js/plain.js';

// HEURÍSTICAS AJUSTABLES (valores razonables, no demostrados; revisar con casos reales). Todas las funciones aceptan
// un objeto `limits` para cambiarlas sin tocar el código.
export const LIMITS = {
  corridorKm: 120, // distancia lateral máxima a la ruta en línea recta (círculo máximo); en el caso real que la motivó, 93 km
  alongSlackKm: 30, // margen antes del origen / después del destino a lo largo de la ruta
  maxTrackDiffDeg: 60, // diferencia máxima entre el rumbo del avión y el rumbo hacia el destino
  maxKmh: 1100, // velocidad máxima creíble respecto al suelo (con viento de cola fuerte)
  reachSlackKm: 50, // margen sobre la distancia máxima recorrible desde la salida
  minKmh: 300, // recorrido mínimo creíble a lo largo de la ruta, una vez en el aire (descarta vuelos que salieron después)
  taxiMin: 45, // tiempo desde la salida de Aena (calzos) sin exigir recorrido: rodaje, espera y ascenso
  cruiseKmh: 780, // velocidad media prevista para situar la zona de búsqueda a lo largo de la ruta
  zoneRadiusNm: 150, // radio de cada consulta por zona (adsb.lol admite hasta 250 NM)
  maxZoneCalls: 3, // consultas por zona por identificación, como mucho
  maxCandidates: 6, // candidatos locales como mucho; más → ambiguo (sin consultar adsbdb)
  sameRouteWindowMin: 120, // otro vuelo de la misma operadora y ruta en ± esta franja → no se intenta
  cooldownMin: 10, // tras un fallo o una invalidación, sin reintentar durante este tiempo
  invalidateAfter: 3, // lecturas seguidas con indicativo distinto para invalidar el hex
  contradictionCrossKm: 400, // lejos de la ruta más que esto → contradicción física clara
  groundAirportKm: 30, // en tierra a más de esto del origen y del destino → contradicción física clara
};

const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
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

const departed = leg => (leg.std ?? leg.st) === 'BOR' || ['FLY', 'FNL'].includes(leg.sta);
const cancelled = leg => [leg.st, leg.std, leg.sta].some(f => f === 'CAN' || f === 'DES');
const operatorIcao = (leg, legs) => (leg.op === leg.al ? leg.icao : legs.find(l => l.al === leg.op && l.icao)?.icao) ?? null;

// ¿Se puede intentar? Aena confirma la salida, la operadora (y su código OACI) y el tipo de avión.
export function canIdentify(leg, legs = []) {
  return Boolean(leg && departed(leg) && !cancelled(leg) && leg.op && leg.ac && operatorIcao(leg, legs) && departureMs(leg) !== null);
}

async function adsbdbRoute(callsign, fetchFn) {
  try {
    const res = await fetchFn(`${ADSBDB}${callsign}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) return null;
    const r = (await res.json())?.response?.flightroute;
    return { o: r?.origin?.iata_code ?? null, a: r?.destination?.iata_code ?? null };
  } catch {
    return null;
  }
}

// Identificación por zona. Devuelve { state: 'identificado', hex, callsign } | { state: 'ambiguo' | 'sin-datos' |
// 'no-disponible' | 'no-aplica' }. Nunca elige entre varios.
export async function identifyByZone({ leg, legs = [], origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS }) {
  if (!canIdentify(leg, legs) || !origin || !dest) return { state: 'no-aplica' };
  const depMs = departureMs(leg);
  const elapsedMin = (nowMs - depMs) / 60000;
  if (elapsedMin <= 0) return { state: 'no-aplica' };
  // Otro vuelo de la misma operadora y ruta en la franja (otro avión físico) → podría confundirse: no se intenta.
  const rival = legs.some(l => l !== leg && l.o === leg.o && l.a === leg.a && (l.op ?? l.al) === leg.op
    && l.sd !== leg.sd && departureMs(l) !== null && Math.abs(departureMs(l) - depMs) <= limits.sameRouteWindowMin * 60000);
  if (rival) return { state: 'ambiguo' };

  // Zonas a lo largo de la ruta: primero donde debería ir, después delante y detrás (sin pasar de lo físicamente posible).
  const icao = operatorIcao(leg, legs);
  const total = distanceKm(origin, dest);
  const reach = Math.min(total, (limits.maxKmh * elapsedMin) / 60 + limits.reachSlackKm);
  const expected = Math.min(reach, (limits.cruiseKmh * elapsedMin) / 60);
  const step = limits.zoneRadiusNm * 1.852 * 1.6;
  const brg = bearingDeg(origin, dest);
  const alongs = [expected, expected + step, expected - step].filter(x => x >= 0 && x <= reach).slice(0, limits.maxZoneCalls);
  const found = new Map();
  let failed = false;
  for (const km of alongs) {
    const [lat, lon] = pointAlong(origin, brg, km);
    const r = await adsbGet(`/point/${lat.toFixed(3)}/${lon.toFixed(3)}/${limits.zoneRadiusNm}`, { fetchFn, limiter });
    if (!r) { failed = true; continue; }
    for (const a of r.ac ?? []) {
      const cs = a.flight?.trim();
      if (!cs || !cs.startsWith(icao) || !a.hex || !airborne(a) || (a.seen_pos ?? a.seen ?? Infinity) > MAX_SEEN_S) continue;
      if (!typeCompatible(leg.ac, a.t)) continue;
      if (!corridor({ origin, dest, lat: a.lat, lon: a.lon, track: a.track, elapsedMin }, limits).ok) continue;
      found.set(a.hex, cs);
    }
  }
  if (found.size > limits.maxCandidates) return { state: 'ambiguo' };
  // Ruta exacta según adsbdb, candidato a candidato (en serie, sin prisa).
  const matches = [];
  for (const [hex, callsign] of found) {
    const route = await adsbdbRoute(callsign, fetchFn);
    if (!route) { failed = true; continue; }
    if (route.o === leg.o && route.a === leg.a) matches.push({ hex, callsign });
  }
  if (matches.length > 1) return { state: 'ambiguo' };
  // Si algo falló, no se puede asegurar que el candidato sea el único: mejor no decir nada.
  if (failed) return { state: 'no-disponible' };
  return matches.length ? { state: 'identificado', ...matches[0] } : { state: 'sin-datos' };
}

// Seguimiento de un hex ya identificado. observation: 'compatible' (mismo indicativo y coherente), 'incompatible'
// (indicativo distinto), 'incompleta' (sin indicativo, sin señal o consulta fallida: no cuenta ni a favor ni en contra)
// o 'contradiccion' (físicamente imposible para este vuelo). result: lo que se muestra, o null.
export async function trackByHex({ entry, leg, origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS }) {
  const r = await adsbGet(`/hex/${entry.hex}`, { fetchFn, limiter });
  const a = (r?.ac ?? []).find(x => x.hex === entry.hex) ?? (r?.ac ?? [])[0];
  if (!a) return { observation: 'incompleta', result: null };
  const depMs = departureMs(leg);
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
  const entries = new Map(); // phys → { hex, callsign, streak } | { until }
  const pending = new Map();
  let running = false;
  const waiting = [];
  // Cola en serie que arranca la tarea en el acto si no hay otra en marcha.
  const enqueue = task => new Promise((resolve, reject) => {
    const run = () => {
      running = true;
      let p;
      try { p = Promise.resolve(task()); } catch (err) { p = Promise.reject(err); }
      p.then(resolve, reject).finally(() => { running = false; waiting.shift()?.(); });
    };
    if (running) waiting.push(run); else run();
  });
  const fail = (phys, nowMs) => entries.set(phys, { until: nowMs + limits.cooldownMin * 60000 });

  return {
    get(phys) {
      const e = entries.get(phys);
      return e?.hex ? { state: 'identificado', hex: e.hex, callsign: e.callsign } : null;
    },
    busy: phys => pending.has(phys),
    resolve(phys, attempt, nowMs) {
      const e = entries.get(phys);
      if (e?.hex) return Promise.resolve({ state: 'identificado', hex: e.hex, callsign: e.callsign });
      if (e && nowMs < e.until) return Promise.resolve(null);
      if (pending.has(phys)) return pending.get(phys);
      const p = enqueue(attempt).then(r => {
        if (r?.state === 'identificado' && r.hex) {
          entries.set(phys, { hex: r.hex, callsign: r.callsign, streak: 0 });
          return { state: 'identificado', hex: r.hex, callsign: r.callsign };
        }
        fail(phys, nowMs);
        return null;
      }, () => { fail(phys, nowMs); return null; }).finally(() => pending.delete(phys));
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
