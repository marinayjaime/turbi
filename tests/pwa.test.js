import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BUILD_ID } from '../js/config.js';

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

  it('mantiene una copia sin conexión nueva y ofrece un aviso de actualización', () => {
    expect(sw).toContain("const CACHE = 'turbi-v66'");
    expect(sw).toContain("e.data?.type === 'SKIP_WAITING'");
    expect(html).toContain('id="update-notice"');
    expect(html).toContain('id="update-app"');
  });
});
