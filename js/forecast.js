// Modelo de vista del pronóstico v2: une perfil, modelos, índice, confianza y resumen.
// Es serializable (JSON) para poder guardarlo y abrirlo sin conexión.
import { forecastRoute } from './models.js';
import { buildSegmentsV2, summarize, altitudeTable } from './summary.js';
import { computeConfidence } from './confidence.js';
import { summarizeMetar, summarizeTaf, sigmetsNearRoute, pirepsNearRoute } from './aviation-weather.js';
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
    route: profile.points.map((p, i) => ({ lat: p.lat, lon: p.lon, level: fc.points[i].valid ? fc.points[i].level : null })),
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

export function aviationView(av, view, nowMs) {
  if (!av.metar && !av.taf && !av.sigmet && !av.pirep) return null;
  return {
    updated: av.metar?.updated ?? av.sigmet?.updated ?? null,
    origin: airport(av, view.originIata, nowMs, view.originTz ?? 'UTC'),
    destination: airport(av, view.destinationIata, nowMs, view.destinationTz ?? 'UTC'),
    // null = archivo no disponible (distinto de «ninguno cerca»)
    sigmets: av.sigmet ? sigmetsNearRoute(av.sigmet.items, view.route, view.depMs, view.arrMs) : null,
    pireps: av.pirep ? pirepsNearRoute(av.pirep.items, view.route, nowMs) : null,
  };
}
