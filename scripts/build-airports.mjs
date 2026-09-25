// Genera data/airports.json desde OurAirports (dominio público).
// Uso: npm run airports
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SRC = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

export function parseCSVLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const round4 = x => Math.round(Number(x) * 1e4) / 1e4;

export function toEntry(row, header) {
  const get = k => row[header.indexOf(k)];
  const iata = get('iata_code');
  if (!/^[A-Z]{3}$/.test(iata ?? '')) return null;
  if (!['large_airport', 'medium_airport'].includes(get('type'))) return null;
  if (get('scheduled_service') !== 'yes') return null;
  return [iata, [get('name'), get('municipality'), round4(get('latitude_deg')), round4(get('longitude_deg'))]];
}

// IATA → OACI (para METAR/TAF). Mismo filtro que toEntry.
export function toIcao(row, header) {
  const entry = toEntry(row, header);
  if (!entry) return null;
  const get = k => row[header.indexOf(k)];
  const icao = [get('icao_code'), get('gps_code')].find(c => /^[A-Z]{4}$/.test(c ?? ''));
  return icao ? [entry[0], icao] : null;
}

async function main() {
  const csv = await (await fetch(SRC)).text();
  const [headLine, ...lines] = csv.split('\n').filter(Boolean);
  const header = parseCSVLine(headLine);
  const db = {};
  const icao = {};
  for (const line of lines) {
    const row = parseCSVLine(line);
    const entry = toEntry(row, header);
    if (entry) db[entry[0]] = entry[1];
    const code = toIcao(row, header);
    if (code) icao[code[0]] = code[1];
  }
  // Zona horaria IANA de cada aeropuerto, local (geo-tz), sin ninguna consulta en tiempo de ejecución.
  const { find } = await import('geo-tz/all');
  const { resolveTimezones, assertResolved } = await import('./airport-tz.mjs');
  const tz = resolveTimezones(db, find);
  assertResolved(tz); // sin zona para algún aeropuerto no se publica nada
  await writeFile(new URL('../data/airports-tz-review.json', import.meta.url), `${JSON.stringify(tz.review, null, 1)}\n`);
  console.log(`Zonas horarias: todas resueltas; ${tz.review.length} ambiguas por regla revisada (data/airports-tz-review.json)`);
  await writeFile(new URL('../data/airports.json', import.meta.url), JSON.stringify(tz.db));
  await writeFile(new URL('../data/icao.json', import.meta.url), JSON.stringify(icao));
  console.log(`${Object.keys(db).length} aeropuertos → data/airports.json, ${Object.keys(icao).length} códigos OACI → data/icao.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
