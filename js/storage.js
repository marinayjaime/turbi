// Historial de pronósticos por vuelo y último pronóstico para consultarlo sin conexión.
// Todo en localStorage, con límites pequeños. Nunca lanza: si no hay almacenamiento, simplemente no guarda.

const FORECASTS = 'turbi.forecasts';
const LAST = 'turbi.last';
const MAX_FLIGHTS = 5;
const MAX_SNAPSHOTS = 6;
const MIN_GAP_MS = 10 * 60000;
const VERDICT_RANK = { tranquilo: 0, movimiento: 1, turbulento: 2 };

const store = () => globalThis.localStorage;
const read = (s, key) => { try { return JSON.parse(s.getItem(key)); } catch { return null; } };
const write = (s, key, value) => { try { s.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } };

export function flightKey({ number, origin, destination, date, time }) {
  return number ? `${number}|${date}` : `${origin.iata}-${destination.iata}-${time}|${date}`;
}

// snap = { t, maxLevel, verdict, confidence }. Devuelve las instantáneas de ese vuelo.
export function recordSnapshot(key, snap, s = store()) {
  const all = read(s, FORECASTS) ?? {};
  const list = all[key] ?? [];
  if (list.length && snap.t - list.at(-1).t < MIN_GAP_MS) list[list.length - 1] = snap;
  else list.push(snap);
  delete all[key]; // se reinserta al final: el orden de claves es el de uso
  all[key] = list.slice(-MAX_SNAPSHOTS);
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FLIGHTS))) delete all[k];
  write(s, FORECASTS, all);
  return all[key];
}

export function agoText(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

const rank = x => x.maxLevel * 10 + (VERDICT_RANK[x.verdict] ?? 0);
const localTime = ms => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

export function forecastTrend(snaps, nowMs, fmt = localTime) {
  if (!snaps || snaps.length < 2) return null;
  const cur = snaps.at(-1), prev = snaps.at(-2);
  if (rank(cur) < rank(prev)) return `La previsión ha mejorado desde la consulta de las ${fmt(prev.t)}.`;
  if (rank(cur) > rank(prev)) return `La previsión ha empeorado desde la consulta de las ${fmt(prev.t)}.`;
  let since = prev;
  for (let i = snaps.length - 2; i >= 0 && rank(snaps[i]) === rank(cur); i--) since = snaps[i];
  return `Sin cambios relevantes desde ${agoText(nowMs - since.t)}.`;
}

export function saveLast(view, savedAt, s = store()) {
  write(s, LAST, { savedAt, view });
}

export function loadLast(s = store()) {
  const x = read(s, LAST);
  return x && x.view && x.savedAt ? x : null;
}
