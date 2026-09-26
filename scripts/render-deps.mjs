// ¿Afecta un cambio al servidor de Render? Grafo REAL de dependencias del proceso que arranca Render, sin listas manuales:
//  - entrada: el script de `startCommand` en render.yaml (hoy server/live.mjs);
//  - imports y reexports relativos, de forma recursiva (import … from, export … from, import './x', e import('./x') con
//    ruta literal), con ciclos; los paquetes de node_modules los cubren package.json / package-lock.json;
//  - recursos leídos en ejecución: cualquier new URL('<ruta relativa>', import.meta.url) literal dentro del grafo;
//  - siempre: render.yaml, package.json y package-lock.json.
// Ante la duda, afectado (fail-safe): import() sin ruta literal, dependencia inexistente, ruta fuera del repositorio,
// entrada no encontrada o cualquier error de lectura.
//
// Uso:
//   git diff --name-only A B | node scripts/render-deps.mjs --affected   → una línea por archivo que afecta (con el motivo)
//   node scripts/render-deps.mjs --graph                                → el grafo completo
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALWAYS = ['render.yaml', 'package.json', 'package-lock.json'];
const CODE = /\.(m?js|cjs)$/;
const STATIC = /\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s*)?(['"])([^'"]+)\1/g;
const DYNAMIC = /\bimport\s*\(\s*([^)]*?)\s*\)/g;
const RUNTIME = /new\s+URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const LITERAL = /^(['"`])([^'"`$]+)\1$/;

// Entrada de Render: el último argumento .mjs/.js/.cjs de startCommand.
export function renderEntry(root) {
  const yaml = readFileSync(join(root, 'render.yaml'), 'utf8');
  const cmd = yaml.match(/^\s*startCommand:\s*(.+)$/m)?.[1];
  const script = cmd?.trim().split(/\s+/).reverse().find(t => CODE.test(t));
  if (!script) throw new Error('render.yaml: startCommand sin script de Node');
  return script.replace(/^\.\//, '');
}

// Coincidencias fuera de comentarios de línea («// …», « * …»): un import comentado no es una dependencia.
function matches(src, re) {
  const out = [];
  for (const m of src.matchAll(re)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index).trim();
    if (before.startsWith('//') || before.startsWith('*') || before.startsWith('/*')) continue;
    out.push(m);
  }
  return out;
}

// → { entry, files: Map(ruta → motivo), problems: [texto] }
export function dependencyGraph(root, entry = null) {
  const files = new Map(), problems = [];
  const rootAbs = resolve(root);
  const inRepo = abs => abs === rootAbs || abs.startsWith(rootAbs + sep);
  const rel = abs => relative(rootAbs, abs).split(sep).join('/');
  try { entry ??= renderEntry(rootAbs); } catch (e) { problems.push(e.message); return { entry: null, files, problems }; }
  for (const f of ALWAYS) files.set(f, 'configuración de Render');
  const add = (fromAbs, spec, how) => {
    const abs = resolve(dirname(fromAbs), spec);
    const from = rel(fromAbs);
    if (!inRepo(abs)) { problems.push(`${from}: «${spec}» sale del repositorio`); return null; }
    if (!existsSync(abs) || !statSync(abs).isFile()) { problems.push(`${from}: «${spec}» no existe (${how})`); return null; }
    if (!files.has(rel(abs))) files.set(rel(abs), `${how} por ${from}`);
    return abs;
  };
  const seen = new Set();
  const visit = abs => {
    if (seen.has(abs)) return; // ciclos
    seen.add(abs);
    let src;
    try { src = readFileSync(abs, 'utf8'); } catch (e) { problems.push(`${rel(abs)}: no se pudo leer (${e.message})`); return; }
    const next = [];
    for (const m of matches(src, STATIC)) if (/^\.\.?\//.test(m[2])) next.push(add(abs, m[2], 'importado'));
    for (const m of matches(src, DYNAMIC)) {
      const lit = m[1].match(LITERAL);
      if (!lit) { problems.push(`${rel(abs)}: import() sin ruta literal (${m[1].slice(0, 40)})`); continue; }
      if (/^\.\.?\//.test(lit[2])) next.push(add(abs, lit[2], 'importado dinámicamente'));
    }
    for (const m of matches(src, RUNTIME)) {
      if (!/^\.\.?\//.test(m[2])) { problems.push(`${rel(abs)}: new URL('${m[2]}', import.meta.url) no es una ruta relativa`); continue; }
      add(abs, m[2], 'leído en ejecución');
    }
    for (const n of next) if (n && CODE.test(n)) visit(n);
  };
  const entryAbs = resolve(rootAbs, entry);
  if (!existsSync(entryAbs)) { problems.push(`entrada ${entry} no existe`); return { entry, files, problems }; }
  files.set(entry, 'entrada de Render (render.yaml)');
  visit(entryAbs);
  return { entry, files, problems };
}

// Archivos cambiados que afectan a Render (con el motivo). Si el análisis tiene problemas, siempre afectado (fail-safe).
export function affected(changed, graph) {
  const out = [];
  for (const p of graph.problems) out.push({ file: '(fail-safe)', reason: p });
  for (const f of changed.map(s => s.trim()).filter(Boolean)) if (graph.files.has(f)) out.push({ file: f, reason: graph.files.get(f) });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let graph;
  try { graph = dependencyGraph(root); } catch (e) { graph = { files: new Map(), problems: [`error del detector: ${e.message}`] }; }
  if (process.argv.includes('--graph')) {
    for (const [f, why] of [...graph.files].sort(([a], [b]) => a.localeCompare(b))) console.log(`${f} · ${why}`);
    for (const p of graph.problems) console.log(`(fail-safe) · ${p}`);
  } else {
    const changed = readFileSync(0, 'utf8').split('\n');
    for (const a of affected(changed, graph)) console.log(`${a.file} · ${a.reason}`);
  }
}
