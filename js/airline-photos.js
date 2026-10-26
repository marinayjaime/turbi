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

// Prioridad:
//  1. operadora segura según Aena (leg.op) + modelo exacto;
//  2. aerolínea del número buscado (al) + modelo exacto, marcada shared (Aena no dice quién opera);
//  3. si no hay modelo (p. ej. vuelo del histórico) o no hay foto de ese modelo: una foto verificada de esa misma
//     aerolínea, marcada representative («Imagen representativa de la aerolínea»: ni el avión ni el modelo del vuelo).
// leg.model: el modelo ya con el nombre de Turbi (fichas de AeroDataBox, que no traen código de avión; ver adbModel).
export function photoFor(db, leg, al = null) {
  if (!db?.photos) return null;
  const model = leg.model ?? (leg.ac ? aircraftName(leg.ac) : null);
  const airline = leg.op ?? al;
  const shared = leg.op ? {} : { shared: true };
  const exact = model && airline ? db.photos[`${airline}|${model}`] : null;
  if (exact) return { ...exact, ...shared };
  const generic = airline && Object.keys(db.photos).find(k => k.startsWith(`${airline}|`) && db.photos[k]);
  return generic ? { ...db.photos[generic], representative: true, ...shared } : null;
}

// Modelo de AeroDataBox (texto del fabricante, p. ej. «Airbus A320 NEO» o «Boeing 737-8AS») con el nombre de Turbi, sin
// adivinar: solo «NEO» → «neo», el código de cliente de Boeing (737-8AS = 737-800) y el AW139. Un nombre genérico como
// «Airbus A330» se queda tal cual y, al no ser ningún modelo concreto, solo puede dar la foto representativa.
export function adbModel(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const neo = t.match(/^Airbus (A3[12]\d) NEO$/i);
  if (neo) return `Airbus ${neo[1].toUpperCase()}neo`;
  const boeing = t.match(/^Boeing 737-([6789])[0-9A-Z]{2}$/);
  if (boeing) return `Boeing 737-${boeing[1]}00`;
  if (/^(Agusta ?Westland|Leonardo) AW139$/i.test(t)) return 'Helicóptero AW139';
  return t;
}

// al: código de la aerolínea buscada (los tramos publicados no lo llevan).
export function operatorName(db, leg, al = leg.al) {
  if (!leg.op || leg.op === al) return null;
  return db?.airlines?.[leg.op] ?? leg.op;
}
