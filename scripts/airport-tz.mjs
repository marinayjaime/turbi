// Zona horaria IANA de cada aeropuerto, calculada LOCALMENTE (sin red) con geo-tz a partir de su latitud y longitud,
// al generar data/airports.json. La app no pide zonas horarias a nadie: Intl.DateTimeFormat hace verano/invierno.
// Se usa el conjunto completo de zonas (geo-tz/all): el por defecto fusiona las que coinciden desde 1970 y daría,
// p. ej., Europe/London para Dublín.
// Resultado ambiguo (varias zonas) o no aceptado por Intl → null y se registra para revisión (nunca se elige solo).
// Uso: node scripts/airport-tz.mjs   → añade la zona a data/airports.json y escribe data/airports-tz-review.json
import { readFileSync, writeFileSync } from 'node:fs';

const validIana = tz => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

// db: { IATA: [nombre, ciudad, lat, lon, (tz)] } · find(lat, lon) → [zonas]. Devuelve { db, review }.
export function resolveTimezones(db, find) {
  const out = {}, review = [];
  for (const [iata, [name, city, lat, lon]] of Object.entries(db)) {
    const zones = find(lat, lon);
    let tz = null;
    if (zones.length === 1 && validIana(zones[0])) tz = zones[0];
    else review.push({ iata, candidates: zones, reason: zones.length === 0 ? 'sin zona' : zones.length > 1 ? 'ambiguo' : 'no válida para Intl' });
    out[iata] = [name, city, lat, lon, tz];
  }
  return { db: out, review };
}

if (process.argv[1]?.endsWith('airport-tz.mjs')) {
  const { find } = await import('geo-tz/all');
  const path = 'data/airports.json';
  const { db, review } = resolveTimezones(JSON.parse(readFileSync(path, 'utf8')), find);
  writeFileSync(path, JSON.stringify(db));
  writeFileSync('data/airports-tz-review.json', `${JSON.stringify(review, null, 1)}\n`);
  console.log(`Zonas horarias: ${Object.keys(db).length - review.length} resueltas, ${review.length} para revisar (data/airports-tz-review.json)`);
}
