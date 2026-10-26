// Cierre de vuelos históricos con Flightradar24 Flight Summary Light: /history-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey>.
// LIVE es /radar (Flight Positions); HISTÓRICO es esto (Flight Summary); TRACK es /track-adb (Flight Tracks con el fr24Id
// que se verifique aquí). Solo vuelos de AeroDataBox (Aena ya da su propio estado final) y solo bajo demanda.
//   - Cuándo: historyDue (js/adb.js), la misma regla que la app: 1 h después de la llegada más tardía conocida.
//   - Identificación (falso negativo antes que otro avión): número comercial exacto, ruta OACI exacta (origen y destino
//     previsto), despegue (o primera señal) entre 3 h antes y 12 h después de la salida programada y, si AeroDataBox y FR24
//     dan matrícula o transpondedor, que coincidan. Exactamente UN candidato; varios → ninguno.
//   - Ventana de la consulta (first_seen): de 3 h antes a 12 h después de la salida programada de ESE tramo (en UTC, no el
//     día del usuario): cubre retrasos largos sin llegar al mismo vuelo del día siguiente (24 h después).
//   - Créditos: lo terminado (aterrizado o desviado) es inmutable y se guarda en la rama data (fr24/…): una sola consulta por
//     vuelo, también tras reiniciar Render. Lo demás (no encontrado, varios, aún sin terminar) se recuerda 30 min en memoria;
//     un fallo, 5 min. Usuarios simultáneos = 1 llamada (promesa compartida). Sin reintentos ni segundo plano.
import { readFileSync } from 'node:fs';
import { fr24Summary, fr24Configured, FLIGHT_RE } from './fr24.mjs';
import { fr24AdbLeg, fr24StatsOf } from './fr24-radar.mjs';
import { adbPhysicalKey, historyDue } from '../js/adb.js';

export const HISTORY_PATH = /^\/history-adb\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const H = 3600000;
export const WINDOW_BEFORE_MS = 3 * H, WINDOW_AFTER_MS = 12 * H;
const MISS_MS = 30 * 60000, FAIL_MS = 5 * 60000;
const MAX_FLIGHT_MS = 20 * H;
const BASE = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
const NO_STORE = { ...BASE, 'Cache-Control': 'no-store' };
const FINAL = { ...BASE, 'Cache-Control': 'public, max-age=3600' };
const ICAO = JSON.parse(readFileSync(new URL('../data/icao.json', import.meta.url), 'utf8'));

const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

// El único candidato que es ESTE vuelo físico, o null (ninguno, o varios que no se pueden distinguir: { multiple: n }).
export function pickSummary(flights, { number, origIcao, destIcao, depMs, reg = null, modeS = null }) {
  const ok = flights.filter(f => {
    if (f.flight !== number || f.origIcao !== origIcao || f.destIcao !== destIcao) return false;
    const t = Date.parse(f.takeoff ?? f.firstSeen);
    if (!Number.isFinite(t) || t < depMs - WINDOW_BEFORE_MS || t > depMs + WINDOW_AFTER_MS) return false;
    if (reg && f.reg && !same(reg, f.reg)) return false;
    if (modeS && f.hex && !same(modeS, f.hex)) return false;
    return true;
  });
  return ok.length === 1 ? ok[0] : ok.length > 1 ? { multiple: ok.length } : null;
}

// Del candidato a lo que puede afirmar Turbi: aterrizado en SU destino (con despegue y aterrizaje coherentes), desviado,
// o aún sin terminar (nunca se afirma un aterrizaje por la hora).
export function summaryOutcome(c, destIcao) {
  const takeoff = Date.parse(c.takeoff), landed = Date.parse(c.landed);
  const actual = c.destIcaoActual ?? c.destIcao;
  if (c.ended && actual && actual !== destIcao) return { state: 'diverted', fr24Id: c.fr24Id, destIcaoActual: actual };
  if (c.ended && Number.isFinite(takeoff) && Number.isFinite(landed) && landed > takeoff && landed - takeoff <= MAX_FLIGHT_MS) {
    return { state: 'landed', fr24Id: c.fr24Id, takeoff: c.takeoff, landed: c.landed, type: c.type, reg: c.reg };
  }
  return { state: 'in-progress' };
}

const historyPath = phys => `fr24/${phys.split('|').slice(1).join('_').replace(/[^A-Za-z0-9_-]/g, '')}.json`;
const isFinal = r => r?.state === 'landed' || r?.state === 'diverted';

