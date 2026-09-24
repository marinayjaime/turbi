const R_KM = 6371;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Punto a fracción f (0..1) del círculo máximo entre a y b.
function intermediatePoint(a, b, f) {
  const φ1 = toRad(a.lat), λ1 = toRad(a.lon), φ2 = toRad(b.lat), λ2 = toRad(b.lon);
  const δ = distanceKm(a, b) / R_KM;
  const A = Math.sin((1 - f) * δ) / Math.sin(δ);
  const B = Math.sin(f * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
}

export function buildRoute(origin, destination, departureMs) {
  const km = distanceKm(origin, destination);
  if (km < 1) throw new Error('Origen y destino son el mismo aeropuerto');

  const durationMin = Math.round(km / 800 * 60 + 30);
  const n = Math.max(10, Math.round(km / 50) + 1);
  const climbMin = durationMin < 60 ? durationMin * 0.4 : 20;
  const descentMin = durationMin < 60 ? durationMin * 0.4 : 25;

  const points = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const min = f * durationMin;
    const pos = i === 0 ? { lat: origin.lat, lon: origin.lon }
      : i === n - 1 ? { lat: destination.lat, lon: destination.lon }
      : intermediatePoint(origin, destination, f);
    const phase = min < climbMin ? 'climb'
      : min > durationMin - descentMin ? 'descent'
      : 'cruise';
    points.push({ ...pos, min, time: departureMs + min * 60000, phase, kmFromOrigin: f * km });
  }

  return { km, durationMin, departureMs, arrivalMs: departureMs + durationMin * 60000, points };
}
