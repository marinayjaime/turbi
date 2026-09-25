// ¿Se mira el radar (ADS-B) de un vuelo? Función PURA compartida por la app (js/radar.js) y el servidor
// (server/radar.mjs, server/live.mjs, server/identify.mjs): la regla está escrita una sola vez.
// Aena es la fuente oficial de horarios y estados, pero NO el guardián del radar: si su estado de puerta va retrasado
// (ULL, EMB, CER…), dentro de una ventana alrededor del despegue se puede comprobar ADS-B. Aena manda para cancelado,
// desviado y llegada final.
//   none     → cero radar
//   direct   → solo búsqueda barata: hex ya conocido, indicativo y variantes seguras
//   identify → direct + identificación por ruta (zona + adsbdb) si lo anterior falla
import { localToUtcMs } from './time.js';

// Heurísticas ajustables.
export const RADAR_GATE = {
  earlyMin: 5, // se empieza a mirar desde la PRIMERA salida conocida (programada o estimada) menos esto
  identifyDelayMin: 15, // sin confirmación de Aena, identificación por ruta desde la salida MÁS RECIENTE más esto
  afterArrivalMin: 60, // sin confirmación de Aena, se deja de mirar pasada la llegada prevista más esto
  confirmedWindowH: 20, // con confirmación de Aena (BOR, FLY, FNL), como hasta ahora
};
const MIN = 60000, H = 3600000;
// Zona por defecto de un aeropuerto de Aena (península o Canarias), si no se conoce la del aeropuerto.
const CANARY = new Set(['LPA', 'TFN', 'TFS', 'ACE', 'FUE', 'SPC', 'VDE', 'GMZ']);
export const aenaTz = iata => (CANARY.has(iata) ? 'Atlantic/Canary' : 'Europe/Madrid');
const FINAL_ARRIVAL = new Set(['LND', 'IBK', 'OPE', 'OPF', 'BOR']);
const none = (reason, confirmed = false) => ({ mode: 'none', reason, confirmed });
const num = x => (Number.isFinite(x) ? x : null);

// Horas de Aena en UTC (null si Aena no las publica). sd/ed son hora local del origen; sa/ea, del destino.
export function legTimes(leg, { originTz, destTz }) {
  const local = (dt, tz) => (dt && tz ? localToUtcMs(dt.slice(0, 10), dt.slice(11, 16), tz) : null);
  return {
    schedDepMs: leg.sd ? local(`${leg.d}T${leg.sd}`, originTz) : null,
    estDepMs: local(leg.ed, originTz),
    arrMs: local(leg.ea ?? (leg.sa ? `${leg.d}T${leg.sa}` : null), destTz),
  };
}

// schedDepMs / estDepMs / arrMs: horas de Aena en UTC (o null). plannedMin: duración estimada de la ruta (la misma
// que usa la app para «Salida estimada»), para calcular lo que Aena no publica.
export function radarGate({ leg, nowMs, schedDepMs = null, estDepMs = null, arrMs = null, plannedMin = null, g = RADAR_GATE }) {
  const flags = [leg.st, leg.std, leg.sta];
  if (flags.includes('CAN') || flags.includes('DES')) return none('cancelado o desviado');
  if (FINAL_ARRIVAL.has(leg.sta)) return none('llegada final');

  const confirmed = (leg.std ?? leg.st) === 'BOR' || ['FLY', 'FNL'].includes(leg.sta);
  const sched = num(schedDepMs), est = num(estDepMs), aenaArr = num(arrMs);
  const planned = plannedMin > 0 ? plannedMin * MIN : null;
  // firstDep: solo para empezar la comprobación barata. latestDep: para identificar (+15) y para calcular la llegada.
  let firstDep = sched !== null && est !== null ? Math.min(sched, est) : sched ?? est;
  let latestDep = est ?? sched;

  if (confirmed) { // como hasta ahora
    if (latestDep !== null) {
      return nowMs >= latestDep && nowMs - latestDep < g.confirmedWindowH * H
        ? { mode: 'identify', reason: 'Aena confirma la salida o el vuelo', confirmed } : none('fuera de la ventana', true);
    }
    if (aenaArr === null) return none('sin horas', true);
    return Math.abs(nowMs - aenaArr) < g.confirmedWindowH * H
      ? { mode: 'identify', reason: 'Aena dice que está en el aire', confirmed } : none('fuera de la ventana', true);
  }

  // Sin confirmación: cualquier estado no final (de puerta, intermedio o desconocido). Sin lista cerrada.
  if (latestDep === null && aenaArr !== null && planned !== null) firstDep = latestDep = aenaArr - planned; // origen extranjero
  const arr = aenaArr ?? (latestDep !== null && planned !== null ? latestDep + planned : null);
  if (firstDep === null || arr === null) return none('sin horas');
  if (nowMs < firstDep - g.earlyMin * MIN) return none('aún no es la hora de salida');
  if (nowMs > arr + g.afterArrivalMin * MIN) return none('pasada la llegada prevista sin confirmación de Aena');
  return nowMs >= latestDep + g.identifyDelayMin * MIN
    ? { mode: 'identify', reason: 'hora de salida superada', confirmed }
    : { mode: 'direct', reason: 'hora de salida alcanzada', confirmed };
}
