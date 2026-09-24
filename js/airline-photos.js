// Fotos reales por aerolínea operadora y modelo (data/airline-photos.json, revisadas a mano: scripts/fetch-airline-photos.mjs).
// Nunca se muestra una foto de otra aerolínea ni «de ejemplo»: si no hay foto de esa combinación, no hay foto.
import { aircraftName } from './plain.js';

let cache = null;

export async function loadAirlinePhotos(fetchFn = fetch) {
  try {
    cache ??= fetchFn('data/airline-photos.json').then(r => (r.ok ? r.json() : null));
    return (await cache) ?? null;
  } catch {
    cache = null;
    return null;
  }
}

// leg.op = aerolínea que opera según Aena (solo si es segura).
export function photoFor(db, leg) {
  const model = aircraftName(leg.ac);
  if (!db || !leg.op || !model) return null;
  return db.photos?.[`${leg.op}|${model}`] ?? null;
}

export function operatorName(db, leg) {
  if (!leg.op || leg.op === leg.al) return null;
  return db?.airlines?.[leg.op] ?? leg.op;
}
