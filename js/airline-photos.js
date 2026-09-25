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

// leg.op = aerolínea que opera según Aena (solo si es segura). Si no lo es (código compartido), foto de la aerolínea
// del número buscado (al), marcada con shared para que la ficha diga que Aena no indica quién lo opera.
export function photoFor(db, leg, al = null) {
  const model = aircraftName(leg.ac);
  if (!db || !model) return null;
  if (leg.op) return db.photos?.[`${leg.op}|${model}`] ?? null;
  const p = al ? db.photos?.[`${al}|${model}`] : null;
  return p ? { ...p, shared: true } : null;
}

// al: código de la aerolínea buscada (los tramos publicados no lo llevan).
export function operatorName(db, leg, al = leg.al) {
  if (!leg.op || leg.op === al) return null;
  return db?.airlines?.[leg.op] ?? leg.op;
}
