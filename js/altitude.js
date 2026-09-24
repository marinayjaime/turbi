// Perfil vertical aproximado del vuelo y correspondencia presión ↔ nivel de vuelo.
// Lógica y justificación: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §1
import { distanceKm, intermediatePoint } from './route.js';

const CLIMB_FL_PER_MIN = 20; // 2000 ft/min
const DESCENT_FL_PER_MIN = 15; // 1500 ft/min

// Nivel de vuelo (centenas de pies) de una superficie de presión en atmósfera estándar (ISA).
export function pressureToFL(hPa) {
  const ft = hPa >= 226.32
    ? 145366.45 * (1 - (hPa / 1013.25) ** 0.190284)
    : 36089.24 + 20805.8 * Math.log(226.321 / hPa);
  return ft / 100;
}

// Capas comunes a ECMWF y GFS (350 hPa solo existe en GFS).
export const LAYERS = [[400, 300], [300, 250], [250, 200], [200, 150]].map(([bottom, top]) => ({
  bottom, top, midFL: (pressureToFL(bottom) + pressureToFL(top)) / 2,
}));
export const PRESSURE_LEVELS = [400, 300, 250, 200, 150];

export function cruiseFL(km) {
  const ceiling = km < 1000 ? 360 : km < 3000 ? 370 : 380;
  return Math.min(ceiling, Math.max(150, Math.round((1.2 * km) / 10) * 10));
}

export function flightLevelAt(min, durationMin, cruise) {
  return Math.max(0, Math.min(cruise, min * CLIMB_FL_PER_MIN, (durationMin - min) * DESCENT_FL_PER_MIN));
}

export function phaseAt(min, durationMin, cruise) {
  if (flightLevelAt(min, durationMin, cruise) >= cruise) return 'cruise';
  return min * CLIMB_FL_PER_MIN <= (durationMin - min) * DESCENT_FL_PER_MIN ? 'climb' : 'descent';
}

// Ruta con un punto cada ~60 km (entre 8 y 30), cada uno con su hora, fase y nivel de vuelo.
export function buildProfile(origin, destination, departureMs, durationMin = null) {
  const km = distanceKm(origin, destination);
  if (km < 1) throw new Error('Origen y destino son el mismo aeropuerto');
  if (!(durationMin > 0)) durationMin = Math.round(km / 800 * 60 + 30);
  const cruise = cruiseFL(km);
  const n = Math.min(30, Math.max(8, Math.round(km / 60) + 1));

  const points = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const min = f * durationMin;
    const pos = i === 0 ? { lat: origin.lat, lon: origin.lon }
      : i === n - 1 ? { lat: destination.lat, lon: destination.lon }
      : intermediatePoint(origin, destination, f);
    points.push({
      ...pos, min, time: departureMs + min * 60000, kmFromOrigin: f * km,
      fl: flightLevelAt(min, durationMin, cruise), phase: phaseAt(min, durationMin, cruise),
    });
  }
  return { km, durationMin, cruiseFL: cruise, departureMs, arrivalMs: departureMs + durationMin * 60000, points };
}
