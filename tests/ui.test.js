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
  const r = { state: 'volando', callsign: 'AEA039', altM: 10668, altFt: 35000, kmh: 851, seenS: 0, remainingKm: 8411, source: 'adsb.lol' };
  it('volando: un único panel de telemetría (estado, velocidad, altitud, distancia) con fuente y señal debajo', () => {
    const html = flightCardHtml({ ...c, radar: r });
    expect(html).toContain('class="telemetry"');
    expect(html.match(/class="tm-cell/g)).toHaveLength(4);
    expect(html).toMatch(/<span class="tm-label">Estado<\/span>\s*<span class="tm-value tm-flying">Volando<span class="fly"/);
    expect(html).toMatch(/<span class="tm-label">Velocidad<\/span>\s*<span class="tm-value">851<small>km\/h<\/small><\/span>/);
    expect(html).toMatch(/<span class="tm-label">Altitud<\/span>\s*<span class="tm-value">10\.700<small>m<\/small><\/span>/);
    expect(html).toMatch(/<span class="tm-label">Distancia restante<\/span>\s*<span class="tm-value tm-remaining">8\.411<small>km<\/small><\/span>/);
    expect(html).toMatch(/<span class="tm-source" title="Datos ADS-B de adsb\.lol">Radar ADS-B<\/span>/); // proveedor solo como title
    expect(html).toContain('<span class="tm-signal">Última señal hace 0 s · AEA039</span>');
    expect(html).not.toContain('Según el radar');
    expect(html).not.toMatch(/>[^<]*adsb\.lol/); // el proveedor no se muestra como texto
  });
  it('avión identificado por su ruta (no por el indicativo del vuelo): se dice, en lenguaje llano', () => {
    const html = flightCardHtml({ ...c, radar: { ...r, callsign: 'RYR12AB', hex: 'abc123', match: 'ruta' } });
    expect(html).toContain('<span class="tm-signal">Última señal hace 0 s · RYR12AB</span>');
    expect(html).toContain('<p class="tm-match">Avión localizado por su ruta, posición y modelo: la aerolínea emite con otro indicativo.</p>');
    expect(flightCardHtml({ ...c, radar: r })).not.toContain('tm-match');
  });
  it('con el panel, la etiqueta exterior «Volando» no se repite', () => {
    const html = flightCardHtml({ ...c, radar: r });
    expect(html).not.toContain('class="status');
    expect(html.match(/Volando/g)).toHaveLength(1);
  });
  it('valores dinámicos; si falta un dato, «—» (no se inventa)', () => {
    const html = flightCardHtml({ ...c, radar: { ...r, kmh: null, remainingKm: undefined, altM: 3048, seenS: 42, callsign: 'FIN1676' } });
    expect(html).toMatch(/Velocidad<\/span>\s*<span class="tm-value">—<\/span>/);
    expect(html).toMatch(/Distancia restante<\/span>\s*<span class="tm-value tm-remaining">—<\/span>/);
    expect(html).toContain('3.000<small>m</small>');
    expect(html).toContain('Última señal hace 42 s · FIN1676');
  });
  it('«Volando» de Aena sin radar (vuelo a España): sigue la etiqueta de siempre, sin panel', () => {
    const html = flightCardHtml(c);
    expect(html).toContain('class="status tone-info flying"');
    expect(html).not.toContain('telemetry');
  });
  it('sin señal reciente: mensaje genérico, sin un indicativo concreto (se prueban varias variantes) y sin deducir nada', () => {
    const html = flightCardHtml({ ...c, status: { text: 'Ha salido', tone: 'info' }, radar: { state: 'sin-senal' } });
    expect(html).toContain('<p class="radar muted">Sin señal ADS-B reciente para este vuelo.</p>');
    expect(html).not.toMatch(/AEA|EIN|indicativo|aterriz/);
  });
  it('señal reciente (hace poco lo vio volando): lo dice el estado; sin panel ni texto extra', () => {
    const html = flightCardHtml({ ...c, status: { text: 'Última señal: volando hace 5 min', tone: 'info' }, radar: { state: 'reciente', ageMin: 5 } });
    expect(html).toContain('<span class="status tone-info">Última señal: volando hace 5 min</span>');
    expect(html).not.toContain('telemetry');
    expect(html).not.toContain('class="radar');
  });
  it('no disponible', () => {
    expect(flightCardHtml({ ...c, radar: { state: 'no-disponible' } })).toContain('El radar no responde ahora mismo.');
  });
  it('aterrizado: estado «Aterrizado» con su confirmación, sin panel de vuelo', () => {
    const html = flightCardHtml({ ...c, status: { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B' }, radar: { state: 'aterrizado' } });
    expect(html).toContain('<span class="status tone-ok">Aterrizado</span><p class="status-note">Confirmado por radar ADS-B</p>');
    expect(html).not.toMatch(/telemetry|Volando|class="radar/);
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
  it('foto genérica de la aerolínea: «Imagen representativa de la aerolínea», sin decir que es el avión ni el modelo', () => {
    const html = flightCardHtml({ ...c, aircraft: null, photo: { ...photo, representative: true } });
    expect(html).toContain('<figcaption>Imagen representativa de la aerolínea · Foto:');
    expect(html).not.toMatch(/código compartido/);
  });
  it('salida estimada por Turbi (solo se conoce la llegada)', () => {
    const html = flightCardHtml({ ...c, dep: { date: '2026-09-25', time: '08:30', estimated: true, note: 'Estimación Turbi basada en la duración de la ruta' } });
    expect(html).toContain('<p class="lbl">Salida estimada</p>');
    expect(html).toContain('<p class="big estimated">08:30</p>');
  });
  it('foto por código compartido: lo dice debajo de la foto', () => {
    expect(flightCardHtml({ ...c, photo: { ...photo, shared: true } })).toContain('Vuelo con código compartido: Aena no indica qué aerolínea lo opera. ');
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
    // Si una de las horas es una estimación de Turbi, el pie no puede decir que todas son de Aena
    expect(flightCardHtml({ ...c, arr: { date: '2026-09-24', time: '22:50', estimated: true, note: 'Estimación Turbi basada en la duración de la ruta' } }))
      .toContain('<p class="foot">Hora de salida publicada por Aena y guardada por Turbi; la llegada es una estimación de Turbi.</p>');
    expect(flightCardHtml({ ...c, dep: { date: '2026-09-24', time: '08:30', estimated: true, note: 'x' } }))
      .toContain('<p class="foot">Hora de llegada publicada por Aena y guardada por Turbi; la salida es una estimación de Turbi.</p>');
  });
});

describe('llegada estimada por Turbi (Aena no publica la llegada)', () => {
  const c = { al: 'FR', title: 'x', route: 'Palma a Londres', status: { text: 'Programado', tone: 'ok' }, o: 'PMI', a: 'LHR', duration: 150, durationEstimated: true,
    dep: { date: '2026-09-25', time: '17:00', est: null, late: false, terminal: null, gate: null }, aircraft: null };
  it('antes del despegue: «Llegada estimada» y «Estimación Turbi», nunca «prevista»', () => {
    const html = flightCardHtml({ ...c, arr: { date: '2026-09-25', time: '18:30', estimated: true, note: 'Estimación Turbi' } });
    expect(html).toContain('<p class="lbl">Llegada estimada</p>');
    expect(html).toContain('<p class="big estimated">18:30</p>'); // color neutro: no es un dato oficial «en hora»
    expect(html).toContain('<p class="est-note">Estimación Turbi</p>');
    expect(html).not.toContain('prevista');
  });
  it('en vuelo: «Estimación Turbi actualizada en vuelo»', () => {
    expect(flightCardHtml({ ...c, arr: { date: '2026-09-25', time: '18:15', estimated: true, note: 'Estimación Turbi actualizada en vuelo' } }))
      .toContain('<p class="est-note">Estimación Turbi actualizada en vuelo</p>');
  });
  it('llegada al día siguiente (hora local del destino)', () => {
    expect(flightCardHtml({ ...c, arr: { date: '2026-09-26', time: '01:00', estimated: true, note: 'Estimación Turbi' } })).toContain('Llegada estimada · +1 día');
  });
  it('duración estimada: marcada con «≈», discreta', () => {
    expect(flightCardHtml({ ...c, arr: null })).toContain('<em>≈ 2h 30min</em>');
    expect(flightCardHtml({ ...c, arr: null, durationEstimated: false })).toContain('<em>2h 30min</em>');
  });
});

describe('aterrizado estimado', () => {
  it('«Aterrizado» con la nota de que es según la llegada estimada, y la llegada estimada visible', () => {
    const html = flightCardHtml({ al: 'EI', title: 'x', route: 'Palma a Dublín', o: 'PMI', a: 'DUB', duration: 157, durationEstimated: true,
      status: { text: 'Aterrizado', tone: 'ok', note: 'Según la llegada estimada por Turbi', landing: 'estimated-landed' },
      dep: { date: '2026-09-24', time: '20:55', est: '21:12', late: true, terminal: null, gate: null },
      arr: { date: '2026-09-24', time: '22:50', estimated: true, note: 'Estimación Turbi basada en la duración de la ruta' }, aircraft: null, past: true });
    expect(html).toContain('<span class="status tone-ok">Aterrizado</span><p class="status-note">Según la llegada estimada por Turbi</p>');
    expect(html).toContain('<p class="big estimated">22:50</p>');
    expect(html).not.toMatch(/Histórico|Ha salido|telemetry/);
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
