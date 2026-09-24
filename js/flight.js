const ADSBDB = 'https://api.adsbdb.com/v0/callsign/';
const FLIGHT_RE = /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/;

const toAirport = a => ({ iata: a.iata_code, name: a.name, city: a.municipality, lat: a.latitude, lon: a.longitude });

export async function lookupFlight(number, fetchFn = fetch) {
  const code = String(number).toUpperCase().replace(/\s+/g, '');
  if (!FLIGHT_RE.test(code)) return null;
  try {
    const res = await fetchFn(ADSBDB + code);
    if (!res.ok) return null;
    const route = (await res.json())?.response?.flightroute;
    if (!route?.origin || !route?.destination) return null;
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
