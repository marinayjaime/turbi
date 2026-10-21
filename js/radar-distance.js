// Distancia restante «en vivo» entre dos lecturas ADS-B reales: interpolación VISUAL a partir de la última lectura
// (remainingKm y kmh medidos). No es una medición nueva: no pide nada a la red, no cambia la velocidad, la altitud,
// el estado del vuelo, la ETA ni la lógica del radar; solo el número de km que se ve.
// Límites (heurísticas, conservadoras):
//  - Se parte EXACTAMENTE de la lectura recibida (no se descuenta la antigüedad que ya traía): mejor quedarse corto.
//  - Freno: nunca baja de REMAINING_FLOOR_KM por extrapolación (si la lectura real ya está por debajo, no se mueve).
//    Cerca del aeropuerto hay aproximación, esperas y vectores: la distancia en línea recta deja de bajar a la
//    velocidad del avión. La llegada la decide una lectura real o Aena, nunca el paso del tiempo.
//  - Señal antigua: se deja de extrapolar cuando la posición tiene más de MAX_EXTRAPOLATION_S (seenS al recibirla +
//    tiempo desde que se recibió, en el reloj monotónico). En crucero son ~70 km: el error de usar la velocidad sobre el
//    suelo como velocidad de acercamiento es pequeño (< 5 %, unos 4 km); más allá, descensos y virajes la hacen poco
//    representativa. Está por encima de los 180 s con los que el servidor aún da por buena una posición (MAX_SEEN_S).
//  - Sin velocidad creíble de vuelo (< MIN_KMH: en tierra o rodando), no se extrapola.
export const REMAINING_FLOOR_KM = 30;
export const MAX_EXTRAPOLATION_S = 300;
export const MIN_KMH = 200;
export const TICK_MS = 1000;

// Referencia a partir de una lectura real (ya pasada por receivedRadar); null si no se puede interpolar. at: instante de
// recepción en el MISMO reloj que el `now` del contador (la app usa el monotónico, performance.now). ageAtReceiptS: seenS
// tal cual (la antigüedad al recibirla). Solo acorta el margen de extrapolación: la distancia mostrada al llegar sigue
// siendo exactamente la del servidor.
export function distanceReference(radar, receivedAt) {
  if (radar?.state !== 'volando' || !Number.isFinite(radar.remainingKm) || radar.remainingKm < 0) return null;
  const seenS = Number.isFinite(radar.seenS) && radar.seenS >= 0 ? radar.seenS : 0;
  return { km: radar.remainingKm, kmh: Number.isFinite(radar.kmh) ? radar.kmh : null, at: receivedAt, ageAtReceiptS: seenS };
}

// La lectura tal como vale AL RECIBIRLA (la que guarda la tarjeta; de ella envejecen «Última señal», el avión del mapa y la
// distancia con una sola cuenta: js/card-model.js). Con Flightradar24 (source 'fr24') el servidor ya da posAgeS y seenS
// del instante en que responde, también desde su caché (server/fr24-radar.mjs): se usa tal cual y el reloj civil del
// móvil no interviene. Con adsb.lol (flujo antiguo, que sirve su caché de 60 s sin recalcular) se suma UNA vez el tiempo
// que pasó en esa caché (recepción − checked; 0 con un `checked` futuro o no válido), como hasta ahora. receivedAtMs: la
// hora del móvil al recibirla (solo para ese flujo antiguo).
export function receivedRadar(radar, receivedAtMs) {
  if (!radar || radar.source === 'fr24') return radar;
  const checkedMs = typeof radar.checked === 'string' ? Date.parse(radar.checked) : NaN;
  const cacheS = Number.isFinite(checkedMs) && Number.isFinite(receivedAtMs) ? Math.max(0, receivedAtMs - checkedMs) / 1000 : 0;
  if (!cacheS) return radar;
  const out = { ...radar };
  out.seenS = (Number.isFinite(radar.seenS) && radar.seenS >= 0 ? radar.seenS : 0) + cacheS;
  if (Number.isFinite(radar.posAgeS) && radar.posAgeS >= 0) out.posAgeS = radar.posAgeS + cacheS;
  return out;
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
// now: el mismo reloj que ref.at (la app, el monotónico).
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
