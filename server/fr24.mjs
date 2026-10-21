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
    const retry = Number(res.headers?.get?.('Retry-After'));
    if (res.status === 429 && Number.isFinite(retry)) out.retryAfterSec = retry;
    return out;
  }
  let body;
  try { body = await res.json(); } catch { return { state: 'unavailable', reason: 'respuesta-invalida', flight }; }
  const items = Array.isArray(body?.data) ? body.data : [];
  if (!items.length) return { state: 'not-found', flight };
  if (items.length > 1) return scrub({ state: 'multiple', flight, count: items.length, candidates: items.map(normalizeFlight) }, token);
  return scrub({ state: 'found', flight, ...normalizeFlight(items[0]) }, token);
}

// GET /fr24-test/<vuelo>.json: valida el número de vuelo y consulta FR24 una vez. Sin caché (es una prueba).
export async function fr24TestResponse(path, { fetchFn = fetch, env = process.env } = {}) {
  const m = String(path).match(TEST_PATH);
  const flight = m?.[1].toUpperCase();
  if (!flight || !FLIGHT_RE.test(flight)) return { status: 400, headers: HEADERS, body: '{"state":"invalid","error":"número de vuelo no válido"}' };
  const out = await fr24Lookup(flight, { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error', flight }));
  return { status: 200, headers: HEADERS, body: JSON.stringify(scrub(out, tokenOf(env))) };
}
