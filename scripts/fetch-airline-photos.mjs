// Foto REAL de cada combinación aerolínea operadora + modelo (p. ej. «Boeing 737-800 of Ryanair» en Wikimedia Commons).
// 1. node scripts/airline-combos.mjs            → data/airline-combos.json (combinaciones que publica Aena)
// 2. node scripts/fetch-airline-photos.mjs      → data/airline-photos-candidates.json (hasta 4 candidatas por combinación)
// 3. Revisión a mano: en cada combinación, «pick» = índice de la candidata que muestra claramente un avión de esa
//    aerolínea y ese modelo, o null si ninguna vale. Solo se publican las revisadas («reviewed»: true).
// 4. Fotos propias: img/fotos/«CÓDIGO Modelo.jpg» (p. ej. «FR Boeing 737-800.jpg»); tienen prioridad.
//    Y la biblioteca verificada img/aviones-comerciales-verificados (Aerolínea/Modelo/foto.jpg + CSV), aún más prioritaria.
// 5. node scripts/fetch-airline-photos.mjs --publish → data/airline-photos.json (lo que carga la app)
// Sin foto de esa aerolínea con ese modelo, la app no muestra ninguna: nunca una de otra aerolínea ni «de ejemplo».
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const API = 'https://commons.wikimedia.org/w/api.php';
const OUT = 'data/airline-photos-candidates.json';
const PUBLISHED = 'data/airline-photos.json';
const COMBOS = 'data/airline-combos.json';
const OWN = 'img/fotos';
// Biblioteca verificada de Jaime (Aerolínea/Modelo/foto.jpg + FUENTES_Y_LICENCIAS.csv): prioridad máxima.
const LIB = 'img/aviones-comerciales-verificados';
const LIB_OUT = 'img/fotos-verificadas';

