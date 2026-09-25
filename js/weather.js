const BASE = 'https://api.open-meteo.com/v1/forecast';
const CHUNK = 100;
const HOUR_MS = 3600000;

// Error de red o del servicio: tiene sentido que la app ofrezca «Reintentar».
const retryable = message => Object.assign(new Error(message), { retryable: true });

const TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 600;
// Tras un fallo de conexión (timeout o red), las consultas que esperan en la cola fallan en el acto durante este
// tiempo, como tras un 429. Sin esto, con Open-Meteo colgado, las consultas de ECMWF y GFS (en serie) esperaban
// cada una su timeout y la sección tardaba ~90 s en decir que no hay previsión.
const DOWN_MS = 10000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Estado por cliente HTTP (en la app, un único fetch compartido): caché de respuestas y pausa tras un 429.
//  - Caché por URL (la URL ya fija ruta, horario y modelo): CACHE_MS; solo respuestas correctas. Así repetir una
//    búsqueda o pulsar «Actualizar» no vuelve a gastar consultas de Open-Meteo.
//  - 429: no se vuelve a llamar hasta que pase Retry-After (o DEFAULT_BLOCK_MS si no viene).
const CACHE_MS = 45 * 60000;
const DEFAULT_BLOCK_MS = 60000;
const states = new WeakMap();
const stateOf = fetchFn => states.get(fetchFn) ?? states.set(fetchFn, { cache: new Map(), pending: new Map(), queue: Promise.resolve(), blockedUntil: 0,
  downUntil: 0 }).get(fetchFn);
const CONNECTION = 'No se pudo conectar con el servicio del tiempo (Open-Meteo). Revisa la conexión e inténtalo de nuevo.';
const TOO_MANY = 'Demasiadas consultas seguidas: espera un minuto y vuelve a intentarlo.';
const tooMany = ms => Object.assign(retryable(TOO_MANY), { retryAfterMs: ms, rateLimited: true });

function retryAfterMs(res) {
  const v = res.headers?.get?.('Retry-After');
  if (!v) return DEFAULT_BLOCK_MS;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : DEFAULT_BLOCK_MS;
}

// En el móvil la red puede cortarse un instante: un fallo de red o un 5xx se reintenta una vez.
async function requestJson(url, fetchFn, st, tries) {
  // Se comprueba al empezar de verdad (no al entrar en la cola): un 429 de la petición anterior cancela las que
  // esperaban sin volver a tocar Open-Meteo.
  if (Date.now() < st.blockedUntil) throw tooMany(st.blockedUntil - Date.now());
  if (Date.now() < st.downUntil) throw retryable(CONNECTION);
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      // Un corte momentáneo (falla en el acto) se reintenta; un timeout no: ya se esperó TIMEOUT_MS.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      if (attempt < tries && !timedOut) { await sleep(RETRY_DELAY_MS); continue; }
      st.downUntil = Date.now() + DOWN_MS;
      throw retryable(CONNECTION);
    }
    if (res.status === 429) {
      const ms = retryAfterMs(res);
      st.blockedUntil = Date.now() + ms;
      throw tooMany(ms);
    }
    if (res.status >= 500 && attempt < tries) { await sleep(RETRY_DELAY_MS); continue; }
    if (!res.ok) throw retryable(`No se pudo obtener el pronóstico (HTTP ${res.status})`);
    const body = await res.json();
    if (st.cache.size > 200) st.cache.clear();
    st.cache.set(url, { at: Date.now(), body });
    return body;
  }
}

async function getJson(url, fetchFn, tries = 2) {
  const st = stateOf(fetchFn);
  const hit = st.cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  if (Date.now() < st.blockedUntil) throw tooMany(st.blockedUntil - Date.now());
  if (Date.now() < st.downUntil) throw retryable(CONNECTION);
  // La misma consulta concurrente se comparte. Las distintas se ejecutan una detrás de otra para no lanzar de golpe
  // centros, laterales, ECMWF y GFS; el resultado visual es el mismo y se reducen mucho los 429.
  if (st.pending.has(url)) return st.pending.get(url);
  const task = st.queue.then(() => requestJson(url, fetchFn, st, tries));
  st.queue = task.catch(() => {});
  st.pending.set(url, task);
  task.finally(() => st.pending.delete(url)).catch(() => {});
  return task;
}

// «Reintentar» del usuario: vuelve a intentarlo de verdad aunque la pausa tras un fallo de conexión no haya acabado
// (la del 429 se respeta: Open-Meteo lo ha pedido).
export function allowRetry(fetchFn = fetch) {
  const st = states.get(fetchFn);
  if (st) st.downUntil = 0;
}

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
    const json = await getJson(forecastUrl(locs.slice(i, i + CHUNK), startMs, endMs), fetchFn);
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

// --- v2: petición por modelo y variables a elección (ver js/models.js) ---

export function modelForecastUrl(locs, vars, model, startMs, endMs) {
  const params = new URLSearchParams({
    latitude: locs.map(l => l.lat.toFixed(3)).join(','),
    longitude: locs.map(l => l.lon.toFixed(3)).join(','),
    hourly: vars.join(','),
    models: model,
    wind_speed_unit: 'ms',
    timezone: 'GMT',
    start_hour: hourKey(startMs - HOUR_MS),
    end_hour: hourKey(endMs + HOUR_MS),
  });
  return `${BASE}?${params}`;
}

export async function fetchModelLocations(locs, vars, model, startMs, endMs, fetchFn = fetch) {
  const results = [];
  for (let i = 0; i < locs.length; i += CHUNK) {
    const json = await getJson(modelForecastUrl(locs.slice(i, i + CHUNK), vars, model, startMs, endMs), fetchFn);
    results.push(...(Array.isArray(json) ? json : [json]));
  }
  return results;
}

// Valores de una ubicación a la hora más cercana, con la coordenada real de la rejilla del modelo.
export function sampleVars(loc, ms, vars) {
  const i = loc?.hourly?.time?.indexOf(hourKey(ms)) ?? -1;
  if (i < 0) return null;
  const out = { lat: loc.latitude, lon: loc.longitude, elevation: loc.elevation ?? null };
  for (const v of vars) out[v] = loc.hourly[v]?.[i] ?? null;
  return out;
}
