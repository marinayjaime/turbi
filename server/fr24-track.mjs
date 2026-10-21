// Estela real del vuelo (Flightradar24 Flight Tracks): /track/AL/N.json?leg=<physicalFlightKey> (Aena) y
// /track-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey> (AeroDataBox). Solo con FR24_API_TOKEN (sin ella, server/live.mjs
// responde «no-aplica»). Principio: falso negativo antes que avión incorrecto, y una posición estimada nunca se pinta.
//   - Vuelo físico: el mismo que /radar y /radar-adb (fr24AenaLeg / fr24AdbLeg, con su puerta), siempre con ?leg=.
//   - fr24Id: SOLO el que el radar ya asoció a ese vuelo físico (fr24Assoc, 24 h, server/fr24-radar.mjs). Nunca uno del
//     usuario; sin asociación → «no-aplica» sin llamar a FR24.
//   - Créditos: caché por fr24Id (encontrada 10 min, la app la prolonga con las posiciones en vivo; «sin estela» y «no
//     disponible» 2 min), promesa compartida en curso por fr24Id (usuarios simultáneos = 1 llamada). Sin reintentos, sin
//     temporizadores, sin segundo plano. Contadores trackRequests/trackCacheHits en /health.fr24.
// El token nunca sale de server/fr24.mjs: la respuesta es una lista cerrada de campos (fr24Track).
import { fr24Track } from './fr24.mjs';
import { fr24AenaLeg, fr24AdbLeg, fr24StatsOf, ASSOC_MS } from './fr24-radar.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';
import { adbPhysicalKey } from '../js/adb.js';

const FOUND_MS = 10 * 60000;
const MISS_MS = 2 * 60000;
export const TRACK_PATH = /^\/track\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
export const ADB_TRACK_PATH = /^\/track-adb\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const BASE = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
const CACHED = { ...BASE, 'Cache-Control': 'public, max-age=60' };
const NO_STORE = { ...BASE, 'Cache-Control': 'no-store' };

const reply = (nowMs, out, headers) => ({ status: 200, headers, body: JSON.stringify({ ...out, source: 'fr24', checked: new Date(nowMs).toISOString() }) });
// «no-aplica» sin guardar en el navegador: en cuanto el radar asocie el avión, la app puede pedirla.
export const trackNotApplicable = nowMs => reply(nowMs, { state: 'no-aplica' }, NO_STORE);

// fr24Track con caché y promesa compartida por fr24Id. Una respuesta fallida también se guarda (también cuesta).
async function cachedTrack(state, fr24Id, { fetchFn, env, nowMs }) {
  const stats = fr24StatsOf(state);
  const cache = state.fr24Tracks ??= new Map();
  const jobs = state.fr24TrackJobs ??= new Map();
  const hit = cache.get(fr24Id);
  if (hit && nowMs - hit.at < (hit.r.state === 'found' ? FOUND_MS : MISS_MS)) { stats.trackCacheHits++; return hit.r; }
  if (jobs.has(fr24Id)) { stats.trackCacheHits++; return jobs.get(fr24Id); }
  const job = (async () => {
    stats.trackRequests++;
    const r = await fr24Track(fr24Id, { fetchFn, env, nowMs }).catch(() => ({ state: 'unavailable', reason: 'error' }));
    if (cache.size > 200) cache.clear();
    cache.set(fr24Id, { at: nowMs, r });
    return r;
  })().finally(() => jobs.delete(fr24Id));
  jobs.set(fr24Id, job);
  return job;
}

// GET /track/… y /track-adb/… (path con su ?leg=). 404 si la ruta no es una de las dos.
export async function fr24TrackResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const aena = url.pathname.match(TRACK_PATH), adb = !aena && url.pathname.match(ADB_TRACK_PATH);
  if (!aena && !adb) return { status: 404, headers: NO_STORE, body: '{"error":"no encontrado"}' };
  const legParam = url.searchParams.get('leg');
  if (legParam === null || legParam.length > 96) return trackNotApplicable(nowMs);
  let phys = null;
  if (aena) {
    const { leg } = fr24AenaLeg(state, aena[1], aena[2], legParam, { nowMs, airports });
    if (leg) phys = `phys|${physicalFlightKey(leg)}`; // la misma clave de asociación que /radar
  } else {
    const { entry, leg, gate } = await fr24AdbLeg(state, adb[1], adb[2], legParam, { nowMs, airports });
    if (leg && gate.mode !== 'none') phys = adbPhysicalKey(entry, leg);
  }
  const assoc = phys ? state.fr24Assoc?.get(phys) : null;
  if (!assoc?.fr24Id || nowMs - assoc.at > ASSOC_MS) return trackNotApplicable(nowMs);
  const r = await cachedTrack(state, assoc.fr24Id, { fetchFn, env, nowMs });
  if (r.state === 'found') return reply(nowMs, { state: 'found', fr24Id: r.fr24Id, points: r.points, times: r.times, lastAt: r.lastAt }, CACHED);
  if (r.state === 'not-found') return reply(nowMs, { state: 'not-found' }, CACHED);
  return reply(nowMs, { state: 'unavailable', reason: typeof r.reason === 'string' ? r.reason : 'error' }, NO_STORE);
}
