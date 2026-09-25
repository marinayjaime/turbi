// Radar (ADS-B) en la ficha: solo para vuelos que Aena da por salidos sin publicar su llegada (destino extranjero).
// El servidor en directo (server/radar.mjs) busca el vuelo por su indicativo exacto; aquí solo se muestra lo que dice.
import { LIVE_BASE } from './config.js';
import { STALE_MIN } from './eta.js';
import { flightStatus } from './schedule.js';
import { radarGate, legTimes, aenaTz } from './radar-gate.js';

const ARR_FINAL = new Set(['LND', 'IBK', 'OPE', 'OPF', 'BOR']);

// ¿Se consulta el radar? La misma regla que el servidor, escrita una sola vez en js/radar-gate.js: con confirmación
// de Aena (BOR, FLY, FNL) como siempre; con un estado de puerta retrasado (ULL, EMB, CER…), dentro de la ventana
// alrededor del despegue. Nunca cancelado, desviado ni con la llegada final.
// times: { nowMs, originTz, destTz, plannedMin } (duración estimada de la ruta, para lo que Aena no publica).
export function wantsRadar(leg, liveBase = LIVE_BASE, { nowMs = Date.now(), originTz = aenaTz(leg.o), destTz = aenaTz(leg.a), plannedMin = null } = {}) {
  if (!liveBase) return false;
  return radarGate({ leg, nowMs, ...legTimes(leg, { originTz, destTz }), plannedMin }).mode !== 'none';
}

// Aena da la salida por finalizada pero no publica la llegada (no es un aeropuerto suyo): se dice.
export function departedText(leg, city) {
  if ((leg.std ?? leg.st) !== 'BOR' || leg.sa || leg.sta) return null;
  return `Ha salido · Aena no informa de la llegada a ${city}`;
}

export const ENDED_ESTIMATED = 'Según la estimación de Turbi, el vuelo ya habría aterrizado: no se muestra la previsión de turbulencias.';

// Aviso cuando ya pasó la llegada: «ha aterrizado» solo si lo confirma Aena; «prevista» solo si la hora es de Aena;
// si es una estimación Turbi, se dice.
export function endedNote(leg, { estimated = false } = {}) {
  if (ARR_FINAL.has(leg?.sta)) return 'Este vuelo ya ha aterrizado.';
  return estimated ? ENDED_ESTIMATED : 'La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.';
}

// Estado que se muestra (distinto del último estado oficial de Aena, que no se toca). Prioridad:
//   1. Aena confirma la llegada (o da otro estado de llegada), no ha salido, cancelado o desviado → estado oficial;
//   2–3. ADS-B en tierra en el destino / volando → lo ponen withLanding y withRadar encima de esto;
//   4. ha salido y la llegada visible aún no ha pasado (o no hay) → «Ha salido»;
//   5. la llegada visible es una estimación Turbi y pasó hace ≥ ESTIMATED_LANDED_MIN → «Aterrizado» estimado
//      (landing: 'estimated-landed', con nota; no es una confirmación: el radar «volando» o Aena lo desmienten).
// visibleArrivalMs = la misma hora que muestra la ficha; arrivalSource = 'aena' | 'turbi'.
const MIN_MS = 60000;
const ESTIMATED_LANDED_MIN = 45; // heurística: margen tras la llegada estimada antes de darla por aterrizada
export function presentStatus({ leg, city, visibleArrivalMs = null, arrivalSource = 'turbi', nowMs = Date.now() }) {
  const official = flightStatus(leg);
  const flags = [leg.st, leg.std, leg.sta];
  if ((leg.std ?? leg.st) !== 'BOR' || leg.sta || flags.includes('CAN') || flags.includes('DES')) return official;
  if (arrivalSource === 'turbi' && Number.isFinite(visibleArrivalMs) && nowMs - visibleArrivalMs >= ESTIMATED_LANDED_MIN * MIN_MS) {
    return { text: 'Aterrizado', tone: 'ok', note: 'Según la llegada estimada por Turbi', landing: 'estimated-landed' };
  }
  return leg.sa ? official : { text: `Ha salido · Aena no informa de la llegada a ${city}`, tone: 'info' };
}

export const NO_ARRIVAL_NOTE = 'El vuelo ya ha salido y no hay una hora de llegada que mostrar: no se muestra la previsión de turbulencias.';

