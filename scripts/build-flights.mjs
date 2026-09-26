// Construye _site/ (la app + horarios de Aena) para desplegar en GitHub Pages.
// Uso: MODE=full|live|auto node scripts/build-flights.mjs
import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { buildLegs, mergeLegs, shardLegs, patchFailed, auditLegs, keepDeparted, departedLegs } from './aena.mjs';
import { fetchMissingLogos } from './fetch-logos.mjs';
import { buildAviation } from './build-aviation.mjs';
import { buildPunctuality } from './build-punctuality.mjs';
import { readFile } from 'node:fs/promises';
import { AIRPORTS, fetchJson, fetchAena, madridDate, pickMode } from './aena-fetch.mjs';
import { buildAliases } from './aliases.mjs';

const SITE = '_site';
const PAGES_URL = process.env.PAGES_URL ?? 'https://marinayjaime.github.io/turbi/';
const APP_FILES = ['index.html', 'manifest.json', 'sw.js', '.nojekyll', 'css', 'js', 'icons', 'img', 'data/airports.json', 'data/icao.json', 'data/airline-photos.json'];
async function previousLegs() {
  try {
    return await fetchJson(`${PAGES_URL}data/flights/_legs.json`, 2);
  } catch {
    return null;
  }
}

// Salidas ya despegadas de la publicación anterior (Aena las retira unas 2 h después de despegar).
async function previousDeparted() {
  try {
    return await fetchJson(`${PAGES_URL}data/flights/_departed.json`, 2);
  } catch {
    return [];
  }
}

// Publicación anterior de un archivo de data/flights (o null).
async function previousFile(name) {
  try {
    return await fetchJson(`${PAGES_URL}data/flights/${name}`, 2);
  } catch {
    return null;
  }
}

async function main() {
  const mode = pickMode();
  console.log(`Modo: ${mode}`);
  await rm(SITE, { recursive: true, force: true });
  // Los originales de la biblioteca de fotos (img/aviones-comerciales-verificados) no se publican: solo sus copias reducidas.
  for (const f of APP_FILES) await cp(f, `${SITE}/${f}`, { recursive: true, filter: src => !src.includes('aviones-comerciales-verificados') });

  const { entries, failed } = await fetchAena(mode === 'live');
  const aenaOk = entries.length > 0 && failed.length < AIRPORTS.length; // más de la mitad de las descargas bien
  const freshDates = [madridDate(0), madridDate(1)];
  const old = mode === 'live' || failed.length || !aenaOk ? await previousLegs() : null;
  let fresh = aenaOk ? buildLegs(entries) : [];
  // Auditoría de fidelidad: lo que se publica debe ser idéntico a lo que dice Aena en esta descarga.
  const audit = aenaOk ? auditLegs(entries, fresh) : { checked: 0, mismatches: [], duplicates: 0 };
  console.log(`Auditoría: ${audit.checked} horas comprobadas contra Aena, ${audit.mismatches.length} discrepancias, ${audit.duplicates} vuelos con dos horas distintas en Aena (se muestran ambas)`);
  for (const m of audit.mismatches.slice(0, 10)) console.warn(`  DISCREPANCIA ${m.flight} ${m.side} ${m.airport}: Aena ${m.aena} · Turbi ${m.turbi}`);
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
  // El vuelo que ya ha despegado no desaparece a las 2 h: se conserva hasta el día siguiente.
  legs = keepDeparted(await previousDeparted(), legs, madridDate(0));

  const { files, airlines } = shardLegs(legs, new Date().toISOString());
  const out = `${SITE}/data/flights`;
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/_legs.json`, JSON.stringify(legs));
  await writeFile(`${out}/_departed.json`, JSON.stringify(departedLegs(legs, madridDate(0))));
  await writeFile(`${out}/airlines.json`, JSON.stringify(airlines));
  // Números comerciales asociados por Aena (BA8462 → CJ8462): solo en modo completo se recalculan y revalidan todas
  // las condiciones; en modo live o sin Aena se conserva la publicación anterior tal cual.
  const updatedAt = new Date().toISOString();
  let aliases = await previousFile('_aliases.json'), evidence = await previousFile('_alias-evidence.json');
  if (mode !== 'live' && aenaOk) {
    const r = buildAliases(entries, legs, evidence, madridDate(0));
    aliases = { updated: updatedAt, aliases: r.aliases };
    evidence = { updated: updatedAt, evidence: r.evidence };
    console.log(`Alias: ${Object.keys(r.aliases).length} números comerciales, ${r.evidence.length} evidencias, ${r.rejected.length} descartados`);
    for (const x of r.rejected.filter(x => x.pair.includes('→'))) console.log(`  relación ${x.pair} descartada: ${x.reason}`);
  }
  await writeFile(`${out}/_aliases.json`, JSON.stringify(aliases ?? { updated: null, aliases: {} }));
  await writeFile(`${out}/_alias-evidence.json`, JSON.stringify(evidence ?? { updated: null, evidence: [] }));
  await writeFile(`${out}/_meta.json`, JSON.stringify({ updated: new Date().toISOString(), mode, legs: legs.length, audit: { checked: audit.checked, mismatches: audit.mismatches.length, duplicates: audit.duplicates } }));
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

  // Histórico de puntualidad (rama «data»). Opcional: un fallo aquí nunca impide publicar.
  try {
    const r = await buildPunctuality({
      entries: aenaOk ? entries : [], legs: aenaOk ? buildLegs(entries) : [],
      storeDir: process.env.PUNCTUALITY_STORE ?? 'store', outDir: `${SITE}/data/punctuality`, today: madridDate(0),
    });
    console.log(`Puntualidad: ${r.records} vuelos en el histórico, ${r.changedDays} días actualizados, ${r.flights} números con datos`);
  } catch (err) {
    console.warn(`Puntualidad: ${err.message}`);
  }

  // METAR/TAF/SIGMET/PIREP (opcional: un fallo aquí nunca impide publicar).
  try {
    const icaoMap = JSON.parse(await readFile('data/icao.json', 'utf8'));
    const icaos = [...new Set(legs.flatMap(l => [l.o, l.a]))].map(c => icaoMap[c]).filter(Boolean).sort();
    await buildAviation(icaos, `${SITE}/data/aviation`, async name => {
      try { return await fetchJson(`${PAGES_URL}data/aviation/${name}.json`, 2); } catch { return null; }
    });
  } catch (err) {
    console.warn(`Aviation Weather: ${err.message}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
