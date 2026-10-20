// Acceso único a adsb.lol (API v2, gratuita y sin registro). TODAS las consultas del servidor —por indicativo, por
// zona, por hex y las trazas— pasan por un único limitador global:
//  - una petición detrás de otra, con una separación mínima entre inicios;
//  - dos prioridades: 'radar' (seguimiento normal por indicativo o por hex) e 'identificacion' (búsquedas por zona,
//    en segundo plano). Una consulta de identificación nunca sale si hay una de radar esperando, y deja más hueco;
//  - 429: pausa global (Retry-After si viene; si no, 60 s). Al primer 429 se cancelan las consultas de identificación
//    pendientes. Durante la pausa no se llama a adsb.lol: la respuesta es «rate-limited» en el acto.
// adsb.lol no publica su límite (medido el 25/09/2026: tras ~3 peticiones seguidas, 429 con 1,1 s y con 2 s; en
// producción, /health mostró 3 aciertos y un 429 a los 1,5 s). Por eso el ritmo es conservador: nunca dos peticiones
// con menos de 5 s entre sus inicios, sean del vuelo o del usuario que sean. La separación sola no basta: con 5–8 s
// entre peticiones (64 peticiones reales, 25/09/2026 15:04–15:24 UTC) llegaba un 429 tras 6–7 peticiones en ~1 min.
// Por eso, además, como mucho ADSB_MAX_PER_WINDOW inicios en cualquier minuto; la identificación deja libre uno de
// ellos para el radar normal. En producción (Render, 25–26/09/2026) seguía llegando algún 429 con 4/min: la IP de
// salida de Render es compartida y adsb.lol cuenta también lo que hacen otros. Por eso 3/min (identificación 2) y,
// tras cada 429, una pausa ADAPTATIVA: 60 s, y si vuelve a pasar poco después 120 s, 180 s… (máx. 5 min). Tras una
// racha de aciertos vuelve a la pausa base. El número de peticiones por minuto nunca se sube solo.
const ADSB = 'https://api.adsb.lol/v2';
// adsb.lol exige un User-Agent con contacto (si no, 403).
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const TIMEOUT_MS = 8000;
// Heurísticas ajustables.
export const ADSB_MIN_INTERVAL_MS = 5000; // separación mínima entre dos peticiones cualesquiera (inicio a inicio)
export const ADSB_IDENTIFY_INTERVAL_MS = 8000; // identificación: hueco mínimo desde la última petición de cualquier tipo
export const ADSB_DEFAULT_COOLDOWN_MS = 60000; // pausa global tras un 429 sin Retry-After
export const ADSB_WINDOW_MS = 60000; // ventana móvil del tope de peticiones
export const ADSB_MAX_PER_WINDOW = 3; // inicios como mucho en cualquier ventana (la identificación, uno menos)
export const ADSB_MAX_COOLDOWN_MS = 300000; // techo de la pausa adaptativa tras 429 repetidos
export const ADSB_STRIKE_MEMORY_MS = 600000; // un 429 a menos de esto del anterior cuenta como repetido
export const ADSB_RECOVERY_SUCCESSES = 5; // aciertos seguidos para volver a la pausa base

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CANCELLED = Symbol('cancelada por un 429');

// Telemetría para /health (contadores, fechas y, para diagnosticar los 429, las cabeceras de límite de una lista cerrada:
// nada de IP, cookies, URLs ni indicativos).
//  - lastAttemptAt / lastAttemptEndpoint / attemptsByEndpoint: solo peticiones que de verdad salen hacia adsb.lol;
//  - rateLimitedCount: 429 reales de adsb.lol; localRateLimitedCount: respuestas «rate-limited» del propio limitador
//    (pausa activa o consulta cancelada) sin llamar al proveedor;
//  - lastRateLimitHeaders: cabeceras de límite de la última respuesta que las traía; last429Headers: las del último 429.
const freshStats = () => ({ last429At: null, lastSuccessAt: null, lastErrorAt: null, lastError: null, lastStatus: null,
  rateLimitedCount: 0, successCount: 0, failedCount: 0, backoffStrikes: 0, lastCooldownSec: null,
  lastAttemptAt: null, lastAttemptEndpoint: null, lastFailureKind: null, localRateLimitedCount: 0,
  attemptsByEndpoint: {}, rateLimitedByEndpoint: {}, lastRateLimitHeaders: null, last429Headers: null });

