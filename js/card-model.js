// Modelo de PRESENTACIÓN de la ficha (rediseño claro, spec 2026-10-20 §5.3–5.8, §10 bis y §13). Funciones puras.
// Regla (Jaime, 20/10/2026): recibe lo que ya deciden eta.js (ETA y su confidence), legPhase, presentStatus,
// withRadar, withLanding, currentPunctuality, el estado de AeroDataBox y el pronóstico, y decide solo CÓMO mostrarlo:
// qué bloques, en qué orden, con qué etiqueta y formato. No recalcula la ETA ni crea otra confianza, no redefine estados,
// no cambia la prioridad Aena / ETA Turbi / AeroDataBox (la hora es la que ya trae card.dep / card.arr), no decide
// aterrizajes (status.landing o la fase) y no duplica umbrales del radar (se importan de eta.js y radar-distance.js).
import { STALE_MIN } from './eta.js';
import { MAX_EXTRAPOLATION_S } from './radar-distance.js';
import { formatLocal } from './time.js';
import { distanceKm } from './route.js';

const MIN = 60000;
// Avión en el mapa (§10 bis y decisión del controlador de 21/10/2026): con una posición de PLANE_MAX_AGE_S o menos es
// «fresca» (se anima de A a B y prolonga la estela); hasta PLANE_LAST_KNOWN_S es la «última posición conocida» (quieta y
// atenuada, nunca presentada como medición nueva); pasada, sin avión.
export const PLANE_MAX_AGE_S = 60;
export const PLANE_LAST_KNOWN_S = 180;
// Reloj MONOTÓNICO (ms, sin relación con la hora civil): el de toda la antigüedad de la ficha. Cambiar la hora del móvil
// no envejece ni rejuvenece una lectura.
export const monoNow = () => globalThis.performance?.now?.() ?? Date.now();
const PENDING = '--:--';

// 'programado' | 'en-curso' | 'finalizado' | 'cancelado'. Solo agrupa lo que ya dicen la fase del tramo (legPhase o
// adbPhase), el estado mostrado (Desviado) y el radar (withRadar / withLanding); el orden es el de prioridad.
export function flightPhase(card) {
  if (card.phase === 'cancelado' || card.status?.text?.includes('Desviado')) return 'cancelado';
  if (card.status?.landing || card.phase === 'terminado') return 'finalizado';
  if (['volando', 'reciente'].includes(card.radar?.state) || card.phase === 'en-curso') return 'en-curso';
  return 'programado';
}

// «42 min», «2 h 15 min», «1 h»; desde 24 h, días y horas sin minutos («2 d 3 h», «1 d»). null si ya pasó (≤ 0). Por
// debajo del minuto, «1 min» (nunca «0 min»).
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(total / 60), m = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// Rótulo de la duración con las horas de pista de AeroDataBox (hora principal y Resumen del vuelo).
export const AIRBORNE_LABEL = 'Tiempo en el aire';
const shown = side => side.est ?? side.time; // la hora que ya muestra la ficha en ese lado
const aside = (label, value) => (value ? { label, value } : null);

