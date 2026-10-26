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
  if (radar?.state === 'aterrizado') return landedNote(radar.source);
  return radar?.state === 'volando'
    ? 'El radar indica que el avión sigue en el aire: la previsión de turbulencias no se muestra con el vuelo en curso.' : null;
}

// leg: physicalFlightKey() del tramo que muestra la ficha (un número puede tener varios tramos la misma fecha); el
// servidor consulta exclusivamente ese vuelo físico.
export async function fetchRadar(al, n, fetchFn = fetch, liveBase = LIVE_BASE, { poll = false, debug = false, leg = null } = {}) {
  try {
    const query = new URLSearchParams({ ...(leg ? { leg } : {}), ...(poll ? { poll: '1' } : {}), ...(debug ? { debug: '1' } : {}) }).toString();
    const res = await fetchFn(`${liveBase}/radar/${al}/${n}.json${query ? `?${query}` : ''}`, { signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Radar de un vuelo de AeroDataBox (sin Aena): el servidor lo busca solo por transpondedor o indicativo.
// legKey: adbPhysicalKey() del tramo que muestra la ficha.
export async function fetchAdbRadar(number, date, legKey, fetchFn = fetch, liveBase = LIVE_BASE, { poll = false } = {}) {
  try {
    const query = new URLSearchParams({ leg: legKey, ...(poll ? { poll: '1' } : {}) }).toString();
    const res = await fetchFn(`${liveBase}/radar-adb/${encodeURIComponent(number)}/${date}.json?${query}`, { signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Estela real del vuelo (Flightradar24 Flight Tracks, server/fr24-track.mjs): el servidor solo la da para el fr24Id que ya
// asoció a ESTE vuelo físico (leg: el mismo ?leg= que /radar y /radar-adb). null si falla: la ruta prevista sigue igual.
async function getTrack(url, fetchFn) {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
export const fetchTrack = (al, n, leg, fetchFn = fetch, liveBase = LIVE_BASE) =>
  getTrack(`${liveBase}/track/${al}/${n}.json?${new URLSearchParams({ leg })}`, fetchFn);
// load: el usuario pidió la ruta realizada (ampliar el mapa). Sin él, la estela de un vuelo histórico solo llega si ya
// estaba guardada (Flight Tracks cuesta ~40 créditos): si no, el servidor responde { state: 'on-demand' } sin pedirla.
export const fetchAdbTrack = (number, date, legKey, fetchFn = fetch, liveBase = LIVE_BASE, { load = false } = {}) =>
  getTrack(`${liveBase}/track-adb/${encodeURIComponent(number)}/${date}.json?${new URLSearchParams({ leg: legKey, ...(load ? { load: '1' } : {}) })}`, fetchFn);
// Cierre histórico de un vuelo de AeroDataBox (Flightradar24 Flight Summary, server/fr24-history.mjs): { state: 'landed',
// takeoff, landed, fr24Id, type, reg } | otro estado | null si falla (la ficha sigue con lo de AeroDataBox).
export const fetchAdbHistory = (number, date, legKey, fetchFn = fetch, liveBase = LIVE_BASE) =>
  getTrack(`${liveBase}/history-adb/${encodeURIComponent(number)}/${date}.json?${new URLSearchParams({ leg: legKey })}`, fetchFn);
// Vuelo que solo encuentra Flightradar24 (server/fr24-discover.mjs): { state: 'found' | 'known', key, origin, destination,
// fr24Id, reg, type, eta, history? … } | otro estado | null si falla (sigue la búsqueda de siempre).
export const fetchFr24Discovery = (number, date, fetchFn = fetch, liveBase = LIVE_BASE) =>
  getTrack(`${liveBase}/discover-fr24/${encodeURIComponent(number)}/${date}.json`, fetchFn);
// Su radar: el de /radar-adb para ese vuelo físico ya descubierto (key: fr24Key, js/fr24-discovery.js).
export async function fetchFr24Radar(number, date, key, fetchFn = fetch, liveBase = LIVE_BASE, { poll = false } = {}) {
  try {
    const query = new URLSearchParams({ leg: key, ...(poll ? { poll: '1' } : {}) }).toString();
    const res = await fetchFn(`${liveBase}/radar-fr24/${encodeURIComponent(number)}/${date}.json?${query}`, { signal: AbortSignal.timeout(20000) });
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
// El servidor está identificando el avión por su ruta en segundo plano. Con el límite de adsb.lol (3 peticiones por
// minuto) eso puede tardar 1–2 min, y si adsb.lol impone una pausa (429, hasta 5 min y repetible) el servidor la
// espera y reanuda solo. El sondeo depende del ESTADO que devuelve el servidor:
//  - identificando: calendario normal, a los 20, 40, 60, 90, 120, 150 y 180 s y después cada minuto;
//  - en pausa (temporary + retryAfterSec): el siguiente sondeo, justo cuando acaba la pausa (+3 s), nunca antes, y
//    esa espera no gasta turnos del calendario.
// Como mucho RADAR_POLL_MAX_MS desde la primera respuesta (cubre dos pausas de 5 min y la identificación). Siempre
// intervalos encadenados (nunca setInterval) y con ?poll=1: el servidor solo lee el estado, sin llamar a ADS-B.
export const RADAR_POLL_DELAYS_MS = [20000, 20000, 20000, 30000, 30000, 30000, 30000, 60000]; // el último se repite
export const RADAR_POLL_MAX_MS = 15 * 60000;
export const RADAR_PAUSE_MARGIN_MS = 3000;

// Espera hasta el siguiente sondeo según la respuesta (normalTurn: turnos del calendario ya usados).
export function nextPollDelay(radar, normalTurn, delays = RADAR_POLL_DELAYS_MS) {
  if (radar?.temporary && Number.isFinite(radar.retryAfterSec)) return { ms: radar.retryAfterSec * 1000 + RADAR_PAUSE_MARGIN_MS, normal: false };
  return { ms: delays[Math.min(normalTurn, delays.length - 1)], normal: true };
}

// ¿Hay que volver a preguntar? Solo mientras el servidor diga que sigue identificando y aún no haya un resultado
// definitivo. Sin respuesta (red, timeout), se vuelve a intentar en el siguiente turno: el trabajo del servidor sigue.
export function keepPolling(radar) {
  if (!radar) return true;
  return radar.identifying === true && !['volando', 'aterrizado'].includes(radar.state);
}

// Sondeo encadenado del radar. fetchOnce({ poll }) → respuesta del servidor (o null); onResult(radar, { attempt }) la
// pinta; isActive() dice si la ficha que lo pidió sigue en pantalla (misma búsqueda). Devuelve { first, cancel }:
// first se resuelve con la primera respuesta (la ficha nunca espera a los siguientes sondeos). onGiveUp(radar): se agotan
// los sondeos sin resultado definitivo (lo usa el seguimiento en vivo en espera, js/app.js, para no quedarse parado).
export function pollRadar({ fetchOnce, onResult, onGiveUp = () => {}, isActive = () => true, delays = RADAR_POLL_DELAYS_MS, maxMs = RADAR_POLL_MAX_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), now = () => Date.now() }) {
  let timer = null, cancelled = false, startedAt = null, normalTurn = 0;
  const stopped = () => cancelled || !isActive();
  const step = async attempt => {
    timer = null;
    if (stopped()) return null;
    const radar = await fetchOnce({ poll: attempt > 0 });
    startedAt ??= now();
    if (stopped()) return radar;
    // Sin respuesta en un sondeo no se pinta nada (se queda lo último que se vio).
    if (radar || attempt === 0) onResult(radar, { attempt });
    if (keepPolling(radar)) {
      const next = nextPollDelay(radar, normalTurn, delays);
      // Límite total: si el siguiente sondeo caería después, se para (nunca se adelanta para caber).
      if (now() + next.ms - startedAt <= maxMs) {
        if (next.normal) normalTurn++;
        timer = setTimer(() => { step(attempt + 1).catch(() => {}); }, next.ms);
      } else onGiveUp(radar);
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
  // La fuente (solo Flightradar24; adsb.lol es la de siempre) acompaña a los estados sin telemetría para atribuirlos bien.
  const src = radar.source === 'fr24' ? { source: 'fr24' } : {};
  if (radar.state === 'aterrizado') return { ...card, status: landedStatus(radar.source), radar: { state: 'aterrizado', ...src } };
  // El servidor aún está buscando el avión (indicativos exactos, identificación por ruta o esperando a que adsb.lol
  // levante una pausa): «Localizando…», también si Aena ya dice «Volando» (el estado de Aena se queda).
  if (radar.identifying === true) return { ...card, radar: { state: 'localizando' } };
  // Aena ya dice «Volando» (FLY/FNL) y el radar no lo ve: se queda lo de Aena, sin panel ni avisos del radar.
  if (card.status?.flying) return card;
  const ageMin = Number.isFinite(lastSeenMs) ? Math.round((nowMs - lastSeenMs) / MIN) : null; // igual que la ETA
  if (ageMin !== null && ageMin < STALE_MIN) {
    const ago = ageMin < 1 ? 'menos de 1 min' : `${ageMin} min`;
    return { ...card, status: { text: `Última señal: volando hace ${ago}`, tone: 'info' }, radar: { state: 'reciente', ageMin, ...src } };
  }
  // Aena aún no confirma la salida (p. ej. «Última llamada»): el avión puede seguir en tierra. Se queda el estado de
  // Aena, sin «Sin señal ADS-B» (no se asume que haya despegado).
  if (radar.departureConfirmed === false) return card;
  return { ...card, radar: { state: ageMin === null && radar.state === 'no-disponible' ? 'no-disponible' : 'sin-senal', ...src } };
}

// Aterrizaje confirmado por ADS-B (el servidor exige tierra, en el destino, señal reciente, mismo indicativo y el
// tiempo mínimo físico de vuelo). Se guarda para que al recargar no se vuelva a «Ha salido»; una lectura posterior
// de «volando» no lo deshace. Aena manda si confirma la llegada; desviado o cancelado, nunca.
// Con Flightradar24 (source 'fr24') los textos lo dicen a él, nunca «ADS-B»; sin fuente o adsb.lol, los de siempre.
const LANDED_STATUS = { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B', landing: 'confirmed-landed' };
const LANDED_STATUS_FR24 = { ...LANDED_STATUS, note: 'Confirmado por Flightradar24', source: 'fr24' };
const landedStatus = source => (source === 'fr24' ? LANDED_STATUS_FR24 : LANDED_STATUS);
export const LANDED_NOTE = 'Este vuelo ya ha aterrizado según el radar ADS-B: no se muestra la previsión de turbulencias.';
const LANDED_NOTE_FR24 = 'Este vuelo ya ha aterrizado según Flightradar24: no se muestra la previsión de turbulencias.';
export const landedNote = source => (source === 'fr24' ? LANDED_NOTE_FR24 : LANDED_NOTE);
const LANDED_STORE = 'turbi-landed';
const LANDED_SOURCE_STORE = 'turbi-landed-source'; // solo las confirmadas por Flightradar24 (aparte: el formato de siempre no cambia)
const landings = new Map();
const landingSources = new Map();

// source: la fuente que confirmó el aterrizaje (recallLandingSource); por defecto, la de la lectura que lleve la tarjeta.
export function withLanding(card, landedAtMs, leg, source = card?.radar?.source) {
  if (!Number.isFinite(landedAtMs)) return card;
  const flags = [leg.st, leg.std, leg.sta];
  if (ARR_FINAL.has(leg.sta) || flags.includes('CAN') || flags.includes('DES')) return card; // Aena manda
  return { ...card, status: landedStatus(source), radar: { state: 'aterrizado', ...(source === 'fr24' ? { source } : {}) } };
}

export function rememberLanding(key, radar, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (radar?.state !== 'aterrizado') return;
  const at = nowMs - (radar.seenS ?? 0) * 1000;
  const fr24 = radar.source === 'fr24';
  landings.set(key, at);
  if (fr24) landingSources.set(key, 'fr24'); else landingSources.delete(key);
  try {
    const all = JSON.parse(storage?.getItem(LANDED_STORE) ?? '{}');
    for (const [k, t] of Object.entries(all)) if (nowMs - t > 7 * 24 * 3600000) delete all[k];
    all[key] = at;
    storage?.setItem(LANDED_STORE, JSON.stringify(all));
    const src = JSON.parse(storage?.getItem(LANDED_SOURCE_STORE) ?? '{}');
    for (const k of Object.keys(src)) if (!(k in all)) delete src[k];
    if (fr24) src[key] = 'fr24'; else delete src[key];
    storage?.setItem(LANDED_SOURCE_STORE, JSON.stringify(src));
  } catch { /* sin almacenamiento: queda en memoria */ }
}

// 'fr24' si el aterrizaje guardado lo confirmó Flightradar24; si no, null (radar ADS-B, como siempre).
export function recallLandingSource(key, storage = globalThis.localStorage, { fresh = false } = {}) {
  if (!fresh && landingSources.has(key)) return landingSources.get(key);
  try {
    return JSON.parse(storage?.getItem(LANDED_SOURCE_STORE) ?? '{}')[key] === 'fr24' ? 'fr24' : null;
  } catch {
    return null;
  }
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
