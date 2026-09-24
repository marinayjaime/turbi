// Servicio «turbi-live» (Render gratis): da a la app el estado en tiempo real de los vuelos de hoy y mañana.
// Cada 10 min descarga Aena, audita cada hora publicada contra su fila de origen y lo sirve por HTTP.
// No guarda nada: el histórico de puntualidad lo sigue calculando GitHub Actions.
// Si el servicio se ha dormido, la primera petición lo despierta y dispara una descarga (la app, mientras, usa GitHub Pages).
// Arranque: node server/live.mjs   (variable: PORT)
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { fetchAena, AIRPORTS } from '../scripts/aena-fetch.mjs';
import { buildLegs, shardLegs, auditLegs, patchFailed } from '../scripts/aena.mjs';

const EVERY_MS = 10 * 60000;
const SAFE_PATH = /^\/flights\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;

export function createState() {
  return { flights: new Map(), legs: null, updated: null, audit: null, lastError: null, runs: 0, running: false };
}

// Una descarga completa. Si Aena no responde, se conserva lo anterior (y se lanza el error para registrarlo).
export async function runCycle(state, { fetchAenaFn = fetchAena, now = () => new Date() } = {}) {
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
  state.updated = updated;
  state.lastError = null;
  state.runs++;
  return { legs: legs.length, flights: state.flights.size, failed: failed.length };
}

// Datos de más de 10 min (o ninguno) y ninguna descarga en marcha → hay que refrescar.
export function needsRefresh(state, nowMs = Date.now()) {
  if (state.running) return false;
  return !state.updated || nowMs - Date.parse(state.updated) > EVERY_MS;
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
  const body = m && state.flights.get(`${m[1]}/${m[2]}.json`);
  if (!body) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  return { status: 200, headers: HEADERS, body: JSON.stringify(body) };
}

async function main() {
  const state = createState();

  const cycle = async () => {
    if (state.running) return;
    state.running = true;
    const t0 = Date.now();
    try {
      const r = await runCycle(state);
      console.log(`Descarga ${state.runs}: ${r.flights} vuelos, auditoría ${state.audit.mismatches} discrepancias, ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (err) {
      state.lastError = `${new Date().toISOString()} ${err.message}`;
      console.error(`Descarga fallida: ${err.message}`);
    } finally {
      state.running = false;
    }
  };

  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, HEADERS); return res.end(); }
    if (needsRefresh(state)) cycle(); // p. ej. al despertar: responde con lo que hay y refresca
    const r = handle(state, new URL(req.url, 'http://x').pathname);
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  }).listen(Number(process.env.PORT ?? 8080), () => console.log(`turbi-live escuchando en ${process.env.PORT ?? 8080}`));

  const loop = async () => {
    const t0 = Date.now();
    await cycle();
    setTimeout(loop, Math.max(60000, EVERY_MS - (Date.now() - t0)));
  };
  loop();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
