// Hora de llegada: fuente oficial (Aena) o, si Aena no publica la llegada (destino extranjero), estimación Turbi.
// Cuatro conceptos separados:
//   official / scheduled      → Aena (hora estimada o final / hora programada). Nunca se sustituye por un cálculo.
//   estimated-preflight       → Turbi: salida + duración estimada por la distancia (antes del despegue).
//   estimated-inflight        → Turbi: la anterior, corregida con el radar ADS-B, suavizada.
//   (estado ADS-B)            → lo que dice el radar; va aparte, en js/radar.js.
// Prioridad: estabilidad y prudencia; se muestra redondeada a 5 min (sin precisión falsa).
import { legArrival } from './schedule.js';

const MIN = 60000;
const VALID_KMH = [250, 1150]; // fuera de aquí (rodando, dato imposible) la velocidad ADS-B no se usa
const PLAN_KMH = 800; // velocidad de crucero supuesta si la medida no sirve
const DESCENT_KM = 150; // los últimos ~150 km son descenso y aproximación
const DESCENT_MIN = 23; // …que llevan unos 23 min, con tráfico
const ROUTE_FACTOR = 1.05; // la ruta real es algo más larga que la línea recta
const HOLD_MIN = 60; // una ETA en vuelo se conserva hasta 60 min sin radar
const JUMP_KM = 100; // la distancia restante no puede crecer más de esto entre dos lecturas
const MAX_KMH_BETWEEN = 1300; // ni bajar más rápido que esto

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
  if (remainingKm < 100) return (remainingKm * 1.3) / 400 * 60 + 5; // vectores y aproximación
  const speedOk = kmh >= VALID_KMH[0] && kmh <= VALID_KMH[1];
  const v = phase === 'cruise' && speedOk ? kmh : PLAN_KMH;
  return Math.max(0, remainingKm * ROUTE_FACTOR - DESCENT_KM) / v * 60 + DESCENT_MIN;
}

// Peso del radar frente al plan: más cuanto más cerca; menos en la subida o con velocidad no válida.
function radarWeight(remainingKm, phase, speedOk) {
  let w = remainingKm > 500 ? 0.4 : remainingKm >= 100 ? 0.7 : 0.9;
  if (phase === 'climb') w *= 0.5;
  if (!speedOk && remainingKm >= 100) w *= 0.5;
  return w;
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
  const maxStep = (remainingKm < 100 ? 4 : 8) * MIN;
  const step = Math.max(-maxStep, Math.min(maxStep, (rawMs - prev.ms) * 0.5));
  return prev.ms + step;
}

const result = (ms, tz, method, confidence, extra = {}) =>
  ({ ...localParts(round5(ms), tz), source: 'turbi', method, confidence, ms, ...extra });

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
  const holdPrev = prev?.method === 'estimated-inflight' && nowMs - prev.at <= HOLD_MIN * MIN;

  if (radarUsable(radar)) {
    if (holdPrev && jumped(radar, prev, nowMs)) return result(prev.ms, tz, 'estimated-inflight', 'low', { held: true });
    const phase = flightPhase(radar);
    const speedOk = radar.kmh >= VALID_KMH[0] && radar.kmh <= VALID_KMH[1];
    const w = radarWeight(radar.remainingKm, phase, speedOk);
    const radarMs = nowMs + radarRemainingMin(radar, phase) * MIN;
    const floor = nowMs + (radar.remainingKm < 30 ? 3 : 5) * MIN; // en el aire: nunca «ya ha llegado» por cálculo
    const raw = Math.max(floor, w * radarMs + (1 - w) * planMs);
    const ms = Math.max(floor, smooth(raw, prev, nowMs, radar.remainingKm));
    const confidence = phase === 'cruise' && speedOk && (radar.seenS ?? 0) <= 60 ? 'medium' : 'low';
    return result(ms, tz, 'estimated-inflight', confidence, { remainingKm: radar.remainingKm, phase });
  }
  // Sin radar ahora (lo perdió un momento): la última ETA en vuelo sigue valiendo un rato.
  if (holdPrev) return result(prev.ms, tz, 'estimated-inflight', 'low', { held: true });
  return result(planMs, tz, 'estimated-preflight', 'low');
}

// Lado «Llegada» de la ficha cuando la hora es una estimación Turbi (con Aena, la ficha usa su hora tal cual).
export function etaSide(eta) {
  if (eta?.source !== 'turbi') return null;
  return { date: eta.date, time: eta.time, estimated: true,
    note: eta.method === 'estimated-inflight' ? 'Estimación Turbi actualizada en vuelo' : 'Estimación Turbi' };
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
  const v = { ms: eta.ms, at: nowMs, method: eta.method, remainingKm: eta.remainingKm };
  memory.set(key, v);
  try {
    const all = JSON.parse(storage?.getItem(STORE) ?? '{}');
    for (const [k, x] of Object.entries(all)) if (nowMs - x.at > 24 * 3600000) delete all[k]; // limpieza
    all[key] = v;
    storage?.setItem(STORE, JSON.stringify(all));
  } catch { /* sin almacenamiento: queda en memoria */ }
}
