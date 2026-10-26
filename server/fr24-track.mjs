// Estela real del vuelo (Flightradar24 Flight Tracks): /track/AL/N.json?leg=<physicalFlightKey> (Aena) y
// /track-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey> (AeroDataBox). Solo con FR24_API_TOKEN (sin ella, server/live.mjs
// responde «no-aplica»). Principio: falso negativo antes que avión incorrecto, y una posición estimada nunca se pinta.
//   - Vuelo físico: el mismo ?leg= que /radar y /radar-adb (obligatorio), entre los tramos de ese número. Sin exigir la
//     puerta del radar: la asociación (≤ 24 h) ya prueba que el radar lo siguió, y así un vuelo aterrizado hace horas
//     conserva su ruta realizada. Cancelado o desviado: no-aplica.
//   - fr24Id: SOLO el que el radar ya asoció a ese vuelo físico (fr24Assoc, 24 h, server/fr24-radar.mjs) o el que verificó
//     el histórico (Flight Summary, server/fr24-history.mjs); si los dos existen y difieren, ninguno. Nunca uno del
//     usuario; sin asociación → «no-aplica» sin llamar a FR24.
//   - Créditos (Flight Tracks cuesta ~40 por vuelo): caché por fr24Id (encontrada 10 min, la app la prolonga con las
//     posiciones en vivo; «sin estela» y «no disponible» 2 min), promesa compartida en curso por fr24Id (usuarios
//     simultáneos = 1 llamada). La de un vuelo ya terminado que verificó el histórico es inmutable: se guarda en la rama
//     data (fr24/track-<fr24Id>.json) y no se vuelve a pagar. Y solo se paga si el usuario la pide (?load=1, al ampliar el
//     mapa): abrir la ficha solo sirve la ya guardada; si no la hay, «on-demand» sin llamar a FR24. Sin reintentos, sin
//     temporizadores, sin segundo plano.
//     Contadores trackRequests/trackCacheHits/trackStoreHits en /health.fr24.
// El token nunca sale de server/fr24.mjs: la respuesta es una lista cerrada de campos (fr24Track).
import { fr24Track } from './fr24.mjs';
import { fr24AdbLeg, fr24StatsOf, ASSOC_MS } from './fr24-radar.mjs';
import { historyFr24Id } from './fr24-history.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';
import { adbPhysicalKey } from '../js/adb.js';

const FOUND_MS = 10 * 60000;
const ADB_ENDED_BADLY = new Set(['Canceled', 'CanceledUncertain', 'Diverted']);
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

// Estela de un vuelo terminado (fr24Id del histórico): primero la guardada en la rama data; si no, y solo si el usuario
// la pidió (load), FR24 (con la caché y la promesa compartida de arriba) y, si la encuentra, se guarda.
async function finishedTrack(state, fr24Id, { load, ...opts }) {
  const store = state.historyStore ?? null, path = `fr24/track-${fr24Id}.json`;
  if (store) {
    const saved = await store.get(path).catch(() => null);
    if (saved?.data?.state === 'found' && saved.data.fr24Id === fr24Id) { fr24StatsOf(state).trackStoreHits++; return saved.data; }
  }
  if (!load) return { state: 'on-demand' };
  const r = await cachedTrack(state, fr24Id, opts);
  if (store && r.state === 'found') {
    const data = { state: 'found', fr24Id: r.fr24Id, points: r.points, times: r.times, lastAt: r.lastAt };
    const q = state.historyWrites ?? Promise.resolve();
    state.historyWrites = q.then(() => store.update(path, cur => (cur ? null : data))).catch(() => {});
    await state.historyWrites;
  }
  return r;
}

// GET /track/… y /track-adb/… (path con su ?leg=). 404 si la ruta no es una de las dos.
export async function fr24TrackResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const aena = url.pathname.match(TRACK_PATH), adb = !aena && url.pathname.match(ADB_TRACK_PATH);
  if (!aena && !adb) return { status: 404, headers: NO_STORE, body: '{"error":"no encontrado"}' };
  const legParam = url.searchParams.get('leg');
  if (legParam === null || legParam.length > 96) return trackNotApplicable(nowMs);
  // Tramo conocido (el mismo ?leg= que /radar), aunque la puerta del radar ya esté cerrada: un vuelo aterrizado hace horas
  // conserva su ruta realizada mientras dure la asociación (≤ 24 h). Cancelado o desviado: nunca.
  let phys = null;
  if (aena) {
    const leg = (state.legs ?? []).find(l => l.al === aena[1] && l.n === aena[2] && physicalFlightKey(l) === legParam);
    if (leg && ![leg.st, leg.std, leg.sta].some(f => f === 'CAN' || f === 'DES')) phys = `phys|${physicalFlightKey(leg)}`; // la clave de /radar
  } else {
    const { entry, leg } = await fr24AdbLeg(state, adb[1], adb[2], legParam, { nowMs, airports });
    if (leg && !ADB_ENDED_BADLY.has(leg.status)) phys = adbPhysicalKey(entry, leg);
  }
  const assoc = phys ? state.fr24Assoc?.get(phys) : null;
  const live = assoc?.fr24Id && nowMs - assoc.at <= ASSOC_MS ? assoc.fr24Id : null;
  const history = phys ? historyFr24Id(state, phys) : null;
  if ((!live && !history) || (live && history && live !== history)) return trackNotApplicable(nowMs);
  const load = url.searchParams.get('load') === '1';
  const r = live ? await cachedTrack(state, live, { fetchFn, env, nowMs }) : await finishedTrack(state, history, { fetchFn, env, nowMs, load });
  if (r.state === 'on-demand') return reply(nowMs, { state: 'on-demand' }, NO_STORE);
  if (r.state === 'found') return reply(nowMs, { state: 'found', fr24Id: r.fr24Id, points: r.points, times: r.times, lastAt: r.lastAt }, CACHED);
  if (r.state === 'not-found') return reply(nowMs, { state: 'not-found' }, CACHED);
  return reply(nowMs, { state: 'unavailable', reason: typeof r.reason === 'string' ? r.reason : 'error' }, NO_STORE);
}
