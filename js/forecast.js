// Modelo de vista del pronóstico v2: une perfil, modelos, índice, confianza y resumen.
// Es serializable (JSON) para poder guardarlo y abrirlo sin conexión.
import { forecastRoute } from './models.js';
import { buildSegmentsV2, summarize, altitudeTable } from './summary.js';
import { computeConfidence } from './confidence.js';
import { summarizeMetar, summarizeTaf, sigmetsNearRoute, pirepsNearRoute, sigmetLabel, sigmetLevels } from './aviation-weather.js';
import { flightPath, sigmetRelevance, sigmetMessage, sigmetsWithoutArea, sigmetLevelsFromText } from './sigmet-relevance.js';
import { agoText } from './storage.js';
import { sourceNote } from './adb.js';

const METAR_MAX_AGE_MS = 3 * 3600000;

export async function forecastView({ q, profile, flight, times, nowMs, fetchFn = fetch }) {
  const fc = await forecastRoute(profile, fetchFn);
  const segments = buildSegmentsV2(profile.points, fc.points);
  return {
    v: 2,
    flight,
    title: `${q.origin.iata} → ${q.destination.iata}`,
    subtitle: [q.number, q.airline, sourceNote(q)].filter(Boolean).join(' · ') || `${q.origin.city} → ${q.destination.city}`,
    sourceInfo: q.adbInfo ?? null,
    times,
    fromCity: q.origin.city,
    toCity: q.destination.city,
    originIata: q.origin.iata,
    destinationIata: q.destination.iata,
    durationMin: profile.durationMin,
    coverage: fc.coverage,
    summary: summarize(segments, profile.durationMin),
    confidence: computeConfidence({
      departureMs: profile.departureMs, nowMs, models: fc.models, agreement: fc.agreement, coverage: fc.coverage, points: fc.points,
    }),
    segments,
    altitudes: altitudeTable(profile.points, fc.points, profile.cruiseFL),
    models: fc.models,
    agreement: fc.agreement,
    queriedAt: nowMs,
    runs: {},
    // score: el Turbi Index combinado del punto (0–100), para el Calm Score (js/calm-score.js) dentro de cada nivel.
    route: profile.points.map((p, i) => ({ lat: p.lat, lon: p.lon, level: fc.points[i].valid ? fc.points[i].level : null,
      score: fc.points[i].valid ? fc.points[i].score : null })),
    depMs: profile.departureMs,
    arrMs: profile.arrivalMs,
  };
}

function airport(av, iata, nowMs, timeZone) {
  const icao = av.icao?.[iata] ?? null;
  const metar = icao ? av.metar?.items?.[icao] : null;
  const taf = icao ? av.taf?.items?.[icao] : null;
  // Un METAR viejo (p. ej. republicado porque NOAA falló) nunca se presenta como actual.
  const metarStale = Boolean(metar) && nowMs - metar.t > METAR_MAX_AGE_MS;
  return {
    iata, icao,
    metarText: metarStale ? null : summarizeMetar(metar ?? null),
    metarAge: metar && !metarStale ? agoText(nowMs - metar.t) : null,
    metarStale,
    metarRaw: metar?.raw ?? null,
    tafText: summarizeTaf(taf ?? null, timeZone), tafRaw: taf?.raw ?? null,
  };
}

// Los SIGMET que ya se mostraban (≤ 100 km de la ruta y vigentes durante el vuelo: sigmetsNearRoute, también los que
// dibuja el mapa), cada uno con su relevancia para ESTE vuelo (lugar + altitud + hora de paso: js/sigmet-relevance.js)
// y su texto. Aparte, los que no traen zona y son de la región del origen o del destino.
function classifiedSigmets(av, view) {
  if (!av.sigmet) return { sigmets: null, sigmetsNoArea: null };
  const path = flightPath(view);
  const cities = { from: view.fromCity ?? null, to: view.toCity ?? null };
  const sigmets = sigmetsNearRoute(av.sigmet.items, view.route, view.depMs, view.arrMs).map(s => {
    const relevance = sigmetRelevance(s, path);
    // Sin niveles en los campos pero sí en el texto del aviso: también en el detalle («hasta 1,8 km de altura»).
    const text = !s.levels ? sigmetLevelsFromText(s.raw) : null;
    const levels = text ? sigmetLevels({ base: text.base || null, top: Number.isFinite(text.top) ? text.top : null }) : s.levels;
    return { ...s, levels, relevance, message: sigmetMessage(s, relevance, cities) };
  });
  const sigmetsNoArea = sigmetsWithoutArea(av.sigmet.items, { originIcao: av.icao?.[view.originIata] ?? null,
    destinationIcao: av.icao?.[view.destinationIata] ?? null, depMs: view.depMs, arrMs: view.arrMs })
    .map(s => ({ ...s, label: sigmetLabel(s), levels: sigmetLevels(s), message: sigmetMessage(s, s.relevance, cities) }));
  return { sigmets, sigmetsNoArea };
}

export function aviationView(av, view, nowMs) {
  if (!av.metar && !av.taf && !av.sigmet && !av.pirep) return null;
  return {
    updated: av.metar?.updated ?? av.sigmet?.updated ?? null,
    origin: airport(av, view.originIata, nowMs, view.originTz ?? 'UTC'),
    destination: airport(av, view.destinationIata, nowMs, view.destinationTz ?? 'UTC'),
    // null = archivo no disponible (distinto de «ninguno cerca»)
    ...classifiedSigmets(av, view),
    pireps: av.pirep ? pirepsNearRoute(av.pirep.items, view.route, nowMs) : null,
  };
}