// Cómo llama Commons a cada modelo (varias formas posibles).
const MODEL_NAMES = {
  'Airbus A318': ['Airbus A318', 'Airbus A318-100'], 'Airbus A319': ['Airbus A319', 'Airbus A319-100'], 'Airbus A320': ['Airbus A320', 'Airbus A320-200'],
  'Airbus A320neo': ['Airbus A320neo', 'Airbus A320-200N', 'Airbus A320-251N'], 'Airbus A321': ['Airbus A321', 'Airbus A321-200'],
  'Airbus A321neo': ['Airbus A321neo', 'Airbus A321-200N', 'Airbus A321-271NX', 'Airbus A321-251NX'],
  'Airbus A330-200': ['Airbus A330-200'], 'Airbus A330-300': ['Airbus A330-300'], 'Airbus A330neo': ['Airbus A330-900', 'Airbus A330neo'],
  'Airbus A340-300': ['Airbus A340-300'], 'Airbus A350-900': ['Airbus A350-900'], 'Airbus A350-1000': ['Airbus A350-1000'], 'Airbus A380': ['Airbus A380-800', 'Airbus A380'],
  'Airbus A220-100': ['Airbus A220-100'], 'Airbus A220-300': ['Airbus A220-300'],
  'Boeing 737-300': ['Boeing 737-300'], 'Boeing 737-600': ['Boeing 737-600'], 'Boeing 737-700': ['Boeing 737-700'], 'Boeing 737-800': ['Boeing 737-800'],
  'Boeing 737-900': ['Boeing 737-900', 'Boeing 737-900ER'], 'Boeing 737 MAX 8': ['Boeing 737 MAX 8', 'Boeing 737-8 MAX', 'Boeing 737 MAX 8-200', 'Boeing 737-8200', 'Boeing 737-8'],
  'Boeing 737 MAX 9': ['Boeing 737 MAX 9', 'Boeing 737-9'], 'Boeing 757-200': ['Boeing 757-200'], 'Boeing 767-300': ['Boeing 767-300', 'Boeing 767-300ER'],
  'Boeing 767-400': ['Boeing 767-400ER', 'Boeing 767-400'], 'Boeing 777-200': ['Boeing 777-200', 'Boeing 777-200ER'], 'Boeing 777-200LR': ['Boeing 777-200LR'],
  'Boeing 777-300': ['Boeing 777-300'], 'Boeing 777-300ER': ['Boeing 777-300ER'], 'Boeing 787-8': ['Boeing 787-8'], 'Boeing 787-9': ['Boeing 787-9'], 'Boeing 787-10': ['Boeing 787-10'],
  'Embraer 170': ['Embraer 170', 'Embraer ERJ-170'], 'Embraer 175': ['Embraer 175', 'Embraer ERJ-175'], 'Embraer 190': ['Embraer 190', 'Embraer ERJ-190'],
  'Embraer 195': ['Embraer 195', 'Embraer ERJ-195'], 'Embraer E190-E2': ['Embraer E190-E2', 'Embraer 190-E2'], 'Embraer E195-E2': ['Embraer E195-E2', 'Embraer 195-E2'],
  'Bombardier CRJ900': ['CRJ900', 'Bombardier CRJ900', 'Bombardier CRJ-900', 'Mitsubishi CRJ900'], 'Bombardier CRJ1000': ['CRJ1000', 'Bombardier CRJ1000', 'Bombardier CRJ-1000'],
  'ATR 72': ['ATR 72'], 'ATR 72-500': ['ATR 72-500', 'ATR 72-212A'], 'ATR 72-600': ['ATR 72-600'], 'Dash 8-400': ['Bombardier Dash 8 Q400', 'De Havilland Canada Dash 8-400', 'Bombardier Q400'],
  'Helicóptero AW139': ['AgustaWestland AW139'],
};
// Nombres de aerolínea de Aena → Commons (solo cuando difieren).
// Ojo: easyJet UK / Europe / Switzerland llevan la misma pintura, pero se usa la categoría de la operadora si existe.
const AIRLINE_NAMES = { 'Jet2.com': ['Jet2.com', 'Jet2'], 'Wizz Air Malta (WMT)': ['Wizz Air Malta', 'Wizz Air'], 'easyJet UK': ['EasyJet UK', 'EasyJet'],
  'easyJet': ['EasyJet Europe', 'EasyJet'], 'Vueling': ['Vueling Airlines', 'Vueling'], 'Norwegian SWEDEN (NSZ)': ['Norwegian Air Sweden', 'Norwegian Air Shuttle'],
  'Tui Airways': ['TUI Airways'], 'SAS Scandinavian Airlines': ['Scandinavian Airlines'] };
const MULTI = /planes|aircraft at|line ?up|\band\b|tails|fleet|apron|view from|desde|from (a|the) (plane|window)|over |panorama/i;
const REG = /\b([A-Z]{1,2}-[A-Z0-9]{3,5}|N\d{1,5}[A-Z]{0,2})\b/;
const BAD = /cabin|interior|cockpit|flight ?deck|seat|galley|engine|tail|wing|window|logo|model|toy|lego|diagram|crash|accident|incident|wreck|fire|damage|livery|drawing|poster|tug|tow|night|sunset|silhouette|landing gear|detail/i;

