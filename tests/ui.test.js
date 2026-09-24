import { describe, it, expect } from 'vitest';
import { esc, timeTicks } from '../js/ui.js';

describe('ui helpers', () => {
  it('esc escapa HTML', () => {
    expect(esc('<b>"A" & \'B\'</b>')).toBe('&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;');
  });
  it('timeTicks elige el paso según la duración', () => {
    expect(timeTicks(45)).toEqual([0, 15, 30, 45]);
    expect(timeTicks(150)).toEqual([0, 30, 60, 90, 120, 150]);
    expect(timeTicks(300)).toEqual([0, 60, 120, 180, 240, 300]);
  });
});

import { formatDuration, dateLabel } from '../js/ui.js';

describe('ficha del vuelo', () => {
  it('formatDuration', () => {
    expect(formatDuration(90)).toBe('1h 30min');
    expect(formatDuration(45)).toBe('45min');
    expect(formatDuration(120)).toBe('2h');
  });
  it('dateLabel en español', () => {
    expect(dateLabel('2026-09-24')).toBe('jue, 24 sept');
    expect(dateLabel('2026-10-03')).toBe('sáb, 3 oct');
  });
});

import { renderResult } from '../js/ui.js';

describe('explicación de la fiabilidad', () => {
  const view = rel => ({
    title: 'PMI → MAD', subtitle: 'IB1668', times: '17:55–19:25', verdict: 'tranquilo',
    reliability: rel, durationMin: 90, segments: [{ level: 0, startMin: 0, endMin: 90 }],
  });
  it('la etiqueta se despliega y explica los niveles, resaltando el actual', () => {
    const el = { innerHTML: '' };
    renderResult(el, view('media'));
    expect(el.innerHTML).toContain('<details class="reliability">');
    expect(el.innerHTML).toContain('<summary>Fiabilidad media');
    for (const txt of ['Faltan menos de 24 h', 'Faltan de 1 a 3 días', 'Faltan de 3 a 7 días', 'Más de 7 días']) {
      expect(el.innerHTML).toContain(txt);
    }
    expect(el.innerHTML).toMatch(/<li class="current"><strong>Media<\/strong>/);
    const block = el.innerHTML.slice(el.innerHTML.indexOf('<details class="reliability">'));
    expect(block.slice(0, block.indexOf('</details>')).match(/class="current"/g)).toHaveLength(1);
  });
});

describe('explicación del veredicto y los tramos', () => {
  const el = { innerHTML: '' };
  renderResult(el, {
    title: 'PMI → MAD', subtitle: 'IB1668', times: '17:55–19:25', verdict: 'movimiento',
    reliability: 'alta', durationMin: 90, segments: [{ level: 1, startMin: 0, endMin: 90, cause: 'ellrod' }],
  });
  const html = el.innerHTML;
  it('desplegable con los tres veredictos y el actual resaltado', () => {
    expect(html).toContain('<details class="explain">');
    expect(html).toContain('<summary>¿Qué significa?');
    for (const v of ['Tranquilo', 'Algo de movimiento', 'Turbulento']) expect(html).toContain(v);
    expect(html).toMatch(/<li class="current"><strong>🟡 Algo de movimiento<\/strong>/);
  });
  it('explica intensidades y causas', () => {
    for (const t of ['Ligera', 'Moderada', 'Fuerte', 'Aire claro', 'Cizalladura', 'Tormentas', 'Onda de montaña']) {
      expect(html).toContain(`<strong>${t}</strong>`);
    }
  });
});

describe('logo de la aerolínea', () => {
  it('se sirve desde la propia web, con respaldo a pics.avs.io', () => {
    const el = { innerHTML: '' };
    renderResult(el, {
      note: 'x',
      flight: { al: 'IB', title: 'Iberia IB 1668', route: 'Palma a Madrid', tabs: [], status: { text: 'Programado', tone: 'ok' },
        o: 'PMI', a: 'MAD', duration: 90, dep: null, arr: null, aircraft: null },
    });
    expect(el.innerHTML).toContain('src="img/logos/IB.png"');
    expect(el.innerHTML).toContain('https://pics.avs.io/200/80/IB.png');
  });
});
