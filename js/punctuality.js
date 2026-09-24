// Puntualidad: situación actual del vuelo e histórico (OTP15, mediana, percentiles, ventanas, tendencia).
// Funciones puras, usadas en el navegador y en GitHub Actions.
// Diseño y definiciones: docs/superpowers/specs/2026-09-24-turbi-punctuality-design.md

export const ON_TIME_MIN = 15;
const DAY_MS = 86400000;

// Estados de Aena (textos oficiales de Infovuelos).
const ARR_FINAL = new Set(['LND', 'IBK', 'OPE', 'OPF']); // En tierra / Entrega equip.
const ARR_PROGRESS = new Set(['FLY', 'FNL']); // En vuelo / Aproximándose
const QUIET = new Set([null, undefined, '', 'SCH', 'INI', 'HOR']);

// Minutos entre la hora programada (fecha + HH:MM) y la real/estimada (AAAA-MM-DDTHH:MM), en el mismo aeropuerto.
export function delayMinutes(date, schedHHMM, actualIso) {
  if (!date || !schedHHMM || !actualIso) return null;
  return Math.round((Date.parse(`${actualIso}:00Z`) - Date.parse(`${date}T${schedHHMM}:00Z`)) / 60000);
}

export function delayBand(min) {
  if (min <= ON_TIME_MIN) return 'ok';
  if (min <= 30) return 'warn';
  if (min <= 60) return 'late';
  return 'bad';
}

const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const hhmm = iso => iso?.slice(11, 16) ?? null;

// Situación del vuelo concreto a partir del tramo del horario (sd/ed, sa/ea, estados de salida y llegada).
export function currentPunctuality(leg) {
  const sta = leg.sta ?? (ARR_FINAL.has(leg.st) || ARR_PROGRESS.has(leg.st) ? leg.st : null);
  const std = leg.std ?? (!sta ? leg.st : null);
  const status = [std, sta, leg.st];
  if (status.includes('CAN')) return { state: 'cancelado', text: 'Vuelo cancelado', band: 'bad', dep: null, arr: null, basis: null };
  if (status.includes('DES')) return { state: 'desviado', text: 'Vuelo desviado', band: 'bad', dep: null, arr: null, basis: null };

  const arrFinal = ARR_FINAL.has(sta) || (sta === 'BOR' && Boolean(leg.ea));
  const depFinal = std === 'BOR' || ARR_FINAL.has(sta) || ARR_PROGRESS.has(sta) || sta === 'BOR';

  const dep = leg.sd ? { sched: leg.sd, time: hhmm(leg.ed), delay: delayMinutes(leg.d, leg.sd, leg.ed), final: depFinal } : null;
  const arrDate = leg.sa ? (leg.sd && leg.sa < leg.sd ? nextDay(leg.d) : leg.d) : null;
  const arr = leg.sa ? { sched: leg.sa, time: hhmm(leg.ea), delay: delayMinutes(arrDate, leg.sa, leg.ea), final: arrFinal } : null;

  const basis = arr ? 'arr' : dep ? 'dep' : null;
  const side = basis === 'arr' ? arr : dep;
  if (!side) return { state: 'sin-datos', text: 'Sin datos de horario', band: null, dep, arr, basis };

  const unchanged = side.delay === null || (side.delay === 0 && !side.final);
  if (unchanged && basis === 'arr' && dep?.delay > ON_TIME_MIN) {
    return { state: 'retrasado', text: `Salida con ${dep.delay} min de retraso; llegada aún sin actualizar`, band: delayBand(dep.delay), dep, arr, basis };
  }
  if (unchanged) return { state: 'sin-cambios', text: 'Sin cambios sobre el horario programado', band: 'ok', dep, arr, basis };

  const late = side.delay > ON_TIME_MIN;
  const verb = basis === 'arr' ? (side.final ? 'Llegó' : 'Llegada prevista') : (side.final ? 'Salió' : 'Salida prevista');
  return {
    state: late ? 'retrasado' : 'puntual',
    text: late ? `${verb} con ${side.delay} min de retraso` : `${verb} puntual`,
    band: delayBand(side.delay), dep, arr, basis,
  };
}

// --- Histórico ---

// Registro compacto: [d, o, a, sd, dd, sa, ad, x, [números]] (x: 0 normal · 1 cancelado · 2 desviado)
export const pack = r => [r.d, r.o, r.a, r.sd, r.dd, r.sa, r.ad, r.x, r.f];
export const unpack = ([d, o, a, sd, dd, sa, ad, x, f]) => ({ d, o, a, sd, dd, sa, ad, x, f });

// Percentil por rango más cercano sobre valores ordenados.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

export function sampleQuality(n) {
  return n < 10 ? 'insuficiente' : n < 30 ? 'orientativa' : 'util';
}

// basis 'arr' = retraso de llegada (métrica oficial); 'dep' = de salida (destinos sin datos de llegada).
export function stats(records, basis = 'arr') {
  const key = basis === 'arr' ? 'ad' : 'dd';
  const delays = records.filter(r => r.x === 0 && typeof r[key] === 'number').map(r => r[key]).sort((a, b) => a - b);
  const cancelled = records.filter(r => r.x !== 0).length;
  const n = delays.length;
  return {
    sample: n,
    otp15: n ? delays.filter(v => v <= ON_TIME_MIN).length / n : null,
    median: median(delays),
    mean: n ? Math.round(delays.reduce((a, b) => a + b, 0) / n) : null,
    p75: percentile(delays, 75),
    p90: percentile(delays, 90),
    cancelled,
    cancelRate: n + cancelled ? cancelled / (n + cancelled) : null,
    quality: sampleQuality(n),
  };
}

export function qualityLabel(s) {
  if (s?.quality !== 'util' || s.otp15 === null) return null;
  return s.otp15 >= 0.9 ? 'excelente' : s.otp15 >= 0.8 ? 'buena' : s.otp15 >= 0.65 ? 'normal' : 'baja';
}

export const slotOf = sd => Math.min(3, Math.floor(Number(sd.slice(0, 2)) / 6));
export const dowOf = d => new Date(`${d}T12:00:00Z`).getUTCDay();
export const SLOT_LABELS = ['00:00–05:59', '06:00–11:59', '12:00–17:59', '18:00–23:59'];
export const DOW_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const byRecent = (a, b) => (b.d + (b.sd ?? '')).localeCompare(a.d + (a.sd ?? ''));

export function lastFlights(records, n) {
  return [...records].sort(byRecent).slice(0, n);
}

export function withinDays(records, today, days) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  return records.filter(r => r.d > from && r.d <= today);
}

// Solo se afirma algo si ambas ventanas tienen muestra útil y difieren al menos 10 puntos.
export function trend(recent, base) {
  if (recent?.quality !== 'util' || base?.quality !== 'util') return null;
  const diff = recent.otp15 - base.otp15;
  if (diff <= -0.1) return 'La puntualidad reciente está por debajo de su media de 90 días.';
  if (diff >= 0.1) return 'La puntualidad reciente está por encima de su media de 90 días.';
  return 'Sin cambios relevantes.';
}
