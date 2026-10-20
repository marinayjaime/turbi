// Modelo de PRESENTACIÓN de la ficha (rediseño claro, spec 2026-10-20 §5.3–5.8, §10 bis y §13). Funciones puras.
// Regla (Jaime, 20/10/2026): recibe lo que ya deciden eta.js (ETA y su confidence), legPhase, presentStatus,
// withRadar, withLanding, currentPunctuality, el estado de AeroDataBox y el pronóstico, y decide solo CÓMO mostrarlo:
// qué bloques, en qué orden, con qué etiqueta y formato. No recalcula la ETA ni crea otra confianza, no redefine estados,
// no cambia la prioridad Aena / ETA Turbi / AeroDataBox (la hora es la que ya trae card.dep / card.arr), no decide
// aterrizajes (status.landing o la fase) y no duplica umbrales del radar (se importan de eta.js y radar-distance.js).
import { STALE_MIN } from './eta.js';
import { receiptAgeS, MAX_EXTRAPOLATION_S } from './radar-distance.js';
import { formatLocal } from './time.js';

const MIN = 60000;
// Antigüedad máxima de una posición para pintar el avión en el mapa (regla aprobada, §10 bis): pasada, sin avión.
export const PLANE_MAX_AGE_S = 60;
const PENDING = '--:--';

// 'programado' | 'en-curso' | 'finalizado' | 'cancelado'. Solo agrupa lo que ya dicen la fase del tramo (legPhase o
// adbPhase), el estado mostrado (Desviado) y el radar (withRadar / withLanding); el orden es el de prioridad.
export function flightPhase(card) {
  if (card.phase === 'cancelado' || card.status?.text?.includes('Desviado')) return 'cancelado';
  if (card.status?.landing || card.phase === 'terminado') return 'finalizado';
  if (['volando', 'reciente'].includes(card.radar?.state) || card.phase === 'en-curso') return 'en-curso';
  return 'programado';
}

// «42 min», «2 h 15 min», «1 h». null si ya pasó (≤ 0). Por debajo del minuto, «1 min» (nunca «0 min»).
export function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

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
  const label = card.arrFinal ? 'Llegada final' : card.status?.landing === 'confirmed-landed' ? 'Aterrizado · radar ADS-B' : flying;
  // Duración solo con salida y llegada reales: con una de las dos prevista sería una cuenta sobre una estimación.
  return { ...base, label, aside: card.depFinal && card.arrFinal ? aside('Duración', formatCountdown(card.arrMs - card.depMs)) : null };
}

// De dónde salen la hora y el estado que se ven (§5.4). Derivación directa: el radar suma si ve el avión (volando o
// aterrizado); en curso, sin llegada de Aena (estimación Turbi) y sin radar, la hora es solo de Turbi.
export function sourceLabel(card) {
  const base = card.source === 'aerodatabox' ? 'AeroDataBox' : 'Aena';
  const radar = ['volando', 'aterrizado'].includes(card.radar?.state);
  if (card.source !== 'aerodatabox' && card.arr?.estimated && flightPhase(card) === 'en-curso') return radar ? 'Radar + Aena' : 'Estimación Turbi';
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
// currentPunctuality ya habla de la salida: se muestra ese mismo retraso.
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

// Antigüedad de la lectura «volando» en nowMs: la de distanceReference al recibirla (seenS + caché del servidor) más
// lo que lleva en pantalla. Solo envejece la presentación: no pide nada ni cambia el estado del radar.
const radarAgeS = (radar, receivedAtMs, nowMs) => receiptAgeS(radar, receivedAtMs) + Math.max(0, nowMs - receivedAtMs) / 1000;

// «Última señal» en vivo (§10 bis): live por debajo de MAX_EXTRAPOLATION_S (la distancia aún se mueve), stale desde
// STALE_MIN (la ETA pasa a «la última disponible»), old entre medias. Fuera de «volando», null.
export function signalState(radar, receivedAtMs, nowMs) {
  if (radar?.state !== 'volando') return null;
  const ageS = radarAgeS(radar, receivedAtMs, nowMs);
  const level = ageS < MAX_EXTRAPOLATION_S ? 'live' : ageS >= STALE_MIN * 60 ? 'stale' : 'old';
  const text = ageS < 60 ? `${Math.floor(ageS)} s` : `${Math.floor(ageS / 60)} min`;
  return { ageS, level, text };
}

// Avión en el mapa: la posición recibida tal cual, solo con «volando» y si tiene PLANE_MAX_AGE_S o menos. Una posición
// antigua nunca se pinta (ni «última posición»): sin avión, solo la ruta y los aeropuertos. Sin interpolar.
export function planeOnMap(radar, receivedAtMs, nowMs) {
  if (radar?.state !== 'volando' || !Number.isFinite(radar.lat) || !Number.isFinite(radar.lon)) return null;
  if (radarAgeS(radar, receivedAtMs, nowMs) > PLANE_MAX_AGE_S) return null;
  return { lat: radar.lat, lon: radar.lon };
}

// Barras de la gráfica de turbulencias: muestreo uniforme de view.route (un punto por paso de tiempo, sobre el tiempo
// en el aire del view). level null = sin datos. seg: el tramo de view.segments que contiene el minuto del punto (el
// último que empieza antes o en ese minuto; los límites de los tramos están redondeados), para data-seg.
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
    bars.push({ level: Number.isFinite(route[i].level) ? route[i].level : null, seg });
  }
  return bars;
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
