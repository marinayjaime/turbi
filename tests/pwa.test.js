import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUILD_ID } from '../js/build.js';

describe('actualización de la PWA', () => {
  const html = readFileSync('index.html', 'utf8');
  const app = readFileSync('js/app.js', 'utf8');
  const sw = readFileSync('sw.js', 'utf8');

  it('versiona los recursos principales con el mismo identificador de build', () => {
    expect(html).toContain(`css/style.css?v=${BUILD_ID}`);
    expect(html).toContain(`js/app.js?v=${BUILD_ID}`);
    expect(sw).toContain(`css/style.css?v=${BUILD_ID}`);
    expect(sw).toContain(`js/app.js?v=${BUILD_ID}`);
  });

  it('comprueba el Service Worker sin caché y recarga una sola vez al cambiar el controlador', () => {
    expect(app).toContain("register('sw.js', { updateViaCache: 'none' })");
    expect(app).toContain("addEventListener('controllerchange'");
    expect(app).toContain('location.reload()');
    expect(app).toContain('turbi-reloaded-${BUILD_ID}');
  });

  it('la versión vive sola en js/build.js (la usa la app, no el servidor); js/config.js no la exporta', async () => {
    const build = await import('../js/build.js');
    const config = await import('../js/config.js');
    expect(Object.keys(build)).toEqual(['BUILD_ID']);
    expect(config).not.toHaveProperty('BUILD_ID');
    expect(config).toHaveProperty('LIVE_BASE');
    expect(sw).toContain("'js/build.js'"); // también disponible sin conexión
  });

  // Sin conexión, un módulo que importe la app y no esté en la copia rompería la carga entera.
  it('la copia sin conexión incluye todos los módulos que carga la app', () => {
    const seen = new Set(), pending = ['js/app.js'];
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, rel] of readFileSync(file, 'utf8').matchAll(/from '\.\/([\w-]+\.js)'/g)) pending.push(`js/${rel}`);
    }
    for (const file of [...seen].filter(f => f !== 'js/app.js')) expect(sw, file).toContain(`'${file}'`);
  });

  it('mantiene una copia sin conexión nueva y ofrece un aviso de actualización', () => {
    expect(sw).toContain("const CACHE = 'turbi-v97'");
    expect(sw).toContain("e.data?.type === 'SKIP_WAITING'");
    expect(html).toContain('id="update-notice"');
    expect(html).toContain('id="update-app"');
  });

  // Estética clara: barra de estado de iOS normal (black-translucent daría texto blanco sobre el fondo claro).
  it('colores claros en la barra del navegador, la barra de estado de iOS y el manifest', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    expect(html).toContain('<meta name="theme-color" content="#F4F8FC">');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default">');
    expect(manifest.background_color).toBe('#F4F8FC');
    expect(manifest.theme_color).toBe('#F4F8FC');
  });
});

// Mapa del vuelo (MapLibre GL JS): copia local, sin CDN, publicada con la app y guardada por el Service Worker al usarse.
import { createHash } from 'node:crypto';
import { MAPLIBRE_VERSION, STYLE_URL } from '../js/map.js';
describe('MapLibre en la PWA', () => {
  const sw = readFileSync('sw.js', 'utf8');
  const VENDOR = 'js/vendor/maplibre';
  // Archivos de maplibre-gl@6.11.2 (npm, dist/ y LICENSE.txt) sin modificar.
  const SHA256 = {
    'maplibre-gl.mjs': '3f55566295583644617fe17d008a36c580414b8c71dd2e1fcff1309de6fdee5d',
    'maplibre-gl-shared.mjs': '76b5f55bdee928c65d592684aaff2b913d50b6b17b0ec6334e88b09b6aa47960',
    'maplibre-gl-worker.mjs': '01ad197aa7f4cec258a890febd71b7515e96309881b036a7095befc01a45296e',
    'maplibre-gl.css': 'd8617d8421930e3fc6185365400e788c374c1a5d9fbe87999998c0bc14a202d3',
    'LICENSE.txt': 'ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2',
  };
  it('L) los tres módulos (el worker y el compartido los carga el principal junto a sí), su CSS y la licencia, íntegros', () => {
    for (const [f, sha] of Object.entries(SHA256)) expect(createHash('sha256').update(readFileSync(`${VENDOR}/${f}`)).digest('hex'), f).toBe(sha);
    expect(readFileSync(`${VENDOR}/maplibre-gl.mjs`, 'utf8')).toContain(`v${MAPLIBRE_VERSION}/LICENSE.txt`);
    expect(readFileSync(`${VENDOR}/maplibre-gl.mjs`, 'utf8')).toContain('from"./maplibre-gl-shared.mjs"');
    expect(readFileSync(`${VENDOR}/maplibre-gl-worker.mjs`, 'utf8')).toContain('from"./maplibre-gl-shared.mjs"');
  });
  it('L) js/map.js la carga desde la copia local (import dinámico: si falla, la app sigue) y nada pide Leaflet ni un CDN', () => {
    const map = readFileSync('js/map.js', 'utf8');
    expect(map).toContain("const MAPLIBRE = './vendor/maplibre/maplibre-gl.mjs';");
    expect(map).toContain("'./vendor/maplibre/maplibre-gl.css'");
    expect(map).toContain('import(MAPLIBRE)');
    for (const f of ['js/map.js', 'js/app.js', 'index.html', 'sw.js']) expect(readFileSync(f, 'utf8'), f).not.toMatch(/leaflet|cdnjs/i);
    expect(STYLE_URL).toBe('https://tiles.openfreemap.org/styles/positron'); // sin clave
  });
  it('L) GitHub Pages publica js/ entero (con vendor/) y el Service Worker guarda al usarla cualquier archivo propio (red primero)', () => {
    expect(readFileSync('scripts/build-flights.mjs', 'utf8')).toMatch(/const APP_FILES = \[[^\]]*'js'/);
    expect(sw).toMatch(/fetch\(e\.request, \{ cache: 'no-cache' \}\)[\s\S]*caches\.open\(CACHE\)\.then\(c => c\.put\(e\.request, copy\)\)[\s\S]*caches\.match\(e\.request\)/);
    // No se precarga (1,2 MB en cada instalación): el mapa es prescindible y la app arranca sin él, también sin conexión.
    expect(sw).not.toContain('vendor/maplibre');
  });
});
