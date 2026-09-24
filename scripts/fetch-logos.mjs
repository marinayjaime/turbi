// Descarga a img/logos/<IATA>.png los logos que falten (fuente: pics.avs.io, lenta: por eso se alojan aquí).
// Uso: node scripts/fetch-logos.mjs [ruta a airlines.json]   (por defecto _site/data/flights/airlines.json)
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = new URL('../img/logos/', import.meta.url);

export async function fetchMissingLogos(codes, { dir = DIR, fetchFn = fetch } = {}) {
  await mkdir(dir, { recursive: true });
  const missing = [];
  for (const code of codes) {
    try { await access(new URL(`${code}.png`, dir)); } catch { missing.push(code); }
  }
  let saved = 0;
  const worker = async () => {
    while (missing.length) {
      const code = missing.shift();
      try {
        const res = await fetchFn(`https://pics.avs.io/200/80/${code}.png`, { signal: AbortSignal.timeout(20000) });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.startsWith('image/')) continue;
        await writeFile(new URL(`${code}.png`, dir), Buffer.from(await res.arrayBuffer()));
        saved++;
      } catch { /* sin logo: la app lo oculta */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return saved;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.argv[2] ?? '_site/data/flights/airlines.json';
  const codes = [...new Set(Object.values(JSON.parse(await readFile(src, 'utf8'))))].filter(c => /^[A-Z0-9]{2}$/.test(c));
  const saved = await fetchMissingLogos(codes);
  console.log(`Logos: ${codes.length} aerolíneas, ${saved} descargados`);
}
