// Horarios de Aena publicados por el pipeline en data/flights/.
// Leg = { d, o, a, sd, ed, sa, ea, td, ta, g, st, ac } (ver scripts/aena.mjs)

import { LIVE_BASE } from './config.js';
import { physicalFlightKey } from './physical-flight.js';
import { aenaTz } from './radar-gate.js';
import { localToUtcMs } from './time.js';

const BASE = 'data/flights/';
const DELAY_MIN = 15;

export function parseFlightNumber(input) {
  const code = String(input).toUpperCase().replace(/\s+/g, '');
  const m = code.match(/^([A-Z]{3}|[A-Z0-9]{2})(\d{1,4})[A-Z]?$/);
  return m ? { prefix: m[1], n: m[2].replace(/^0+(?=\d)/, '') } : null;
}

async function getJson(url, fetchFn) {
  const res = await fetchFn(url);
  if (!res.ok) return null;
  return res.json();
}

const quiet = p => p.catch(() => null);

// Hoy y mañana llegan de Render (cada 10 min); el resto de los 14 días, de GitHub Pages.
// Si Render no responde o sus datos son más antiguos que los de GitHub Pages, se usa GitHub Pages
// (con su hora de actualización, que la ficha muestra): siempre gana la descarga de Aena más reciente.
export async function fetchSchedule(number, fetchFn = fetch, liveBase = LIVE_BASE) {
  const parsed = parseFlightNumber(number);
  if (!parsed) return null;
  try {
    let al = parsed.prefix;
    if (al.length === 3) {
      al = (await getJson(`${BASE}airlines.json`, fetchFn))?.[al];
      if (!al) return null;
    }
    const path = `${al}/${parsed.n}.json`;
    let [pages, live] = await Promise.all([
      quiet(getJson(`${BASE}${path}`, fetchFn)),
      liveBase ? quiet(getJson(`${liveBase}/flights/${path}`, (u, o) => fetchFn(u, { ...o, signal: AbortSignal.timeout(5000) }))) : null,
    ]);
    if (live && pages?.updated && live.updated && Date.parse(pages.updated) > Date.parse(live.updated)) live = null;
    const liveDates = new Set((live?.legs ?? []).map(l => l.d));
    const legs = [...(pages?.legs ?? []).filter(l => !liveDates.has(l.d)), ...(live?.legs ?? [])]
      .sort((x, y) => (x.d + (x.sd ?? x.sa)).localeCompare(y.d + (y.sd ?? y.sa)));
    if (!legs.length) return null;
    const src = live?.legs?.length ? live : pages;
    return {
      al, n: parsed.n, name: src.name ?? pages?.name, legs, updated: src.updated,
      ...(liveBase ? { source: live?.legs?.length ? 'live' : 'pages' } : {}),
    };
  } catch {
    return null;
  }
}

// «Iberia IB 1668»; sin nombre de aerolínea (Aena no lo da en aerolíneas fuera de su catálogo), solo «JU 571».
export const flightTitle = ({ name, al, n }) => [name, `${al} ${n}`].filter(Boolean).join(' ');

// Un mismo número puede tener VARIOS vuelos físicos en una fecha (p. ej. GRU → MAD y después MAD → PEK con el mismo
// número). Número + fecha no identifica un tramo: se distinguen con physicalFlightKey() y se elige con el estado de
// Aena y la hora, nunca por el orden de la lista.
//   - Un solo tramo: ese.
//   - Varios: se elige solo si hay EXACTAMENTE uno en curso (en el aire, salido o embarcando) y todos los demás ya
//     terminaron o se cancelaron. En cualquier otro caso (dos futuros, dos terminados, uno en curso y otro por salir…)
//     no se elige: `leg` es null y `choices` trae los tramos, en orden de hora, para que el usuario escoja por ruta.
// Devuelve { leg, choices } (choices: todos los tramos de la fecha si hay más de uno; si no, []).
const FINAL_ARRIVAL = new Set(['LND', 'IBK', 'OPE', 'OPF', 'BOR']);
const IN_PROGRESS_GATE = new Set(['EMB', 'ULL', 'CER', 'BTR']);
const ENDED_AFTER_ARRIVAL_MIN = 90;
const MAX_FLIGHT_H = 20; // el vuelo más largo posible (como MAX_FLIGHT_MIN en scripts/aena.mjs)

