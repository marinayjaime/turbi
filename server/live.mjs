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
import { needsRadar, findOnRadar, radarGateFor, plannedMinFor } from './radar.mjs';
import { canIdentify, identifyByZone, trackByHex, createHexRegistry, operatorIcaos } from './identify.mjs';
import { adsbHealth, adsbLimiter } from './adsb.mjs';
import { buildLegs, shardLegs, auditLegs, patchFailed, keepDeparted } from '../scripts/aena.mjs';
import { physicalFlightKey, samePhysicalFlight } from '../js/physical-flight.js';

const PAGES_URL = 'https://marinayjaime.github.io/turbi/';

const EVERY_MS = 10 * 60000;
const SAFE_PATH = /^\/flights\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const RADAR_PATH = /^\/radar\/([A-Z0-9]{2})\/(\d{1,4}[A-Z]?)\.json$/;
const RADAR_CACHE_MS = 60000;
const DIRECT_MISS_MS = 2 * 60000;
const DIRECT_RESUMES = 3; // repeticiones automáticas de los indicativos exactos tras un 429

const freshRadarStats = () => ({ requests: 0, cacheHits: 0, directLookups: 0, directFound: 0,
  identificationStarted: 0, identificationBusyPolls: 0, identificationSucceeded: 0,
  identificationAmbiguous: 0, identificationUnavailable: 0, rateLimited: 0, blockedReasons: {} });

export function createState() {
  return { flights: new Map(), legs: null, updated: null, audit: null, lastError: null, runs: 0, running: false,
    radar: new Map(), directMisses: new Map(), radarDiagnostics: new Map(), radarStats: freshRadarStats(), hexes: createHexRegistry() };
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
        adsb: adsbHealth(), radar: state.radarStats ?? freshRadarStats() }) }; // estado de adsb.lol sin consultarlo
  }
  const m = path.match(SAFE_PATH);
  const body = m && state.flights.get(`${m[1]}/${m[2]}.json`);
  if (!body) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  return { status: 200, headers: HEADERS, body: JSON.stringify(body) };
}