// Hora principal (§5.3). La fase elige el lado; si ese lado no existe, null (no se inventa una hora). Los minutos
// salen de card.depMs / card.arrMs (UTC, de buildFlight): la misma salida y la misma llegada visibles.
export function mainTime(card, nowMs) {
  const phase = flightPhase(card);
  if (phase === 'cancelado') return null;
  if (phase === 'programado') {
    const { dep } = card;
    if (!dep) return null;
    const label = dep.estimated ? 'Salida estimada' : dep.est ? 'Salida prevista' : 'Salida programada';
    return { time: shown(dep), label, plusDay: false, note: dep.estimated ? dep.note ?? null : null,
      aside: aside('Sale en', formatCountdown(card.depMs - nowMs)) };
  }
  const { arr } = card;
  if (!arr) return null;
  const flying = arr.estimated ? 'Llegada estimada' : 'Llegada prevista';
  const base = { time: shown(arr), plusDay: Boolean(card.dep && arr.date > card.dep.date), note: arr.note ?? null };
  if (phase === 'en-curso') return { ...base, label: flying, aside: aside('Llega en', formatCountdown(card.arrMs - nowMs)) };
  const label = card.arrFinal ? 'Llegada final' : card.status?.landing === 'confirmed-landed'
    ? (card.status.source === 'fr24' ? 'Aterrizado · Flightradar24' : 'Aterrizado · radar ADS-B') : flying;
  // Duración solo con salida y llegada reales: con una de las dos prevista sería una cuenta sobre una estimación. Con
  // las horas de pista de AeroDataBox es el tiempo en el aire (la misma etiqueta que el Resumen del vuelo).
  const durLabel = card.source === 'aerodatabox' ? AIRBORNE_LABEL : 'Duración';
  return { ...base, label, aside: card.depFinal && card.arrFinal ? aside(durLabel, formatCountdown(card.arrMs - card.depMs)) : null };
}

// De dónde salen la hora y el estado que se ven (§5.4). Derivación directa: el radar suma si ve el avión (volando o
// aterrizado); en curso o finalizado, sin llegada de Aena (estimación Turbi) y sin radar, la hora es solo de Turbi.
export function sourceLabel(card) {
  const base = card.source === 'aerodatabox' ? 'AeroDataBox' : 'Aena';
  const radar = ['volando', 'aterrizado'].includes(card.radar?.state);
  if (card.source !== 'aerodatabox' && card.arr?.estimated && ['en-curso', 'finalizado'].includes(flightPhase(card))) {
    return radar ? 'Radar + Aena' : 'Estimación Turbi';
  }
  return radar ? `Radar + ${base}` : base;
}

// Confianza de la información temporal: la de eta.js tal cual (eta.confidence), solo rotulada. Verde, ámbar o rojo.
const CONFIDENCE = {
  high: { text: 'Alta', tone: 'ok', limited: false },
  medium: { text: 'Media', tone: 'warn', limited: false },
  low: { text: 'Baja', tone: 'bad', limited: true },
  'very-low': { text: 'Muy baja', tone: 'bad', limited: true },
};
export function confidenceInfo(level) {
  return CONFIDENCE[level] ? { ...CONFIDENCE[level] } : null;
}

// Retraso de hoy (currentPunctuality) en corto, con su banda. Con la llegada aún sin actualizar y la salida retrasada,
// currentPunctuality ya habla de la salida: se muestra ese mismo retraso. `unchanged` replica la regla de
// currentPunctuality (js/punctuality.js, «const unchanged = side.delay === null || …»): si cambia allí, cambia aquí.
export function punctualityTile(p) {
  if (!p || p.state === 'sin-datos') return null;
  if (p.state === 'cancelado') return { text: 'Cancelado', band: p.band };
  if (p.state === 'desviado') return { text: 'Desviado', band: p.band };
  if (p.state === 'sin-cambios') return { text: 'En hora', band: p.band };
  const side = p.basis === 'arr' ? p.arr : p.dep;
  const unchanged = !Number.isFinite(side?.delay) || (side.delay === 0 && !side.final);
  const delay = unchanged ? p.dep?.delay : side.delay;
  if (!Number.isFinite(delay)) return null;
  const text = delay > 0 ? `+${delay} min` : delay < 0 ? `${-delay} min antes` : 'En hora';
  return { text, band: p.band };
}

// Tarjetas de resumen (§5.4): la que no tiene dato no está (sin huecos ni «—»).
export function summaryTiles(card) {
  const tiles = [];
  const punct = punctualityTile(card.punctuality);
  if (punct) tiles.push({ key: 'punctuality', label: 'Puntualidad', value: punct.text, tone: punct.band });
  tiles.push({ key: 'source', label: 'Fuente', value: sourceLabel(card), tone: null });
  const conf = confidenceInfo(card.timeConfidence);
  if (conf) tiles.push({ key: 'confidence', label: 'Confianza', value: conf.text, tone: conf.tone, limited: conf.limited });
  return tiles;
}