// Estado final CONFIRMADO por Aena (llegada final, cancelado o desviado): manda sobre cualquier lectura ADS-B.
export function aenaFinal(leg) {
  const flags = [leg.st, leg.std, leg.sta];
  if (flags.includes('CAN') || flags.includes('DES')) return true;
  const sta = leg.sta ?? (['LND', 'IBK', 'OPE', 'OPF'].includes(leg.st) ? leg.st : null);
  return FINAL_ARRIVAL.has(sta);
}

// 'cancelado' | 'terminado' | 'en-curso' | 'pendiente'
export function legPhase(leg, nowMs = Date.now()) {
  const flags = [leg.st, leg.std, leg.sta];
  if (flags.includes('CAN') || flags.includes('DES')) return 'cancelado';
  const sta = leg.sta ?? (['FLY', 'FNL', 'LND', 'IBK', 'OPE', 'OPF'].includes(leg.st) ? leg.st : null);
  const std = leg.std ?? (sta ? null : leg.st);
  if (FINAL_ARRIVAL.has(sta)) return 'terminado';
  if (sta === 'FLY' || sta === 'FNL') return 'en-curso'; // Aena (llegada) lo ve en el aire: manda sobre la hora
  // Aena no siempre cierra el estado: con la llegada de Aena muy pasada o, sin llegada (destino extranjero), pasada la
  // duración máxima de un vuelo desde la salida, el tramo ya terminó aunque la salida siga en BOR o en puerta.
  const arrMs = arrivalUtcMs(leg);
  const dep = legDeparture(leg);
  const depMs = dep ? localToUtcMs(dep.date, dep.time, aenaTz(leg.o)) : null;
  if (arrMs !== null ? nowMs - arrMs > ENDED_AFTER_ARRIVAL_MIN * 60000 : depMs !== null && nowMs - depMs > MAX_FLIGHT_H * 3600000) return 'terminado';
  if (std === 'BOR' || IN_PROGRESS_GATE.has(std)) return 'en-curso';
  return 'pendiente';
}

// Llegada de Aena (estimada o programada, con el cambio de día) y salida programada, en UTC; null si no hay.
function arrivalUtcMs(leg) {
  const arr = legArrival(leg);
  return arr ? localToUtcMs(arr.date, arr.time, aenaTz(leg.a)) : null;
}
// Hora de referencia para ordenar (salida programada o, si no la hay, llegada).
const legOrderMs = leg => (leg.sd ? localToUtcMs(leg.d, leg.sd, aenaTz(leg.o)) : null) ?? arrivalUtcMs(leg) ?? Infinity;

export function chooseLeg(legs, date, nowMs = Date.now()) {
  const byKey = new Map();
  for (const l of legs) if (l.d === date && !byKey.has(physicalFlightKey(l))) byKey.set(physicalFlightKey(l), l);
  const all = [...byKey.values()].sort((x, y) => legOrderMs(x) - legOrderMs(y) || physicalFlightKey(x).localeCompare(physicalFlightKey(y)));
  if (all.length <= 1) return { leg: all[0] ?? null, choices: [] };
  const phases = all.map(l => legPhase(l, nowMs));
  const active = all.filter((_, i) => phases[i] === 'en-curso');
  const rest = phases.filter(p => p !== 'en-curso');
  const leg = active.length === 1 && rest.every(p => p === 'terminado' || p === 'cancelado') ? active[0] : null;
  return { leg, choices: all };
}

// El tramo elegido por el usuario (su clave de vuelo físico), si sigue existiendo en esa fecha.
export const legByKey = (legs, key) => legs.find(l => physicalFlightKey(l) === key) ?? null;

export function tabDates(legs, selected, max = 7) {
  const dates = [...new Set(legs.map(l => l.d))].sort();
  let idx = dates.findIndex(d => d >= selected);
  if (idx < 0) idx = dates.length - 1;
  const start = Math.max(0, Math.min(idx - 1, dates.length - max));
  return dates.slice(start, start + max);
}

