// Detector de dependencias de Render (scripts/render-deps.mjs): el grafo real del proceso, sin listas manuales.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { dependencyGraph, affected, renderEntry, ALWAYS } from '../scripts/render-deps.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
// Repositorio simulado: { 'ruta': 'contenido' }; render.yaml arranca server/main.mjs salvo que se indique otro.
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'render-deps-'));
  dirs.push(root);
  const all = { 'render.yaml': 'services:\n  - type: web\n    startCommand: node --max-old-space-size=256 server/main.mjs\n', 'package.json': '{}', 'package-lock.json': '{}', ...files };
  for (const [p, c] of Object.entries(all)) { mkdirSync(join(root, dirname(p)), { recursive: true }); writeFileSync(join(root, p), c); }
  return root;
}
const deps = root => [...dependencyGraph(root).files.keys()].sort();
const hits = (root, changed) => affected(changed, dependencyGraph(root)).map(a => a.file);

describe('grafo sintético', () => {
  it('entrada leída de render.yaml (último script de startCommand)', () => {
    expect(renderEntry(repo({ 'server/main.mjs': '' }))).toBe('server/main.mjs');
  });
  it('dependencia indirecta de tres niveles, export … from e import sin nombres; paquetes de node_modules fuera', () => {
    const root = repo({
      'server/main.mjs': "import http from 'node:http';\nimport { a } from '../js/a.js';\nexport * from './b.mjs';\nimport './side.mjs';",
      'js/a.js': "import {\n  x,\n  y,\n} from './deep/c.js';\nexport const a = 1;",
      'js/deep/c.js': "export { d } from '../d.js';",
      'js/d.js': 'export const d = 1;',
      'server/b.mjs': 'export const b = 1;',
      'server/side.mjs': '',
      'js/app.js': "import { a } from './a.js';", // la app importa el grafo, pero el servidor no la importa a ella
    });
    expect(deps(root)).toEqual([...ALWAYS, 'js/a.js', 'js/d.js', 'js/deep/c.js', 'server/b.mjs', 'server/main.mjs', 'server/side.mjs'].sort());
    expect(hits(root, ['js/d.js'])).toEqual(['js/d.js']);
    expect(hits(root, ['js/app.js', 'css/style.css', 'index.html'])).toEqual([]);
  });
  it('ciclo entre módulos: seguro', () => {
    const root = repo({ 'server/main.mjs': "import './a.mjs';", 'server/a.mjs': "import './b.mjs';", 'server/b.mjs': "import './a.mjs';" });
    expect(deps(root)).toEqual([...ALWAYS, 'server/a.mjs', 'server/b.mjs', 'server/main.mjs'].sort());
  });
  it("import('./literal.mjs') dinámico con ruta literal → se sigue como una dependencia normal", () => {
    const root = repo({ 'server/main.mjs': "const m = await import('./lazy.mjs');", 'server/lazy.mjs': "import '../js/x.js';", 'js/x.js': '' });
    expect(deps(root)).toEqual(expect.arrayContaining(['server/lazy.mjs', 'js/x.js']));
    expect(dependencyGraph(root).problems).toEqual([]);
  });
  it('import(variable) → fail-safe: Render afectado con cualquier cambio', () => {
    const root = repo({ 'server/main.mjs': 'const name = process.env.X;\nawait import(name);' });
    const g = dependencyGraph(root);
    expect(g.problems[0]).toMatch(/import\(\) sin ruta literal/);
    expect(affected(['css/style.css'], g)).toEqual([{ file: '(fail-safe)', reason: expect.stringContaining('sin ruta literal') }]);
  });
  it("new URL('../data/foo.json', import.meta.url) literal (en readFileSync, readFile o suelto) → recurso de ejecución", () => {
    const root = repo({
      'server/main.mjs': "import { readFileSync } from 'node:fs';\nconst a = JSON.parse(readFileSync(new URL('../data/foo.json', import.meta.url)));\nimport './b.mjs';",
      'server/b.mjs': "const u = new URL(\"../data/bar.csv\", import.meta.url);\nawait readFile(new URL(`./tpl.txt`, import.meta.url));",
      'data/foo.json': '{}', 'data/bar.csv': '', 'server/tpl.txt': '',
    });
    const g = dependencyGraph(root);
    expect(g.files.get('data/foo.json')).toBe('leído en ejecución por server/main.mjs');
    expect(g.files.get('data/bar.csv')).toBe('leído en ejecución por server/b.mjs');
    expect(g.files.get('server/tpl.txt')).toBe('leído en ejecución por server/b.mjs');
    expect(hits(root, ['data/foo.json'])).toEqual(['data/foo.json']);
  });
  it('dependencia eliminada pero todavía importada → fail-safe, Render afectado', () => {
    const root = repo({ 'server/main.mjs': "import { gone } from '../js/gone.js';" });
    const out = affected(['js/gone.js'], dependencyGraph(root));
    expect(out[0]).toMatchObject({ file: '(fail-safe)', reason: expect.stringContaining('«../js/gone.js» no existe') });
  });
  it('recurso inexistente o ruta fuera del repositorio → fail-safe', () => {
    expect(dependencyGraph(repo({ 'server/main.mjs': "new URL('../data/missing.json', import.meta.url);" })).problems[0]).toMatch(/no existe/);
    expect(dependencyGraph(repo({ 'server/main.mjs': "import '../../fuera.mjs';" })).problems[0]).toMatch(/sale del repositorio/);
  });
  it('render.yaml sin script de arranque → fail-safe', () => {
    const root = repo({ 'render.yaml': 'services:\n  - type: web\n    startCommand: npm start\n' });
    expect(affected([], dependencyGraph(root))[0]).toMatchObject({ file: '(fail-safe)', reason: expect.stringContaining('startCommand') });
  });
  it('un import comentado no es una dependencia', () => {
    const root = repo({ 'server/main.mjs': "// import './old.mjs';\n/*\n * import '../js/nada.js';\n */\nexport const a = 1;" });
    expect(dependencyGraph(root).problems).toEqual([]);
    expect(deps(root)).toEqual([...ALWAYS, 'server/main.mjs'].sort());
  });
  it('render.yaml, package.json y package-lock.json siempre afectan', () => {
    const root = repo({ 'server/main.mjs': '' });
    expect(hits(root, ['render.yaml', 'package-lock.json', 'package.json', 'README.md'])).toEqual(['render.yaml', 'package-lock.json', 'package.json']);
  });
});

