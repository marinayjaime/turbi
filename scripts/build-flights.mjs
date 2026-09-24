// Construye _site/ (la app + horarios de Aena) para desplegar en GitHub Pages.
// Uso: MODE=full|live|auto node scripts/build-flights.mjs
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { buildLegs, mergeLegs, shardLegs, patchFailed } from './aena.mjs';
import { fetchMissingLogos } from './fetch-logos.mjs';

const SITE = '_site';
const PAGES_URL = process.env.PAGES_URL ?? 'https://marinayjaime.github.io/turbi/';
const APP_FILES = ['index.html', 'manifest.json', 'sw.js', '.nojekyll', 'css', 'js', 'icons', 'img', 'data/airports.json'];
const AIRPORTS = [
  'MAD', 'BCN', 'PMI', 'AGP', 'ALC', 'LPA', 'TFS', 'IBZ', 'TFN', 'VLC', 'SVQ', 'BIO', 'ACE', 'FUE', 'MAH',
  'SCQ', 'GRO', 'REU', 'XRY', 'VGO', 'OVD', 'SDR', 'LEI', 'RMU', 'GRX', 'ZAZ', 'SPC', 'VIT', 'PNA', 'GMZ',
  'VDE', 'EAS', 'LCG', 'MLN', 'JCU', 'ODB', 'HSK', 'RJL', 'LEN', 'SLM', 'VLL', 'RGS', 'BJZ',
];
const AENA = 'https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const madridDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offsetDays * 86400000));

function pickMode() {
  const m = process.env.MODE ?? 'auto';
  if (m !== 'auto') return m;
  const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule';
  return scheduled && new Date().getUTCHours() % 6 !== 0 ? 'live' : 'full';
}

// Aena a veces responde con un cuerpo roto; se reintenta con esperas crecientes.
async function fetchJson(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}

async function fetchAena(twoDays) {
  const jobs = AIRPORTS.flatMap(airport => ['S', 'L'].map(type => ({ airport, type })));
  const entries = [];
  const failed = [];
  const worker = async () => {
    while (jobs.length) {
      const { airport, type } = jobs.shift();
      const url = `${AENA}&airport=${airport}&flightType=${type}${twoDays ? '&dosDias=si' : ''}`;
      try {
        const rows = await fetchJson(url);
        if (Array.isArray(rows)) for (const row of rows) entries.push({ airport, type, row });
      } catch (err) {
        failed.push({ airport, type });
        console.warn(`Aena ${airport} ${type}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`Aena: ${entries.length} filas, ${failed.length} fallos de ${AIRPORTS.length * 2}`);
  return { entries, failed };
}

async function previousLegs() {
  try {
    return await fetchJson(`${PAGES_URL}data/flights/_legs.json`, 2);
  } catch {
    return null;
  }
}

async function main() {
  const mode = pickMode();
  console.log(`Modo: ${mode}`);
  await rm(SITE, { recursive: true, force: true });
  for (const f of APP_FILES) await cp(f, `${SITE}/${f}`, { recursive: true });

  const { entries, failed } = await fetchAena(mode === 'live');
  const aenaOk = entries.length > 0 && failed.length < AIRPORTS.length; // más de la mitad de las descargas bien
  const freshDates = [madridDate(0), madridDate(1)];
  const old = mode === 'live' || failed.length || !aenaOk ? await previousLegs() : null;
  let fresh = aenaOk ? buildLegs(entries) : [];
  if (aenaOk && failed.length && old) {
    // En modo live solo se recuperan las fechas que se están refrescando.
    const oldScope = mode === 'live' ? old.filter(l => freshDates.includes(l.d)) : old;
    fresh = patchFailed(fresh, oldScope, failed, AIRPORTS);
    console.log(`Recuperados de la publicación anterior: ${failed.map(f => `${f.airport} ${f.type}`).join(', ')}`);
  }
  let legs;
  if (mode === 'live' || !aenaOk) {
    if (!aenaOk) console.warn('Aena no disponible: se conservan los horarios anteriores');
    legs = old ? (aenaOk ? mergeLegs(old, fresh, freshDates, madridDate(0)) : old) : fresh;
  } else {
    legs = fresh;
  }

  const { files, airlines } = shardLegs(legs);
  const out = `${SITE}/data/flights`;
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/_legs.json`, JSON.stringify(legs));
  await writeFile(`${out}/airlines.json`, JSON.stringify(airlines));
  await writeFile(`${out}/_meta.json`, JSON.stringify({ updated: new Date().toISOString(), mode, legs: legs.length }));
  for (const [path, body] of Object.entries(files)) {
    const dir = `${out}/${path.split('/')[0]}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${out}/${path}`, JSON.stringify(body));
  }
  console.log(`${legs.length} tramos, ${Object.keys(files).length} vuelos, ${Object.keys(airlines).length} aerolíneas`);

  // Logos de aerolíneas nuevas (los conocidos ya están en img/logos del repo).
  const codes = [...new Set(Object.keys(files).map(p => p.split('/')[0]))];
  const saved = await fetchMissingLogos(codes, { dir: new URL(`../${SITE}/img/logos/`, import.meta.url) });
  if (saved) console.log(`Logos nuevos: ${saved} (añádelos al repo con: node scripts/fetch-logos.mjs)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
