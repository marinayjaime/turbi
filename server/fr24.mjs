// Flightradar24 API: PRUEBA de backend (fase 1). Solo bajo demanda, en /fr24-test/<vuelo>.json; nunca en segundo plano,
// sin reintentos y sin sustituir a adsb.lol. La clave (FR24_API_TOKEN) solo se lee aquí, solo va en la cabecera de la
// petición a FR24 y nunca se registra ni se devuelve: la respuesta es una lista cerrada de campos normalizados.
export const FR24_BASE = 'https://fr24api.flightradar24.com/api';
const TIMEOUT_MS = 10000;
// Número de vuelo: prefijo IATA (2, con al menos una letra) u OACI (3 letras), 1–4 cifras y sufijo opcional de hasta 2
// letras (indicativos operativos como RYR19HB). Nada más entra en la URL.
export const FLIGHT_RE = /^(?:[A-Z]{3}|[A-Z][A-Z0-9]|[0-9][A-Z])\d{1,4}[A-Z]{0,2}$/;
const TEST_PATH = /^\/fr24-test\/([A-Za-z0-9]{3,9})\.json$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

const tokenOf = env => (typeof env?.FR24_API_TOKEN === 'string' ? env.FR24_API_TOKEN.trim() : '');
// /health: solo si la variable existe. Nunca llama a FR24 ni devuelve su valor.
export const fr24Configured = (env = process.env) => tokenOf(env).length > 0;

// Campos de diagnóstico: números finitos y textos cortos (primera línea, caracteres seguros). Lo demás se descarta.
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = v => (v === null || v === undefined ? null : String(v).split(/[\r\n]/)[0].replace(/[^\w .:+/-]/g, '').slice(0, 40) || null);
export function normalizeFlight(f = {}) {
  return {
    fr24Id: text(f.fr24_id), callsign: text(f.callsign), lat: num(f.lat), lon: num(f.lon), track: num(f.track), alt: num(f.alt),
    gspeed: num(f.gspeed), vspeed: num(f.vspeed), timestamp: text(f.timestamp), source: text(f.source), hex: text(f.hex),
    type: text(f.type), reg: text(f.reg), operatingAs: text(f.operating_as), paintedAs: text(f.painted_as),
    originIata: text(f.orig_iata), destinationIata: text(f.dest_iata), eta: text(f.eta),
    // Para el descubrimiento (server/fr24-discover.mjs): número tal cual y aeropuertos OACI.
    flightNumber: text(f.flight), origIcao: icao(f.orig_icao), destIcao: icao(f.dest_icao),
  };
}

// Por si FR24 devolviera la clave en algún campo: nunca sale. (La clave nunca se usa en mensajes ni errores.)
const scrub = (value, token) => (token ? JSON.parse(JSON.stringify(value).split(token).join('[oculto]')) : value);

const reasonOf = status => (status === 401 || status === 403 ? 'autorizacion' : status === 429 ? 'limite' : status >= 500 ? 'servidor' : 'http');