describe('repositorio real', () => {
  const g = dependencyGraph('.');
  it('entrada server/live.mjs, sin problemas, e incluye los módulos de js/ que el detector anterior no veía', () => {
    expect(g.entry).toBe('server/live.mjs');
    expect(g.problems).toEqual([]);
    for (const f of ['js/adb.js', 'js/radar-gate.js', 'js/physical-flight.js', 'js/time.js', 'data/airports.json', 'scripts/aena.mjs', 'server/radar-adb.mjs'])
      expect(g.files.has(f), f).toBe(true);
    for (const f of ['js/app.js', 'js/ui.js', 'sw.js', 'index.html', 'css/style.css', 'scripts/build-flights.mjs', 'scripts/aliases.mjs'])
      expect(g.files.has(f), f).toBe(false);
  });
  it('cambio puramente de la app (CSS, index.html, sw.js, versión en js/build.js, test) → 0 archivos que afecten a Render', () => {
    expect(g.files.has('js/build.js')).toBe(false); // la versión de la app no está en el grafo del servidor
    expect(affected(['css/style.css', 'index.html', 'sw.js', 'js/build.js', 'tests/pwa.test.js'], g)).toEqual([]);
  });
  it('js/adb.js → sí afecta, por el grafo real (server/aerodatabox.mjs lo importa)', () => {
    expect(affected(['js/adb.js'], g)).toEqual([{ file: 'js/adb.js', reason: 'importado por server/aerodatabox.mjs' }]);
  });
  it('js/config.js (LIVE_BASE) sigue en el grafo: cambiarlo sí afecta a Render', () => {
    expect(affected(['js/config.js'], g)).toEqual([{ file: 'js/config.js', reason: 'importado por js/adb.js' }]);
  });
});
