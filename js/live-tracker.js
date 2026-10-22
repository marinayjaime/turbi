// Seguimiento en vivo de la posición mientras se mira un vuelo en curso con Flightradar24 (decisión del controlador,
// 21/10/2026). Solo decide CUÁNDO volver a preguntar y qué hacer con la respuesta; quien llama (js/app.js) da la petición
// (EXACTAMENTE el /radar o /radar-adb que ya usa la ficha, con su ?leg=) y la pinta por el camino de siempre (paintRadar).
// Sin meteorología, sin Flight Tracks, sin rehacer la búsqueda; nunca se extrapola ni se mueve nada con datos viejos.
//   - Cadencia: LIVE_INTERVAL_MS = 45 s entre peticiones, con setTimeout encadenado (nunca setInterval) y UN solo
//     temporizador. El servidor guarda la respuesta 40 s por vuelo físico (server/fr24-radar.mjs): con 45 > 40 cada ciclo
//     trae una lectura nueva de FR24 y varios usuarios del mismo vuelo comparten caché y promesa (≈ 1 llamada por vuelo
//     cada 45 s, unas 80 por hora con la ficha abierta).
//   - Fallos (la última posición real se queda quieta en la ficha: un fallo no se pinta): sin respuesta, red, timeout o
//     5xx → espera creciente LIVE_BACKOFF_MS (90, 180 y 300 s como máximo) y vuelta a 45 s tras un éxito; 429 → no antes
//     de Retry-After (y nunca antes de 45 s); 401/403 → se para (sin bucles).
//   - Se para con un final definitivo (aterrizado, no-aplica, una respuesta que ya no es de FR24) o cuando isOver() /
//     isActive() lo dicen (Aena final, cancelado, desviado, otra búsqueda, ficha cerrada…).
//   - UNA sola autoridad por vuelo físico: «Actualizar» no abre otro camino; la consulta la hace este seguidor (refresh),
//     reutilizando la petición en curso si la hay; nunca hay dos peticiones a la vez (inflight) ni dos temporizadores.
//   - Pestaña oculta (visibilityState distinto de 'visible'): cero peticiones; al volver, si ya tocaba, pide en el acto.
//   - onTime: el seguidor va al día (activo, visible, sin fallos ni espera): la app no atenúa el avión entre lecturas.
//     onChange() avisa cuando eso puede haber cambiado (fallo, espera, pausa, parada, lectura nueva).
export const LIVE_INTERVAL_MS = 45000;
export const LIVE_BACKOFF_MS = [90000, 180000, 300000];
// Tope de una espera (hold, p. ej. «Actualizar» cuyo sondeo no llega a dar respuesta útil): pasado, el seguidor sale solo
// de la espera como tras un fallo (siguiente intento a los 90 s). Nunca se queda parado para siempre.
export const LIVE_HOLD_MAX_MS = 180000;

// Respuesta del radar → { paint, stop, delayMs, failures } (failures: fallos seguidos, para la espera creciente).
export function liveDecision(radar, failures = 0) {
  const backoff = () => ({ paint: false, stop: false, delayMs: LIVE_BACKOFF_MS[Math.min(failures, LIVE_BACKOFF_MS.length - 1)], failures: failures + 1 });
  if (!radar) return backoff();
  if (radar.state === 'no-disponible') {
    if (radar.reason === 'autorizacion') return { paint: false, stop: true, delayMs: null, failures };
    if (radar.reason === 'limite' && Number.isFinite(radar.retryAfterSec) && radar.retryAfterSec >= 0) {
      return { paint: false, stop: false, delayMs: Math.max(LIVE_INTERVAL_MS, radar.retryAfterSec * 1000), failures: failures + 1 };
    }
    return backoff();
  }
  if (radar.state === 'no-aplica') return { paint: false, stop: true, delayMs: null, failures };
  // Una lectura real (aterrizado, o ya no es de FR24: el servidor volvió al flujo antiguo) se pinta como siempre, y se para.
  if (radar.state === 'aterrizado' || radar.source !== 'fr24') return { paint: true, stop: true, delayMs: null, failures: 0 };
  return { paint: true, stop: false, delayMs: LIVE_INTERVAL_MS, failures: 0 };
}

