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

// Aviso cuando ya pasó la llegada: «ha aterrizado» solo si lo confirma Aena.
export function endedNote(leg) {
  return ARR_FINAL.has(leg?.sta) ? 'Este vuelo ya ha aterrizado.'
    : 'La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.';
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
