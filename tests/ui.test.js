import { describe, it, expect } from 'vitest';
import { esc, timeTicks, missingDateText } from '../js/ui.js';

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
  it('sin asignar: lo dice, sin más explicaciones', () => {
    const h = flightCardHtml(card(dep({ gate: null })));
    expect(h).toContain('Aún sin asignar');
    expect(h).not.toContain('1–2 h antes de la salida');
  });
  it('cambio de puerta destacado', () => {
    expect(flightCardHtml(card(dep(), { gateChanged: true }))).toContain('Cambio de puerta');
  });
  it('pie: solo cuándo se actualizaron los datos', () => {
    const h = flightCardHtml(card(dep(), { updatedAgo: 'hace 25 minutos', aircraft: 'Airbus A321' }));
    expect(h).toContain('<p class="foot">Datos actualizados hace 25 minutos</p>');
    expect(h).not.toContain('hora local de cada aeropuerto');
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

describe('solo la fecha pedida: si ese día no hay vuelo, se dice (nunca se salta a otro día)', () => {
  const dates = ['2026-09-26', '2026-09-27', '2026-09-28'];
  it('fecha futura sin vuelo: lo dice y lista los días que sí tiene', () => {
    expect(missingDateText('IB1668', '2026-09-25', dates, '2026-09-24')).toBe(
      'Aena no tiene el IB1668 el vie, 25 sept. Sí lo tiene: sáb, 26 sept · dom, 27 sept · lun, 28 sept.');
  });
  it('hoy sin vuelo', () => {
    expect(missingDateText('IB1668', '2026-09-24', dates, '2026-09-24')).toBe(
      'Aena no tiene hoy el IB1668 (puede que hoy no opere). Sí lo tiene: sáb, 26 sept · dom, 27 sept · lun, 28 sept.');
  });
  it('fecha pasada: Aena no publica el pasado; solo se guardan los vuelos que salieron ayer y hoy', () => {
    expect(missingDateText('IB1668', '2026-09-20', dates, '2026-09-24')).toBe(
      'No hay datos del IB1668 del dom, 20 sept: Aena no publica vuelos pasados y Turbi solo guarda los que salieron ayer y hoy.');
  });
  it('sin ningún otro día', () => {
    expect(missingDateText('IB1668', '2026-09-25', [], '2026-09-24')).toBe('Aena no tiene el IB1668 el vie, 25 sept.');
  });
  it('la ficha no lleva pestañas de otros días', () => {
    const c = { al: 'IB', title: 'x', route: 'y', tabs: [{ date: '2026-09-25', active: true }, { date: '2026-09-26', active: false }], status: { text: 'Programado', tone: 'ok' },
      o: 'PMI', a: 'MAD', duration: 90, dep: { date: '2026-09-25', time: '17:55', est: null, late: false, terminal: null, gate: null }, arr: null, aircraft: null };
    expect(flightCardHtml(c)).not.toContain('class="tabs"');
  });
});

describe('cabecera: foto del modelo y logo junto al número', () => {
  const c = { al: 'EI', number: 'EI 737', airline: 'Aer Lingus', title: 'Aer Lingus EI 737', route: 'Palma a Dublín', tabs: [], status: { text: 'Programado', tone: 'ok' },
    o: 'PMI', a: 'DUB', duration: 160, dep: { date: '2026-09-27', time: '20:55', est: null, late: false, terminal: null, gate: null }, arr: null,
    aircraft: 'Airbus A320', photo: null };
  const photo = { thumb: 'https://upload.wikimedia.org/x/1000px-EI.jpg', artist: 'Pedro Aragão', license: 'CC BY-SA 3.0', page: 'https://commons.wikimedia.org/wiki/File:EI.jpg' };
  it('foto real (de esa aerolínea y ese modelo) arriba del todo, con modelo, autor y licencia', () => {
    const html = flightCardHtml({ ...c, photo });
    expect(html.indexOf('class="plane-photo"')).toBeLessThan(html.indexOf('class="flight-head"'));
    expect(html).toContain('src="https://upload.wikimedia.org/x/1000px-EI.jpg"');
    expect(html).toContain('<figcaption>Foto: <a href="https://commons.wikimedia.org/wiki/File:EI.jpg" target="_blank" rel="noopener">Pedro Aragão</a>, CC BY-SA 3.0</figcaption>');
    expect(html).not.toContain('foto de ejemplo');
  });
  it('foto propia (subida a img/fotos): sin autor ni licencia, solo el modelo', () => {
    const html = flightCardHtml({ ...c, photo: { thumb: 'img/fotos/FR%20Boeing%20737-800.jpg' } });
    expect(html).toContain('src="img/fotos/FR%20Boeing%20737-800.jpg"');
    expect(html).not.toContain('<figcaption>');
  });
  it('número de vuelo a la izquierda y logo a la derecha; aerolínea y ruta debajo', () => {
    const html = flightCardHtml(c);
    expect(html).toMatch(/<div class="flight-id">\s*<h2>EI 737<\/h2>\s*<img class="logo"[^>]*>\s*<\/div>/);
    expect(html).toContain('<p>Aer Lingus · Palma a Dublín</p>');
  });
  it('tipo de avión justo debajo del número de vuelo', () => {
    const html = flightCardHtml(c);
    expect(html).toMatch(/<\/div>\s*<p class="aircraft">Airbus A320<\/p>\s*<p>Aer Lingus/);
    expect(flightCardHtml({ ...c, aircraft: null })).not.toContain('class="aircraft"');
  });
  it('operada por otra aerolínea: se dice', () => {
    expect(flightCardHtml({ ...c, operator: 'Air Nostrum' })).toContain('<p>Aer Lingus · Palma a Dublín · Operado por Air Nostrum</p>');
  });
  it('sin foto real de esa aerolínea y modelo: sin foto', () => {
    expect(flightCardHtml({ ...c, photo: null })).not.toContain('plane-photo');
  });
});

describe('vuelo pasado (del histórico)', () => {
  const c = { al: 'IB', number: 'IB 1668', airline: 'Iberia', title: 'x', route: 'Palma de Mallorca a Madrid', status: { text: 'Ha llegado', tone: 'ok' },
    o: 'PMI', a: 'MAD', duration: 90, dep: { date: '2026-09-24', time: '17:55', est: '18:44', late: true, terminal: null, gate: null },
    arr: { date: '2026-09-24', time: '19:25', est: '20:10', late: true, terminal: null }, aircraft: null, past: true };
  it('sin puerta de embarque ni «actualizado hace»; dice de dónde salen las horas', () => {
    const html = flightCardHtml(c);
    expect(html).not.toContain('Puerta de embarque');
    expect(html).toContain('<p class="foot">Horas finales publicadas por Aena y guardadas por Turbi.</p>');
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
