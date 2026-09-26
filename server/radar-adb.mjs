// Radar (ADS-B, adsb.lol) para vuelos que Aena no publica y que AeroDataBox ha encontrado. Principio: falso negativo
// antes que avión incorrecto. Nunca consulta AeroDataBox (lee su caché con peek) y nunca identifica por zona ni por ruta.
//
// Orden de identificación:
//   1. Transpondedor (modeS de AeroDataBox, o el hex ya aceptado antes por indicativo): /v2/hex/{hex}.
//      Se acepta solo si está en el aire (o aterrizado en el destino), sin contradicción física, con la misma matrícula
//      si ambas fuentes la dan y con el mismo indicativo si ambas lo dan; si falta el indicativo en alguna, además
//      tiene que ser compatible con el corredor origen → destino.
//   2. Solo si ese transpondedor NO aparece (no si la consulta falla o hay pausa por 429) y hay indicativo: UNA consulta
//      /v2/callsign/{callSign}. Vale el único avión en el aire compatible con el corredor (aunque sea el único
//      resultado); con 0 o varios, nada. Si trae otro transpondedor, se acepta como cambio de avión y se recuerda.
//   3. Sin transpondedor ni indicativo: 0 consultas, sin radar.
// Todas las consultas pasan por el limitador global de server/adsb.mjs (prioridad de radar).
import { adsbGet, adsbLimiter } from './adsb.mjs';
import { airborne, landedAt, flyingResult, distanceKm, plannedMinFor } from './radar.mjs';
import { corridor, LIMITS } from './identify.mjs';
import { adbPhysicalKey, adbRadarGate } from '../js/adb.js';

const RADAR_CACHE_MS = 60000;
const ADB_RADAR_PATH = /^\/radar-adb\/([A-Z0-9]{2,3}\d{1,4}[A-Z]?)\/(\d{4}-\d{2}-\d{2})\.json$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };

const cleanCs = a => a?.flight?.trim().toUpperCase() || null;
const cleanReg = r => String(r ?? '').replace(/[\s-]/g, '').toUpperCase() || null;
const bestDepMs = leg => (leg.dep.runway ?? leg.dep.revised ?? leg.dep.sched).utc;

