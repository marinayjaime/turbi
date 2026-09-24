// Proceso de Railway «turbi-live»: cada 10 min descarga de Aena los vuelos de hoy y mañana, audita,
// captura la puntualidad (historial en disco persistente) y lo sirve a la app por HTTP.
// Arranque: node server/live.mjs   (variables: PORT, STORE_DIR)
import http from 'node:http';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchAena, madridDate, AIRPORTS } from '../scripts/aena-fetch.mjs';
import { buildLegs, shardLegs, auditLegs, patchFailed } from '../scripts/aena.mjs';
import { observe, mergeRecords, prune, aggregateFlights, loadStore, saveDays } from '../scripts/build-punctuality.mjs';

const EVERY_MS = 10 * 60000;
const SAFE_PATH = /^\/(flights|punctuality)\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;

export function createState() {
  return { flights: new Map(), punctuality: new Map(), legs: null, store: null, updated: null, audit: null, lastError: null, runs: 0 };
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

  const daysDir = `${storeDir}/days`;
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

export function handle(state, path) {
  if (path === '/health') {
    return { status: 200, headers: { ...HEADERS, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ updated: state.updated, runs: state.runs, audit: state.audit, lastError: state.lastError, flights: state.flights.size }) };
  }
  const m = path.match(SAFE_PATH);
  const body = m && (m[1] === 'flights' ? state.flights : state.punctuality).get(`${m[2]}/${m[3]}.json`);
  if (!body) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  return { status: 200, headers: HEADERS, body: JSON.stringify(body) };
}

// Primer arranque con el disco vacío: se trae el historial que ya había en la rama «data» de GitHub.
async function seedStore(storeDir) {
  const daysDir = `${storeDir}/days`;
  await mkdir(daysDir, { recursive: true });
  if ((await readdir(daysDir)).length) return;
  try {
    const list = await (await fetch('https://api.github.com/repos/marinayjaime/turbi/contents/punctuality/days?ref=data')).json();
    for (const f of Array.isArray(list) ? list : []) {
      const res = await fetch(f.download_url);
      if (res.ok) await writeFile(`${daysDir}/${f.name}`, await res.text());
    }
    console.log(`Historial inicial traído de GitHub: ${Array.isArray(list) ? list.length : 0} días`);
  } catch (err) {
    console.warn(`No se pudo traer el historial inicial: ${err.message}`);
  }
}

async function main() {
  const storeDir = process.env.STORE_DIR ?? '/data/punctuality';
  const state = createState();
  await seedStore(storeDir);

  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS); return res.end(); }
    const r = handle(state, new URL(req.url, 'http://x').pathname);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  }).listen(Number(process.env.PORT ?? 8080), () => console.log(`turbi-live escuchando en ${process.env.PORT ?? 8080}`));

  const tick = async () => {
    const t0 = Date.now();
    try {
      const r = await runCycle(state, { storeDir });
      console.log(`Ciclo ${state.runs}: ${r.flights} vuelos, ${r.records} en el historial, auditoría ${state.audit.mismatches} discrepancias, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) {
      state.lastError = `${new Date().toISOString()} ${err.message}`;
      console.error(`Ciclo fallido: ${err.message}`);
    }
    setTimeout(tick, Math.max(60000, EVERY_MS - (Date.now() - t0)));
  };
  tick();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
