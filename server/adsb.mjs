// Acceso único a adsb.lol (API v2, gratuita y sin registro). TODAS las consultas del servidor —por indicativo, por
// zona y por hex— pasan por un único limitador global:
//  - una petición detrás de otra, con una separación mínima entre inicios;
//  - dos prioridades: 'radar' (seguimiento normal por indicativo o por hex) e 'identificacion' (búsquedas por zona,
//    en segundo plano). Una consulta de identificación nunca sale si hay una de radar esperando, y deja más hueco;
//  - 429: pausa global (Retry-After si viene; si no, 60 s). Al primer 429 se cancelan las consultas de identificación
//    pendientes. Durante la pausa no se llama a adsb.lol: la respuesta es «rate-limited» en el acto.
// adsb.lol no publica su límite (medido el 25/09/2026: tras ~3 peticiones seguidas, 429 con 1,1 s y con 2 s).
const ADSB = 'https://api.adsb.lol/v2';
// adsb.lol exige un User-Agent con contacto (si no, 403).
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const TIMEOUT_MS = 8000;
// Heurísticas ajustables.
export const ADSB_MIN_INTERVAL_MS = 1100; // radar: separación mínima entre dos peticiones (inicio a inicio)
export const ADSB_IDENTIFY_INTERVAL_MS = 5000; // identificación: hueco mínimo desde la última petición de cualquier tipo
export const ADSB_DEFAULT_COOLDOWN_MS = 60000; // pausa global tras un 429 sin Retry-After

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CANCELLED = Symbol('cancelada por un 429');

export function createLimiter(minIntervalMs = ADSB_MIN_INTERVAL_MS, { identifyIntervalMs = ADSB_IDENTIFY_INTERVAL_MS } = {}) {
  const queues = { radar: [], identificacion: [] };
  let busy = false, last = -Infinity, timer = null;
  const limiter = {
    minIntervalMs,
    identifyIntervalMs,
    blockedUntil: 0,
    // Tarea en cola; devuelve su resultado (o CANCELLED si se cancela por un 429).
    schedule(task, { priority = 'radar' } = {}) {
      return new Promise((resolve, reject) => { queues[priority].push({ task, resolve, reject }); pump(); });
    },
    pending: () => queues.radar.length + queues.identificacion.length,
    // Pausa global (429) y cancelación inmediata de las consultas de identificación que esperan.
    block(ms) {
      limiter.blockedUntil = Math.max(limiter.blockedUntil, Date.now() + ms);
      for (const job of queues.identificacion.splice(0)) job.resolve(CANCELLED);
    },
    isBlocked: () => Date.now() < limiter.blockedUntil,
    reset({ minIntervalMs: m = ADSB_MIN_INTERVAL_MS, identifyIntervalMs: i = ADSB_IDENTIFY_INTERVAL_MS } = {}) {
      Object.assign(limiter, { minIntervalMs: m, identifyIntervalMs: i, blockedUntil: 0 });
      last = -Infinity;
      if (timer) { clearTimeout(timer); timer = null; }
      for (const q of Object.values(queues)) for (const job of q.splice(0)) job.resolve(CANCELLED);
    },
  };
  function pump() {
    if (busy || timer) return;
    const priority = queues.radar.length ? 'radar' : queues.identificacion.length ? 'identificacion' : null;
    if (!priority) return;
    const gap = priority === 'radar' ? limiter.minIntervalMs : Math.max(limiter.minIntervalMs, limiter.identifyIntervalMs);
    const wait = last + gap - Date.now();
    // Se vuelve a elegir al acabar la espera: si entretanto llega una de radar, sale antes.
    if (wait > 0) { timer = setTimeout(() => { timer = null; pump(); }, wait); return; }
    const job = queues[priority].shift();
    busy = true;
    last = Date.now();
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { busy = false; pump(); });
  }
  return limiter;
}

// El limitador global del proceso (compartido por server/radar.mjs y server/identify.mjs).
export const adsbLimiter = createLimiter();

function retryAfterMs(res) {
  const v = res.headers?.get?.('Retry-After');
  if (!v) return ADSB_DEFAULT_COOLDOWN_MS;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : ADSB_DEFAULT_COOLDOWN_MS;
}

// GET a adsb.lol a través del limitador. Resultado: { data } | { error: 'rate-limited' } (429 o pausa activa: no se
// reintenta) | { error: 'failed' } (red, 5xx…: no se sabe nada).
export async function adsbGet(path, { fetchFn = fetch, limiter = adsbLimiter, priority = 'radar' } = {}) {
  if (limiter.isBlocked()) return { error: 'rate-limited' };
  const out = await limiter.schedule(async () => {
    if (limiter.isBlocked()) return { error: 'rate-limited' };
    try {
      const res = await fetchFn(`${ADSB}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (res.status === 429) { limiter.block(retryAfterMs(res)); return { error: 'rate-limited' }; }
      return res.ok ? { data: await res.json() } : { error: 'failed' };
    } catch {
      return { error: 'failed' };
    }
  }, { priority });
  return out === CANCELLED ? { error: 'rate-limited' } : out;
}
