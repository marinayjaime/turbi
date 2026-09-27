// Refresco LIGERO del estado oficial de Aena mientras el vuelo está en curso: solo el horario del número
// (/flights/AL/N.json, ~0,5 KB, que Render sirve desde memoria), nunca ADS-B ni la meteorología. Se sigue SIEMPRE el
// mismo vuelo físico (physicalFlightKey): si desaparece, no se salta a otro tramo del mismo número.
// Cadencia con el reloj real de los datos: Render descarga Aena cada RENDER_CYCLE_MS, y `updated` dice cuándo fue la
// última. Nada nuevo puede llegar antes de updated + ciclo, así que:
//   - el siguiente refresco, directamente a updated + ciclo + margen (sin tope mientras se espera);
//   - si al llegar aún no hay datos nuevos, a los 60 s y después cada 120 s hasta ver un ciclo nuevo;
//   - `updated` inválido o de hace más de TOO_OLD_MS: cada 120 s;
//   - fallo de red: se mantiene lo último y se reintenta a los 120 s; tras 3 fallos seguidos se prueba GitHub Pages
//     (solo vale si trae el mismo vuelo físico y es realmente más reciente).
// Normalmente, ~1 petición por ciclo de Render (2–3 si su descarga se retrasa).
// Datos de más de TOO_OLD_MS (stale, p. ej. la copia de GitHub Pages mientras Render despertaba): el primer intento sale
// enseguida y, si Render no responde, se prueba GitHub Pages sin esperar a 3 fallos.
import { physicalFlightKey } from './physical-flight.js';

export const RENDER_CYCLE_MS = 10 * 60000;
export const CYCLE_MARGIN_MS = 20000;
export const RETRY_FIRST_MS = 60000;
export const RETRY_MS = 120000;
export const TOO_OLD_MS = 30 * 60000;
export const PAGES_AFTER_FAILURES = 3;
const MIN_WAIT_MS = 5000;
export const PREWATCH_MS = 6 * 3600000; // un vuelo programado se refresca de forma continua desde 6 h antes de salir

// ¿Cómo se refresca la ficha de un vuelo de Aena? phase: legPhase() · depMs: salida (estimada o programada) en UTC o null ·
// updatedMs: cuándo descargó Render (o GitHub Pages) esos datos.
//   'continuous' → en curso, o programado y como mucho a PREWATCH_MS de la salida (puerta, estado y horas se renuevan);
//   'once'       → más lejos, pero con datos stale: un solo intento de traer una versión más reciente;
//   'none'       → terminado o cancelado (Aena ya dio su estado final), o lejano con datos al día.
export function refreshMode({ phase, depMs = null, updatedMs = null, nowMs }) {
  if (phase === 'terminado' || phase === 'cancelado') return 'none';
  if (phase === 'en-curso') return 'continuous';
  if (Number.isFinite(depMs) && depMs - nowMs <= PREWATCH_MS) return 'continuous';
  return isStale(updatedMs, nowMs) ? 'once' : 'none';
}
export const isStale = (updatedMs, nowMs) => !Number.isFinite(updatedMs) || nowMs - updatedMs > TOO_OLD_MS;

// Espera hasta el siguiente refresco. changed: esta respuesta trae un ciclo nuevo; unchanged: respuestas seguidas
// sin ciclo nuevo.
export function nextRefreshDelay({ updatedMs, changed, unchanged, nowMs }) {
  if (!Number.isFinite(updatedMs) || nowMs - updatedMs > TOO_OLD_MS) return RETRY_MS;
  const expected = updatedMs + RENDER_CYCLE_MS + CYCLE_MARGIN_MS;
  if (changed && expected - nowMs > 0) return Math.max(expected - nowMs, MIN_WAIT_MS);
  return unchanged <= 1 ? RETRY_FIRST_MS : RETRY_MS;
}

// fetchLive() / fetchPages() → horario del número ({ updated, legs }) o null. onLeg(leg, updated): el tramo nuevo
// (mismo vuelo físico). isOver(leg): terminado (llegada final, cancelado o desviado) → se deja de refrescar.
// once: un solo intento (Render y, si falla y los datos siguen stale, GitHub Pages) y se para.
export function startStatusRefresh({ key, initialUpdated, fetchLive, fetchPages = async () => null, onLeg, isOver, isActive = () => true,
  once = false, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let timer = null, stopped = false, failures = 0, unchanged = 0;
  let lastUpdatedMs = Date.parse(initialUpdated ?? '');
  const stop = () => { stopped = true; if (timer !== null) clearTimer(timer); timer = null; };
  let started = false;
  const schedule = ms => {
    if (stopped) return;
    if (once && started) return stop(); // modo «una vez»: nada después del primer intento
    timer = setTimer(() => { started = true; tick().catch(() => schedule(RETRY_MS)); }, ms);
  };
  const valid = data => data && Array.isArray(data.legs);
  // Aplica una respuesta; true si hay que seguir.
  const apply = data => {
    const updMs = Date.parse(data.updated ?? '');
    const changed = Number.isFinite(updMs) && (!Number.isFinite(lastUpdatedMs) || updMs > lastUpdatedMs);
    if (changed) { lastUpdatedMs = updMs; unchanged = 0; } else unchanged++;
    const leg = changed ? data.legs.find(l => physicalFlightKey(l) === key) : null; // nunca otro tramo por parecido
    if (leg) {
      onLeg(leg, data.updated);
      if (isOver(leg)) { stop(); return false; }
    }
    schedule(nextRefreshDelay({ updatedMs: lastUpdatedMs, changed, unchanged, nowMs: now() }));
    return true;
  };
  async function tick() {
    timer = null;
    if (stopped || !isActive()) return stop();
    const data = await fetchLive();
    if (stopped || !isActive()) return stop();
    if (valid(data)) { failures = 0; apply(data); return; }
    failures++;
    if (failures >= PAGES_AFTER_FAILURES || isStale(lastUpdatedMs, now())) {
      const pages = await fetchPages();
      if (stopped || !isActive()) return stop();
      const updMs = Date.parse(pages?.updated ?? '');
      // GitHub Pages solo si trae EXACTAMENTE este vuelo físico y es más reciente que lo último que tenemos.
      if (valid(pages) && Number.isFinite(updMs) && (!Number.isFinite(lastUpdatedMs) || updMs > lastUpdatedMs)
        && pages.legs.some(l => physicalFlightKey(l) === key)) { apply(pages); return; }
    }
    schedule(RETRY_MS); // fallo temporal: no se cambia nada
  }
  // Datos stale: primer intento enseguida (no a los 120 s).
  schedule(isStale(lastUpdatedMs, now()) ? MIN_WAIT_MS : nextRefreshDelay({ updatedMs: lastUpdatedMs, changed: true, unchanged: 0, nowMs: now() }));
  return { stop, get pending() { return timer !== null; } };
}