// Cuatro hitos del Horario (§5.6). Un lado estimado por Turbi (etaSide o la salida estimada) no tiene hora programada:
// su programada es «Pendiente» y la hora se muestra solo como estimación. Lado nulo: los dos hitos, «Pendiente».
const pending = key => ({ key, time: PENDING, caption: 'Pendiente', kind: 'pending' });
const sched = (key, side) => (side && !side.estimated ? { key, time: side.time, caption: 'Programada', kind: 'sched' } : pending(key));
function best(key, side, final, finalCaption) {
  if (!side) return pending(key);
  if (final) return { key, time: shown(side), caption: finalCaption, kind: 'real' };
  if (side.estimated) return { key, time: side.time, caption: 'Estimada', kind: 'turbi' };
  if (side.est) return { key, time: side.est, caption: 'Prevista', kind: 'aena-est' };
  return pending(key);
}
export function milestones(card) {
  return [
    sched('dep-sched', card.dep), best('dep-real', card.dep, card.depFinal, 'Real'),
    sched('arr-sched', card.arr), best('arr-best', card.arr, card.arrFinal, 'Final'),
  ];
}

// Antigüedades sin el reloj civil del móvil: la tarjeta guarda la lectura tal como valía al recibirla (receivedRadar,
// js/radar-distance.js: posAgeS/seenS del instante en que respondió el servidor) y el instante MONOTÓNICO de recepción
// (radarReceivedMono). receivedMono y nowMono son del mismo reloj monotónico (monoNow); solo se suma lo transcurrido.
// Solo envejece la presentación: no pide nada ni cambia el estado del radar.
const elapsedS = (receivedMono, nowMono) => Math.max(0, nowMono - receivedMono) / 1000;
const radarAgeS = (radar, receivedMono, nowMono) =>
  (Number.isFinite(radar?.seenS) && radar.seenS >= 0 ? radar.seenS : 0) + elapsedS(receivedMono, nowMono);

// Antigüedad legible: segundos por debajo del minuto, minutos a partir de ahí (la de «Última señal» y la de la posición).
export const ageText = ageS => ageS < 60 ? `${Math.floor(ageS)} s` : `${Math.floor(ageS / 60)} min`;

// «Última señal» en vivo (§10 bis): live por debajo de MAX_EXTRAPOLATION_S (la distancia aún se mueve), stale desde
// STALE_MIN (la ETA pasa a «la última disponible»), old entre medias. Fuera de «volando», null.
export function signalState(radar, receivedMono, nowMono) {
  if (radar?.state !== 'volando' || !Number.isFinite(receivedMono)) return null;
  const ageS = radarAgeS(radar, receivedMono, nowMono);
  if (!Number.isFinite(ageS)) return null; // sin instante de recepción no hay antigüedad: no se inventa «NaN min»
  const level = ageS < MAX_EXTRAPOLATION_S ? 'live' : ageS >= STALE_MIN * 60 ? 'stale' : 'old';
  return { ageS, level, text: ageText(ageS) };
}

// Antigüedad REAL de la posición: posAgeS (al responder el servidor) más lo transcurrido desde que se recibió (reloj
// monotónico). Nunca seenS: el último mensaje puede ser reciente con la posición vieja. null si no está «volando», sin
// posAgeS finito o sin instante de recepción válido.
export function positionAgeS(radar, receivedMono, nowMono) {
  if (radar?.state !== 'volando' || !Number.isFinite(radar.posAgeS) || radar.posAgeS < 0 || !Number.isFinite(receivedMono)) return null;
  return radar.posAgeS + elapsedS(receivedMono, nowMono);
}