// Aviso de llegada con UNA sola fuente de verdad: la llegada que la ficha muestra (la de Aena, officialMs, o la
// estimación Turbi visible, eta). Si la ficha muestra «Llegada —», el aviso no puede basarse en ninguna estimación.
export function arrivalNote({ leg, officialMs = null, eta = null, departureMs = null, nowMs = Date.now() }) {
  const official = Number.isFinite(officialMs);
  const shownMs = official ? officialMs : eta?.source === 'turbi' ? eta.ms : null;
  if (shownMs !== null) return shownMs < nowMs ? endedNote(leg, { estimated: !official }) : null;
  if ([leg.st, leg.std, leg.sta].includes('CAN')) return null; // lo dice «Vuelo cancelado.»
  return Number.isFinite(departureMs) && departureMs < nowMs ? NO_ARRIVAL_NOTE : null;
}

// Si el radar ve el avión en el aire, sustituye al aviso de llegada estimada ya pasada (no puede contradecirlo).
export function radarNote(radar) {
  if (radar?.state === 'aterrizado') return LANDED_NOTE;
  return radar?.state === 'volando'
    ? 'El radar indica que el avión sigue en el aire: la previsión de turbulencias no se muestra con el vuelo en curso.' : null;
}

export async function fetchRadar(al, n, fetchFn = fetch, liveBase = LIVE_BASE, { poll = false, debug = false } = {}) {
  try {
    const query = new URLSearchParams({ ...(poll ? { poll: '1' } : {}), ...(debug ? { debug: '1' } : {}) }).toString();
    const res = await fetchFn(`${liveBase}/radar/${al}/${n}.json${query ? `?${query}` : ''}`, { signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const MIN = 60000;

// Ficha con la respuesta del radar y la última vez que lo vio volando (lastSeenMs):
//   ahora mismo            → «Volando» y panel de telemetría;
//   hace menos de 12 min   → «Última señal: volando hace X min» (no es tiempo real; mismo umbral que la ETA);
//   más tarde o nunca      → el estado oficial de Aena, y «sin señal ADS-B reciente».
// Perder el radar nunca se interpreta como «ha aterrizado». No se expone un indicativo concreto: el servidor
// prueba varias variantes.
// El servidor está identificando el avión por su ruta en segundo plano. Con el límite de adsb.lol (4 peticiones por
// minuto) eso puede tardar 1–2 min, así que la app vuelve a preguntar a los 20, 40, 60, 90, 120, 150 y 180 s desde la
// primera respuesta (intervalos sucesivos, encadenados; nunca setInterval). Estos sondeos llevan ?poll=1: el servidor
// solo lee el estado del trabajo en curso y no hace ninguna consulta nueva a ADS-B.
export const RADAR_POLL_DELAYS_MS = [20000, 20000, 20000, 30000, 30000, 30000, 30000];

// ¿Hay que volver a preguntar? Solo mientras el servidor diga que sigue identificando y aún no haya un resultado
// definitivo. Sin respuesta (red, timeout), se vuelve a intentar en el siguiente turno: el trabajo del servidor sigue.
export function keepPolling(radar) {
  if (!radar) return true;
  return radar.identifying === true && !['volando', 'aterrizado'].includes(radar.state);
}

// Sondeo encadenado del radar. fetchOnce({ poll }) → respuesta del servidor (o null); onResult(radar, { attempt }) la
// pinta; isActive() dice si la ficha que lo pidió sigue en pantalla (misma búsqueda). Devuelve { first, cancel }:
// first se resuelve con la primera respuesta (la ficha nunca espera a los siguientes sondeos).
export function pollRadar({ fetchOnce, onResult, isActive = () => true, delays = RADAR_POLL_DELAYS_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let timer = null, cancelled = false;
  const stopped = () => cancelled || !isActive();
  const step = async attempt => {
    timer = null;
    if (stopped()) return null;
    const radar = await fetchOnce({ poll: attempt > 0 });
    if (stopped()) return radar;
    // Sin respuesta en un sondeo no se pinta nada (se queda lo último que se vio).
    if (radar || attempt === 0) onResult(radar, { attempt });
    if (keepPolling(radar) && attempt < delays.length) {
      timer = setTimer(() => { step(attempt + 1).catch(() => {}); }, delays[attempt]);
    }
    return radar;
  };
  return {
    first: step(0),
    cancel() { cancelled = true; if (timer !== null) clearTimer(timer); timer = null; },
    get pending() { return timer !== null; },
  };
}

export function withRadar(card, radar, lastSeenMs = null, nowMs = Date.now()) {
  if (!radar || !['volando', 'aterrizado', 'sin-datos', 'no-disponible'].includes(radar.state)) return card;
  if (radar.state === 'volando') return { ...card, status: { text: 'Volando', tone: 'info', flying: true }, radar };
  if (radar.state === 'aterrizado') return { ...card, status: LANDED_STATUS, radar: { state: 'aterrizado' } };
  // Aena ya dice «Volando» (FLY/FNL) y el radar no lo ve: se queda lo de Aena, sin panel ni avisos del radar.
  if (card.status?.flying) return card;
  const ageMin = Number.isFinite(lastSeenMs) ? Math.round((nowMs - lastSeenMs) / MIN) : null; // igual que la ETA
  if (ageMin !== null && ageMin < STALE_MIN) {
    const ago = ageMin < 1 ? 'menos de 1 min' : `${ageMin} min`;
    return { ...card, status: { text: `Última señal: volando hace ${ago}`, tone: 'info' }, radar: { state: 'reciente', ageMin } };
  }
  // Aena aún no confirma la salida (p. ej. «Última llamada»): el avión puede seguir en tierra. Se queda el estado de
  // Aena, sin «Sin señal ADS-B» (no se asume que haya despegado).
  if (radar.departureConfirmed === false) return card;
  return { ...card, radar: { state: ageMin === null && radar.state === 'no-disponible' ? 'no-disponible' : 'sin-senal' } };
}

// Aterrizaje confirmado por ADS-B (el servidor exige tierra, en el destino, señal reciente, mismo indicativo y el
// tiempo mínimo físico de vuelo). Se guarda para que al recargar no se vuelva a «Ha salido»; una lectura posterior
// de «volando» no lo deshace. Aena manda si confirma la llegada; desviado o cancelado, nunca.
const LANDED_STATUS = { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B', landing: 'confirmed-landed' };
export const LANDED_NOTE = 'Este vuelo ya ha aterrizado según el radar ADS-B: no se muestra la previsión de turbulencias.';
const LANDED_STORE = 'turbi-landed';
const landings = new Map();

export function withLanding(card, landedAtMs, leg) {
  if (!Number.isFinite(landedAtMs)) return card;
  const flags = [leg.st, leg.std, leg.sta];
  if (ARR_FINAL.has(leg.sta) || flags.includes('CAN') || flags.includes('DES')) return card; // Aena manda
  return { ...card, status: LANDED_STATUS, radar: { state: 'aterrizado' } };
}

export function rememberLanding(key, radar, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (radar?.state !== 'aterrizado') return;
  const at = nowMs - (radar.seenS ?? 0) * 1000;
  landings.set(key, at);
  try {
    const all = JSON.parse(storage?.getItem(LANDED_STORE) ?? '{}');
    for (const [k, t] of Object.entries(all)) if (nowMs - t > 7 * 24 * 3600000) delete all[k];
    all[key] = at;
    storage?.setItem(LANDED_STORE, JSON.stringify(all));
  } catch { /* sin almacenamiento: queda en memoria */ }
}

// fresh: lee solo el almacenamiento (como tras recargar la página).
export function recallLanding(key, storage = globalThis.localStorage, { fresh = false } = {}) {
  if (!fresh && landings.has(key)) return landings.get(key);
  try {
    const t = JSON.parse(storage?.getItem(LANDED_STORE) ?? '{}')[key];
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// Última vez que el radar vio el avión volando (hora de la observación = consulta − seenS): en memoria y, para
// que sobreviva a reabrir la app, en el almacenamiento del navegador. Distinta de la ETA (js/eta.js).
const seen = new Map();
const SEEN_STORE = 'turbi-radar-seen';

export function rememberSighting(key, radar, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (radar?.state !== 'volando') return;
  const at = nowMs - (radar.seenS ?? 0) * 1000;
  seen.set(key, at);
  try {
    const all = JSON.parse(storage?.getItem(SEEN_STORE) ?? '{}');
    for (const [k, t] of Object.entries(all)) if (nowMs - t > 24 * 3600000) delete all[k];
    all[key] = at;
    storage?.setItem(SEEN_STORE, JSON.stringify(all));
  } catch { /* sin almacenamiento: queda en memoria */ }
}

export function recallSighting(key, storage = globalThis.localStorage) {
  if (seen.has(key)) return seen.get(key);
  try {
    const t = JSON.parse(storage?.getItem(SEEN_STORE) ?? '{}')[key];
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
