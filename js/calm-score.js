// Calm Score: tranquilidad prevista durante TODO el tiempo en el aire (0-100).
// Índice orientativo propio: NO es una probabilidad, una medición de sacudidas ni EDR.
// Usa los puntos válidos del Turbi Index combinado, sin peticiones ni radar.
// Si menos del 95 % del trayecto tiene datos, no se publica una nota.
const MIN_COVERAGE = 0.95;
const TAIL_SHARE = 0.15;
const TAIL_MINUTES = 15;
const AVERAGE_WEIGHT = 0.7;

// Los valores 0-15 del Turbi Index no penalizan. Por encima, el impacto crece con la intensidad.
const discomfort = score => (Math.max(0, score - 15) / 85) ** 1.25;

export function computeCalmScore(points, durationMin) {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(durationMin) || durationMin <= 0) return null;
  const step = durationMin / (points.length - 1);
  const values = [];
  let validMinutes = 0;
  let exposure = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // Celda temporal centrada en cada punto: los extremos ocupan media celda.
    const minutes = step * (i === 0 || i === points.length - 1 ? 0.5 : 1);
    if (!p?.valid || !Number.isFinite(p.score) || p.score < 0 || p.score > 100) continue;
    const impact = discomfort(p.score);
    values.push({ minutes, impact });
    validMinutes += minutes;
    exposure += minutes * impact;
  }
  if (validMinutes / durationMin < MIN_COVERAGE - 1e-9) return null;

  // Pondera también la peor fracción temporal (mínimo 15 min), no el máximo aislado.
  // Así un episodio intenso cuenta más, sin dominar toda la nota de un vuelo largo.
  const tailMinutes = Math.min(validMinutes, Math.max(TAIL_MINUTES, TAIL_SHARE * durationMin));
  let remaining = tailMinutes;
  let tailExposure = 0;
  for (const { minutes, impact } of values.sort((a, b) => b.impact - a.impact)) {
    const taken = Math.min(minutes, remaining);
    tailExposure += taken * impact;
    remaining -= taken;
    if (remaining <= 1e-9) break;
  }
  const risk = AVERAGE_WEIGHT * exposure / validMinutes + (1 - AVERAGE_WEIGHT) * tailExposure / tailMinutes;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - risk))));
}
