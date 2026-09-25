// Radar (ADS-B) en la ficha: solo para vuelos que Aena da por salidos sin publicar su llegada (destino extranjero).
// El servidor en directo (server/radar.mjs) busca el vuelo por su indicativo exacto; aquí solo se muestra lo que dice.
import { LIVE_BASE } from './config.js';
import { STALE_MIN } from './eta.js';
import { flightStatus } from './schedule.js';

const ARR_FINAL = new Set(['LND', 'IBK', 'OPE', 'OPF', 'BOR']);

export function wantsRadar(leg, liveBase = LIVE_BASE) {
  return Boolean(liveBase) && (leg.std ?? leg.st) === 'BOR' && !leg.sta;
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

// Estado que se muestra (distinto del último estado oficial de Aena, que no se toca):
//   Aena confirma la llegada (o da otro estado de llegada), no ha salido, cancelado o desviado → estado oficial;
//   ha salido y la llegada VISIBLE en la ficha (Aena o estimación Turbi) aún no ha pasado → «Ha salido»;
//   ha salido y esa llegada ya pasó, o la ficha no muestra ninguna → «Histórico», etiqueta neutra (no es un estado
//   operativo: nunca «aterrizado», «ha llegado» ni «completado» si ninguna fuente lo confirma).
// «Volando» (radar) lo pone withRadar encima de esto. visibleArrivalMs = la misma hora que muestra la ficha, o null.
export function presentStatus({ leg, city, visibleArrivalMs = null, nowMs = Date.now() }) {
  const official = flightStatus(leg);
  const flags = [leg.st, leg.std, leg.sta];
  if ((leg.std ?? leg.st) !== 'BOR' || leg.sta || flags.includes('CAN') || flags.includes('DES')) return official;
  if (Number.isFinite(visibleArrivalMs) && visibleArrivalMs > nowMs) {
    return leg.sa ? official : { text: `Ha salido · Aena no informa de la llegada a ${city}`, tone: 'info' };
  }
  return { text: 'Histórico', tone: 'stale',
    note: leg.sa || leg.ea ? 'Aena no ha confirmado la llegada' : 'Aena no publica la llegada a este destino' };
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
  return radar?.state === 'volando'
    ? 'El radar indica que el avión sigue en el aire: la previsión de turbulencias no se muestra con el vuelo en curso.' : null;
}

export async function fetchRadar(al, n, fetchFn = fetch, liveBase = LIVE_BASE) {
  try {
    const res = await fetchFn(`${liveBase}/radar/${al}/${n}.json`, { signal: AbortSignal.timeout(20000) });
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
export function withRadar(card, radar, lastSeenMs = null, nowMs = Date.now()) {
  if (!radar || !['volando', 'sin-datos', 'no-disponible'].includes(radar.state)) return card;
  if (radar.state === 'volando') return { ...card, status: { text: 'Volando', tone: 'info', flying: true }, radar };
  const ageMin = Number.isFinite(lastSeenMs) ? Math.round((nowMs - lastSeenMs) / MIN) : null; // igual que la ETA
  if (ageMin !== null && ageMin < STALE_MIN) {
    const ago = ageMin < 1 ? 'menos de 1 min' : `${ageMin} min`;
    return { ...card, status: { text: `Última señal: volando hace ${ago}`, tone: 'info' }, radar: { state: 'reciente', ageMin } };
  }
  return { ...card, radar: { state: ageMin === null && radar.state === 'no-disponible' ? 'no-disponible' : 'sin-senal' } };
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
