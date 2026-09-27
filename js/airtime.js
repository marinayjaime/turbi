// Tiempo EN EL AIRE para el pronóstico de turbulencias. Los horarios oficiales (Aena, AeroDataBox) son de BLOQUE
// (calzos fuera → calzos dentro: incluyen rodaje, espera y aproximación en tierra); el perfil meteorológico (puntos,
// fases, FL y la hora de cada punto) debe cubrir solo el vuelo: despegue → aterrizaje. La ficha, la ETA, el radar, la
// puntualidad y los avisos siguen usando las horas de bloque: esto SOLO alimenta el pronóstico.
//
// Conceptos:
//   blockDepartureMs / blockArrivalMs / blockDurationMin   → horario operativo (oficial o, si falta, estimado).
//   forecastTakeoffMs / forecastAirborneMin / forecastLandingMs → ventana en el aire usada por la meteorología.

// ── Física del vuelo (HEURÍSTICAS, compartidas con js/eta.js; no son valores demostrados) ──────────────────────
export const PLAN_KMH = 800; // velocidad de crucero supuesta (la misma que route.js)
export const DESCENT_KM = 150; // los últimos ~150 km son descenso y aproximación
export const DESCENT_MIN = 23; // …que llevan unos 23 min, con tráfico
export const ROUTE_FACTOR = 1.05; // la ruta real es algo más larga que la línea recta

// Minutos de vuelo para una distancia: crucero hasta el inicio del descenso + descenso y aproximación. js/eta.js usa la
// misma función para el tiempo restante en vuelo (con la velocidad medida por el radar si sirve).
export function airMinutesForKm(km, kmh = PLAN_KMH) {
  return Math.max(0, km * ROUTE_FACTOR - DESCENT_KM) / kmh * 60 + DESCENT_MIN;
}

// ── Encaje en el horario de bloque (HEURÍSTICAS) ────────────────────────────────────────────────────────────────
export const MIN_GROUND_MIN = 10; // rodaje total mínimo (salida + llegada) que se deja siempre dentro del bloque
export const MIN_BLOCK_AIR_SHARE = 0.6; // en bloques muy cortos, el aire nunca baja del 60 % del bloque
export const MIN_AIR_MIN = 10;

// Ventana en el aire del pronóstico.
//  - Pista de salida y de llegada (AeroDataBox): despegue y aterrizaje reales; la duración es su diferencia.
//  - Solo pista de salida: despegue real; aire estimado, sin pasar de la llegada de bloque si se conoce.
//  - Sin pista (Aena, o AeroDataBox antes de despegar): aire estimado por la distancia, limitado por el bloque:
//      aire = min(estimado, max(bloque − MIN_GROUND_MIN, bloque × MIN_BLOCK_AIR_SHARE))
//    y el tiempo de tierra que sobra (bloque − aire) se reparte a partes iguales antes del despegue y después del
//    aterrizaje (no hay datos de rodaje por aeropuerto en Turbi que justifiquen otro reparto).
// blockArrivalMs puede ser una estimación (sin llegada oficial): el encaje es el mismo.
export function forecastWindow({ km, blockDepartureMs, blockArrivalMs, runwayDepartureMs = null, runwayArrivalMs = null }) {
  const blockDurationMin = (blockArrivalMs - blockDepartureMs) / 60000;
  const estimated = Math.round(airMinutesForKm(km)); // minutos enteros: los tramos del pronóstico se muestran en minutos
  const out = (takeoff, air, source) => ({
    blockDepartureMs, blockArrivalMs, blockDurationMin,
    forecastTakeoffMs: takeoff, forecastAirborneMin: air, forecastLandingMs: takeoff + air * 60000, source,
  });
  if (Number.isFinite(runwayDepartureMs) && Number.isFinite(runwayArrivalMs) && runwayArrivalMs > runwayDepartureMs) {
    return out(runwayDepartureMs, Math.round((runwayArrivalMs - runwayDepartureMs) / 60000), 'pista');
  }
  if (Number.isFinite(runwayDepartureMs)) {
    const untilBlock = Number.isFinite(blockArrivalMs) ? (blockArrivalMs - runwayDepartureMs) / 60000 : Infinity;
    return out(runwayDepartureMs, Math.max(MIN_AIR_MIN, Math.round(Math.min(estimated, untilBlock))), 'pista-salida');
  }
  const air = Math.max(MIN_AIR_MIN, Math.round(Math.min(estimated, Math.max(blockDurationMin - MIN_GROUND_MIN, blockDurationMin * MIN_BLOCK_AIR_SHARE))));
  const ground = Math.max(0, blockDurationMin - air);
  return out(blockDepartureMs + (ground / 2) * 60000, air, 'estimada');
}