// Radar de un vuelo (solo si Aena dice que ha salido y no informa de la llegada). Respuesta guardada 60 s.
export async function radarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), pauseMs, airports = {} } = {}) {
  const requestUrl = new URL(path, 'http://turbi.local');
  const pathname = requestUrl.pathname;
  const debug = requestUrl.searchParams.get('debug') === '1';
  const pollOnly = requestUrl.searchParams.get('poll') === '1';
  const m = pathname.match(RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  state.radarStats ??= freshRadarStats();
  state.directMisses ??= new Map();
  state.radarDiagnostics ??= new Map();
  state.radarStats.requests++;
  // Decisión con js/radar-gate.js: none (cero radar) / direct (hex conocido e indicativo) / identify (+ por ruta).
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const tzOf = iata => airports[iata]?.[4] ?? undefined;
  const gateOpts = l => ({ originTz: tzOf(l.o), destTz: tzOf(l.a), plannedMin: plannedMinFor(coords(l.o), coords(l.a)) });
  const leg = (state.legs ?? []).find(l => l.al === m[1] && l.n === m[2] && needsRadar(l, nowMs, gateOpts(l)));
  const gate = leg ? radarGateFor(leg, nowMs, gateOpts(leg)) : null;
  // Mismo avión (códigos compartidos): una sola consulta por vuelo físico cada 60 s.
  const phys = leg && `phys|${physicalFlightKey(leg)}`;
  const hexes = state.hexes ??= createHexRegistry();
  if (phys) hexes.touch(phys); // alguien mira este vuelo: si su identificación se interrumpe, merece reanudarse
  const diagnostic = extra => ({ gate: gate?.mode ?? 'none', gateReason: gate?.reason ?? 'vuelo-no-encontrado',
    departureConfirmed: gate?.confirmed ?? false, ...(phys ? state.radarDiagnostics.get(phys) : null), ...extra,
    ...(phys ? { registry: hexes.status(phys, nowMs) } : {}) });
  const bodyOf = (payload, extra = {}) => JSON.stringify({ ...payload, ...extra,
    checked: new Date(nowMs).toISOString(), ...(debug ? { diagnostic: diagnostic() } : {}) });

  const cached = state.radar.get(pathname);
  if (cached && nowMs - cached.at < RADAR_CACHE_MS) {
    state.radarStats.cacheHits++;
    return { status: 200, headers: HEADERS, body: debug ? bodyOf(JSON.parse(cached.body)) : cached.body };
  }
  const shared = phys && state.radar.get(phys);
  if (shared && nowMs - shared.at < RADAR_CACHE_MS) {
    state.radarStats.cacheHits++;
    state.radar.set(pathname, shared);
    return { status: 200, headers: HEADERS, body: debug ? bodyOf(JSON.parse(shared.body)) : shared.body };
  }
  const origin = leg && coords(leg.o), dest = leg && coords(leg.a);
  const noStore = { ...HEADERS, 'Cache-Control': 'no-store' };
  const pending = gate && !gate.confirmed ? { departureConfirmed: false } : {};
  // Respuesta «trabajando»: la app sigue sondeando y muestra «Localizando el avión en el radar…». phase: 'hex' |
  // 'direct' (indicativos exactos) | 'identify' (por ruta) | 'pausa' (esperando a que adsb.lol levante un 429).
  const working = (phase, resumeAt = null) => {
    const st = phys ? hexes.status(phys, nowMs) : null;
    const miss = phys && state.directMisses.get(phys)?.result;
    const retryAfterSec = resumeAt !== null ? Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000)) : st?.interrupted ? st.retryAfterSec : null;
    return { status: 200, headers: noStore, body: bodyOf(miss ?? { state: 'sin-datos' }, { identifying: true,
      phase: retryAfterSec !== null ? 'pausa' : phase, ...(retryAfterSec !== null ? { temporary: true, retryAfterSec } : {}), ...pending }) };
  };
  const respond = ({ result, identifying }) => {
    const extra = { ...(identifying ? { identifying: true, phase: 'identify' } : {}), ...pending };
    const payload = { ...result, ...extra, checked: new Date(nowMs).toISOString() };
    const plainBody = JSON.stringify(payload);
    const responseBody = debug ? JSON.stringify({ ...payload, diagnostic: diagnostic() }) : plainBody;
    return { status: 200, headers: identifying ? noStore : HEADERS, body: responseBody };
  };

  // Trabajo de radar por vuelo físico (phys → { phase, promise }): seguimiento por hex, indicativos exactos y el
  // arranque de la identificación por ruta. Mientras dura, un sondeo solo lee su fase y una consulta normal comparte
  // el mismo resultado: dos usuarios (o un usuario cuyo navegador abandonó a los 20 s y vuelve a sondear) nunca
  // lanzan dos búsquedas del mismo vuelo, y un sondeo nunca recibe «sin datos» mientras otro sigue probando.
  const jobs = state.radarJobs ??= new Map();
  const job = phys && jobs.get(phys);
  if (job) {
    state.radarStats.identificationBusyPolls++;
    if (pollOnly || job.phase === 'pausa') return working(job.phase, job.phase === 'pausa' ? job.resumeAt : null);
    const out = await job.promise;
    return out.paused ? working('pausa', job.resumeAt) : out.identifying ? working('identify') : respond(out);
  }
  const known = phys && hexes.get(phys);
  // Identificación en cola, consultando zonas o en pausa por un 429: los sondeos y las consultas solo leen su estado.
  if (!known && phys && hexes.busy(phys)) {
    state.radarStats.identificationBusyPolls++;
    return working('identify');
  }
  // Un sondeo nunca inicia trabajo nuevo. Si el trabajo terminó con un hex, la caché de 60 s ya lo ha devuelto (o se
  // sigue por hex en la siguiente consulta normal); si no, devuelve el último resultado directo.
  if (!known && pollOnly) {
    const miss = phys && state.directMisses.get(phys);
    const lastIdentity = phys ? hexes.status(phys, nowMs).diagnostic?.result : null;
    const polledResult = lastIdentity === 'no-disponible' ? { state: 'no-disponible' } : miss?.result ?? { state: 'sin-datos' };
    return { status: 200, headers: noStore, body: bodyOf(polledResult, pending) };
  }

  // now: reloj de esta ejecución (la de la petición y, al repetirla tras una pausa, esa hora más la pausa).
  const work = async (now, current) => {
    let result = null;
    // 1) Avión ya identificado por su ruta (server/identify.mjs): se sigue por su hex. Una lectura rara no lo invalida.
    if (known && origin && dest) {
      const t = await trackByHex({ entry: known, leg, origin, dest, nowMs: now, fetchFn });
      hexes.observe(phys, t.observation, now);
      result = t.result ?? { state: 'sin-datos' };
    }
    // 2) Indicativo exacto (OACI + número, códigos compartidos). El resultado negativo se comparte brevemente para que
    // refrescar o abrir un código compartido no repita el mismo trabajo mientras se identifica por ruta.
    let directRateLimited = false;
    if (!result) {
      current.phase = 'direct';
      const miss = phys && state.directMisses.get(phys);
      if (miss && now - miss.at < DIRECT_MISS_MS) result = miss.result;
      else {
        let directDiagnostic = null;
        result = leg ? await findOnRadar({ leg, siblings: state.legs.filter(l => samePhysicalFlight(l, leg)),
          fetchFn, pauseMs, nowMs: now, dest, origin, onDiagnostic: d => { directDiagnostic = d; } }) : { state: 'no-aplica' };
        if (directDiagnostic) {
          state.radarStats.directLookups += directDiagnostic.lookupsMade;
          if (directDiagnostic.found) state.radarStats.directFound++;
          if (directDiagnostic.rateLimited) { state.radarStats.rateLimited++; directRateLimited = true; }
          if (phys) state.radarDiagnostics.set(phys, { ...diagnostic(), direct: directDiagnostic,
            identifiedBy: directDiagnostic.found ? 'direct' : null });
        }
        if (phys && result.state === 'sin-datos') state.directMisses.set(phys, { at: now, result });
      }
    }
    // 429 en los indicativos exactos: no se sabe si el avión emite con su indicativo. No es «sin datos» ni motivo para
    // identificar por ruta: el trabajo se repite cuando acabe la pausa (ver más abajo).
    if (directRateLimited) return { result: { state: 'sin-datos' }, directRateLimited: true };
    // 3) No aparece con su indicativo: identificación por ruta EN
    //    SEGUNDO PLANO, arrancada dentro de este trabajo para que no quede ningún hueco en el que un sondeo lea «sin
    //    datos». Si adsb.lol entra en pausa durante la identificación, queda interrumpida y se reanuda sola (temporal).
    const notFound = result.state === 'sin-datos';
    const registryBefore = phys ? hexes.status(phys, now) : null;
    if (notFound && gate?.mode === 'identify' && phys && !hexes.get(phys) && origin && dest
      && !registryBefore.cooldownRemainingMs && canIdentify(leg, state.legs, { origin, dest, nowMs: now, ...gateOpts(leg) })) {
      current.phase = 'identify';
      state.radarStats.identificationStarted++;
      const base = state.radarDiagnostics.get(phys) ?? diagnostic();
      hexes.resolve(phys, async ({ queueWaitMs, sinceMs = queueWaitMs }) => {
        let idDiagnostic = null;
        // sinceMs: tiempo real desde esta petición (cola y, si se reanuda tras una pausa, la pausa).
        // En una reanudación, el vuelo tal como lo publica Aena AHORA (puede haber aterrizado o cambiado de estado).
        const currentLeg = state.legs.find(l => l.al === leg.al && l.n === leg.n && l.d === leg.d && l.o === leg.o && l.a === leg.a) ?? leg;
        const identified = await identifyByZone({ leg: currentLeg, legs: state.legs, origin, dest, nowMs: now + sinceMs, fetchFn, coordsOf: coords,
          onDiagnostic: d => { idDiagnostic = { ...d, queueWaitMs, sinceMs }; } });
        const full = { ...base, identification: idDiagnostic, identifiedBy: idDiagnostic?.identifiedBy ?? null };
        state.radarDiagnostics.set(phys, full);
        if (identified.state === 'identificado') state.radarStats.identificationSucceeded++;
        else if (identified.state === 'ambiguo') state.radarStats.identificationAmbiguous++;
        else if (identified.state === 'no-disponible') state.radarStats.identificationUnavailable++;
        if (identified.rateLimited) state.radarStats.rateLimited++;
        return { ...identified, diagnostic: idDiagnostic };
      }, now).catch(() => {});
      if (hexes.busy(phys)) return { result, identifying: true };
    } else if (result.state === 'sin-datos' && gate?.mode === 'identify' && leg) {
      const reason = registryBefore?.cooldownRemainingMs ? 'cooldown-identidad' : !origin || !dest ? 'sin-coordenadas' : !leg.ac ? 'sin-tipo'
        : !operatorIcaos(leg, state.legs ?? []).length ? 'sin-operadora' : 'no-identificable';
      state.radarStats.blockedReasons[reason] = (state.radarStats.blockedReasons[reason] ?? 0) + 1;
      if (phys) state.radarDiagnostics.set(phys, { ...diagnostic(), identificationBlockedReason: reason });
    }
    // Resultado definitivo de esta consulta: se guarda 60 s (por ruta y por vuelo físico) para sondeos y códigos compartidos.
    const payload = { ...result, ...pending, checked: new Date(now).toISOString() };
    if (state.radar.size > 500) state.radar.clear();
    state.radar.set(pathname, { at: now, body: JSON.stringify(payload) });
    if (phys) state.radar.set(phys, { at: now, body: JSON.stringify(payload) });
    return { result, identifying: false };
  };
  if (!phys) {
    const out = await work(nowMs, { phase: 'direct' });
    return out.directRateLimited ? respond({ result: { state: 'no-disponible' } }) : respond(out);
  }
  // El trabajo vive en el servidor aunque el navegador que lo pidió abandone (timeout de 20 s): se guarda por phys y
  // termina solo. Si los indicativos exactos reciben un 429, queda en pausa ('pausa', temporal) y el propio servidor
  // lo repite al acabar la pausa de adsb.lol, como mucho DIRECT_RESUMES veces; los sondeos solo leen su estado.
  const firstReal = Date.now();
  const entry = { phase: known ? 'hex' : 'direct', resumeAt: null, resumes: 0, promise: null };
  const finish = out => { if (jobs.get(phys) === entry) jobs.delete(phys); return out; };
  const exec = async () => {
    const out = await work(nowMs + (Date.now() - firstReal), entry);
    if (!out.directRateLimited) return finish(out);
    if (entry.resumes >= DIRECT_RESUMES) return finish({ result: { state: 'no-disponible' } });
    entry.resumes++;
    entry.phase = 'pausa';
    entry.resumeAt = Math.max(adsbLimiter.blockedUntil + 2000, Date.now() + 5000);
    setTimeout(() => {
      entry.phase = 'direct';
      entry.resumeAt = null;
      entry.promise = exec().catch(() => finish({ result: { state: 'sin-datos' } }));
    }, entry.resumeAt - Date.now());
    return { result: { state: 'sin-datos' }, paused: true };
  };
  entry.promise = exec().catch(() => finish({ result: { state: 'sin-datos' } }));
  jobs.set(phys, entry);
  const out = await entry.promise;
  return out.paused ? working('pausa', entry.resumeAt) : respond(out);
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
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const send = r => { res.writeHead(r.status, r.headers); res.end(r.body); };
    if (path.startsWith('/radar/')) {
      radarResponse(state, `${path}${url.search}`, { airports }).then(send, () => send({ status: 200, headers: HEADERS, body: '{"state":"sin-datos"}' }));
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
