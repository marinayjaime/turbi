import { findAirport } from './airports.js';

const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
const FLIGHT_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

const toAirport = a => ({ iata: a.iata_code, name: a.name, city: a.municipality, lat: a.latitude, lon: a.longitude });

// timeoutMs: adsbdb a veces no responde; mejor pasar a la entrada manual que esperar sin fin.
export async function lookupFlight(number, fetchFn = fetch, timeoutMs = 8000) {
  const code = String(number).toUpperCase().replace(/\s+/g, '');
  if (!FLIGHT_RE.test(code)) return null;
  try {
    const res = await fetchFn(ADSBDB + code, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const route = (await res.json())?.response?.flightroute;
    const located = a => Number.isFinite(a?.latitude) && Number.isFinite(a?.longitude);
    if (!located(route?.origin) || !located(route?.destination)) return null;
    return {
      number: route.callsign_iata || code,
      airline: route.airline?.name ?? '',
      origin: toAirport(route.origin),
      destination: toAirport(route.destination),
    };
  } catch {
    return null;
  }
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