// Posición en vivo de un número de vuelo (ya validado). { state: 'found' | 'multiple' | 'not-found' | 'unavailable', … }.
// Varios resultados: no se elige ninguno; se devuelven los candidatos para diagnosticarlos.
export async function fr24Lookup(flight, { fetchFn = fetch, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const token = tokenOf(env);
  if (!token) return { state: 'unavailable', reason: 'sin-configurar', flight };
  let res;
  try {
    res = await fetchFn(`${FR24_BASE}/live/flight-positions/full?flights=${encodeURIComponent(flight)}&limit=5`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { state: 'unavailable', reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'red', flight };
  }
  if (!res.ok) {
    const out = { state: 'unavailable', reason: reasonOf(res.status), httpStatus: res.status, flight };
    // Retry-After en segundos, solo si FR24 lo da (sin cabecera, Number(null) sería un 0 inventado).
    const header = res.headers?.get?.('Retry-After');
    const retry = header === null || header === undefined || String(header).trim() === '' ? NaN : Number(header);
    if (res.status === 429 && Number.isFinite(retry) && retry >= 0) out.retryAfterSec = retry;
    return out;
  }
  let body;
  try { body = await res.json(); } catch { return { state: 'unavailable', reason: 'respuesta-invalida', flight }; }
  const items = Array.isArray(body?.data) ? body.data : [];
  if (!items.length) return { state: 'not-found', flight };
  if (items.length > 1) return scrub({ state: 'multiple', flight, count: items.length, candidates: items.map(normalizeFlight) }, token);
  return scrub({ state: 'found', flight, ...normalizeFlight(items[0]) }, token);
}

// GET /fr24-test/<vuelo>.json: valida el número de vuelo y consulta FR24 una vez. lookup: en Render, la consulta con caché
// de 40 s por número y contadores de /health (fr24CachedLookup, server/fr24-radar.mjs): el endpoint es público.
export async function fr24TestResponse(path, { fetchFn = fetch, env = process.env, lookup = fr24Lookup } = {}) {
  const m = String(path).match(TEST_PATH);
  const flight = m?.[1].toUpperCase();
  if (!flight || !FLIGHT_RE.test(flight)) return { status: 400, headers: HEADERS, body: '{"state":"invalid","error":"número de vuelo no válido"}' };
  const out = await lookup(flight, { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error', flight }));
  return { status: 200, headers: HEADERS, body: JSON.stringify(scrub(out, tokenOf(env))) };
}

// Flight Summary Light (histórico): fecha y hora en ISO UTC válidas o null; aeropuertos OACI de 4 letras o null.
const iso = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
const icao = v => (typeof v === 'string' && /^[A-Z]{4}$/.test(v) ? v : null);
export function normalizeSummary(f = {}) {
  return {
    fr24Id: text(f.fr24_id), flight: text(f.flight), callsign: text(f.callsign), operatingAs: text(f.operating_as), type: text(f.type),
    reg: text(f.reg), hex: text(f.hex), origIcao: icao(f.orig_icao), destIcao: icao(f.dest_icao), destIcaoActual: icao(f.dest_icao_actual),
    takeoff: iso(f.datetime_takeoff), landed: iso(f.datetime_landed), firstSeen: iso(f.first_seen), lastSeen: iso(f.last_seen),
    ended: f.flight_ended === true,
  };
}

const utcParam = ms => new Date(ms).toISOString().slice(0, 19) + 'Z';
// Vuelos históricos de un número en una ruta (OACI) cuyo first_seen cae en [fromMs, toMs]: FR24 Flight Summary Light. Una
// llamada, sin reintentos, timeout de 10 s. → { state: 'ok', flights: [normalizeSummary…], credits } | { state: 'unavailable',
// reason, httpStatus?, retryAfterSec? }. Elegir el vuelo (o ninguno) es cosa de quien llama (server/fr24-history.mjs).
export async function fr24Summary({ flight, origIcao, destIcao, fromMs, toMs }, { fetchFn = fetch, env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  if (!FLIGHT_RE.test(String(flight)) || !icao(origIcao) || !icao(destIcao) || !(toMs > fromMs)) return { state: 'unavailable', reason: 'consulta-no-valida' };
  const token = tokenOf(env);
  if (!token) return { state: 'unavailable', reason: 'sin-configurar' };
  const query = new URLSearchParams({ flights: flight, routes: `${origIcao}-${destIcao}`, flight_datetime_from: utcParam(fromMs),
    flight_datetime_to: utcParam(toMs), limit: '10' });
  let res;
  try {
    res = await fetchFn(`${FR24_BASE}/flight-summary/light?${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { state: 'unavailable', reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'red' };
  }
  if (!res.ok) {
    const out = { state: 'unavailable', reason: reasonOf(res.status), httpStatus: res.status };
    const header = res.headers?.get?.('Retry-After');
    const retry = header === null || header === undefined || String(header).trim() === '' ? NaN : Number(header);
    if (res.status === 429 && Number.isFinite(retry) && retry >= 0) out.retryAfterSec = retry;
    return out;
  }
  let body;
  try { body = await res.json(); } catch { return { state: 'unavailable', reason: 'respuesta-invalida' }; }
  const credits = Number(res.headers?.get?.('x-fr24-credits-consumed'));
  const flights = (Array.isArray(body?.data) ? body.data : []).filter(f => f && typeof f === 'object').map(normalizeSummary);
  return scrub({ state: 'ok', flights, credits: Number.isFinite(credits) ? credits : null }, token);
}

// Fuentes de posición REAL (decisión conservadora): cualquier otra (ESTIMATED, FAA, OTHER, vacía…) no es una medida.
// La usan el radar (server/fr24-radar.mjs) y la estela (fr24Track).
export const REAL_SOURCES = new Set(['ADSB', 'MLAT', 'SATELLITE', 'UAT', 'FLARM']);
// fr24Id: identificador corto alfanumérico (hexadecimal en la práctica). Nada más entra en la URL de Flight Tracks.
export const FR24_ID_RE = /^[A-Za-z0-9]{4,16}$/;
const TRACK_MAX_POINTS = 600;
const FUTURE_TOLERANCE_MS = 30000;
const round4 = v => Math.round(v * 1e4) / 1e4;

// Estela real de un vuelo de FR24 (Flight Tracks) por su fr24Id, que SOLO viene de la asociación del radar
// (server/fr24-track.mjs). Una llamada, sin reintentos, timeout de 10 s. → { state: 'found', fr24Id, points: [[lat, lon]…],
// times: [s…] (hora de cada punto, epoch en segundos), lastAt } | { state: 'not-found' } | { state: 'unavailable', reason,
// httpStatus? }. Solo posiciones de fuente real con lat/lon finitos y hora válida (no del futuro), ordenadas por tiempo y,
// si pasan de 600, un submuestreo uniforme que conserva el primero y el último (sin interpolar ni inventar nada). Una
// respuesta de otro fr24_id (o sin él) no se acepta: nunca se mezclan vuelos.
export async function fr24Track(fr24Id, { fetchFn = fetch, env = process.env, timeoutMs = TIMEOUT_MS, nowMs = Date.now() } = {}) {
  if (typeof fr24Id !== 'string' || !FR24_ID_RE.test(fr24Id)) return { state: 'unavailable', reason: 'id-no-valido' };
  const token = tokenOf(env);
  if (!token) return { state: 'unavailable', reason: 'sin-configurar' };
  let res;
  try {
    res = await fetchFn(`${FR24_BASE}/flight-tracks?flight_id=${encodeURIComponent(fr24Id)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'Accept-Version': 'v1', Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return { state: 'unavailable', reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'red' };
  }
  if (res.status === 404) return { state: 'not-found' };
  if (!res.ok) return { state: 'unavailable', reason: reasonOf(res.status), httpStatus: res.status };
  let body;
  try { body = await res.json(); } catch { return { state: 'unavailable', reason: 'respuesta-invalida' }; }
  const flight = (Array.isArray(body) ? body : [body]).find(b => b && typeof b === 'object' && String(b.fr24_id ?? '').toLowerCase() === fr24Id.toLowerCase());
  const real = [];
  for (const p of Array.isArray(flight?.tracks) ? flight.tracks : []) {
    const ms = typeof p?.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
    if (!REAL_SOURCES.has(String(p?.source ?? '').toUpperCase()) || !Number.isFinite(ms) || ms > nowMs + FUTURE_TOLERANCE_MS) continue;
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
      || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
    real.push({ ms, lat: round4(p.lat), lon: round4(p.lon) });
  }
  real.sort((a, b) => a.ms - b.ms);
  const unique = real.filter((p, i) => i === 0 || p.ms !== real[i - 1].ms);
  if (!unique.length) return { state: 'not-found' };
  const kept = unique.length <= TRACK_MAX_POINTS ? unique
    : Array.from({ length: TRACK_MAX_POINTS }, (_, i) => unique[Math.round((i * (unique.length - 1)) / (TRACK_MAX_POINTS - 1))]);
  return { state: 'found', fr24Id, points: kept.map(p => [p.lat, p.lon]), times: kept.map(p => Math.round(p.ms / 1000)),
    lastAt: new Date(kept.at(-1).ms).toISOString() };
}
