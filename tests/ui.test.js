import { describe, it, expect } from 'vitest';
import { esc, timeTicks, skippedText } from '../js/ui.js';

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
    for (const t of ['Ligera', 'Moderada', 'Fuerte', 'Aire revuelto en altura, sin nubes', 'Cambio brusco del viento con la altura', 'Tormentas', 'Viento sobre montañas']) {
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

import { flightCardHtml } from '../js/ui.js';

describe('puerta de embarque en la ficha', () => {
  const card = (dep, extra = {}) => ({
    al: 'IB', title: 'Iberia IB 1668', route: 'Palma a Madrid', tabs: [], status: { text: 'Programado', tone: 'ok' },
    o: 'PMI', a: 'MAD', duration: 90, dep, arr: null, aircraft: null, ...extra,
  });
  const dep = over => ({ date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D71', ...over });
  it('línea propia y visible con la puerta', () => {
    const h = flightCardHtml(card(dep()));
    expect(h).toContain('Puerta de embarque');
    expect(h).toMatch(/class="gate[^"]*"[^>]*>[\s\S]*D71/);
  });
  it('solo zona (una letra): lo explica', () => {
    const h = flightCardHtml(card(dep({ gate: 'H' })));
    expect(h).toContain('Zona H');
    expect(h).toContain('la puerta exacta se anuncia más cerca de la salida');
  });
  it('sin asignar: lo dice y explica cuándo suele salir', () => {
    const h = flightCardHtml(card(dep({ gate: null })));
    expect(h).toContain('Aún sin asignar');
    expect(h).toContain('1–2 h antes de la salida');
  });
  it('cambio de puerta destacado', () => {
    expect(flightCardHtml(card(dep(), { gateChanged: true }))).toContain('Cambio de puerta');
  });
  it('indica cuándo se actualizó el dato de Aena', () => {
    expect(flightCardHtml(card(dep(), { updatedAgo: 'hace 25 min' }))).toContain('Datos de Aena actualizados hace 25 min');
  });
  it('escapa la puerta', () => {
    expect(flightCardHtml(card(dep({ gate: '<b>' })))).not.toContain('<b>');
  });
});

describe('en vuelo', () => {
  const c = { al: 'IB', title: 'x', route: 'y', tabs: [], status: { text: 'Volando', tone: 'info', flying: true }, o: 'PMI', a: 'MAD', duration: 90,
    dep: { date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D86' }, arr: null, aircraft: null };
  it('«Volando» con el avión animado al lado', () => {
    const html = flightCardHtml({ ...c, updatedAgo: 'hace 3 min', stale: false });
    expect(html).toContain('class="status tone-info flying"');
    expect(html).toMatch(/Volando<span class="fly" aria-hidden="true">/);
  });
  it('con datos antiguos no hay animación (no se sabe si sigue volando)', () => {
    const html = flightCardHtml({ ...c, updatedAgo: 'hace 2 h', stale: true });
    expect(html).not.toContain('class="fly"');
    expect(html).toContain('Volando hace 2 h');
  });
});

describe('radar', () => {
  const c = { al: 'EI', title: 'x', route: 'y', tabs: [], status: { text: 'Volando', tone: 'info', flying: true }, o: 'PMI', a: 'DUB', duration: 160,
    dep: { date: '2026-09-24', time: '20:55', est: null, late: false, terminal: null, gate: null }, arr: null, aircraft: null, updatedAgo: 'hace 3 min', stale: false };
  it('volando: altura, velocidad, señal y con qué indicativo, en lenguaje llano', () => {
    const html = flightCardHtml({ ...c, radar: { state: 'volando', callsign: 'EIN737', altM: 4808, altFt: 15775, kmh: 669, seenS: 12 } });
    expect(html).toContain('Según el radar (adsb.lol): a 4.800 m (15.800 pies), a 669 km/h. Última señal hace 12 s, con el indicativo EIN737.');
  });
  it('cuánto le queda: destacado, y dicho que es un cálculo de Turbi y no una hora oficial', () => {
    const r = { state: 'volando', callsign: 'EIN737', altM: 10363, altFt: 34000, kmh: 812, seenS: 4 };
    expect(flightCardHtml({ ...c, radar: { ...r, remainingKm: 320, etaMin: 24 } })).toContain(
      '<strong>Aterrizaría en aprox. 24 min</strong> · cálculo de Turbi con el radar: quedan 320 km a 812 km/h. No es una hora oficial.');
    expect(flightCardHtml({ ...c, radar: { ...r, remainingKm: 1300, etaMin: 96 } })).toContain('<strong>Aterrizaría en aprox. 1 h 36 min</strong>');
    expect(flightCardHtml({ ...c, radar: { ...r, remainingKm: 20, etaMin: 2 } })).toContain('<strong>Está a punto de aterrizar</strong>');
    expect(flightCardHtml({ ...c, radar: r })).not.toContain('Aterrizaría');
  });
  it('sin datos: se dice sin deducir nada', () => {
    const html = flightCardHtml({ ...c, status: { text: 'Ha salido', tone: 'info' }, radar: { state: 'sin-datos', callsign: 'EIN737' } });
    expect(html).toContain('El radar no lo encuentra con el indicativo EIN737: puede haber aterrizado o emitir con otro indicativo.');
  });
  it('no disponible', () => {
    expect(flightCardHtml({ ...c, radar: { state: 'no-disponible' } })).toContain('El radar no responde ahora mismo.');
  });
});

describe('fecha pedida sin vuelo (EI737: Aena ya lo retiró y la app enseñaba el del domingo como si fuera hoy)', () => {
  it('hoy: lo dice y explica por qué puede faltar', () => {
    expect(skippedText('2026-09-24', '2026-09-27', '2026-09-24')).toBe(
      'Aena ya no publica este vuelo para hoy: retira cada vuelo unas 2 h después de su salida (o puede que hoy no opere). Se muestra el siguiente: dom, 27 sept.');
  });
  it('otra fecha: Aena no lo tiene ese día', () => {
    expect(skippedText('2026-09-25', '2026-09-27', '2026-09-24')).toBe('Aena no tiene este vuelo el vie, 25 sept. Se muestra el siguiente: dom, 27 sept.');
  });
  it('misma fecha: nada', () => {
    expect(skippedText('2026-09-27', '2026-09-27', '2026-09-24')).toBeNull();
  });
  it('en la ficha, arriba del todo, antes del estado', () => {
    const c = { al: 'EI', title: 'x', route: 'y', tabs: [], status: { text: 'Programado', tone: 'ok' }, o: 'PMI', a: 'DUB', duration: 160,
      dep: { date: '2026-09-27', time: '20:55', est: null, late: false, terminal: null, gate: null }, arr: null, aircraft: null, skipped: 'Aena ya no publica este vuelo para hoy…' };
    const html = flightCardHtml(c);
    expect(html.indexOf('class="skipped"')).toBeGreaterThan(-1);
    expect(html.indexOf('class="skipped"')).toBeLessThan(html.indexOf('class="status'));
  });
});

describe('datos de Aena antiguos', () => {
  it('aviso visible si tienen más de 40 min', () => {
    const c = { al: 'IB', title: 'x', route: 'y', tabs: [], status: { text: 'Programado', tone: 'ok' }, o: 'PMI', a: 'MAD', duration: 90,
      dep: { date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D86' }, arr: null, aircraft: null };
    expect(flightCardHtml({ ...c, updatedAgo: 'hace 2 h', stale: true })).toContain('Los datos de Aena son de hace 2 h: pueden haber cambiado desde entonces.');
    expect(flightCardHtml({ ...c, updatedAgo: 'hace 10 min', stale: false })).not.toContain('pueden haber cambiado');
  });
  it('el estado viejo no se presenta como actual (IB1668: «Embarcando» ya aterrizado)', () => {
    const c = { al: 'IB', title: 'x', route: 'y', tabs: [], status: { text: 'Embarcando', tone: 'info' }, o: 'PMI', a: 'MAD', duration: 90,
      dep: { date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D86' }, arr: null, aircraft: null };
    const old = flightCardHtml({ ...c, updatedAgo: 'hace 2 h', stale: true });
    expect(old).toContain('<span class="status tone-stale">Embarcando hace 2 h</span>');
    expect(old.indexOf('class="stale"')).toBeLessThan(old.indexOf('class="route-line"'));
    expect(flightCardHtml({ ...c, updatedAgo: 'hace 5 min', stale: false })).toContain('<span class="status tone-info">Embarcando</span>');
  });
});