// Avión en el mapa: la posición recibida tal cual, solo con «volando» y con antigüedad de la POSICIÓN conocida.
// → { lat, lon, heading, fresh }: fresh con PLANE_MAX_AGE_S o menos; fresh: false (última posición conocida, quieta y
// atenuada) hasta PLANE_LAST_KNOWN_S; más antigua (o de antigüedad desconocida) → null: sin avión, solo la ruta, la
// estela real pasada y los aeropuertos. heading: el `track` medido (grados, 0 = norte) o null. Sin interpolar.
export function planeOnMap(radar, receivedMono, nowMono) {
  if (!Number.isFinite(radar?.lat) || !Number.isFinite(radar.lon)) return null;
  const ageS = positionAgeS(radar, receivedMono, nowMono);
  if (ageS === null || ageS > PLANE_LAST_KNOWN_S) return null;
  return { lat: radar.lat, lon: radar.lon, heading: Number.isFinite(radar.track) ? radar.track : null, fresh: ageS <= PLANE_MAX_AGE_S };
}

// Barras de la gráfica de turbulencias: muestreo uniforme de view.route (un punto por paso de tiempo, sobre el tiempo
// en el aire del view). seg: el tramo de view.segments que contiene el minuto del punto (el último que empieza antes o
// en ese minuto; los límites de los tramos están redondeados), para data-seg. level: el de ese tramo (§9 bis), así la
// barra dice lo mismo que el detalle que abre; null (rayada) si el punto no tiene datos. Sin tramos, el del punto.
export function turbulenceBars(view, maxBars = 56) {
  const route = view?.route ?? [];
  const n = route.length;
  if (!n) return [];
  const step = Math.max(1, Math.ceil(n / maxBars));
  const segs = view.segments ?? [];
  const bars = [];
  for (let i = 0; i < n; i += step) {
    const min = n > 1 ? (i * view.durationMin) / (n - 1) : 0;
    let seg = 0;
    segs.forEach((s, k) => { if (s.startMin <= min) seg = k; });
    const level = !Number.isFinite(route[i].level) ? null : Number.isFinite(segs[seg]?.level) ? segs[seg].level : route[i].level;
    bars.push({ level, seg });
  }
  return bars;
}

