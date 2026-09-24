const BASE = 'https://api.open-meteo.com/v1/forecast';
const CHUNK = 100;
const HOUR_MS = 3600000;

// Error de red o del servicio: tiene sentido que la app ofrezca «Reintentar».
const retryable = message => Object.assign(new Error(message), { retryable: true });

export const HOURLY_VARS = [
  'wind_speed_300hPa', 'wind_direction_300hPa', 'geopotential_height_300hPa',
  'wind_speed_250hPa', 'wind_direction_250hPa', 'geopotential_height_250hPa',
  'wind_speed_700hPa', 'cape', 'weather_code',
];

export function hourKey(ms) {
  return new Date(Math.round(ms / HOUR_MS) * HOUR_MS).toISOString().slice(0, 13) + ':00';
}

export function neighbours(p, km = 50) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos(p.lat * Math.PI / 180));
  return {
    n: { lat: p.lat + dLat, lon: p.lon },
    s: { lat: p.lat - dLat, lon: p.lon },
    e: { lat: p.lat, lon: p.lon + dLon },
    w: { lat: p.lat, lon: p.lon - dLon },
  };
}

function forecastUrl(locs, startMs, endMs) {
  const params = new URLSearchParams({
    latitude: locs.map(l => l.lat.toFixed(3)).join(','),
    longitude: locs.map(l => l.lon.toFixed(3)).join(','),
    hourly: HOURLY_VARS.join(','),
    wind_speed_unit: 'ms',
    timezone: 'GMT',
    start_hour: hourKey(startMs - HOUR_MS),
    end_hour: hourKey(endMs + HOUR_MS),
  });
  return `${BASE}?${params}`;
}

export async function fetchLocations(locs, startMs, endMs, fetchFn = fetch) {
  const results = [];
  for (let i = 0; i < locs.length; i += CHUNK) {
    const res = await fetchFn(forecastUrl(locs.slice(i, i + CHUNK), startMs, endMs));
    if (res.status === 429) throw retryable('Demasiadas consultas seguidas: espera un minuto y vuelve a intentarlo.');
    if (!res.ok) throw retryable(`No se pudo obtener el pronóstico (HTTP ${res.status})`);
    const json = await res.json();
    results.push(...(Array.isArray(json) ? json : [json]));
  }
  return results;
}

function sampleAt(loc, ms) {
  const i = loc.hourly.time.indexOf(hourKey(ms));
  if (i < 0) throw new Error('No hay pronóstico para esa hora');
  const out = { elevation: loc.elevation ?? null };
  for (const v of HOURLY_VARS) out[v] = loc.hourly[v]?.[i] ?? null;
  return out;
}

export async function fetchRouteWeather(route, fetchFn = fetch) {
  const locs = [];
  const index = route.points.map(p => {
    const entry = { center: locs.push(p) - 1 };
    if (p.phase === 'cruise') {
      const nb = neighbours(p);
      for (const k of ['n', 's', 'e', 'w']) entry[k] = locs.push(nb[k]) - 1;
    }
    return entry;
  });

  const data = await fetchLocations(locs, route.departureMs, route.arrivalMs, fetchFn);

  return route.points.map((p, i) => {
    const out = {};
    for (const [k, idx] of Object.entries(index[i])) out[k] = sampleAt(data[idx], p.time);
    return out;
  });
}

export async function fetchTimezone(point, fetchFn = fetch) {
  const params = new URLSearchParams({
    latitude: point.lat.toFixed(3),
    longitude: point.lon.toFixed(3),
    hourly: 'cape',
    timezone: 'auto',
    forecast_days: '1',
  });
  const res = await fetchFn(`${BASE}?${params}`);
  if (!res.ok) throw retryable(`No se pudo obtener el pronóstico (HTTP ${res.status})`);
  return (await res.json()).timezone;
}