export function createLimiter(minIntervalMs = ADSB_MIN_INTERVAL_MS, { identifyIntervalMs = ADSB_IDENTIFY_INTERVAL_MS,
  maxPerWindow = ADSB_MAX_PER_WINDOW, windowMs = ADSB_WINDOW_MS } = {}) {
  const queues = { radar: [], identificacion: [] };
  let busy = false, last = -Infinity, timer = null;
  let starts = []; // inicios dentro de la ventana móvil
  const limiter = {
    minIntervalMs,
    identifyIntervalMs,
    maxPerWindow,
    windowMs,
    blockedUntil: 0,
    strikes: 0, // 429 recientes seguidos (pausa adaptativa)
    lastRateLimitAt: -Infinity,
    successStreak: 0,
    stats: freshStats(),
    pendingOf: priority => queues[priority].length,
    // Tarea en cola; devuelve su resultado (o CANCELLED si se cancela por un 429).
    schedule(task, { priority = 'radar' } = {}) {
      return new Promise((resolve, reject) => {
        queues[priority].push({ task, resolve, reject });
        // Una espera en curso (p. ej. la identificación, hasta que se libere el minuto) se recalcula: el radar que
        // llega entretanto sale en cuanto le toca a él, sin quedarse detrás de ese temporizador.
        if (timer) { clearTimeout(timer); timer = null; }
        pump();
      });
    },
    pending: () => queues.radar.length + queues.identificacion.length,
    // Pausa global (429) y cancelación inmediata de las consultas de identificación que esperan.
    block(ms) {
      limiter.blockedUntil = Math.max(limiter.blockedUntil, Date.now() + ms);
      for (const job of queues.identificacion.splice(0)) job.resolve(CANCELLED);
    },
    // 429 de adsb.lol: pausa global adaptativa. retryAfter: la del servidor (ms) o null si no la manda. El primer
    // 429 respeta Retry-After (o 60 s); si se repite poco después, 60 s × número de 429 seguidos (máx. 5 min), nunca
    // menos de lo que pida Retry-After. Devuelve la pausa aplicada.
    rateLimited(retryAfter = null) {
      const now = Date.now();
      limiter.strikes = now - limiter.lastRateLimitAt < ADSB_STRIKE_MEMORY_MS ? limiter.strikes + 1 : 1;
      limiter.lastRateLimitAt = now;
      limiter.successStreak = 0;
      const adaptive = Math.min(ADSB_DEFAULT_COOLDOWN_MS * limiter.strikes, ADSB_MAX_COOLDOWN_MS);
      const ms = limiter.strikes === 1 && retryAfter !== null ? retryAfter : Math.max(retryAfter ?? 0, adaptive);
      limiter.stats.lastCooldownSec = Math.round(ms / 1000);
      limiter.stats.backoffStrikes = limiter.strikes;
      limiter.block(ms);
      return ms;
    },
    // Acierto: tras una racha suficiente, la pausa vuelve a la base.
    succeeded() {
      if (++limiter.successStreak >= ADSB_RECOVERY_SUCCESSES && limiter.strikes) {
        limiter.strikes = 0;
        limiter.stats.backoffStrikes = 0;
      }
    },
    isBlocked: () => Date.now() < limiter.blockedUntil,
    reset({ minIntervalMs: m = ADSB_MIN_INTERVAL_MS, identifyIntervalMs: i = ADSB_IDENTIFY_INTERVAL_MS,
      maxPerWindow: w = ADSB_MAX_PER_WINDOW, windowMs: wm = ADSB_WINDOW_MS } = {}) {
      Object.assign(limiter, { minIntervalMs: m, identifyIntervalMs: i, maxPerWindow: w, windowMs: wm, blockedUntil: 0, stats: freshStats(),
        strikes: 0, lastRateLimitAt: -Infinity, successStreak: 0 });
      last = -Infinity;
      starts = [];
      if (timer) { clearTimeout(timer); timer = null; }
      for (const q of Object.values(queues)) for (const job of q.splice(0)) job.resolve(CANCELLED);
    },
  };
  function pump() {
    if (busy || timer) return;
    const priority = queues.radar.length ? 'radar' : queues.identificacion.length ? 'identificacion' : null;
    if (!priority) return;
    const gap = priority === 'radar' ? limiter.minIntervalMs : Math.max(limiter.minIntervalMs, limiter.identifyIntervalMs);
    const now = Date.now();
    starts = starts.filter(t => now - t < limiter.windowMs);
    // Tope por ventana: la identificación solo usa hasta maxPerWindow − 1 (queda uno para el radar normal).
    const cap = priority === 'radar' ? limiter.maxPerWindow : Math.max(1, limiter.maxPerWindow - 1);
    const windowWait = starts.length >= cap ? starts[starts.length - cap] + limiter.windowMs - now : 0;
    const wait = Math.max(last + gap - now, windowWait);
    // Se vuelve a elegir al acabar la espera: si entretanto llega una de radar, sale antes.
    if (wait > 0) { timer = setTimeout(() => { timer = null; pump(); }, wait); return; }
    const job = queues[priority].shift();
    busy = true;
    last = Date.now();
    starts.push(last);
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { busy = false; pump(); });
  }
  return limiter;
}

