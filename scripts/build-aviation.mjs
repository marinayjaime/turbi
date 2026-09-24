// Descarga METAR, TAF, SIGMET y PIREP de Aviation Weather (NOAA) para publicarlos junto a la app.
// La API no admite CORS, así que se hace aquí (GitHub Actions) una vez por hora, con pocas peticiones.
// Uso de la API: https://aviationweather.gov/data/api/ (sin clave, máx. 100 peticiones/min, User-Agent propio).
import { mkdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseCSVLine } from './build-airports.mjs';

const API = 'https://aviationweather.gov/api/data';
const CACHE_PIREP = 'https://aviationweather.gov/data/cache/aircraftreports.cache.csv.gz';
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const HAZARDS = ['TURB', 'TS', 'MTW', 'TC'];
const BBOX = { minLat: 20, maxLat: 75, minLon: -70, maxLon: 45 }; // Europa + Atlántico Norte

export function compactMetar(m) {
  return {
    raw: m.rawOb, t: m.obsTime * 1000, wdir: m.wdir ?? null, wspd: m.wspd ?? null, wgst: m.wgst ?? null,
    visib: m.visib ?? null, clouds: (m.clouds ?? []).map(c => ({ cover: c.cover, base: c.base ?? null })),
    wx: m.wxString ?? '', temp: m.temp ?? null, fltCat: m.fltCat ?? null,
  };
}

export function compactTaf(t) {
  return {
    raw: t.rawTAF, issue: Date.parse(t.issueTime),
    fcsts: (t.fcsts ?? []).map(f => ({
      from: f.timeFrom, to: f.timeTo, change: f.fcstChange ?? null, prob: f.probability ?? null,
      wspd: f.wspd ?? null, wgst: f.wgst ?? null, visib: f.visib ?? null, wx: f.wxString ?? '',
    })),
  };
}

export function compactSigmets(list) {
  return list.filter(s => HAZARDS.includes(s.hazard)).map(s => ({
    hazard: s.hazard, qualifier: s.qualifier ?? null, base: s.base ?? null, top: s.top ?? null,
    validFrom: s.validTimeFrom, validTo: s.validTimeTo, coords: s.coords ?? [], raw: s.rawSigmet, fir: s.firName,
  }));
}

// CSV de caché: unas líneas de cabecera informativa y después la tabla. Hay columnas repetidas:
// se usa la primera capa de turbulencia.
export function parsePirepCsv(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.startsWith('receipt_time,'));
  if (start < 0) return [];
  const header = parseCSVLine(lines[start]);
  const col = name => header.indexOf(name);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const r = parseCSVLine(line);
    const int = r[col('turbulence_intensity')];
    const lat = Number(r[col('latitude')]), lon = Number(r[col('longitude')]);
    if (!int || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) continue;
    const alt = Number(r[col('altitude_ft_msl')]);
    out.push({
      lat, lon, fl: Number.isFinite(alt) ? Math.round(alt / 100) : null,
      t: Date.parse(r[col('observation_time')]), int, type: r[col('turbulence_type')] || null, raw: r[col('raw_text')],
    });
  }
  return out;
}

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return as === 'json' ? res.json() : Buffer.from(await res.arrayBuffer());
}

async function byStations(product, icaos) {
  const items = {};
  for (let i = 0; i < icaos.length; i += 80) {
    const list = await get(`${API}/${product}?ids=${icaos.slice(i, i + 80).join(',')}&format=json`);
    for (const x of list ?? []) items[x.icaoId] ??= product === 'metar' ? compactMetar(x) : compactTaf(x);
    await new Promise(r => setTimeout(r, 1000)); // cortesía entre peticiones
  }
  return items;
}

// icaos: códigos OACI de los aeropuertos que aparecen en los horarios. previous: fn(nombre) → datos publicados antes.
export async function buildAviation(icaos, outDir, previous = async () => null) {
  await mkdir(outDir, { recursive: true });
  const jobs = {
    metar: () => byStations('metar', icaos),
    taf: () => byStations('taf', icaos),
    sigmet: async () => compactSigmets(await get(`${API}/isigmet?format=json`)),
    pirep: async () => parsePirepCsv(gunzipSync(await get(CACHE_PIREP, 'buffer')).toString('utf8')),
  };
  for (const [name, job] of Object.entries(jobs)) {
    let body;
    try {
      body = { updated: new Date().toISOString(), items: await job() };
    } catch (err) {
      console.warn(`Aviation Weather ${name}: ${err.message}`);
      body = await previous(name); // se conserva lo publicado antes; si no hay, no se publica
    }
    if (body) await writeFile(`${outDir}/${name}.json`, JSON.stringify(body));
    const n = body ? Object.keys(body.items).length : 0;
    console.log(`Aviation Weather ${name}: ${n}${body ? '' : ' (sin datos)'}`);
  }
}
