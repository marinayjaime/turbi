// Descarga una foto de ejemplo de cada modelo de avión (foto principal de su artículo de Wikipedia, en Wikimedia Commons)
// a img/aircraft/<slug>.jpg y escribe js/aircraft-photos.js con autor y licencia (obligatorio mostrarlos).
// Se ejecuta a mano (macOS, usa sips para reducirlas) y el resultado se guarda en el repositorio:
//   node scripts/fetch-aircraft-photos.mjs
import { mkdir, writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PHOTO_ARTICLE, photoSlug } from '../js/plain.js';

const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const OUT = 'img/aircraft';
const get = async url => {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
};
const text = html => String(html ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

await mkdir(OUT, { recursive: true });
let credits = {};
try { credits = (await import('../js/aircraft-photos.js')).PHOTO_CREDITS; } catch { /* primera vez */ }
for (const article of [...new Set(Object.values(PHOTO_ARTICLE))]) {
  const slug = photoSlug(article);
  if (credits[slug] && await access(`${OUT}/${slug}.jpg`).then(() => true, () => false)) continue; // ya descargada
  try {
    const summary = await (await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article.replaceAll(' ', '_'))}`)).json();
    // …/commons/a/ab/Archivo.jpg o, si es muy grande, …/commons/thumb/a/ab/Archivo.jpg/3840px-Archivo.jpg
    const parts = new URL(summary.originalimage.source).pathname.split('/');
    const file = decodeURIComponent(parts.includes('thumb') ? parts.at(-2) : parts.at(-1));
    const q = await (await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1400&titles=${encodeURIComponent(`File:${file}`)}`)).json();
    const page = Object.values(q.query.pages)[0];
    if (!page.imageinfo) throw new Error(`sin imageinfo para ${file}: ${JSON.stringify(page).slice(0, 200)}`);
    const info = page.imageinfo[0];
    const img = Buffer.from(await (await get(info.thumburl)).arrayBuffer());
    const path = `${OUT}/${slug}.jpg`;
    await writeFile(path, img);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '--resampleWidth', '1000', path, '--out', path], { stdio: 'ignore' });
    const m = info.extmetadata;
    credits[slug] = { artist: text(m.Artist?.value) || 'Autor desconocido', license: text(m.LicenseShortName?.value), source: info.descriptionurl };
    console.log(`${slug}: ${file} · ${credits[slug].artist} · ${credits[slug].license}`);
    await new Promise(r => setTimeout(r, 1500));
  } catch (err) {
    console.warn(`${slug}: ${err.message}`);
  }
}
await writeFile('js/aircraft-photos.js', `// Generado por scripts/fetch-aircraft-photos.mjs: autor, licencia y origen de cada foto de img/aircraft.\nexport const PHOTO_CREDITS = ${JSON.stringify(credits, null, 2)};\n`);