// «Ahora» en la gráfica de Turbulencias (vuelo en curso): en qué punto del pronóstico está el avión. Solo con datos
// que Turbi ya tiene, sin pedir nada ni extrapolar. Misma correspondencia punto ↔ minuto que turbulenceBars (route[i]
// en el minuto i · durationMin / (n − 1)), así el marcador cae sobre la barra que lo representa:
//   1) pos (la posición real en pantalla, planeOnMap): se proyecta sobre la polilínea de view.route; a más de
//      NOW_MAX_OFF_ROUTE_KM de ella no se sitúa (otra trayectoria, otro avión o un dato raro);
//   2) si no, remainingKm (distancia restante del radar): la fracción recorrida a lo largo de la misma ruta.
// level: el del tramo (view.segments) que contiene ese minuto, como la barra; null si allí no hay datos. next: el primer
// tramo posterior con OTRO nivel (con datos): { level, inMin } en minutos del pronóstico; null si no cambia. Sin ruta
// con coordenadas ni datos de posición válidos, null: no se inventa un «Ahora».
export const NOW_MAX_OFF_ROUTE_KM = 150;
export function turbNow(view, { pos = null, remainingKm = null } = {}) {
  const route = view?.route ?? [];
  const n = route.length;
  const D = view?.durationMin;
  if (n < 2 || !(D > 0) || !route.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))) return null;
  const t = (Number.isFinite(pos?.lat) && Number.isFinite(pos?.lon) ? projectOnRoute(route, pos) : null)
    ?? (Number.isFinite(remainingKm) && remainingKm >= 0 ? alongRoute(route, remainingKm) : null);
  if (t === null) return null;
  const min = (t * D) / (n - 1);
  const segs = view.segments ?? [];
  let k = -1;
  segs.forEach((s, i) => { if (s.startMin <= min) k = i; });
  const cur = segs[k];
  const level = cur && !cur.missing && Number.isFinite(cur.level) ? cur.level : null;
  const after = segs.slice(k + 1).find(s => !s.missing && Number.isFinite(s.level) && s.level !== level && s.startMin > min);
  return { min, frac: min / D, level, next: after ? { level: after.level, inMin: after.startMin - min } : null };
}
// Índice fraccionario (0 … n − 1) del punto de la ruta más cercano a pos, o null si queda lejos de toda la ruta.
// Proyección local plana por tramo: a esta escala (≈ 50 km entre puntos) el error es despreciable.
function projectOnRoute(route, pos) {
  const kx = 111.32 * Math.cos((pos.lat * Math.PI) / 180), ky = 110.57;
  const xy = p => [(p.lon - pos.lon) * kx, (p.lat - pos.lat) * ky];
  let best = null;
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = xy(route[i]), [bx, by] = xy(route[i + 1]);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const u = len2 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + u * dx, ay + u * dy);
    if (!best || d < best.d) best = { d, t: i + u };
  }
  return best && best.d <= NOW_MAX_OFF_ROUTE_KM ? best.t : null;
}
// Índice fraccionario a lo largo de la ruta con remainingKm hasta el destino (la ruta entera es la referencia).
function alongRoute(route, remainingKm) {
  const cum = [0];
  for (let i = 1; i < route.length; i++) cum.push(cum[i - 1] + distanceKm(route[i - 1], route[i]));
  const total = cum.at(-1);
  if (!(total > 0) || remainingKm > total) return null; // más lejos que el propio origen: no es de esta ruta
  const done = total - remainingKm;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < done) i++;
  const span = cum[i] - cum[i - 1];
  return i - 1 + (span ? (done - cum[i - 1]) / span : 0);
}

// «Tramo más movido» (summary.moments[0]): horas locales si origen y destino comparten zona; si no, minutos desde el
// despegue (Turbi no inventa una zona intermedia). Sin turbulencia, null.
export function roughestSpan(view) {
  const m = view?.summary?.moments?.[0];
  if (!view?.summary?.maxLevel || !m) return null;
  const tz = view.originTz;
  if (tz && tz === view.destinationTz && Number.isFinite(view.depMs)) {
    return { text: `${formatLocal(view.depMs + m.startMin * MIN, tz)} – ${formatLocal(view.depMs + m.endMin * MIN, tz)}` };
  }
  return { text: `min ${m.startMin}–${m.endMin}` };
}

// Línea compacta de avisos en la tarjeta de Turbulencias (§10 bis): solo lo que ya devuelven sigmetsNearRoute y
// pirepsNearRoute. label: la del primero. crosses: algún SIGMET cruza la ruta (ámbar). Nulos o vacíos: nada.
export function weatherAlerts(aviation) {
  const out = [];
  const sigmets = Array.isArray(aviation?.sigmets) ? aviation.sigmets : [];
  const pireps = Array.isArray(aviation?.pireps) ? aviation.pireps : [];
  if (sigmets.length) {
    out.push({ kind: 'sigmet', text: sigmets.length === 1 ? '1 aviso oficial (SIGMET)' : `${sigmets.length} avisos oficiales (SIGMET)`,
      label: sigmets[0].label ?? null, crosses: sigmets.some(s => s.crosses) });
  }
  if (pireps.length) {
    out.push({ kind: 'pirep', text: pireps.length === 1 ? '1 informe de pilotos cerca de la ruta' : `${pireps.length} informes de pilotos cerca de la ruta`,
      label: pireps[0].label ?? null, crosses: false });
  }
  return out;
}
