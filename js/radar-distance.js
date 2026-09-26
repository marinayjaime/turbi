// Distancia restante «en vivo» entre dos lecturas ADS-B reales: interpolación VISUAL a partir de la última lectura
// (remainingKm y kmh medidos). No es una medición nueva: no pide nada a la red, no cambia la velocidad, la altitud,
// el estado del vuelo, la ETA ni la lógica del radar; solo el número de km que se ve.
// Límites (heurísticas, conservadoras):
//  - Se parte EXACTAMENTE de la lectura recibida (no se descuenta la antigüedad que ya traía): mejor quedarse corto.
//  - Freno: nunca baja de REMAINING_FLOOR_KM por extrapolación (si la lectura real ya está por debajo, no se mueve).
//    Cerca del aeropuerto hay aproximación, esperas y vectores: la distancia en línea recta deja de bajar a la
//    velocidad del avión. La llegada la decide una lectura real o Aena, nunca el paso del tiempo.
//  - Señal antigua: se deja de extrapolar cuando la posición tiene más de MAX_EXTRAPOLATION_S (seenS + tiempo en la
//    caché del servidor + tiempo desde que se recibió). En crucero son ~70 km: el error de usar la velocidad sobre el suelo como velocidad de
//    acercamiento es pequeño (< 5 %, unos 4 km); más allá, descensos y virajes la hacen poco representativa. Está por
//    encima de los 180 s con los que el servidor aún da por buena una posición (MAX_SEEN_S).
//  - Sin velocidad creíble de vuelo (< MIN_KMH: en tierra o rodando), no se extrapola.
export const REMAINING_FLOOR_KM = 30;
export const MAX_EXTRAPOLATION_S = 300;
export const MIN_KMH = 200;
export const TICK_MS = 1000;

// Referencia a partir de una lectura real; null si no se puede interpolar.
// Antigüedad de la posición al recibirla: seenS (lo que tenía cuando el servidor la leyó, en `checked`) más lo que la
// respuesta ha podido pasar en la caché de 60 s del servidor (recepción − checked). Un `checked` futuro (pequeño
// desfase de reloj) no resta; sin `checked` válido, solo seenS. Solo acorta el margen de extrapolación: la distancia
// mostrada al llegar sigue siendo exactamente la del servidor.
export function distanceReference(radar, receivedAtMs) {
  if (radar?.state !== 'volando' || !Number.isFinite(radar.remainingKm) || radar.remainingKm < 0) return null;
  const seenS = Number.isFinite(radar.seenS) && radar.seenS >= 0 ? radar.seenS : 0;
  const checkedMs = typeof radar.checked === 'string' ? Date.parse(radar.checked) : NaN;
  const cachedS = Number.isFinite(checkedMs) ? Math.max(0, receivedAtMs - checkedMs) / 1000 : 0;
  return { km: radar.remainingKm, kmh: Number.isFinite(radar.kmh) ? radar.kmh : null, at: receivedAtMs, ageAtReceiptS: seenS + cachedS };
}

// Distancia visible en nowMs. { km, moving }: moving = false cuando ya no se extrapola (freno, señal antigua…).
export function estimateRemaining(ref, nowMs) {
  if (!ref) return null;
  if (!(ref.kmh >= MIN_KMH) || ref.km <= REMAINING_FLOOR_KM) return { km: Math.round(ref.km), moving: false };
  const budgetS = Math.max(0, MAX_EXTRAPOLATION_S - ref.ageAtReceiptS); // lo que queda antes de considerarla antigua
  const elapsedS = Math.max(0, (nowMs - ref.at) / 1000);
  const usedS = Math.min(elapsedS, budgetS);
  const km = Math.max(REMAINING_FLOOR_KM, ref.km - (ref.kmh * usedS) / 3600);
  return { km: Math.round(km), moving: elapsedS < budgetS && km > REMAINING_FLOOR_KM };
}

// Temporizador encadenado (1 s) que repinta solo el número. render(km) → false si el elemento ya no existe.
// Se detiene con stop(), si isActive() deja de ser cierto, si desaparece el elemento o cuando ya no hay movimiento.
export function startRemainingTicker({ ref, render, isActive = () => true, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) }) {
  let timer = null, stopped = false;
  const stop = () => { stopped = true; if (timer !== null) clearTimer(timer); timer = null; };
  const tick = () => {
    timer = null;
    if (stopped || !isActive()) return stop();
    const est = estimateRemaining(ref, now());
    if (!est || render(est.km) === false) return stop();
    if (!est.moving) return stop(); // último valor pintado; se queda quieto hasta otra lectura real
    timer = setTimer(tick, TICK_MS);
  };
  if (ref) timer = setTimer(tick, TICK_MS); // la lectura real ya está pintada: el primer cambio, al cabo de 1 s
  return { stop, get running() { return timer !== null; } };
}
