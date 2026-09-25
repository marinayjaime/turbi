// Hora de llegada: fuente oficial (Aena) o, si Aena no publica la llegada (destino extranjero), estimación Turbi.
// Cuatro conceptos separados:
//   official / scheduled      → Aena (hora estimada o final / hora programada). Nunca se sustituye por un cálculo.
//   estimated-preflight       → Turbi: salida + duración estimada por la distancia (antes del despegue).
//   estimated-inflight        → Turbi: la anterior, corregida con el radar ADS-B, suavizada.
//   (estado ADS-B)            → lo que dice el radar; va aparte, en js/radar.js.
// Prioridad: estabilidad y prudencia; se muestra redondeada a 5 min (sin precisión falsa).
import { legArrival } from './schedule.js';

const MIN = 60000;

// ── Parámetros ─────────────────────────────────────────────────────────────────────────────────────────────
// TODOS son HEURÍSTICAS razonables, NO valores demostrados. Se validarán con el histórico (ETA predicha frente a
// llegada real) y se ajustarán. No presentarlos como exactos.
const VALID_KMH = [250, 1150]; // heurística: fuera de aquí (rodando, dato imposible) la velocidad ADS-B no se usa
const PLAN_KMH = 800; // heurística: velocidad de crucero supuesta si la medida no sirve (la misma que route.js)
const DESCENT_KM = 150; // heurística: los últimos ~150 km son descenso y aproximación
const DESCENT_MIN = 23; // heurística: …que llevan unos 23 min, con tráfico
const ROUTE_FACTOR = 1.05; // heurística: la ruta real es algo más larga que la línea recta
const APPROACH_FACTOR = 1.3, APPROACH_KMH = 400, APPROACH_MIN = 5; // heurística: < 100 km (vectores, aproximación)
const WEIGHTS = { far: 0.4, mid: 0.7, near: 0.9 }; // heurística: peso del radar a > 500 km, 100–500 km y < 100 km
// Sin observación ADS-B nueva, la última ETA en vuelo NUNCA se sustituye por la previa al vuelo (es mejor dato):
export const STALE_MIN = 12; // heurística: hasta 12 min, igual que estaba; desde 12, «la última disponible», confianza baja
const HOLD_MIN = 60; // heurística: desde 60 min, «sin datos recientes», confianza muy baja (y ya no suaviza ni compara)
const MAX_HOLD_H = 24; // heurística: límite absoluto (el vuelo más largo dura ~17 h): después, sin ETA (nunca la previa)
const JUMP_KM = 100; // heurística: la distancia restante no puede crecer más de esto entre dos lecturas
const MAX_KMH_BETWEEN = 1300; // heurística: ni bajar más rápido que esto
const MAX_STEP_MIN = { far: 8, near: 4 }; // heurística: cuánto puede moverse la ETA por actualización

const cancelled = leg => [leg.st, leg.std, leg.sta].includes('CAN');
const diverted = leg => [leg.st, leg.std, leg.sta].includes('DES');
const round5 = ms => Math.round(ms / (5 * MIN)) * 5 * MIN;

