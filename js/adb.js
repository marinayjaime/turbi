// Horario de AeroDataBox (vía Render) para un vuelo + fecha que Aena no publica. La app nunca ve la clave: solo pide a
// Render /schedule/{número}/{fecha}.json, que decide si consulta AeroDataBox (una vez por vuelo + fecha, más un único
// refresco en las 3 h previas a la salida si la consulta era de antes del día del vuelo).
import { LIVE_BASE } from './config.js';
import { ADSBDB_NOTE } from './flight.js';

export const ADB_NOTE = 'horario según AeroDataBox';
// Nota de la fuente de la ruta en el subtítulo del pronóstico (sin horario de Aena).
export const sourceNote = q => (q.routeSource === 'adsbdb' ? ADSBDB_NOTE : q.routeSource === 'aerodatabox' ? ADB_NOTE : '');

export const REFRESH_WINDOW_MS = 3 * 3600000;
const PREFIX = 'turbi-adb:';
const KEEP_DAYS = 3;
const TIMEOUT_MS = 15000; // Render gratis puede estar dormido: se espera un poco antes de seguir con ADSBDB

export const adbNumber = n => String(n ?? '').toUpperCase().replace(/\s+/g, '');

// ¿Toca el refresco operativo? (la misma regla en Render y en el navegador)
export function refreshDue(entry, nowMs) {
  if (entry?.status !== 'found' || entry.refreshedAt) return false;
  const fetched = Date.parse(entry.fetchedAt);
  return entry.legs.some(l => {
    const { utc, off } = l.dep.sched;
    const fetchedLocalDay = new Date(fetched + off * 60000).toISOString().slice(0, 10);
    return fetchedLocalDay < entry.date && nowMs >= utc - REFRESH_WINDOW_MS && nowMs < utc;
  });
}

function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function readLocal(key) {
  try { const v = storage()?.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function writeLocal(key, entry, nowMs) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(entry));
    // Limpieza: fuera lo de hace más de KEEP_DAYS días.
    const oldest = new Date(nowMs - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX) && k.slice(-10) < oldest) s.removeItem(k);
    }
  } catch { /* sin almacenamiento: no pasa nada, Render tiene su caché */ }
}

// { status: 'found' | 'not_found' | 'unavailable', legs, fetchedAt, refreshedAt? }. Nunca lanza.
export async function fetchAdb(number, date, { fetchFn = fetch, liveBase = LIVE_BASE, nowMs = Date.now() } = {}) {
  const n = adbNumber(number);
  const key = `${PREFIX}${n}|${date}`;
  const local = readLocal(key);
  if (local && !refreshDue(local, nowMs)) return local; // ni siquiera se pregunta a Render
  if (!liveBase) return local ?? { status: 'unavailable', reason: 'sin-servidor' };
  try {
    const res = await fetchFn(`${liveBase}/schedule/${encodeURIComponent(n)}/${date}.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = res.ok ? await res.json() : null;
    if (body?.status === 'found' || body?.status === 'not_found') {
      writeLocal(key, body, nowMs);
      return body;
    }
    return local ?? { status: 'unavailable', reason: body?.reason ?? `http-${res.status}` };
  } catch {
    return local ?? { status: 'unavailable', reason: 'sin-respuesta' };
  }
}

// Mejor hora disponible: real (pista) > revisada/prevista > programada.
const best = (...ts) => ts.find(Boolean) ?? null;
export function adbTimes(leg) {
  const dep = best(leg.dep.runway, leg.dep.revised, leg.dep.sched);
  const arr = best(leg.arr.runway, leg.arr.revised, leg.arr.predicted, leg.arr.sched);
  return { dep, arr, durationMin: dep && arr && arr.utc > dep.utc ? Math.round((arr.utc - dep.utc) / 60000) : null };
}

const STATUS = {
  Expected: 'Programado', CheckIn: 'Facturación', Boarding: 'Embarcando', GateClosed: 'Puerta cerrada', Delayed: 'Retrasado',
  Departed: 'Ha salido', EnRoute: 'En vuelo', Approaching: 'Aproximándose', Arrived: 'Ha llegado', Canceled: 'Cancelado',
  Diverted: 'Desviado', CanceledUncertain: 'Posiblemente cancelado',
};
export const adbStatusText = s => STATUS[s] ?? null;

// Pseudo-tramo para el selector de tramos (misma clave de vuelo físico que el resto de Turbi).
export const adbPhysical = leg => ({ d: leg.dep.sched.local.slice(0, 10), o: leg.o, a: leg.a, sd: leg.dep.sched.local.slice(11, 16) });

const hm = t => t.local.slice(11, 16);
const ago = ms => (ms < 90000 ? 'hace un momento' : ms < 5400000 ? `hace ${Math.round(ms / 60000)} min` : ms < 172800000 ? `hace ${Math.round(ms / 3600000)} h` : `hace ${Math.round(ms / 86400000)} días`);

// «Horario según AeroDataBox (consultado hace 2 h): Ha salido · salida 12:34 (programada 12:30) · llegada prevista 17:21 · Boeing 737-800»
export function adbInfo(meta, leg, nowMs = Date.now()) {
  const at = Date.parse(meta.refreshedAt ?? meta.fetchedAt);
  const { dep, arr } = adbTimes(leg);
  const depText = dep === leg.dep.sched ? `salida ${hm(dep)}` : `salida ${leg.dep.runway ? '' : 'prevista '}${hm(dep)} (programada ${hm(leg.dep.sched)})`;
  const arrText = !arr ? null : leg.arr.runway ? `llegada ${hm(arr)}` : arr === leg.arr.sched ? `llegada ${hm(arr)}` : `llegada prevista ${hm(arr)}`;
  return `Horario según AeroDataBox (consultado ${ago(nowMs - at)}): ${[adbStatusText(leg.status), depText, arrText, leg.aircraft].filter(Boolean).join(' · ')}`;
}
