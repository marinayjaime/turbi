// Radar (ADS-B) en la ficha: solo para vuelos que Aena da por salidos sin publicar su llegada (destino extranjero).
// El servidor en directo (server/radar.mjs) busca el vuelo por su indicativo exacto; aquí solo se muestra lo que dice.
import { LIVE_BASE } from './config.js';

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

// Ficha con la respuesta del radar. Solo «volando» cambia el estado; lo demás se explica sin cambiarlo.
export function withRadar(card, radar) {
  if (!radar || !['volando', 'sin-datos', 'no-disponible'].includes(radar.state)) return card;
  if (radar.state !== 'volando') return { ...card, radar };
  return { ...card, status: { text: 'Volando', tone: 'info', flying: true }, radar };
}
