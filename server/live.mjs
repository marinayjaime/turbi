// Servicio «turbi-live» (Render gratis): cada 10 min descarga de Aena los vuelos de hoy y mañana, audita,
// captura la puntualidad y lo sirve a la app por HTTP.
// El disco de Render gratis se borra al dormir: el historial vive en la rama «data» de GitHub (server/git-store.mjs).
// Si el servicio se ha dormido, la primera petición lo despierta y dispara una descarga.
// Arranque: node server/live.mjs   (variables: PORT, GITHUB_TOKEN para guardar el historial, STORE_DIR)
import http from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchAena, madridDate, AIRPORTS } from '../scripts/aena-fetch.mjs';
import { buildLegs, shardLegs, auditLegs, patchFailed } from '../scripts/aena.mjs';
import { observe, mergeRecords, prune, aggregateFlights, loadStore, saveDays } from '../scripts/build-punctuality.mjs';
import { openStore, syncStore } from './git-store.mjs';

const EVERY_MS = 10 * 60000;
const SYNC_MS = 30 * 60000;
const SAFE_PATH = /^\/(flights|punctuality)\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;

export function createState() {
  return { flights: new Map(), punctuality: new Map(), legs: null, store: null, updated: null, audit: null, lastError: null, runs: 0, running: false, historyReady: true };
}

// Un ciclo completo. Si Aena no responde, se conserva lo anterior (y se lanza el error para registrarlo).
export async function runCycle(state, { fetchAenaFn = fetchAena, storeDir, now = () => new Date(), today = () => madridDate(0) }) {
  const { entries, failed } = await fetchAenaFn(true);
  if (!entries.length || failed.length >= AIRPORTS.length) throw new Error('Aena no disponible: se mantienen los datos anteriores');

  let legs = buildLegs(entries);
  const audit = auditLegs(entries, legs);
  if (failed.length && state.legs) legs = patchFailed(legs, state.legs, failed, AIRPORTS);
  const updated = now().toISOString();
  state.flights = new Map(Object.entries(shardLegs(legs, updated).files));
  state.legs = legs;
  state.audit = { checked: audit.checked, mismatches: audit.mismatches.length, duplicates: audit.duplicates };
  for (const m of audit.mismatches.slice(0, 10)) console.warn(`DISCREPANCIA ${m.flight} ${m.side} ${m.airport}: Aena ${m.aena} · Turbi ${m.turbi}`);

  const daysDir = `${storeDir}/punctuality/days`;
  state.store ??= await loadStore(daysDir);
  const changed = mergeRecords(state.store, observe(entries, buildLegs(entries)));
  prune(state.store, today());
  await saveDays(daysDir, state.store, changed, today());
  state.punctuality = new Map(Object.entries(aggregateFlights([...state.store.values()], today()).files));

  state.updated = updated;
  state.lastError = null;
  state.runs++;
  return { legs: legs.length, flights: state.flights.size, records: state.store.size, changedDays: changed.size, failed: failed.length };
}

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=60',
};

// Datos de más de 10 min (o ninguno) y ninguna descarga en marcha → hay que refrescar.
export function needsRefresh(state, nowMs = Date.now()) {
  if (state.running) return false;
  return !state.updated || nowMs - Date.parse(state.updated) > EVERY_MS;
}

export function handle(state, path) {
  if (path === '/health') {
    return { status: 200, headers: { ...HEADERS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ updated: state.updated, runs: state.runs, audit: state.audit, lastError: state.lastError, flights: state.flights.size }) };
  }
  const m = path.match(SAFE_PATH);
  // Sin el historial completo de GitHub no se sirve una puntualidad a medias: la app usa la de GitHub Pages.
  if (m?.[1] === 'punctuality' && !state.historyReady) return { status: 404, headers: HEADERS, body: '{"error":"historial no disponible"}' };
  const body = m && (m[1] === 'flights' ? state.flights : state.punctuality).get(`${m[2]}/${m[3]}.json`);
  if (!body) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  return { status: 200, headers: HEADERS, body: JSON.stringify(body) };
}

async function main() {
  const state = createState();
  const token = process.env.GITHUB_TOKEN;
  const repo = `https://${token ? `x-access-token:${token}@` : ''}github.com/marinayjaime/turbi.git`;
  const storeDir = process.env.STORE_DIR ?? `${tmpdir()}/turbi-store`;
  let history = null;
  try {
    history = await openStore({ dir: storeDir, repo });
    state.store = history.store;
    console.log(`Historial traído de GitHub: ${history.store.size} vuelos${token ? '' : ' (sin GITHUB_TOKEN: no se guardará)'}`);
  } catch (err) {
    state.historyReady = false;
    console.error(`Sin historial: ${err.message}`);
  }

  const cycle = async () => {
    if (state.running) return;
    state.running = true;
    const t0 = Date.now();
    try {
      const r = await runCycle(state, { storeDir });
      console.log(`Ciclo ${state.runs}: ${r.flights} vuelos, ${r.records} en el historial, auditoría ${state.audit.mismatches} discrepancias, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) {
      state.lastError = `${new Date().toISOString()} ${err.message}`;
      console.error(`Ciclo fallido: ${err.message}`);
    } finally {
      state.running = false;
    }
  };

  let lastSync = Date.now();
  const sync = async (why) => {
    if (!history || !token) return;
    try {
      const r = await syncStore(history, { today: madridDate(0) });
      lastSync = Date.now();
      console.log(`Historial ${r.pushed ? `guardado en GitHub (${r.changedDays} días)` : 'sin cambios'} [${why}]`);
    } catch (err) {
      console.error(`No se pudo guardar el historial: ${err.message}`);
    }
  };

  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS); return res.end(); }
    if (needsRefresh(state)) cycle(); // p. ej. al despertar tras dormir: responde con lo que hay y refresca
    const r = handle(state, new URL(req.url, 'http://x').pathname);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  }).listen(Number(process.env.PORT ?? 8080), () => console.log(`turbi-live escuchando en ${process.env.PORT ?? 8080}`));

  const loop = async () => {
    const t0 = Date.now();
    await cycle();
    if (Date.now() - lastSync >= SYNC_MS) await sync('cada 30 min');
    setTimeout(loop, Math.max(60000, EVERY_MS - (Date.now() - t0)));
  };
  loop();

  // Render avisa con SIGTERM antes de dormir o redesplegar: se guarda el historial antes de salir.
  process.on('SIGTERM', async () => {
    await sync('apagado');
    process.exit(0);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