const split = iso => ({ date: iso.slice(0, 10), time: iso.slice(11, 16) });

export function legDeparture(leg) {
  if (leg.ed) return split(leg.ed);
  if (leg.sd) return { date: leg.d, time: leg.sd };
  return null;
}

// Llegada programada: si es antes que la salida, es del día siguiente.
function scheduledArrival(leg) {
  if (!leg.sa) return null;
  if (leg.sd && leg.sa < leg.sd) {
    const next = new Date(Date.parse(`${leg.d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return { date: next, time: leg.sa };
  }
  return { date: leg.d, time: leg.sa };
}

export function legArrival(leg) {
  return leg.ea ? split(leg.ea) : scheduledArrival(leg);
}

// Textos oficiales de Aena (Infovuelos): BOR = «Finalizado», DES = «Desviado», IBK/OPE/OPF = «Entrega equip.».
const ARRIVAL_STATES = {
  LND: { text: 'En tierra', tone: 'ok' },
  IBK: { text: 'Ha llegado', tone: 'ok' },
  OPE: { text: 'Ha llegado', tone: 'ok' },
  OPF: { text: 'Ha llegado', tone: 'ok' },
  BOR: { text: 'Ha llegado', tone: 'ok' },
  // flying: Aena (aeropuerto de llegada) dice que está en el aire → la ficha lo anima.
  FNL: { text: 'Aproximándose', tone: 'info', flying: true },
  FLY: { text: 'Volando', tone: 'info', flying: true },
};
const GATE_STATES = {
  EMB: { text: 'Embarcando', tone: 'info' },
  ULL: { text: 'Última llamada', tone: 'info' },
  CER: { text: 'Puerta cerrada', tone: 'info' },
  BTR: { text: 'Próximo embarque', tone: 'info' },
  NPT: { text: 'Cambio de puerta', tone: 'warn' },
  NPR: { text: 'Cambio de puerta', tone: 'warn' },
};

function delayMin(leg) {
  if (!leg.ed || !leg.sd) return 0;
  return (Date.parse(`${leg.ed}:00Z`) - Date.parse(`${leg.d}T${leg.sd}:00Z`)) / 60000;
}

export function flightStatus(leg) {
  // Horarios antiguos solo traen el estado mezclado (st).
  const sta = leg.sta ?? (['FLY', 'FNL', 'LND', 'IBK', 'OPE', 'OPF'].includes(leg.st) ? leg.st : null);
  const std = leg.std ?? (sta ? null : leg.st);
  if ([std, sta, leg.st].includes('CAN')) return { text: 'Cancelado', tone: 'bad' };
  if ([std, sta, leg.st].includes('DES')) return { text: 'Desviado', tone: 'bad' };
  if (ARRIVAL_STATES[sta]) return ARRIVAL_STATES[sta];
  if (std === 'BOR') return { text: 'Ha salido', tone: 'info' };
  if (GATE_STATES[std]) return GATE_STATES[std];
  // Llegada desde el extranjero: solo hay hora de llegada.
  if (!std && sta) {
    const sched = scheduledArrival(leg);
    const late = leg.ea && sched && (Date.parse(`${leg.ea}:00Z`) - Date.parse(`${sched.date}T${sched.time}:00Z`)) / 60000 > DELAY_MIN;
    if (sta === 'RET' || late) return { text: `Retrasado · llega ${legArrival(leg).time}`, tone: 'warn' };
  }
  if (std === 'RET' || delayMin(leg) > DELAY_MIN) {
    return { text: `Retrasado · sale ${legDeparture(leg).time}`, tone: 'warn' };
  }
  return { text: 'Programado', tone: 'ok' };
}

// ¿La hora estimada es posterior a la programada? (compara fecha y hora, no solo HH:MM)
export function isLate(leg, which) {
  if (which === 'dep') return delayMin(leg) > 0;
  const sched = scheduledArrival(leg);
  if (!sched || !leg.ea) return false;
  return Date.parse(`${leg.ea}:00Z`) > Date.parse(`${sched.date}T${sched.time}:00Z`);
}