// fetchOnce() → respuesta (o null); onReading(radar) la pinta; isActive(): la ficha que lo pidió sigue en pantalla;
// isOver(): el vuelo ya no está en curso (final de Aena, cancelado, desviado, aterrizado); visible(): pestaña visible.
// now: reloj monotónico. La primera lectura ya está pintada: el primer ciclo, a los firstDelayMs.
// → { key, hold(), feed(radar), onVisibility(), stop(), stopped, pending, onTime }.
export function startLiveTracker({ key, fetchOnce, onReading, onFailure = () => {}, isActive = () => true, isOver = () => false,
  onChange = () => {}, visible = () => globalThis.document?.visibilityState === 'visible',
  now = () => globalThis.performance?.now?.() ?? Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  firstDelayMs = LIVE_INTERVAL_MS, holdMaxMs = LIVE_HOLD_MAX_MS }) {
  const NONE = Symbol('sin respuesta guardada');
  // inflight: hay UNA petición en curso (nunca dos); parked: respuesta que llegó en espera (hold), para refresh;
  // refreshing: la respuesta siguiente es la de «Actualizar» (también un fallo se entrega, a onFailure).
  let timer = null, stopped = false, held = false, inflight = false, failures = 0, dueAt = null, parked = NONE, refreshing = false;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const changed = () => { try { onChange(); } catch { /* solo presentación */ } };
  const stop = () => { if (stopped) return; stopped = true; held = false; parked = NONE; clear(); changed(); };
  // Programa el siguiente ciclo para dentro de ms; con la pestaña oculta solo apunta cuándo tocaría (pausa).
  const schedule = ms => {
    clear();
    dueAt = now() + ms;
    if (visible()) timer = setTimer(cycle, ms);
  };
  const handle = (radar, paint, failToo = false) => {
    const d = liveDecision(radar, failures);
    failures = d.failures;
    if (paint && d.paint) onReading(radar);
    else if (paint && failToo) onFailure(radar);
    if (d.stop || isOver()) { stop(); return; }
    schedule(d.delayMs);
    changed();
  };
  async function cycle() {
    timer = null;
    if (stopped || held || inflight) return;
    if (!isActive() || isOver()) { stop(); return; }
    if (!visible()) { changed(); return; } // pausa: onVisibility la reanuda
    inflight = true;
    let radar = null;
    try { radar = await fetchOnce(); } catch { radar = null; }
    inflight = false;
    if (stopped) return;
    if (held) { parked = radar; return; } // «Actualizar» en marcha: esta respuesta será la suya (refresh)
    if (!isActive()) { stop(); return; }
    const failToo = refreshing;
    refreshing = false;
    handle(radar, true, failToo);
  }
  // Sale de la espera: con una respuesta guardada, la usa; con una petición en curso, la espera; si no, pide ya.
  const release = asRefresh => {
    held = false;
    clear();
    if (asRefresh) refreshing = true;
    if (parked !== NONE) {
      const r = parked;
      parked = NONE;
      if (!isActive()) { stop(); return; }
      const failToo = refreshing;
      refreshing = false;
      handle(r, true, failToo);
      return;
    }
    if (inflight) { changed(); return; }
    if (asRefresh) cycle();
    else handle(null, false); // tope de la espera sin nada: como tras un fallo
  };
  schedule(firstDelayMs);
  return {
    key,
    // En espera (run() de «Actualizar» mientras rehace la ficha): ningún ciclo nuevo; una petición en curso sigue y su
    // respuesta se guarda para refresh. Tope holdMaxMs: sale sola (con la respuesta guardada, la en curso o, si no hay
    // nada, como tras un fallo). Nunca abre una segunda petición.
    hold() {
      if (stopped) return;
      held = true;
      clear();
      timer = setTimer(() => { timer = null; if (!stopped && held) release(false); }, holdMaxMs);
      changed();
    },
    // «Actualizar» (showRadar de la consulta nueva): la consulta la hace ESTE seguidor, nunca un sondeo aparte. Con una
    // petición en curso, se usa esa; con una respuesta guardada, esa; si no, una petición en el acto. La respuesta se
    // pinta (onReading) y, si falla, se entrega a onFailure.
    refresh() { if (!stopped) release(true); },
    // Lectura que ya pintó otro camino: decide el siguiente ciclo sin volver a pintarla.
    feed(radar) { if (stopped || inflight) return; held = false; parked = NONE; handle(radar, false); },
    onVisibility() {
      if (stopped || held || inflight) return;
      if (!visible()) { clear(); changed(); return; }
      if (timer === null && dueAt !== null) {
        const ms = Math.max(0, dueAt - now());
        timer = setTimer(cycle, ms);
        changed();
      }
    },
    stop,
    get stopped() { return stopped; },
    get pending() { return timer !== null && !held; },
    get held() { return held && !stopped; },
    get inflight() { return inflight; },
    get onTime() { return !stopped && !held && failures === 0 && visible() && (timer !== null || inflight); },
  };
}
