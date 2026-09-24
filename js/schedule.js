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
    return { al, n: parsed.n, name: data.name, legs: data.legs };
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

export function legArrival(leg) {
  return leg.ea ? split(leg.ea) : scheduledArrival(leg);
}

const STATES = {
  CAN: { text: 'Cancelado', tone: 'bad' },
  BOR: { text: 'Embarcando', tone: 'info' },
  EMB: { text: 'Embarcando', tone: 'info' },
  ULL: { text: 'Última llamada', tone: 'info' },
  CER: { text: 'Puerta cerrada', tone: 'info' },
  DES: { text: 'Despegado', tone: 'ok' },
  ATE: { text: 'Aterrizado', tone: 'ok' },
  LLE: { text: 'Aterrizado', tone: 'ok' },
};

function delayMin(leg) {
  if (!leg.ed || !leg.sd) return 0;
  return (Date.parse(`${leg.ed}:00Z`) - Date.parse(`${leg.d}T${leg.sd}:00Z`)) / 60000;
}

export function flightStatus(leg) {
  if (leg.st === 'CAN') return STATES.CAN;
  if (leg.st === 'RET' || delayMin(leg) > DELAY_MIN) {
    return { text: `Retrasado · sale ${legDeparture(leg).time}`, tone: 'warn' };
  }
  return STATES[leg.st] ?? { text: 'Programado', tone: 'ok' };
}

// ¿La hora estimada es posterior a la programada? (compara fecha y hora, no solo HH:MM)
export function isLate(leg, which) {
  if (which === 'dep') return delayMin(leg) > 0;
  const sched = scheduledArrival(leg);
  if (!sched || !leg.ea) return false;
  return Date.parse(`${leg.ea}:00Z`) > Date.parse(`${sched.date}T${sched.time}:00Z`);
}
