// Iconos lineales (js/icons.js): SVG inline que heredan el color del texto; decorativos salvo que lleven etiqueta.
import { describe, it, expect } from 'vitest';
import { icon } from '../js/icons.js';

const NAMES = ['altitude', 'speed', 'distance', 'signal', 'clock', 'plane', 'route', 'turbulence', 'sources', 'shield',
  'chevron', 'refresh', 'back', 'expand', 'close', 'gate', 'sound', 'alert', 'info'];

describe('icon()', () => {
  it.each(NAMES)('%s: <svg> lineal con currentColor, decorativo por defecto', name => {
    const svg = icon(name);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).not.toContain('aria-label');
    expect(svg).toMatch(/<(path|circle|line|polyline|rect)\b/);
  });

  it('size fija el ancho y el alto (20 por defecto)', () => {
    expect(icon('plane')).toContain('width="20" height="20"');
    expect(icon('plane', { size: 16 })).toContain('width="16" height="16"');
  });

  it('label lo convierte en imagen accesible (role="img" y aria-label), escapando el texto', () => {
    const svg = icon('refresh', { label: 'Actualizar' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Actualizar"');
    expect(svg).not.toContain('aria-hidden');
    expect(icon('info', { label: 'a "b" <c>' })).toContain('aria-label="a &quot;b&quot; &lt;c&gt;"');
  });

  it('un nombre desconocido lanza Error', () => {
    expect(() => icon('nope')).toThrow(Error);
  });
});
