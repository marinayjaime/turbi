let cache = null;

export async function loadAirports(fetchFn = fetch) {
  if (!cache) {
    try {
      const res = await fetchFn('data/airports.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache = await res.json();
    } catch {
      throw Object.assign(new Error('No se pudo cargar la lista de aeropuertos.'), { retryable: true });
    }
  }
  return cache;
}

// r = [nombre, ciudad, lat, lon, zona IANA]
const toAirport = (iata, r) => ({ iata, name: r[0], city: r[1], lat: r[2], lon: r[3], tz: r[4] ?? null });
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Zona horaria IANA del aeropuerto: siempre la de data/airports.json, calculada al generarlo (scripts/airport-tz.mjs,
// que no publica el archivo si falta alguna). Nunca se pide por la red.
export function timezoneOf(airport) {
  if (!airport.tz) throw new Error(`Falta la zona horaria del aeropuerto ${airport.iata}`);
  return airport.tz;
}

export function findAirport(db, code) {
  const iata = String(code).trim().toUpperCase();
  return db[iata] ? toAirport(iata, db[iata]) : null;
}

export function searchAirports(db, query, limit = 6) {
  const q = fold(String(query).trim());
  if (!q) return [];
  const byCode = [], byText = [];
  for (const [iata, r] of Object.entries(db)) {
    if (iata.toLowerCase().startsWith(q)) byCode.push(toAirport(iata, r));
    else if (fold(r[1]).includes(q) || fold(r[0]).includes(q)) byText.push(toAirport(iata, r));
  }
  return [...byCode, ...byText].slice(0, limit);
}