// fr24Id que el histórico verificó para este vuelo físico (aterrizado), o null. Solo lo que Render ya resolvió.
export function historyFr24Id(state, phys) {
  const r = state.fr24History?.get(phys)?.r;
  return r?.state === 'landed' && typeof r.fr24Id === 'string' ? r.fr24Id : null;
}

async function resolveHistory(state, { phys, entry, leg }, { fetchFn, env, nowMs }) {
  const stats = fr24StatsOf(state);
  const memory = state.fr24History ??= new Map();
  const hit = memory.get(phys);
  if (hit && (isFinal(hit.r) || nowMs - hit.at < (hit.r.state === 'unavailable' ? FAIL_MS : MISS_MS))) { stats.historyCacheHits++; return hit.r; }
  const store = state.historyStore ?? null, path = historyPath(phys);
  if (store) {
    const saved = await store.get(path).catch(() => null);
    if (isFinal(saved?.data)) { memory.set(phys, { at: nowMs, r: saved.data }); stats.historyStoreHits++; return saved.data; }
  }
  const origIcao = ICAO[leg.o], destIcao = ICAO[leg.a];
  if (!origIcao || !destIcao || !FLIGHT_RE.test(entry.number)) return { state: 'no-aplica' };
  stats.historyRequests++;
  const depMs = leg.dep.sched.utc;
  const res = await fr24Summary({ flight: entry.number, origIcao, destIcao, fromMs: depMs - WINDOW_BEFORE_MS, toMs: Math.min(depMs + WINDOW_AFTER_MS, nowMs) },
    { fetchFn, env }).catch(() => ({ state: 'unavailable', reason: 'error' }));
  let r;
  if (res.state !== 'ok') { stats.historyUnavailable++; r = { state: 'unavailable', reason: typeof res.reason === 'string' ? res.reason : 'error' }; }
  else {
    if (Number.isFinite(res.credits)) stats.historyCredits += res.credits;
    const c = pickSummary(res.flights, { number: entry.number, origIcao, destIcao, depMs, reg: leg.reg, modeS: leg.modeS });
    r = !c ? { state: 'not-found' } : c.multiple ? { state: 'multiple', count: c.multiple } : summaryOutcome(c, destIcao);
    stats[r.state === 'landed' ? 'historyLanded' : r.state === 'not-found' ? 'historyNotFound' : r.state === 'multiple' ? 'historyMultiple' : 'historyOther']++;
  }
  memory.set(phys, { at: nowMs, r });
  // Terminado: inmutable, a la rama data (si ya había uno guardado, manda el guardado). Sin caché persistente, solo memoria.
  if (isFinal(r) && store) {
    const q = state.historyWrites ?? Promise.resolve();
    state.historyWrites = q.then(() => store.update(path, cur => (cur ? null : r))).catch(() => {});
    await state.historyWrites;
  }
  return r;
}

// GET /history-adb/<vuelo>/<fecha>.json?leg=<adbPhysicalKey>
export async function fr24HistoryResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, env = process.env } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(HISTORY_PATH);
  if (!m) return { status: 404, headers: NO_STORE, body: '{"error":"no encontrado"}' };
  const reply = (r, headers = NO_STORE) => ({ status: 200, headers, body: JSON.stringify({ ...r, source: 'fr24', checked: new Date(nowMs).toISOString() }) });
  const legParam = url.searchParams.get('leg');
  if (!fr24Configured(env) || legParam === null || legParam.length > 96) return reply({ state: 'no-aplica' });
  const { entry, leg } = await fr24AdbLeg(state, m[1], m[2], legParam, { nowMs, airports });
  if (!leg || !historyDue(leg, nowMs)) return reply({ state: 'no-aplica' });
  const phys = adbPhysicalKey(entry, leg);
  const jobs = state.fr24HistoryJobs ??= new Map();
  if (!jobs.has(phys)) jobs.set(phys, resolveHistory(state, { phys, entry, leg }, { fetchFn, env, nowMs }).finally(() => jobs.delete(phys)));
  else fr24StatsOf(state).historyCacheHits++;
  const r = await jobs.get(phys);
  const out = r.state === 'landed' ? { state: 'landed', fr24Id: r.fr24Id, takeoff: r.takeoff, landed: r.landed, type: r.type ?? null, reg: r.reg ?? null }
    : r.state === 'diverted' ? { state: 'diverted', fr24Id: r.fr24Id, destIcaoActual: r.destIcaoActual }
      : r.state === 'unavailable' ? { state: 'unavailable', reason: r.reason } : { state: r.state };
  return reply(out, isFinal(r) ? FINAL : NO_STORE);
}
