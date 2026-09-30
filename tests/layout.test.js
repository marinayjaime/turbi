// Layout móvil: pantalla de inicio y «Consultando el pronóstico…» centradas en el viewport visible; la foto de fondo
// cubre toda la pantalla (sin la franja azul lisa del manifest); la ficha conserva su flujo y su scroll.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const css = readFileSync('css/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const doc = new JSDOM(readFileSync('index.html', 'utf8')).window.document;

// Declaraciones de la regla con ese selector exacto, en orden (se conservan las repetidas: respaldo + valor moderno).
function decls(selector) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map(s => s.trim()).includes(selector)) {
      for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) out.push([d.slice(0, i).trim(), d.slice(i + 1).trim()]); }
    }
  }
  return out;
}
const values = (selector, prop) => decls(selector).filter(([p]) => p === prop).map(([, v]) => v);

describe('pantallas centradas (inicio y carga)', () => {
  it('#query-view y #loading son pantallas; el panel de carga va dentro', () => {
    expect(doc.getElementById('query-view').classList.contains('screen')).toBe(true);
    const loading = doc.getElementById('loading');
    expect(loading.classList.contains('screen')).toBe(true);
    expect(loading.classList.contains('panel')).toBe(false);
    expect(loading.querySelector('.panel .spinner')).not.toBeNull();
  });

  it('.screen ocupa el viewport visible (100dvh, respaldo 100vh) y centra con grid', () => {
    expect(values('.screen', 'min-height')).toEqual(['100vh', '100dvh']);
    expect(values('.screen', 'display')).toEqual(['grid']);
    expect(values('.screen', 'align-content')).toEqual(['center']);
  });

  it('mismo margen arriba y abajo: las zonas seguras no desplazan el centro', () => {
    expect(values('.screen', 'padding-block')).toEqual(['calc(max(env(safe-area-inset-top), env(safe-area-inset-bottom)) + 16px)']);
  });

  it('nada descentra el panel: sin margen inferior de .panel, sin margin-top en el formulario, sin padding vertical en main', () => {
    expect(values('.screen > .panel', 'margin-bottom')).toEqual(['0']);
    expect(values('#query-form', 'margin-top')).toEqual([]);
    expect(values('main', 'padding')).toEqual(['0 20px']);
  });

  it('100svh solo con el teclado abierto (:focus-within): con el teclado cerrado manda 100dvh', () => {
    expect(values('.screen:focus-within', 'min-height')).toEqual(['100vh', '100svh']);
    const svh = [...css.matchAll(/([^{}]+)\{[^{}]*100svh[^{}]*\}/g)].map(m => m[1].trim());
    expect(svh).toEqual(['.screen:focus-within']);
  });

  it('el error, que siempre se muestra con la pantalla de inicio, va dentro de ella (visible bajo el panel)', () => {
    expect(doc.querySelector('#query-view > #error')).not.toBeNull();
  });
});

describe('la ficha del vuelo conserva su flujo', () => {
  it('#result-view no es una pantalla centrada y respeta las zonas seguras', () => {
    expect(doc.getElementById('result-view').classList.contains('screen')).toBe(false);
    expect(values('#result-view', 'padding')).toEqual(['calc(env(safe-area-inset-top) + 16px) 0 calc(env(safe-area-inset-bottom) + 32px)']);
  });
});

describe('fondo: la foto es el fondo del documento', () => {
  it('el html pinta sky.jpg una sola vez, estirada al 100 % del documento, sin repetir y sin color', () => {
    expect(values('html', 'background')).toEqual(["url('../img/sky.jpg') center top / 100% 100% no-repeat"]);
    expect(values('html', 'background-size')).toEqual([]);
    expect(css).not.toMatch(/repeat-y|[^-]repeat[;\s]/);
    expect(values('html', 'min-height')).toEqual(['100%']);
    expect(values('html', 'background-color')).toEqual([]);
    expect(css).not.toMatch(/#939ba1/i);
  });

  it('sin capa fija para la foto: no hay body::before y la foto solo aparece en el html', () => {
    expect(decls('body::before')).toEqual([]);
    const withSky = [...css.matchAll(/([^{}]+)\{[^{}]*sky\.jpg[^{}]*\}/g)].map(m => m[1].trim());
    expect(withSky).toEqual(['html']);
  });
});