const api = async params => {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}?${new URLSearchParams({ format: 'json', ...params })}`, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Commons no responde');
};
const text = html => String(html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function existingCategories(titles) {
  const out = [];
  for (let i = 0; i < titles.length; i += 50) {
    const r = await api({ action: 'query', prop: 'categoryinfo', titles: titles.slice(i, i + 50).join('|') });
    for (const p of Object.values(r.query.pages)) if (p.categoryinfo && (p.categoryinfo.files || p.categoryinfo.subcats)) out.push(p.title);
  }
  // En el orden pedido (primero las formas más habituales).
  return titles.filter(t => out.includes(t));
}

async function filesIn(category, depth = 2, acc = [], seen = new Set()) {
  if (seen.has(category) || acc.length >= 60) return acc;
  seen.add(category);
  const r = await api({ action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '100', cmtype: 'file|subcat' });
  const members = r.query.categorymembers;
  for (const m of members) if (m.ns === 6 && /\.jpe?g$/i.test(m.title) && !BAD.test(m.title)) acc.push(m.title);
  if (depth > 0) {
    // Subcategorías: primero «Current …» y las de matrícula; nunca «by location», «interior», «accidents»…
    const subs = members.filter(m => m.ns === 14 && !/location|interior|cabin|cockpit|accident|incident|livery|special|retro/i.test(m.title));
    subs.sort((a, b) => /current/i.test(b.title) - /current/i.test(a.title));
    for (const s of subs.slice(0, 8)) await filesIn(s.title, depth - 1, acc, seen);
  }
  return acc;
}

// Hasta 4 candidatas (foto apaisada de buena resolución), ordenadas por lo que dice el nombre del archivo.
async function candidates(files, score) {
  const ok = [];
  for (let i = 0; i < Math.min(files.length, 60); i += 20) {
    const r = await api({ action: 'query', prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1000', titles: files.slice(i, i + 20).join('|') });
    for (const p of Object.values(r.query.pages)) {
      const x = p.imageinfo?.[0];
      if (!x || x.width < 1200 || x.width / x.height < 1.3 || x.width / x.height > 2.2) continue;
      ok.push({ score: score(p.title), thumb: x.thumburl, artist: text(x.extmetadata?.Artist?.value) || 'Autor desconocido',
        license: text(x.extmetadata?.LicenseShortName?.value), page: x.descriptionurl });
    }
  }
  return ok.sort((a, b) => b.score - a.score).slice(0, 4);
}

// Todas las categorías «<modelo> of <aerolínea>[ at <aeropuerto>]» de una aerolínea.
const catCache = new Map();
async function airlineCategories(airline) {
  if (catCache.has(airline)) return catCache.get(airline);
  const out = [];
  for (let offset = 0; offset < 1000; offset += 500) {
    const r = await api({ action: 'query', list: 'search', srnamespace: '14', srlimit: '500', sroffset: String(offset), srsearch: `intitle:"of ${airline}"` });
    out.push(...r.query.search.map(m => m.title));
    if (!r.continue) break;
  }
  catCache.set(airline, out);
  return out;
}

const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function resolve({ name, model }) {
  if (!name || !MODEL_NAMES[model]) return null;
  const airlines = AIRLINE_NAMES[name] ?? [name];
  for (const airline of airlines) {
    const cats = await airlineCategories(airline);
    for (const m of MODEL_NAMES[model]) {
      // Exacto «<modelo> of <aerolínea>», luego «… at <aeropuerto>», y por último «Former …» (aviones que tuvo).
      const re = new RegExp(`^Category:(Former )?${esc(m)} of ${esc(airline)}( at .+)?$`, 'i');
      const matching = cats.filter(c => re.test(c)).sort((a, b) => (/^Category:Former/.test(a) - /^Category:Former/.test(b)) || (/ at /.test(a) - / at /.test(b)));
      const word = airline.split(' ')[0].replace(/[^a-z0-9]/gi, '');
      const digits = (model.match(/\d{2,4}/) ?? [''])[0];
      const score = f => (new RegExp(word, 'i').test(f) ? 2 : 0) + (REG.test(f) ? 2 : 0) + (digits && f.includes(digits) ? 2 : 0) + (/neo|max/i.test(model) && new RegExp(model.match(/neo|max/i)[0], 'i').test(f) ? 1 : 0);
      for (const cat of matching) {
        const files = (await filesIn(cat)).filter(f => !MULTI.test(f) && (new RegExp(word, 'i').test(f) || REG.test(f)));
        const list = await candidates(files, score);
        if (list.length) return { pick: 0, category: cat, candidates: list };
      }
    }
  }
  return null;
}

// CSV con comillas (los autores y las páginas llevan comas).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function publish() {
  const combos = JSON.parse(readFileSync(COMBOS, 'utf8'));
  const all = JSON.parse(readFileSync(OUT, 'utf8'));
  const photos = {};
  for (const [key, v] of Object.entries(all)) {
    if (!v?.reviewed || v.pick === null || v.pick === undefined) continue;
    const { thumb, artist, license, page } = v.candidates[v.pick];
    photos[key] = { thumb, artist, license, page };
  }
  // Fotos propias (img/fotos/«FR Boeing 737-800.jpg»): tienen prioridad; se reducen a 1200 px de ancho.
  if (existsSync(OWN)) {
    for (const file of readdirSync(OWN).filter(f => /\.jpe?g$/i.test(f))) {
      const m = file.match(/^([A-Z0-9]{2,3}) (.+)\.jpe?g$/i);
      if (!m || !MODEL_NAMES[m[2]]) { console.warn(`img/fotos/${file}: el nombre debe ser «CÓDIGO Modelo.jpg» (p. ej. «FR Boeing 737-800.jpg»)`); continue; }
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '--resampleWidth', '1200', `${OWN}/${file}`, '--out', `${OWN}/${file}`], { stdio: 'ignore' });
      photos[`${m[1].toUpperCase()}|${m[2]}`] = { thumb: `${OWN}/${encodeURIComponent(file)}` };
    }
  }
  // Biblioteca verificada: copias reducidas a 1000 px en img/fotos-verificadas, con autor y licencia de su CSV.
  if (existsSync(`${LIB}/FUENTES_Y_LICENCIAS.csv`)) {
    mkdirSync(LIB_OUT, { recursive: true });
    const [head, ...rows] = parseCsv(readFileSync(`${LIB}/FUENTES_Y_LICENCIAS.csv`, 'utf8').replace(/^\uFEFF/, ''));
    const col = name => head.indexOf(name);
    for (const r of rows) {
      const code = r[col('CODIGO_OPERADOR')], model = r[col('MODELO')];
      const src = `${LIB}/${r[col('ARCHIVO')]}`;
      if (!code || !model || !existsSync(src)) continue;
      const name = `${code} ${model}.jpg`.replace(/[/\\]/g, '-');
      const out = `${LIB_OUT}/${name}`;
      if (!existsSync(out)) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '--resampleWidth', '1000', src, '--out', out], { stdio: 'ignore' });
      photos[`${code}|${model}`] = { thumb: `${LIB_OUT}/${encodeURIComponent(name)}`, artist: r[col('AUTOR')], license: r[col('LICENCIA')], page: r[col('PAGINA_FUENTE')] };
    }
  }
  const airlines = Object.fromEntries(combos.filter(c => c.name).map(c => [c.op, c.name]));
  writeFileSync(PUBLISHED, `${JSON.stringify({ airlines, photos })}\n`);
  console.log(`Publicadas ${Object.keys(photos).length} fotos revisadas de ${Object.keys(all).length} combinaciones`);
}

if (process.argv[1]?.endsWith('fetch-airline-photos.mjs') && process.argv[2] === '--publish') publish();
else if (process.argv[1]?.endsWith('fetch-airline-photos.mjs')) {
  const combos = JSON.parse(readFileSync(COMBOS, 'utf8'));
  const limit = Number(process.argv[2] ?? Infinity);
  const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  for (const c of combos.slice(0, limit)) {
    const key = `${c.op}|${c.model}`;
    if (key in out) continue;
    try {
      out[key] = await resolve(c);
      await new Promise(r => setTimeout(r, 300));
      console.log(`${key}: ${out[key] ? `${out[key].category} · ${out[key].candidates.length} candidatas` : '— sin foto'}`);
    } catch (err) {
      console.warn(`${key}: ${err.message}`);
    }
    writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  }
}