// El limitador global del proceso (compartido por server/radar.mjs y server/identify.mjs).
export const adsbLimiter = createLimiter();

// Retry-After de la respuesta en ms, o null si no viene (o no se entiende).
function retryAfterMs(res) {
  const v = res.headers?.get?.('Retry-After');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Cabeceras de límite que se guardan para /health (lista cerrada; adsb.lol, 20/10/2026: x-ratelimit-limit
// «4, 4;w=1, 60;w=60, 500;w=86400», x-ratelimit-remaining, x-ratelimit-reset y x-envoy-ratelimited en los 429, sin
// Retry-After). Valor: solo la primera línea, caracteres seguros y como mucho 120.
const RATE_LIMIT_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-policy', 'x-envoy-ratelimited',
  'retry-after', 'ratelimit', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'ratelimit-policy'];
const safeValue = v => String(v).split(/[\r\n]/)[0].replace(/[^\w ,;=.:/-]/g, '').slice(0, 120);
function rateLimitHeaders(res) {
  const out = {};
  for (const name of RATE_LIMIT_HEADERS) {
    const v = res.headers?.get?.(name);
    if (v !== null && v !== undefined) out[name] = safeValue(v);
  }
  return Object.keys(out).length ? out : null;
}

// Tipo de consulta, nunca la URL: 'callsign' | 'hex' | 'point' | … | 'trace' | 'other'.
const ENDPOINTS = new Set(['callsign', 'hex', 'point', 'reg', 'type', 'sqk', 'mil', 'ladd', 'pia', 'icao', 'closest', 'radius']);
export function endpointKind(path) {
  if (/^https?:\/\//.test(path)) return /\/traces\//.test(path) ? 'trace' : 'other';
  const first = String(path).split('/').filter(Boolean)[0];
  return ENDPOINTS.has(first) ? first : 'other';
}

// Tipo de fallo para el diagnóstico: 'rate-limit' | 'http' | 'timeout' | 'network' | 'parse'.
const FAILURE_KIND = { 429: 'rate-limit', 'invalid-json': 'parse', timeout: 'timeout', network: 'network' };

// Tipo simple de fallo: '429' | '403' | '4xx' | '5xx' | 'timeout' | 'network' | 'invalid-json'.
const statusKind = s => (s === 429 ? '429' : s === 403 ? '403' : s >= 500 ? '5xx' : '4xx');
const errorKind = err => (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : err instanceof SyntaxError ? 'invalid-json' : 'network');
function recordError(limiter, kind) {
  const st = limiter.stats;
  st.lastError = kind;
  st.lastErrorAt = new Date().toISOString();
  st.lastFailureKind = FAILURE_KIND[kind] ?? 'http';
  if (kind === '429') { st.rateLimitedCount++; st.last429At = st.lastErrorAt; } else st.failedCount++;
}

// Diagnóstico de adsb.lol para /health: solo lee el estado; nunca consulta adsb.lol.
export function adsbHealth(limiter = adsbLimiter, nowMs = Date.now()) {
  const blocked = nowMs < limiter.blockedUntil;
  return {
    blocked,
    blockedUntil: blocked ? new Date(limiter.blockedUntil).toISOString() : null,
    retryInSec: blocked ? Math.ceil((limiter.blockedUntil - nowMs) / 1000) : 0,
    ...limiter.stats,
    pendingRadar: limiter.pendingOf('radar'),
    pendingIdentification: limiter.pendingOf('identificacion'),
  };
}

// GET a adsb.lol (API v2 o trazas) a través del limitador. Resultado: { data } | { error: 'rate-limited' } (429 o pausa activa: no se
// reintenta) | { error: 'failed' } (red, 5xx…: no se sabe nada).
export async function adsbGet(path, { fetchFn = fetch, limiter = adsbLimiter, priority = 'radar' } = {}) {
  const local = () => { limiter.stats.localRateLimitedCount++; return { error: 'rate-limited' }; }; // sin llamar a adsb.lol
  if (limiter.isBlocked()) return local();
  const endpoint = endpointKind(path);
  const out = await limiter.schedule(async () => {
    if (limiter.isBlocked()) return local();
    const st = limiter.stats;
    try {
      // Rutas de la API v2 o, para las trazas públicas del mismo proveedor, una URL completa de adsb.lol.
      const url = /^https:\/\/([a-z0-9-]+\.)*adsb\.lol\//.test(path) ? path : `${ADSB}${path}`;
      st.lastAttemptAt = new Date().toISOString(); // sale de verdad hacia adsb.lol
      st.lastAttemptEndpoint = endpoint;
      st.attemptsByEndpoint[endpoint] = (st.attemptsByEndpoint[endpoint] ?? 0) + 1;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': UA } });
      st.lastStatus = res.status;
      const rl = rateLimitHeaders(res);
      if (rl) st.lastRateLimitHeaders = { at: new Date().toISOString(), status: res.status, endpoint, ...rl };
      if (res.status === 429) {
        st.rateLimitedByEndpoint[endpoint] = (st.rateLimitedByEndpoint[endpoint] ?? 0) + 1;
        st.last429Headers = { at: new Date().toISOString(), status: 429, endpoint, ...(rl ?? {}) };
        recordError(limiter, '429');
        limiter.rateLimited(retryAfterMs(res)); // pausa de siempre: x-ratelimit-reset solo se observa, no se usa todavía
        return { error: 'rate-limited' };
      }
      if (!res.ok) { recordError(limiter, statusKind(res.status)); return { error: 'failed' }; }
      const data = await res.json();
      limiter.stats.successCount++;
      limiter.succeeded();
      limiter.stats.lastSuccessAt = new Date().toISOString();
      return { data };
    } catch (err) {
      recordError(limiter, errorKind(err));
      return { error: 'failed' };
    }
  }, { priority });
  return out === CANCELLED ? local() : out;
}
