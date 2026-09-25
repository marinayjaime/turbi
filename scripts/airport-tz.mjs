// Zona horaria IANA de cada aeropuerto, calculada LOCALMENTE (sin red) con geo-tz a partir de su latitud y longitud,
// al generar data/airports.json. La app no pide zonas horarias a nadie: Intl.DateTimeFormat hace verano/invierno.
// Se usa el conjunto completo de zonas (geo-tz/all): el por defecto fusiona las que coinciden desde 1970 y daría,
// p. ej., Europe/London para Dublín.
// Resultado ambiguo (varias zonas): solo se resuelve si hay una regla revisada para ESE par de candidatas (TZ_RULES,
// con su fuente); nunca se elige una sola ni por aeropuerto. Sin regla, sin zona o no válida para Intl → la generación
// se detiene: la app publicada tiene siempre una zona para cada aeropuerto y nunca la pide a Open-Meteo.
// Los casos resueltos por regla quedan registrados en data/airports-tz-review.json.
// Uso: node scripts/airport-tz.mjs   → añade la zona a data/airports.json y escribe data/airports-tz-review.json
import { readFileSync, writeFileSync } from 'node:fs';

const validIana = tz => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

// Reglas revisadas para zonas ambiguas, por par de candidatas (en cualquier orden).
export const TZ_RULES = [
  { candidates: ['Asia/Shanghai', 'Asia/Urumqi'], tz: 'Asia/Shanghai',
    reason: 'Xinjiang: la aviación funciona con la hora de Pekín (tzdb: «All planes, trains, and schools function on Beijing time»); Asia/Urumqi es la hora local de Xinjiang, de uso civil',
    source: 'https://github.com/eggert/tz/blob/main/asia' },
  { candidates: ['Asia/Tbilisi', 'Europe/Moscow'], tz: 'Europe/Moscow',
    reason: 'Abjasia (Sujumi): el aeropuerto opera con la hora de Moscú (UTC+3); solo tiene vuelos de aerolíneas rusas',
    source: 'https://en.wikipedia.org/wiki/Sukhum_International_Airport' },
];
const sameSet = (a, b) => a.length === b.length && a.every(z => b.includes(z));

// db: { IATA: [nombre, ciudad, lat, lon, (tz)] } · find(lat, lon) → [zonas]. Devuelve { db, review, unresolved }.
export function resolveTimezones(db, find, rules = TZ_RULES) {
  const out = {}, review = [], unresolved = [];
  for (const [iata, [name, city, lat, lon]] of Object.entries(db)) {
    const zones = find(lat, lon);
    let tz = null;
    if (zones.length === 1) {
      if (validIana(zones[0])) tz = zones[0];
      else unresolved.push({ iata, candidates: zones, reason: 'no válida para Intl' });
    } else if (zones.length === 0) {
      unresolved.push({ iata, candidates: zones, reason: 'sin zona' });
    } else {
      const rule = rules.find(r => sameSet(r.candidates, zones));
      if (rule && validIana(rule.tz)) {
        tz = rule.tz;
        review.push({ iata, candidates: zones, tz, rule: rule.reason });
      } else unresolved.push({ iata, candidates: zones, reason: 'ambiguo sin regla' });
    }
    out[iata] = [name, city, lat, lon, tz];
  }
  return { db: out, review, unresolved };
}

// Para los scripts de generación: sin zona para algún aeropuerto no se escribe nada.
export function assertResolved({ unresolved }) {
  if (unresolved.length) {
    throw new Error(`Zonas horarias sin resolver (añade una regla revisada en TZ_RULES): ${unresolved.map(u => `${u.iata} ${u.reason} [${u.candidates.join(' | ')}]`).join('; ')}`);
  }
}

if (process.argv[1]?.endsWith('airport-tz.mjs')) {
  const { find } = await import('geo-tz/all');
  const path = 'data/airports.json';
  const res = resolveTimezones(JSON.parse(readFileSync(path, 'utf8')), find);
  assertResolved(res);
  const { db, review } = res;
  writeFileSync(path, JSON.stringify(db));
  writeFileSync('data/airports-tz-review.json', `${JSON.stringify(review, null, 1)}\n`);
  console.log(`Zonas horarias: ${Object.keys(db).length} resueltas; ${review.length} ambiguas resueltas por regla (data/airports-tz-review.json)`);
}
