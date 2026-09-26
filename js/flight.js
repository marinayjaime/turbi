import { findAirport } from './airports.js';

const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
const FLIGHT_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

const toAirport = a => ({ iata: a.iata_code, name: a.name, city: a.municipality, lat: a.latitude, lon: a.longitude });

// Resultado de ADSBDB para un número, distinguiendo lo que significa cada fallo:
//   { status: 'found', flight, iata: [origen, destino] }  flight es null si faltan coordenadas (ruta inutilizable)
//   { status: 'unknown' }  ADSBDB no conoce ese número (404 o respuesta sin ruta)
//   { status: 'error' }    fallo temporal (red, tiempo límite, 429, 5xx…): no dice nada sobre el vuelo
// timeoutMs: adsbdb a veces no responde; mejor pasar a la entrada manual que esperar sin fin.
export async function lookupFlightResult(number, fetchFn = fetch, timeoutMs = 8000) {
  const code = String(number).toUpperCase().replace(/\s+/g, '');
  if (!FLIGHT_RE.test(code)) return { status: 'unknown' };
  let body;
  try {
    const res = await fetchFn(ADSBDB + code, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return { status: 'unknown' };
    if (!res.ok) return { status: 'error' };
    body = await res.json();
  } catch {
    return { status: 'error' };
  }
  const route = body?.response?.flightroute;
  const iata = [route?.origin?.iata_code, route?.destination?.iata_code];
  if (!iata[0] || !iata[1]) return { status: 'unknown' };
  const located = a => Number.isFinite(a?.latitude) && Number.isFinite(a?.longitude);
  const flight = located(route.origin) && located(route.destination) ? {
    number: route.callsign_iata || code,
    airline: route.airline?.name ?? '',
    origin: toAirport(route.origin),
    destination: toAirport(route.destination),
  } : null;
  return { status: 'found', flight, iata };
}

// La ruta de ADSBDB, o null si no la hay (desconocido, fallo o sin coordenadas).
export async function lookupFlight(number, fetchFn = fetch, timeoutMs = 8000) {
  return (await lookupFlightResult(number, fetchFn, timeoutMs)).flight ?? null;
}

// Nota que acompaña siempre a una ruta sacada de ADSBDB (no es un horario oficial).
export const ADSBDB_NOTE = 'ruta según ADSBDB (no oficial)';

// ADSBDB solo aporta los códigos IATA de origen y destino: los aeropuertos (zona horaria, nombre, ciudad, coordenadas)
// salen siempre de data/airports.json. Si alguno no está, null → entrada manual (nunca una ruta sin zona horaria).
export function canonicalRoute(flight, db) {
  const origin = findAirport(db, flight.origin.iata ?? '');
  const destination = findAirport(db, flight.destination.iata ?? '');
  return origin && destination ? { ...flight, origin, destination } : null;
}