// Fecha y hora locales (AAAA-MM-DD, HH:MM) de un instante en una zona horaria.
function localParts(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(ms).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Fase según la velocidad vertical ADS-B (pies/min); sin ella, por altitud y distancia.
export function flightPhase({ altFt, vRateFpm, remainingKm }) {
  if (Number.isFinite(vRateFpm)) {
    if (vRateFpm >= 500) return 'climb';
    if (vRateFpm <= -500) return 'descent';
  }
  if (altFt >= 20000) return 'cruise';
  return remainingKm !== undefined && remainingKm < 250 ? 'descent' : 'climb';
}

// Minutos que le quedan según el radar. No se toma la velocidad instantánea como media hasta el destino:
// crucero hasta el inicio del descenso y un tiempo fijo de descenso y aproximación; cerca, velocidad de aproximación.
function radarRemainingMin({ remainingKm, kmh }, phase) {
  if (remainingKm < 100) return (remainingKm * APPROACH_FACTOR) / APPROACH_KMH * 60 + APPROACH_MIN; // vectores y aproximación
  const speedOk = kmh >= VALID_KMH[0] && kmh <= VALID_KMH[1];
  const v = phase === 'cruise' && speedOk ? kmh : PLAN_KMH;
  return Math.max(0, remainingKm * ROUTE_FACTOR - DESCENT_KM) / v * 60 + DESCENT_MIN;
}

// Antigüedad de la señal ADS-B (s): una posición de hace 2–3 min no vale lo mismo que una de hace 5 s.
// Heurística: ×1 hasta FRESH_S; después baja de forma continua hasta ×MIN_FRESHNESS a los MAX_SEEN_S (el servidor
// no da por «en el aire» señales más viejas). Cerca del destino (rumbo y velocidad cambian rápido) se eleva al cuadrado.
const FRESH_S = 10, MAX_SEEN_S = 180, MIN_FRESHNESS = 0.3;
export function freshness(seenS = 0, remainingKm = Infinity) {
  const f = seenS <= FRESH_S ? 1 : Math.max(MIN_FRESHNESS, 1 - (1 - MIN_FRESHNESS) * (seenS - FRESH_S) / (MAX_SEEN_S - FRESH_S));
  return remainingKm < 100 ? f * f : f;
}

// Peso del radar frente al plan: más cuanto más cerca; menos en la subida, con velocidad no válida o señal vieja.
function radarWeight({ remainingKm, seenS }, phase, speedOk) {
  let w = remainingKm > 500 ? WEIGHTS.far : remainingKm >= 100 ? WEIGHTS.mid : WEIGHTS.near;
  if (phase === 'climb') w *= 0.5;
  if (!speedOk && remainingKm >= 100) w *= 0.5;
  return w * freshness(seenS, remainingKm);
}

const radarUsable = r => r?.state === 'volando' && Number.isFinite(r.remainingKm);

// ¿La nueva lectura es incompatible con la anterior (salto de posición)?
function jumped(radar, prev, nowMs) {
  if (!Number.isFinite(prev?.remainingKm)) return false;
  if (radar.remainingKm - prev.remainingKm > JUMP_KM) return true;
  const hours = (nowMs - prev.at) / 3600000;
  return hours > 2 / 60 && (prev.remainingKm - radar.remainingKm) / hours > MAX_KMH_BETWEEN;
}

// Suavizado: la ETA se mueve como mucho la mitad de la diferencia y nunca más de 8 min (4 min cerca del destino).
function smooth(rawMs, prev, nowMs, remainingKm) {
  if (!prev || prev.method !== 'estimated-inflight' || nowMs - prev.at > HOLD_MIN * MIN) return rawMs;
  const maxStep = (remainingKm < 100 ? MAX_STEP_MIN.near : MAX_STEP_MIN.far) * MIN;
  const step = Math.max(-maxStep, Math.min(maxStep, (rawMs - prev.ms) * 0.5));
  return prev.ms + step;
}

const result = (ms, tz, method, confidence, extra = {}) =>
  ({ ...localParts(round5(ms), tz), source: 'turbi', method, confidence, ms, ...extra });

// Última ETA en vuelo, conservada sin radar: con su antigüedad y su confianza rebajada según pasa el tiempo.
function held(prev, nowMs, tz) {
  const ageMin = Math.round((nowMs - prev.at) / MIN);
  const confidence = ageMin < STALE_MIN ? prev.confidence ?? 'low' : ageMin <= HOLD_MIN ? 'low' : 'very-low';
  return result(prev.ms, tz, 'estimated-inflight', confidence, { held: true, ageMin });
}

// leg: tramo de Aena · depUtcMs: salida (real/estimada/programada) en UTC · plannedMin: duración estimada ·
// tz: zona horaria del destino · radar: respuesta de /radar (o null) · prev: última ETA en vuelo de este vuelo.
export function estimateArrival({ leg, depUtcMs, plannedMin, tz, nowMs = Date.now(), radar = null, prev = null }) {
  if (cancelled(leg) || diverted(leg)) return null;

  const official = legArrival(leg);
  if (official) {
    return { ...official, source: 'aena', method: leg.ea ? 'official' : 'scheduled', confidence: leg.ea ? 'high' : 'medium' };
  }
  if (!Number.isFinite(depUtcMs) || !(plannedMin > 0) || !tz) return null;
  const planMs = depUtcMs + plannedMin * MIN;
  const hadInflight = prev?.method === 'estimated-inflight';
  const recentPrev = hadInflight && nowMs - prev.at <= HOLD_MIN * MIN; // para detectar saltos de posición
  const withinMax = hadInflight && nowMs - prev.at <= MAX_HOLD_H * 3600000;

  if (radarUsable(radar)) {
    if (recentPrev && jumped(radar, prev, nowMs)) return held(prev, nowMs, tz);
    const phase = flightPhase(radar);
    const speedOk = radar.kmh >= VALID_KMH[0] && radar.kmh <= VALID_KMH[1];
    const w = radarWeight(radar, phase, speedOk);
    const radarMs = nowMs + radarRemainingMin(radar, phase) * MIN;
    const floor = nowMs + (radar.remainingKm < 30 ? 3 : 5) * MIN; // en el aire: nunca «ya ha llegado» por cálculo
    const raw = Math.max(floor, w * radarMs + (1 - w) * planMs);
    const ms = Math.max(floor, smooth(raw, prev, nowMs, radar.remainingKm));
    const confidence = phase === 'cruise' && speedOk && (radar.seenS ?? 0) <= 60 ? 'medium' : 'low';
    return result(ms, tz, 'estimated-inflight', confidence, { remainingKm: radar.remainingKm, phase, seenS: radar.seenS ?? 0 });
  }
  // Sin radar ahora: la última ETA en vuelo sigue siendo mejor que la previa al vuelo; nunca se vuelve a esta.
  if (withinMax) return held(prev, nowMs, tz);
  if (hadInflight) return null; // más de MAX_HOLD_H sin señal: sin ETA
  return result(planMs, tz, 'estimated-preflight', 'low');
}

// Estimación Turbi para la ficha. En los vuelos del histórico (ya pasados) solo cuenta la última ETA calculada en
// vuelo que siga guardada (hasta MAX_HOLD_H): nunca se fabrica una estimación nueva para un vuelo pasado.
export function turbiEstimate({ leg, prev = null, ...rest }) {
  if (leg.past && prev?.method !== 'estimated-inflight') return null;
  return estimateArrival({ leg, prev, ...rest });
}

// Lado «Llegada» de la ficha cuando la hora es una estimación Turbi (con Aena, la ficha usa su hora tal cual).
export function etaSide(eta) {
  if (eta?.source !== 'turbi') return null;
  const age = m => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
  const note = eta.method !== 'estimated-inflight' ? 'Estimación Turbi'
    : eta.held && eta.ageMin > HOLD_MIN ? `Última estimación Turbi disponible · sin datos recientes (hace ${age(eta.ageMin)})`
    : eta.held && eta.ageMin >= STALE_MIN ? `Última estimación Turbi disponible (hace ${eta.ageMin} min, sin señal de radar desde entonces)`
    : 'Estimación Turbi actualizada en vuelo';
  return { date: eta.date, time: eta.time, estimated: true, note };
}

// Última ETA en vuelo de cada vuelo: en memoria durante la sesión y, para que sobreviva a reabrir la app
// (que en el iPhone recarga la página), también en el almacenamiento del navegador.
const memory = new Map();
const STORE = 'turbi-eta';

export function recallEta(key, storage = globalThis.localStorage) {
  if (memory.has(key)) return memory.get(key);
  try {
    const v = JSON.parse(storage?.getItem(STORE) ?? '{}')[key];
    if (v) memory.set(key, v);
    return v ?? null;
  } catch {
    return null;
  }
}

export function rememberEta(key, eta, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (eta?.method !== 'estimated-inflight' || eta.held) return;
  // at = momento de la observación ADS-B (consulta − seenS): de ahí se mide cuánto lleva sin señal.
  const v = { ms: eta.ms, at: nowMs - (eta.seenS ?? 0) * 1000, method: eta.method, remainingKm: eta.remainingKm, confidence: eta.confidence };
  memory.set(key, v);
  try {
    const all = JSON.parse(storage?.getItem(STORE) ?? '{}');
    for (const [k, x] of Object.entries(all)) if (nowMs - x.at > 24 * 3600000) delete all[k]; // limpieza
    all[key] = v;
    storage?.setItem(STORE, JSON.stringify(all));
  } catch { /* sin almacenamiento: queda en memoria */ }
}
