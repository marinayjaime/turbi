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

async function main() {
  const csv = await (await fetch(SRC)).text();
  const [headLine, ...lines] = csv.split('\n').filter(Boolean);
  const header = parseCSVLine(headLine);
  const db = {};
  for (const line of lines) {
    const entry = toEntry(parseCSVLine(line), header);
    if (entry) db[entry[0]] = entry[1];
  }
  const out = new URL('../data/airports.json', import.meta.url);
  await writeFile(out, JSON.stringify(db));
  console.log(`${Object.keys(db).length} aeropuertos → data/airports.json`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
