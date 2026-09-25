// Acceso único a adsb.lol (API v2, gratuita y sin registro). TODAS las consultas del servidor —por indicativo, por
// zona y por hex— pasan por un único limitador global: una petición detrás de otra y con una separación mínima entre
// inicios (adsb.lol devuelve 429 si se le pregunta demasiado seguido; ~1 petición/s).
const ADSB = 'https://api.adsb.lol/v2';
// adsb.lol exige un User-Agent con contacto (si no, 403).
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const TIMEOUT_MS = 8000;
// Heurística ajustable: separación mínima entre dos peticiones a adsb.lol (inicio a inicio).
export const ADSB_MIN_INTERVAL_MS = 1100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cola en serie: cada tarea empieza cuando ha terminado la anterior y han pasado minIntervalMs desde su inicio.
export function createLimiter(minIntervalMs) {
  let last = -Infinity;
  let chain = Promise.resolve();
  const limiter = {
    minIntervalMs,
    schedule(task) {
      const run = chain.then(async () => {
        const wait = last + limiter.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now();
        return task();
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  return limiter;
}

// El limitador global del proceso (compartido por server/radar.mjs y server/identify.mjs).
export const adsbLimiter = createLimiter(ADSB_MIN_INTERVAL_MS);

// GET a adsb.lol a través del limitador. null = la consulta ha fallado (red, 429, 5xx…): no se sabe nada.
export async function adsbGet(path, { fetchFn = fetch, limiter = adsbLimiter } = {}) {
  return limiter.schedule(async () => {
    try {
      const res = await fetchFn(`${ADSB}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': UA } });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  });
}
