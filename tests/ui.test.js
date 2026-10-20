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
import { JSDOM } from 'jsdom';

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
    expect(html).toMatch(/<li class="current"><strong><span class="dot lvl2"><\/span>Algo de movimiento<\/strong>/); // punto de color, sin emoji
  });
  it('explica intensidades y causas', () => {
    for (const t of ['Ligera', 'Moderada', 'Fuerte', 'Aire revuelto en altura, sin nubes', 'Cambio brusco del viento con la altura', 'Tormentas', 'Viento sobre montañas']) {
      expect(html).toContain(`<strong>${t}</strong>`);
    }
  });
});

// Cálculo simplificado (v1): la misma tarjeta de Turbulencias que el pronóstico v2 (spec §5.7), con una línea que lo dice.
describe('cálculo v1: misma tarjeta y barras', () => {
  const dom = h => new JSDOM(`<body>${h}</body>`).window.document;
  const segments = [{ level: 0, startMin: 0, endMin: 30, cause: null }, { level: 2, startMin: 30, endMin: 45, cause: 'ellrod' }, { level: 1, startMin: 45, endMin: 150, cause: 'shear' }];
  const legacy = { verdict: 'movimiento', reliability: 'media', durationMin: 150, segments, sectionOnly: true };
  const el = { innerHTML: '' };
  renderResult(el, legacy);
  const doc = dom(el.innerHTML);
  const card = doc.querySelector('details.card.turb[data-card="turbulence"]');
  it('tarjeta desplegable con el título, «General» y la línea del cálculo simplificado visibles', () => {
    expect(card).not.toBeNull();
    const sum = card.querySelector(':scope > summary');
    expect(sum.querySelector('h3.section').textContent).toBe('Turbulencias');
    expect(sum.querySelector('.turb-general .v').textContent).toBe('Algo de movimiento');
    expect(sum.querySelector('.turb-general').classList.contains('lvl-ink2')).toBe(true);
    expect(sum.textContent).toContain('Cálculo simplificado: los modelos ECMWF y GFS no han dado datos para esta ruta.');
    expect(doc.querySelector('.flight')).toBeNull(); // sectionOnly: sin la ficha
  });
  it('barras: ≤ 56, decorativas (sin botones, data-seg ni #seg-detail: en el v1 no hay detalle que abrir); eje en minutos', () => {
    const bars = [...card.querySelectorAll('#timeline .tbar')];
    expect(bars.length).toBeGreaterThan(3);
    expect(bars.length).toBeLessThanOrEqual(56);
    expect(bars.every(b => b.tagName === 'SPAN' && !b.hasAttribute('data-seg'))).toBe(true);
    expect(card.querySelector(':scope > summary').querySelectorAll('button, [tabindex], [data-seg]')).toHaveLength(0); // tocar la gráfica abre la tarjeta
    expect(card.querySelector('#seg-detail')).toBeNull();
    expect(card.querySelector('.tchart').getAttribute('aria-hidden')).toBe('true');
    expect(bars.filter(b => b.className === 'tbar lvl2').length).toBeGreaterThan(0);
    expect([...card.querySelectorAll('.ticks span')].map(t => t.textContent)).toEqual(['0′', '50′', '100′', '150′']);
  });
  it('al desplegar: veredicto, ¿Qué significa?, fiabilidad y los tramos .seg-card; sin emojis', () => {
    const body = card.querySelector(':scope > .card-body');
    expect(body.querySelector('.reliability')).not.toBeNull();
    expect(body.querySelector('.explain')).not.toBeNull();
    expect([...body.querySelectorAll('.seg-card strong')].map(s => s.textContent)).toEqual(['Min 30–45 · Moderada', 'Min 45–150 · Ligera']);
    expect(el.innerHTML).not.toMatch(/\p{Extended_Pictographic}/u);
    // sectionOnly (#forecast-area): sin aviso legal; lo pone el armazón al final de la ficha (§5.7), una sola vez.
    expect(doc.querySelector('.disclaimer')).toBeNull();
  });
  it('con la ficha (respaldo a pantalla completa): ficha y después la tarjeta', () => {
    const full = { innerHTML: '' };
    renderResult(full, { ...legacy, sectionOnly: false, title: 'PMI → MAD', subtitle: 'x', times: '10:00–11:30',
      flight: { al: 'IB', number: 'IB 1', title: 'IB 1', status: { text: 'Programado', tone: 'ok' }, o: 'PMI', a: 'MAD', dep: null, arr: null } });
    const d = dom(full.innerHTML);
    const flight = d.querySelector('.flight'), turb = d.querySelector('[data-card="turbulence"]');
    expect(flight.compareDocumentPosition(turb) & 4).toBe(4); // DOCUMENT_POSITION_FOLLOWING
    // Pantalla completa: el aviso legal, una vez y al final del resultado.
    expect(d.querySelectorAll('.disclaimer')).toHaveLength(1);
    expect(d.body.lastElementChild.className).toBe('disclaimer');
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


// Ficha rediseñada (spec 2026-10-20 §5.1–5.6, §5.9–5.10): hero, ruta, hora principal, resumen, Ahora, Horario y,
// según la fase, Avión o Resumen del vuelo. Datos de los tests, nunca del código.
const NOW = Date.parse('2026-09-24T14:00:00Z');
const MIN = 60000;
const card = (over = {}) => ({
  al: 'IB', number: 'IB 1668', airline: 'Iberia', title: 'Iberia IB 1668', route: 'Palma a Madrid', tabs: [],
  status: { text: 'Programado', tone: 'ok' }, o: 'PMI', a: 'MAD', duration: 90, cities: { o: 'Palma', a: 'Madrid' },
  dep: { date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D71' },
  arr: { date: '2026-09-24', time: '19:25', est: null, late: false, terminal: '4' },
  aircraft: 'Airbus A321', photo: null, phase: 'programado', source: 'aena', timeConfidence: 'medium', punctuality: null,
  depFinal: false, arrFinal: false, depMs: NOW + 135 * MIN, arrMs: NOW + 225 * MIN, km: 547, ...over,
});
const html = (c, opts = {}) => flightCardHtml(c, { nowMs: NOW, ...opts });
// El <details> de una tarjeta, completo (hasta su cierre).
const block = (h, name) => {
  const i = h.indexOf(`data-card="${name}"`);
  if (i < 0) return '';
  const start = h.lastIndexOf('<', i);
  const tag = h.slice(start + 1, h.indexOf(' ', start));
  return h.slice(start, h.indexOf(`</${tag}>`, i) + tag.length + 3);
};

describe('estructura de la ficha', () => {
  it('orden: hero, ruta, hora principal, resumen, Ahora y Horario dentro de .flight', () => {
    const h = html(card());
    expect(h).toMatch(/^\s*<section class="flight"/);
    const order = ['class="hero', 'class="route-codes', 'class="main-time', 'class="tiles', 'data-card="now"', 'data-card="schedule"'].map(s => h.indexOf(s));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('firma con valores por defecto: flightCardHtml(card) funciona igual que antes (app.js la llama así)', () => {
    expect(flightCardHtml(card())).toContain('class="flight"');
  });
  it('los desplegables abiertos se indican con open (por data-card)', () => {
    const h = html(card(), { open: new Set(['schedule']) });
    expect(h).toMatch(/<details class="card[^"]*" data-card="schedule" open>/);
    expect(h).not.toMatch(/data-card="now" open/);
    expect(html(card())).not.toMatch(/data-card="schedule" open/);
  });
  it('desplegables con <details>/<summary> y chevron', () => {
    const now = block(html(card()), 'now');
    expect(now).toMatch(/^<details class="card[^"]*" data-card="now">\s*<summary/);
    expect(now).toContain('<svg class="icon"');
  });
  it('sin emojis', () => {
    const variants = [card(), card({ status: { text: 'Volando', tone: 'info', flying: true }, phase: 'en-curso',
      radar: { state: 'volando', callsign: 'IBE1668', altM: 10668, altFt: 35000, kmh: 830, seenS: 2, remainingKm: 300 }, radarReceivedAt: NOW }),
    card({ photo: { thumb: 'x.jpg', artist: 'A', license: 'CC', page: 'p' } }), card({ stale: true, updatedAgo: 'hace 2 h' }),
    card({ phase: 'terminado', depFinal: true, arrFinal: true, status: { text: 'Ha llegado', tone: 'ok' } })];
    for (const c of variants) expect(html(c)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('cabecera (hero): foto, número, aerolínea · modelo y estado', () => {
  const photo = { thumb: 'https://upload.wikimedia.org/x/1000px-EI.jpg', artist: 'Pedro Aragão', license: 'CC BY-SA 3.0', page: 'https://commons.wikimedia.org/wiki/File:EI.jpg' };
  const c = card({ al: 'EI', number: 'EI 737', airline: 'Aer Lingus', title: 'Aer Lingus EI 737', route: 'Palma a Dublín', a: 'DUB',
    cities: { o: 'Palma', a: 'Dublín' }, aircraft: 'Airbus A320' });
  it('foto arriba del todo, con autor y licencia (atribución obligatoria)', () => {
    const h = html({ ...c, photo });
    expect(h.indexOf('class="plane-photo"')).toBeLessThan(h.indexOf('<h2>'));
    expect(h).toContain('src="https://upload.wikimedia.org/x/1000px-EI.jpg"');
    expect(h).toContain('<figcaption>Foto: <a href="https://commons.wikimedia.org/wiki/File:EI.jpg" target="_blank" rel="noopener">Pedro Aragão</a>, CC BY-SA 3.0</figcaption>');
  });
  it('foto propia (img/fotos): sin figcaption', () => {
    const h = html({ ...c, photo: { thumb: 'img/fotos/FR%20Boeing%20737-800.jpg' } });
    expect(h).toContain('src="img/fotos/FR%20Boeing%20737-800.jpg"');
    expect(h).not.toContain('<figcaption>');
  });
  it('imagen representativa y código compartido: lo dice el pie', () => {
    expect(html({ ...c, aircraft: null, photo: { ...photo, representative: true } })).toContain('<figcaption>Imagen representativa de la aerolínea · Foto:');
    expect(html({ ...c, photo: { ...photo, shared: true } })).toContain('Vuelo con código compartido: Aena no indica qué aerolínea lo opera. ');
  });
  it('sin foto: sin figura, y el número sigue con el logotipo', () => {
    const h = html({ ...c, photo: null });
    expect(h).not.toContain('plane-photo');
    expect(h).toContain('src="img/logos/EI.png"');
  });
  it('número grande y «Aerolínea · Modelo»; operador distinto en la misma línea', () => {
    const h = html(c);
    expect(h).toContain('<h2>EI 737</h2>');
    expect(h).toContain('<p class="hero-sub">Aer Lingus · Airbus A320</p>');
    expect(html({ ...c, aircraft: null })).toContain('<p class="hero-sub">Aer Lingus</p>');
    expect(html({ ...c, operator: 'Air Nostrum' })).toContain('<p class="hero-sub">Aer Lingus · Airbus A320 · Operado por Air Nostrum</p>');
  });
  it('chip del estado con su tono y la nota debajo', () => {
    const h = html(card({ status: { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B', landing: 'confirmed-landed' }, radar: { state: 'aterrizado' } }));
    expect(h).toMatch(/<span class="chip status tone-ok">Aterrizado<\/span>\s*<p class="status-note">Confirmado por radar ADS-B<\/p>/);
  });
  it('«Volando»: chip con el avión animado (icono SVG, no emoji)', () => {
    const h = html(card({ status: { text: 'Volando', tone: 'info', flying: true }, phase: 'en-curso' }));
    expect(h).toMatch(/<span class="chip status tone-info flying">Volando<span class="fly" aria-hidden="true"><span class="fly-plane"><svg class="icon"/);
  });
});

describe('ruta', () => {
  it('códigos grandes y la ciudad debajo; sin ciudad, solo el código', () => {
    const h = html(card());
    expect(h).toMatch(/<strong>PMI<\/strong>\s*<span>Palma<\/span>/);
    expect(h).toMatch(/<strong>MAD<\/strong>\s*<span>Madrid<\/span>/);
    const none = html(card({ cities: { o: null, a: 'Madrid' } }));
    expect(none).toMatch(/<strong>PMI<\/strong>\s*<\/div>/);
  });
  it('la duración prevista entre los códigos, junto al avión; «≈» si la calcula Turbi; sin duración, solo el avión', () => {
    const mid = h => h.slice(h.indexOf('class="rc-mid"'), h.indexOf('</div>', h.indexOf('class="rc-mid"')));
    expect(mid(html(card()))).toMatch(/rc-arrow[\s\S]*<span class="rc-dur">1 h 30 min<\/span>/);
    expect(mid(html(card({ duration: 157, durationEstimated: true })))).toContain('<span class="rc-dur">≈ 2 h 37 min</span>');
    const none = html(card({ duration: null }));
    expect(none).toContain('class="rc-arrow"');
    expect(none).not.toContain('rc-dur');
  });
});

describe('hora principal', () => {
  it('programado: la salida, su etiqueta y «Sale en»', () => {
    const h = html(card({ dep: { ...card().dep, est: '18:10', late: true } }));
    expect(h).toMatch(/class="mt-time[^"]*">18:10/);
    expect(h).toContain('Salida prevista');
    expect(h).toMatch(/Sale en<\/span>\s*<span class="v">2 h 15 min<\/span>/);
  });
  it('en curso con llegada estimada por Turbi: «Llegada estimada», su nota, «+1 día» y «Llega en»', () => {
    const h = html(card({ phase: 'en-curso', arrMs: NOW + 42 * MIN,
      arr: { date: '2026-09-25', time: '00:40', estimated: true, note: 'Estimación Turbi actualizada en vuelo' } }));
    expect(h).toMatch(/class="mt-time turbi">00:40<small>\+1 día<\/small>/);
    expect(h).toContain('Llegada estimada');
    expect(h).toContain('<p class="mt-note">Estimación Turbi actualizada en vuelo</p>');
    expect(h).toMatch(/Llega en<\/span>\s*<span class="v">42 min<\/span>/);
  });
  it('cancelado: sin hora principal', () => {
    expect(html(card({ phase: 'cancelado', status: { text: 'Cancelado', tone: 'bad' } }))).not.toContain('class="main-time');
  });
});

describe('fila de resumen', () => {
  it('Aena: puntualidad, fuente y confianza', () => {
    const punctuality = { state: 'retrasado', band: 'warn', basis: 'dep', dep: { delay: 20, final: false }, arr: null };
    const h = html(card({ punctuality }));
    expect(h.match(/class="tile"/g)).toHaveLength(3);
    expect(h).toMatch(/Puntualidad<\/span>\s*<span class="v">\+20 min<\/span>/);
    expect(h).toMatch(/Fuente<\/span>\s*<span class="v">Aena<\/span>/);
    expect(h).toMatch(/data-tone="warn"[^>]*>[\s\S]*?Confianza<\/span>\s*<span class="v">Media<\/span>/);
  });
  it('AeroDataBox (sin puntualidad ni confianza): una sola tarjeta, sin huecos', () => {
    const h = html(card({ source: 'aerodatabox', timeConfidence: null, punctuality: null }));
    expect(h.match(/class="tile"/g)).toHaveLength(1);
    expect(h).toContain('AeroDataBox');
  });
  it('confianza muy baja: «Muy baja» en rojo y la línea de información limitada', () => {
    const h = html(card({ timeConfidence: 'very-low' }));
    expect(h).toMatch(/data-tone="bad"[^>]*>[\s\S]*?<span class="v">Muy baja<\/span>/);
    expect(h).toContain('La información puede ser limitada o proceder de fuentes no oficiales.');
    expect(html(card({ timeConfidence: 'high' }))).not.toContain('puede ser limitada');
  });
});

describe('Ahora: puerta de embarque (sin radar)', () => {
  const dep = over => ({ date: '2026-09-24', time: '17:55', est: null, late: false, terminal: 'N', gate: 'D71', ...over });
  it('estado de Aena, terminal y la puerta en su línea propia', () => {
    const now = block(html(card({ dep: dep(), status: { text: 'Embarcando', tone: 'info' } })), 'now');
    expect(now).toContain('Embarcando');
    expect(now).toContain('Terminal N');
    expect(now).toContain('Puerta de embarque');
    expect(now).toMatch(/class="gate[^"]*"[^>]*>[\s\S]*D71/);
  });
  it('solo zona (una letra): lo explica', () => {
    const h = html(card({ dep: dep({ gate: 'H' }) }));
    expect(h).toContain('Zona H');
    expect(h).toContain('la puerta exacta se anuncia más cerca de la salida');
  });
  it('sin asignar: lo dice, sin más explicaciones', () => {
    const h = html(card({ dep: dep({ gate: null }) }));
    expect(h).toContain('Aún sin asignar');
    expect(h).not.toContain('1–2 h antes de la salida');
  });
  it('cambio de puerta destacado', () => {
    expect(html(card({ dep: dep(), gateChanged: true }))).toContain('Cambio de puerta');
  });
  it('escapa la puerta', () => {
    expect(html(card({ dep: dep({ gate: '<b>' }) }))).not.toContain('<b>');
  });
  it('vuelo del histórico o de AeroDataBox: sin puerta', () => {
    expect(html(card({ past: true }))).not.toContain('Puerta de embarque');
    expect(html(card({ source: 'aerodatabox', sourceNote: 'Horario según AeroDataBox · consultado hace 1 min' }))).not.toContain('Puerta de embarque');
  });
});

describe('Ahora: radar', () => {
  const r = { state: 'volando', callsign: 'AEA039', altM: 10668, altFt: 35000, kmh: 851, seenS: 0, remainingKm: 8411, source: 'adsb.lol' };
  const flying = (radar = r, over = {}) => card({ phase: 'en-curso', status: { text: 'Volando', tone: 'info', flying: true }, a: 'DUB',
    arr: null, radar, radarReceivedAt: NOW, ...over });
  const cell = (h, label) => h.match(new RegExp(`<div class="tm-cell[^"]*">\\s*${label}[\\s\\S]*?</div>`))?.[0] ?? '';
  it('volando: cuatro celdas (altitud, velocidad, distancia y última señal)', () => {
    const h = html(flying());
    expect(h.match(/class="tm-cell/g)).toHaveLength(4);
    expect(h).toMatch(/<span class="tm-label">Velocidad<\/span>\s*<span class="tm-value">851<small>km\/h<\/small><\/span>/);
    expect(h).toMatch(/<span class="tm-value tm-remaining">8\.411<small>km<\/small><\/span>/);
  });
  it('altitud en pies con «ft» y los metros aparte', () => {
    const alt = cell(html(flying()), '<span class="tm-icon">[\\s\\S]*?</span>\\s*<span class="tm-label">Altitud');
    expect(alt).toMatch(/<span class="tm-value">35\.000<small>ft<\/small><\/span>/);
    expect(alt).toMatch(/<small class="tm-sub">10\.700 m<\/small>/);
  });
  it('señal: indicador «live» con «Señal radar reciente»; antigua, «Sin señal reciente»', () => {
    const h = html(flying());
    expect(h).toMatch(/<span class="signal" data-signal-level="live">[\s\S]*?Señal radar reciente<\/span>/);
    expect(h).toMatch(/Última señal<\/span>\s*<span class="tm-value">0 s<\/span>/);
    const old = html(flying({ ...r, seenS: 400 }));
    expect(old).toMatch(/data-signal-level="old">[\s\S]*?Sin señal reciente/);
    expect(old).toMatch(/Última señal<\/span>\s*<span class="tm-value">6 min<\/span>/);
    expect(html(flying({ ...r, seenS: 800 }))).toMatch(/data-signal-level="stale"/);
  });
  it('sin instante de recepción: ni «Última señal» ni indicador inventados', () => {
    const h = html(flying(r, { radarReceivedAt: undefined }));
    expect(h).not.toContain('data-signal-level');
    expect(h.match(/class="tm-cell/g)).toHaveLength(3);
  });
  it('si falta un dato, su celda no está (ni «—»)', () => {
    const h = html(flying({ ...r, kmh: null, remainingKm: undefined }));
    expect(h).not.toContain('Velocidad');
    expect(h).not.toContain('tm-remaining');
    expect(h).not.toContain('—');
  });
  it('sin lat/lon no pasa nada (la posición es del mapa)', () => {
    expect(html(flying({ ...r, lat: undefined, lon: undefined })).match(/class="tm-cell/g)).toHaveLength(4);
  });
  it('al desplegar: indicativo y fuente (proveedor solo como title)', () => {
    const now = block(html(flying()), 'now');
    expect(now).toContain('AEA039');
    expect(now).toMatch(/<span class="v" title="Datos ADS-B de adsb\.lol">Radar ADS-B<\/span>/);
    expect(now).not.toMatch(/>[^<]*adsb\.lol/);
  });
  it('identificado por su ruta, o con otro avión: los mismos textos', () => {
    const h = html(flying({ ...r, callsign: 'RYR12AB', match: 'ruta' }));
    expect(h).toContain('<p class="tm-match">Avión localizado por su ruta, posición y modelo: la aerolínea emite con otro indicativo.</p>');
    expect(html(flying())).not.toContain('tm-match');
    expect(html(flying({ ...r, aircraftChanged: true }))).toContain('no es el que AeroDataBox tenía asignado a este vuelo');
  });
  it('«Volando» lo dice el chip del estado (las celdas no lo repiten)', () => {
    const h = html(flying());
    expect(h).toContain('class="chip status tone-info flying"');
    expect(h.match(/Volando/g)).toHaveLength(1);
  });
  it('señal reciente: chip ámbar «Última señal · hace X min», sin panel', () => {
    const h = html(card({ phase: 'en-curso', status: { text: 'Última señal: volando hace 5 min', tone: 'info' }, radar: { state: 'reciente', ageMin: 5 } }));
    expect(block(h, 'now')).toContain('<span class="chip tone-warn">Última señal · hace 5 min</span>');
    expect(h).not.toContain('tm-cell');
  });
  it('localizando: «Buscando el avión en el radar…»', () => {
    const h = html(card({ phase: 'en-curso', radar: { state: 'localizando' } }));
    expect(h).toMatch(/<p class="radar muted">[\s\S]*Buscando el avión en el radar…<\/p>/);
  });
  it('sin señal: el texto corto de siempre, sin indicativo ni deducciones', () => {
    const h = html(card({ phase: 'en-curso', status: { text: 'Ha salido', tone: 'info' }, radar: { state: 'sin-senal' } }));
    expect(h).toMatch(/<p class="radar muted">[\s\S]*Sin señal ADS-B reciente para este vuelo\.<\/p>/);
    expect(h).not.toMatch(/AEA|EIN|indicativo|aterriz/);
    expect(h).not.toContain('tm-cell');
  });
  it('no disponible', () => {
    const h = html(card({ phase: 'en-curso', radar: { state: 'no-disponible' } }));
    expect(h).toContain('El radar no responde ahora mismo.');
    expect(h).not.toContain('tm-cell');
  });
  it('aterrizado: sin «Ahora» ni panel', () => {
    const h = html(card({ status: { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B', landing: 'confirmed-landed' }, radar: { state: 'aterrizado' } }));
    expect(h).not.toContain('data-card="now"');
    expect(h).not.toMatch(/tm-cell|class="radar/);
  });
});

describe('datos de Aena antiguos', () => {
  const c = card({ status: { text: 'Embarcando', tone: 'info' }, updatedAgo: 'hace 2 h', stale: true,
    radar: { state: 'volando', callsign: 'IBE1668', altM: 10668, altFt: 35000, kmh: 830, seenS: 2, remainingKm: 300 }, radarReceivedAt: NOW });
  it('chip gris con «… hace X» y la línea «Datos de Aena de hace X»; sin telemetría', () => {
    const h = html(c);
    expect(h).toContain('<span class="chip status tone-stale">Embarcando hace 2 h</span>');
    expect(h).toContain('Datos de Aena de hace 2 h');
    expect(h).not.toContain('tm-cell');
    expect(h).not.toContain('class="fly"');
  });
  it('datos recientes: sin aviso', () => {
    const h = html({ ...c, stale: false, updatedAgo: 'hace 10 min', radar: null });
    expect(h).not.toContain('Datos de Aena de hace');
    expect(h).toContain('<span class="chip status tone-info">Embarcando</span>');
  });
});

describe('Horario', () => {
  it('cuatro hitos: programada, real o prevista, programada y final, prevista o estimada', () => {
    const h = block(html(card({ dep: { ...card().dep, est: '18:10' }, depFinal: true })), 'schedule');
    expect(h.match(/<li class="ms /g)).toHaveLength(4);
    expect(h).toMatch(/ms-sched[\s\S]*?17:55[\s\S]*?Programada/);
    expect(h).toMatch(/ms-real[\s\S]*?18:10[\s\S]*?Real/);
    expect(h).toMatch(/ms-pending[\s\S]*?--:--[\s\S]*?Pendiente/);
  });
  it('llegada estimada por Turbi: «Estimada», sin programada ni «prevista», y su nota visible', () => {
    const whole = html(card({ arr: { date: '2026-09-24', time: '18:30', estimated: true, note: 'Estimación Turbi' } }));
    const h = block(whole, 'schedule');
    expect(h).toMatch(/ms-turbi[\s\S]*?18:30[\s\S]*?Estimada/);
    expect(h).toContain('Estimación Turbi');
    expect(h).not.toMatch(/[Pp]revista/);
    // Antes del despegue, en toda la ficha (hora principal, resumen, Horario, Avión): nada se llama «prevista».
    expect(whole).not.toMatch(/[Pp]revista/);
  });
  it('terminal de llegada en pequeño bajo el último hito; sin terminal (o estimación Turbi), nada', () => {
    const h = block(html(card()), 'schedule');
    const last = h.slice(h.lastIndexOf('<li class="ms '), h.indexOf('</ol>'));
    expect(last).toMatch(/<span class="ms-side">Llegada<\/span> <span class="ms-term">Terminal 4<\/span><\/li>/);
    expect(h.match(/ms-term/g)).toHaveLength(1);
    expect(block(html(card({ arr: { ...card().arr, terminal: null } })), 'schedule')).not.toContain('ms-term');
    expect(block(html(card({ arr: { date: '2026-09-24', time: '18:30', estimated: true, note: 'x' } })), 'schedule')).not.toContain('Terminal');
  });
  it('avisos de Aena (otra hora, llegada antes del despegue) visibles sin desplegar', () => {
    const punctuality = { state: 'puntual', band: 'ok', basis: 'arr', dep: { sched: '17:55', time: '17:55', delay: 0, alt: ['18:02'] },
      arr: { sched: '19:25', time: '19:25', delay: 0, beforeTakeoff: true } };
    const h = block(html(card({ punctuality })), 'schedule');
    const summary = h.slice(0, h.indexOf('</summary>'));
    expect(summary).toContain('18:02');
    expect(summary).toContain('El avión aún no ha despegado');
  });
  it('contenedor #punctuality en el cuerpo, con el contenido que se le pase', () => {
    const h = block(html(card(), { punctualityBody: '<p>hoy</p>' }), 'schedule');
    expect(h.indexOf('</summary>')).toBeLessThan(h.indexOf('<section id="punctuality">'));
    expect(h).toContain('<section id="punctuality"><p>hoy</p></section>');
    expect(block(html(card()), 'schedule')).toContain('<section id="punctuality"></section>');
  });
  it('pie: cuándo se actualizaron los datos', () => {
    expect(html(card({ updatedAgo: 'hace 25 minutos' }))).toContain('<p class="foot">Datos actualizados hace 25 minutos</p>');
  });
  it('AeroDataBox: de dónde es el horario', () => {
    expect(html(card({ source: 'aerodatabox', sourceNote: 'Horario según AeroDataBox · consultado hace 2 min' })))
      .toContain('<p class="foot">Horario según AeroDataBox · consultado hace 2 min</p>');
  });
  it('vuelo del histórico: de dónde salen las horas', () => {
    const c = card({ past: true, phase: 'terminado', depFinal: true, arrFinal: true, status: { text: 'Ha llegado', tone: 'ok' } });
    expect(html(c)).toContain('<p class="foot">Horas finales publicadas por Aena y guardadas por Turbi.</p>');
    expect(html({ ...c, arr: { date: '2026-09-24', time: '22:50', estimated: true, note: 'x' } }))
      .toContain('<p class="foot">Hora de salida publicada por Aena y guardada por Turbi; la llegada es una estimación de Turbi.</p>');
    expect(html({ ...c, dep: { date: '2026-09-24', time: '08:30', estimated: true, note: 'x' } }))
      .toContain('<p class="foot">Hora de llegada publicada por Aena y guardada por Turbi; la salida es una estimación de Turbi.</p>');
  });
});

describe('aterrizado estimado (estimated-landed)', () => {
  it('chip «Aterrizado», la nota «Según la llegada estimada por Turbi» y la llegada estimada visible', () => {
    const h = html(card({ phase: 'en-curso', durationEstimated: true, depFinal: true,
      status: { text: 'Aterrizado', tone: 'ok', note: 'Según la llegada estimada por Turbi', landing: 'estimated-landed' },
      dep: { ...card().dep, est: '18:12', late: true },
      arr: { date: '2026-09-24', time: '20:32', estimated: true, note: 'Estimación Turbi basada en la duración de la ruta' },
      arrMs: NOW - 60 * MIN }));
    expect(h).toContain('data-phase="finalizado"');
    expect(h).toMatch(/<span class="chip status tone-ok">Aterrizado<\/span>\s*<p class="status-note">Según la llegada estimada por Turbi<\/p>/);
    expect(h).toMatch(/class="mt-time turbi">20:32/); // la llegada estimada, en azul (no es un dato oficial)
    expect(h).toContain('Llegada estimada');
    expect(block(h, 'schedule')).toMatch(/ms-turbi[\s\S]*?20:32[\s\S]*?Estimada/);
    expect(h).toMatch(/Fuente<\/span><span class="v">Estimación Turbi<\/span>/);
    expect(h).not.toMatch(/Aterrizado · radar|Llegada final|telemetry/);
  });
});

describe('fases', () => {
  it('finalizado: sin «Ahora», con «Resumen del vuelo» (distancia directa y duración real)', () => {
    const h = html(card({ phase: 'terminado', depFinal: true, arrFinal: true, status: { text: 'Ha llegado', tone: 'ok' }, depMs: NOW, arrMs: NOW + 85 * MIN }));
    expect(h).not.toContain('data-card="now"');
    const sum = block(h, 'flight-summary');
    expect(sum).toContain('Resumen del vuelo');
    expect(sum).toMatch(/Distancia en ruta directa<\/span>\s*<span class="v">547 km<\/span>/);
    expect(sum).toMatch(/Duración real<\/span>\s*<span class="v">1 h 25 min<\/span>/);
    expect(sum).not.toContain('Tiempo en el aire');
    expect(h).not.toContain('data-card="aircraft"');
  });
  it('finalizado sin horas reales: sin duración (no se calcula sobre una estimación)', () => {
    const sum = block(html(card({ phase: 'terminado', arrFinal: true, status: { text: 'Ha llegado', tone: 'ok' } })), 'flight-summary');
    expect(sum).not.toContain('Duración');
  });
  it('AeroDataBox con horas de pista: tiempo en el aire', () => {
    const sum = block(html(card({ source: 'aerodatabox', phase: 'terminado', depFinal: true, arrFinal: true, status: { text: 'Ha llegado', tone: 'ok' },
      depMs: NOW, arrMs: NOW + 70 * MIN })), 'flight-summary');
    expect(sum).toMatch(/Tiempo en el aire<\/span>\s*<span class="v">1 h 10 min<\/span>/);
  });
  it('programado: tarjeta «Avión»; la matrícula solo si existe (AeroDataBox)', () => {
    const h = html(card());
    const air = block(h, 'aircraft');
    expect(air).toContain('Airbus A321');
    expect(air).not.toContain('Matrícula');
    expect(h).not.toContain('data-card="flight-summary"');
    const adb = block(html(card({ source: 'aerodatabox', aircraftReg: 'EC-ABC', aircraftHex: '34a1b2' })), 'aircraft');
    expect(adb).toMatch(/Matrícula<\/span>\s*<span class="v">EC-ABC<\/span>/);
    expect(adb).toContain('34A1B2');
  });
  it('en curso: sin «Avión» ni «Resumen del vuelo»', () => {
    const h = html(card({ phase: 'en-curso' }));
    expect(h).not.toMatch(/data-card="(aircraft|flight-summary)"/);
  });
  it('cancelado: sin «Ahora»', () => {
    expect(html(card({ phase: 'cancelado', status: { text: 'Cancelado', tone: 'bad' } }))).not.toContain('data-card="now"');
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


// Prueba real en iPhone (FR1104, 20/10/2026): Aena seguía en «Puerta cerrada» con el avión ya en el aire. El estado del
// chip principal sale de withRadar (js/radar.js), sin otra lógica: una lectura ADS-B «volando» gana al estado de puerta
// de Aena; un radar sin lectura actual (sin señal, buscando, avistamiento antiguo) no convierte el vuelo en «Volando».
import { withRadar } from '../js/radar.js';

describe('estado principal: radar «volando» frente al estado de puerta de Aena', () => {
  const chip = h => h.match(/<span class="chip status[^"]*">([^<]*)/)?.[1].trim();
  const cer = () => card({ status: { text: 'Puerta cerrada', tone: 'warn' }, phase: 'pendiente' });
  const flying = { state: 'volando', callsign: 'RYR4AB', altFt: 31000, altM: 9449, kmh: 820, seenS: 3, remainingKm: 900, source: 'adsb.lol' };

  it('Aena «Puerta cerrada» + radar volando → el chip dice «Volando», no «Puerta cerrada»', () => {
    const h = html({ ...withRadar(cer(), flying, null, NOW), radarReceivedAt: NOW });
    expect(chip(h)).toBe('Volando');
    expect(h).not.toMatch(/class="chip status[^"]*">\s*Puerta cerrada/);
  });

  it.each([
    ['sin datos y Aena sin confirmar la salida', { state: 'sin-datos', departureConfirmed: false }, null],
    ['buscando el avión (identificación en curso)', { state: 'sin-datos', identifying: true }, null],
    ['radar no disponible', { state: 'no-disponible' }, null],
    ['último avistamiento de hace 20 min', { state: 'sin-datos' }, NOW - 20 * MIN],
  ])('sin lectura actual (%s) → sigue «Puerta cerrada»', (_, radar, lastSeen) => {
    const h = html(withRadar(cer(), radar, lastSeen, NOW));
    expect(chip(h)).toBe('Puerta cerrada');
    expect(chip(h)).not.toBe('Volando');
  });
});
