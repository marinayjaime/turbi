// Horarios de Aena publicados por el pipeline en data/flights/.
// Leg = { d, o, a, sd, ed, sa, ea, td, ta, g, st, ac } (ver scripts/aena.mjs)

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

export async function fetchSchedule(number, fetchFn = fetch) {
  const parsed = parseFlightNumber(number);
  if (!parsed) return null;
  try {
    let al = parsed.prefix;
    if (al.length === 3) {
      al = (await getJson(`${BASE}airlines.json`, fetchFn))?.[al];
      if (!al) return null;
    }
    const data = await getJson(`${BASE}${al}/${parsed.n}.json`, fetchFn);
    if (!data?.legs?.length) return null;
    return { al, n: parsed.n, name: data.name, legs: data.legs, updated: data.updated };
  } catch {
    return null;
  }
}

export const pickLeg = (legs, date) => legs.find(l => l.d === date) ?? null;

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

const DEPARTED = new Set(['BOR', 'FLY', 'FNL', 'LND', 'IBK', 'OPE', 'OPF']);
const hasDeparted = leg => [leg.std, leg.sta, leg.st].some(s => DEPARTED.has(s));
const MAX_ARR_GAP = 20; // min

// Llegada estimada. Antes del despegue, la estimación del aeropuerto de destino puede quedarse desfasada
// (caso real IB1668 el 24/09/2026: 20:07 → 19:50 → 19:31 en una hora). Si va más de 20 min por detrás
// de lo que implica la salida, se usa programada + retraso de salida (adjusted = true).
export function arrivalEstimate(leg) {
  const sched = scheduledArrival(leg);
  if (!sched) return leg.ea ? { ...split(leg.ea), adjusted: false } : null;
  if (!leg.ea) return { ...sched, adjusted: false };
  const est = split(leg.ea);
  if (hasDeparted(leg) || !leg.sd) return { ...est, adjusted: false };
  const schedMs = Date.parse(`${sched.date}T${sched.time}:00Z`);
  const depDelay = Math.max(0, delayMin(leg));
  const arrDelay = (Date.parse(`${leg.ea}:00Z`) - schedMs) / 60000;
  if (arrDelay - depDelay <= MAX_ARR_GAP) return { ...est, adjusted: false };
  const iso = new Date(schedMs + depDelay * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), adjusted: true };
}

export function legArrival(leg) {
  const a = arrivalEstimate(leg);
  return a ? { date: a.date, time: a.time } : null;
}

// Textos oficiales de Aena (Infovuelos): BOR = «Finalizado», DES = «Desviado», IBK/OPE/OPF = «Entrega equip.».
const ARRIVAL_STATES = {
  LND: { text: 'En tierra', tone: 'ok' },
  IBK: { text: 'Ha llegado', tone: 'ok' },
  OPE: { text: 'Ha llegado', tone: 'ok' },
  OPF: { text: 'Ha llegado', tone: 'ok' },
  BOR: { text: 'Ha llegado', tone: 'ok' },
  FNL: { text: 'Aproximándose', tone: 'info' },
  FLY: { text: 'En vuelo', tone: 'info' },
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
  const est = leg.ea ? arrivalEstimate(leg) : null;
  if (!sched || !est) return false;
  return Date.parse(`${est.date}T${est.time}:00Z`) > Date.parse(`${sched.date}T${sched.time}:00Z`);
}