// Validación de un avión visto por su transpondedor. → { ok: resultado } | { reject: motivo } | { none: motivo }
export function checkByHex(a, { expectedCs, reg, origin, dest, nowMs, depMs, limits = LIMITS }) {
  const cs = cleanCs(a);
  if (reg && a.r && cleanReg(a.r) !== cleanReg(reg)) return { reject: 'matricula' };
  if (a.alt_baro === 'ground') {
    const pos = Number.isFinite(a.lat) && Number.isFinite(a.lon) ? [a.lat, a.lon] : null;
    if (pos && distanceKm(pos, dest) > limits.groundAirportKm && distanceKm(pos, origin) > limits.groundAirportKm) return { reject: 'contradiccion' };
    if (cs && expectedCs && cs !== expectedCs) return { reject: 'indicativo' };
    const landed = landedAt(a, expectedCs ?? cs ?? '', { dest, origin, depMs, nowMs, byHex: true });
    return landed ? { ok: { ...landed, callsign: expectedCs ?? cs, hex: a.hex } } : { none: 'en-tierra' };
  }
  if (!airborne(a) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return { none: 'sin-posicion' };
  const c = corridor({ origin, dest, lat: a.lat, lon: a.lon, track: a.track, elapsedMin: (nowMs - depMs) / 60000 }, limits);
  if (c.reason === 'demasiado-lejos' || Math.abs(c.crossKm) > limits.contradictionCrossKm) return { reject: 'contradiccion' };
  if (cs && expectedCs) {
    if (cs !== expectedCs) return { reject: 'indicativo' }; // el avión está haciendo otro vuelo
  } else if (!c.ok) return { reject: `corredor-${c.reason}` }; // sin indicativo que comparar: corredor completo
  return { ok: { ...flyingResult(a, cs ?? expectedCs, dest), hex: a.hex, match: 'transpondedor' } };
}

// → { result, learned: { hex, callsign } | null, forget: bool, requests, strategy, reason }
export async function findAdbOnRadar({ leg, known = null, origin, dest, nowMs = Date.now(), fetchFn = fetch, limiter = adsbLimiter, limits = LIMITS }) {
  let requests = 0;
  const get = async path => { requests++; return adsbGet(path, { fetchFn, limiter }); };
  const depMs = bestDepMs(leg);
  const ctx = { origin, dest, nowMs, depMs, limits };
  const out = (result, extra = {}) => ({ result, learned: null, forget: false, requests, ...extra });
  const hex = known?.hex ?? leg.modeS;
  const cs = known?.callsign ?? leg.callSign;
  if (!hex && !cs) return out({ state: 'no-aplica' }, { strategy: 'ninguna', reason: 'sin-identificador' });

  if (hex) {
    const res = await get(`/hex/${hex}`);
    if (res.error) return out({ state: 'no-disponible' }, { strategy: 'transpondedor', reason: res.error }); // 429 o fallo: sin plan B ahora
    const a = (res.data?.ac ?? []).find(x => String(x.hex).toLowerCase() === hex);
    if (a) {
      const v = checkByHex(a, { ...ctx, expectedCs: cs, reg: known ? null : leg.reg });
      if (v.ok) return out(v.ok, { strategy: 'transpondedor' });
      // Visto pero no vale (otro vuelo, otra matrícula, contradicción…): no se busca otro avión.
      return out({ state: 'sin-datos' }, { strategy: 'transpondedor', reason: v.reject ?? v.none, forget: Boolean(known && v.reject) });
    }
    if (!cs) return out({ state: 'sin-datos' }, { strategy: 'transpondedor', reason: 'no-aparece' });
  }

  // Indicativo: una sola consulta (también como plan B cuando el transpondedor no aparece).
  const res = await get(`/callsign/${cs}`);
  const strategy = hex ? 'transpondedor+indicativo' : 'indicativo';
  if (res.error) return out({ state: 'no-disponible' }, { strategy, reason: res.error });
  const ac = (res.data?.ac ?? []).filter(x => cleanCs(x) === cs);
  const compatible = ac.filter(x => airborne(x) && Number.isFinite(x.lat) && Number.isFinite(x.lon)
    && corridor({ origin, dest, lat: x.lat, lon: x.lon, track: x.track, elapsedMin: (nowMs - depMs) / 60000 }, limits).ok);
  if (compatible.length === 1) {
    const a = compatible[0];
    const swapped = Boolean(leg.modeS && a.hex && String(a.hex).toLowerCase() !== leg.modeS);
    return out({ ...flyingResult(a, cs, dest), hex: a.hex, match: 'indicativo', ...(swapped ? { aircraftChanged: true } : {}) },
      { strategy, learned: a.hex ? { hex: String(a.hex).toLowerCase(), callsign: cs } : null });
  }
  const landed = ac.map(x => landedAt(x, cs, { dest, origin, depMs, nowMs })).find(Boolean);
  if (!compatible.length && landed) return out(landed, { strategy });
  return out({ state: 'sin-datos' }, { strategy, reason: compatible.length > 1 ? 'ambiguo' : ac.length ? 'fuera-del-corredor' : 'no-aparece' });
}

// GET /radar-adb/{número}/{fecha}.json?leg=<adbPhysicalKey>[&poll=1][&debug=1]
export async function adbRadarResponse(state, path, { fetchFn = fetch, nowMs = Date.now(), airports = {}, limiter = adsbLimiter } = {}) {
  const url = new URL(path, 'http://turbi.local');
  const m = url.pathname.match(ADB_RADAR_PATH);
  if (!m) return { status: 404, headers: HEADERS, body: '{"error":"no encontrado"}' };
  const legParam = url.searchParams.get('leg');
  const pollOnly = url.searchParams.get('poll') === '1';
  const debug = url.searchParams.get('debug') === '1';
  const stats = (state.radarStats ??= {}).adb ??= { requests: 0, cacheHits: 0, adsbRequests: 0, found: 0, landed: 0, notFound: 0, unavailable: 0, reasons: {} };
  stats.requests++;
  const noStore = { ...HEADERS, 'Cache-Control': 'no-store' };
  const send = (payload, headers = HEADERS) => ({ status: 200, headers, body: JSON.stringify({ ...payload, checked: new Date(nowMs).toISOString() }) });
  const notApplicable = reason => { stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1; return send({ state: 'no-aplica', ...(debug ? { reason } : {}) }, noStore); };

  const entry = state.adb ? await state.adb.peek(m[1], m[2]) : null; // solo caché: 0 unidades de AeroDataBox
  if (entry?.status !== 'found') return notApplicable('sin-horario-aerodatabox');
  const legs = entry.legs ?? [];
  const leg = legParam !== null ? legs.find(l => adbPhysicalKey(entry, l) === legParam) : legs.length === 1 ? legs[0] : null;
  if (!leg) return notApplicable(legParam !== null ? 'tramo-desconocido' : 'varios-tramos-sin-elegir');
  const coords = iata => (airports[iata] ? [airports[iata][2], airports[iata][3]] : null);
  const origin = coords(leg.o), dest = coords(leg.a);
  if (!origin || !dest || distanceKm(origin, dest) < 1) return notApplicable('sin-coordenadas');
  const gate = adbRadarGate(leg, entry, nowMs, { plannedMin: plannedMinFor(origin, dest) });
  if (gate.mode === 'none') return notApplicable(gate.reason);
  const pending = gate.confirmed ? {} : { departureConfirmed: false };

  const phys = adbPhysicalKey(entry, leg);
  const cached = state.radar?.get(phys);
  if (cached && nowMs - cached.at < RADAR_CACHE_MS) { stats.cacheHits++; return { status: 200, headers: HEADERS, body: cached.body }; }
  if (pollOnly) return send({ state: 'sin-datos', ...pending }, noStore); // un sondeo nunca consulta ADS-B
  const jobs = state.adbRadarJobs ??= new Map();
  if (!jobs.has(phys)) {
    jobs.set(phys, (async () => {
      const hexes = state.adbHexes ??= new Map();
      const r = await findAdbOnRadar({ leg, known: hexes.get(phys) ?? null, origin, dest, nowMs, fetchFn, limiter });
      stats.adsbRequests += r.requests;
      if (r.learned) hexes.set(phys, r.learned);
      if (r.forget) hexes.delete(phys);
      const key = r.result.state === 'volando' ? 'found' : r.result.state === 'aterrizado' ? 'landed' : r.result.state === 'no-disponible' ? 'unavailable' : 'notFound';
      stats[key]++;
      if (r.reason) stats.reasons[r.reason] = (stats.reasons[r.reason] ?? 0) + 1;
      const payload = { ...r.result, ...pending, checked: new Date(nowMs).toISOString(), ...(debug ? { diagnostic: { gate: gate.reason, strategy: r.strategy, reason: r.reason ?? null, requests: r.requests } } : {}) };
      const body = JSON.stringify(payload);
      if (r.result.state !== 'no-disponible') (state.radar ??= new Map()).set(phys, { at: nowMs, body: debug ? JSON.stringify({ ...payload, diagnostic: undefined }) : body });
      return { status: 200, headers: r.result.state === 'no-disponible' ? noStore : HEADERS, body };
    })().finally(() => jobs.delete(phys)));
  }
  return jobs.get(phys);
}
