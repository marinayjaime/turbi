// Servicio «turbi-live» (Render gratis): da a la app el estado en tiempo real de los vuelos de hoy y mañana.
// Cada 10 min descarga Aena, audita cada hora publicada contra su fila de origen y lo sirve por HTTP.
// Para vuelos al extranjero (Aena no publica la llegada) consulta el radar ADS-B: /radar/AL/N.json (server/radar.mjs).
// No guarda nada: el histórico de puntualidad lo sigue calculando GitHub Actions.
// Si el servicio se ha dormido, la primera petición lo despierta y dispara una descarga (la app, mientras, usa GitHub Pages).
// Arranque: node server/live.mjs   (variable: PORT)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchAena, madridDate, AIRPORTS } from '../scripts/aena-fetch.mjs';
import { needsRadar, findOnRadar } from './radar.mjs';
import { canIdentify, identifyByZone, trackByHex, createHexRegistry } from './identify.mjs';
import { adsbHealth } from './adsb.mjs';
import { buildLegs, shardLegs, auditLegs, patchFailed, keepDeparted } from '../scripts/aena.mjs';

const PAGES_URL = 'https://marinayjaime.github.io/turbi/';

const EVERY_MS = 10 * 60000;
const SAFE_PATH = /^\/flights\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const RADAR_PATH = /^\/radar\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const RADAR_CACHE_MS = 60000;

export function createState() {
  return { flights: new Map(), legs: null, updated: null, audit: null, lastError: null, runs: 0, running: false, radar: new Map(), hexes: createHexRegistry() };
}

// Una descarga completa. Si Aena no responde, se conserva lo anterior (y se lanza el error para registrarlo).
export async function runCycle(state, { fetchAenaFn = fetchAena, now = () => new Date(), today = () => madridDate(0) } = {}) {
  const { entries, failed } = await fetchAenaFn(true);
  if (!entries.length || failed.length >= AIRPORTS.length) throw new Error('Aena no disponible: se mantienen los datos anteriores');

  let legs = buildLegs(entries);
  const audit = auditLegs(entries, legs);
  if (failed.length && state.legs) legs = patchFailed(legs, state.legs, failed, AIRPORTS);
  if (state.legs) legs = keepDeparted(state.legs, legs, today());
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
      body: JSON.stringify({ updated: state.updated, runs: state.runs, audit: state.audit, lastError: state.lastError, flights: state.flights.size,
        adsb: adsbHealth() }) }; // estado de adsb.lol sin consultarlo
  }
  const m = path.match(SAFE_PATH);
  const body = m && state.flights.get(`${m[1]}/${m[2]}.json`);
  if (!body) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  return { status: 200, headers: HEADERS, body: JSON.stringify(body) };
}

// Radar de un vuelo (solo si Aena dice que ha salido y no informa de la llegada). Respuesta guardada 60 s.
export async function radarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), pauseMs, airports = {} } = {}) {
  const m = path.match(RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const cached = state.radar.get(path);
  if (cached && nowMs - cached.at < RADAR_CACHE_MS) return { status: 200, headers: HEADERS, body: cached.body };
  const leg = (state.legs ?? []).find(l => l.al === m[1] && l.n === m[2] && needsRadar(l, nowMs));
  // Mismo avión (códigos compartidos): una sola consulta por vuelo físico cada 60 s.
  const phys = leg && `phys|${leg.d}|${leg.o}|${leg.a}|${leg.sd ?? `L${leg.sa}`}`;
  const shared = phys && state.radar.get(phys);
  if (shared && nowMs - shared.at < RADAR_CACHE_MS) {
    state.radar.set(path, shared);
    return { status: 200, headers: HEADERS, body: shared.body };
  }
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const origin = leg && coords(leg.o), dest = leg && coords(leg.a);
  const hexes = state.hexes ??= createHexRegistry();
  let result = null;
  // 1) Avión ya identificado por su ruta (server/identify.mjs): se sigue por su hex. Una lectura rara no lo invalida.
  const known = phys && hexes.get(phys);
  if (known && origin && dest) {
    const t = await trackByHex({ entry: known, leg, origin, dest, nowMs, fetchFn });
    hexes.observe(phys, t.observation, nowMs);
    result = t.result;
  }
  // 2) Indicativo exacto (OACI + número, códigos compartidos), como siempre.
  if (!result) {
    result = leg ? await findOnRadar({ leg, siblings: state.legs.filter(l => l.d === leg.d && l.o === leg.o && l.a === leg.a && l.sd === leg.sd), fetchFn, pauseMs, nowMs,
      dest, origin }) : { state: 'no-aplica' };
  }
  // 3) No aparece con su indicativo: identificación por ruta EN SEGUNDO PLANO (nunca se espera aquí). La respuesta
  //    «identificando» no se guarda en caché, para que la app pueda volver a preguntar en unos segundos.
  let identifying = false;
  if (result.state === 'sin-datos' && phys && !hexes.get(phys) && origin && dest && canIdentify(leg, state.legs, { origin, dest })) {
    hexes.resolve(phys, () => identifyByZone({ leg, legs: state.legs, origin, dest, nowMs, fetchFn }), nowMs).catch(() => {});
    identifying = hexes.busy(phys);
  }
  const body = JSON.stringify({ ...result, ...(identifying ? { identifying: true } : {}), checked: new Date(nowMs).toISOString() });
  if (identifying) return { status: 200, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body };
  if (state.radar.size > 500) state.radar.clear();
  state.radar.set(path, { at: nowMs, body });
  if (phys) state.radar.set(phys, { at: nowMs, body });
  return { status: 200, headers: HEADERS, body };
}

async function main() {
  const state = createState();
  const airports = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url), 'utf8'));
  // Tras un reinicio: las salidas ya despegadas que publicó GitHub (Aena las retira a las 2 h).
  try {
    const res = await fetch(`${PAGES_URL}data/flights/_departed.json`, { signal: AbortSignal.timeout(20000) });
    if (res.ok) state.legs = await res.json();
    console.log(`Salidas ya despegadas recuperadas de GitHub: ${state.legs?.length ?? 0}`);
  } catch (err) {
    console.warn(`No se pudieron recuperar las salidas ya despegadas: ${err.message}`);
  }

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
    const path = new URL(req.url, 'http://x').pathname;
    const send = r => { res.writeHead(r.status, r.headers); res.end(r.body); };
    if (path.startsWith('/radar/')) {
      radarResponse(state, path, { airports }).then(send, () => send({ status: 200, headers: HEADERS, body: '{"state":"sin-datos"}' }));
      return;
    }
    send(handle(state, path));
  }).listen(Number(process.env.PORT ?? 8080), () => console.log(`turbi-live escuchando en ${process.env.PORT ?? 8080}`));

  const loop = async () => {
    const t0 = Date.now();
    await cycle();
    setTimeout(loop, Math.max(60000, EVERY_MS - (Date.now() - t0)));
  };
  loop();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
