import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { flightNoteHtml, summaryHtml, timelineHtml, segmentDetailHtml, altitudeHtml, freshnessHtml, aviationHtml, offlineBanner, renderForecast, flText } from '../js/ui-forecast.js';

const NOW = Date.parse('2026-09-24T10:18:00Z');
const dom = html => new JSDOM(`<body>${html}</body>`).window.document;
const seg = (level, startMin, endMin, extra = {}) => ({ level, startMin, endMin, causes: level ? ['vertical_shear', 'jet_stream'] : [], flMin: 350, flMax: 350, mid: { kmFromOrigin: 180 }, ...extra });
const view = {
  v: 2, flight: null, title: 'PMI → MAD', subtitle: 'IB1668 · Iberia', times: '17:55–19:25', fromCity: 'Palma de Mallorca', toCity: 'Madrid', originIata: 'PMI',
  durationMin: 90,
  summary: { headline: 'Mayormente tranquilo', verdict: 'tranquilo', maxLevel: 2, maxDurationMin: 12, moments: [{ startMin: 42, endMin: 54 }], percentages: [60, 30, 10, 0] },
  confidence: { level: 'alta', reasons: ['faltan menos de 24 h', 'ECMWF y GFS muestran un patrón parecido', 'cobertura meteorológica completa'] },
  segments: [seg(0, 0, 42), seg(2, 42, 54, { place: 'sobre el Golfo de León' }), seg(0, 54, 90)],
  altitudes: [300, 320, 340, 360, 380, 400].map((fl, i) => ({ flightLevel: fl, worst: [1, 1, 2, 1, 0, 0][i], share: [0.3, 0.3, 0.5, 0.2, 0, 0][i], isCruise: fl === 360, calmest: fl >= 380 })),
  models: ['ECMWF', 'GFS'], agreement: { level: 'alta' }, queriedAt: NOW - 18 * 60000, runs: { ECMWF: Date.parse('2026-09-24T00:00:00Z'), GFS: Date.parse('2026-09-24T06:00:00Z') },
};

describe('resumen', () => {
  it('responde: cómo será, máximo, duración, momento, confianza y porcentajes', () => {
    const h = summaryHtml(view);
    expect(forecastSectionHtml(view, NOW)).toContain('Mayormente tranquilo'); // el titular, en «General» (cabecera de la tarjeta)
    for (const t of ['Máximo previsto', 'Turbulencia moderada', 'Duración estimada', '≈ 10 min', 'Momento', 'aprox. 42–54 min después del despegue', 'Confianza', 'Alta',
      'Nula', '60 %', 'Ligera', '30 %', 'Moderada', '10 %', 'Fuerte', '0 %']) expect(h).toContain(t);
    for (const r of view.confidence.reasons) expect(h).toContain(r);
  });
  it('con más de dos tramos indica cuántos más hay (coherente con la duración total)', () => {
    const moments = [{ startMin: 111, endMin: 128 }, { startMin: 264, endMin: 281 }, { startMin: 300, endMin: 320 }, { startMin: 340, endMin: 371 }];
    const h = summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 85, moments } });
    expect(h).toContain('aprox. 111–128 y 264–281 min después del despegue, y 2 tramos más');
  });
  it('sin turbulencia no muestra duración ni momento', () => {
    const h = summaryHtml({ ...view, summary: { headline: 'Tranquilo', maxLevel: 0, maxDurationMin: 0, moments: [], percentages: [100, 0, 0, 0] } });
    expect(h).toContain('Sin turbulencia prevista');
    expect(h).not.toContain('Duración estimada');
  });
  it('confianza sin cálculo', () => {
    expect(summaryHtml({ ...view, confidence: { level: null, reasons: ['falta más de una semana: el pronóstico aún no es útil'] } })).toContain('Sin cálculo');
  });
});

describe('cobertura, frescura y precisión', () => {
  it('con cobertura incompleta avisa en la tarjeta, visible sin desplegarla (condición 2 de Jaime)', () => {
    const doc = dom(forecastSectionHtml({ ...view, coverage: 0.8 }, NOW));
    expect(doc.querySelector('[data-card="turbulence"] > summary').textContent).toContain('Faltan datos en el 20 % de la ruta');
    expect(forecastSectionHtml({ ...view, coverage: 0.96 }, NOW)).not.toContain('Faltan datos');
    expect(forecastSectionHtml({ ...view, coverage: 0.93 }, NOW)).toContain('Faltan datos en el 5 % de la ruta');
  });
  it('la duración se redondea a 5 min', () => {
    expect(summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 23 } })).toContain('≈ 25 min');
    expect(summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 2 } })).toContain('≈ 5 min');
  });
  it('tramos sin datos se distinguen en la barra', () => {
    const h = timelineHtml({ ...view, segments: [seg(0, 0, 90, { missing: true })] });
    expect(h).toContain('class="tbar missing"');
    expect(h).not.toMatch(/class="tbar lvl/);
  });
  it('METAR: antigüedad visible; viejo o ausente, dicho claramente; SIGMET/PIREP no disponibles ≠ ninguno', () => {
    const av = {
      updated: new Date(NOW - 2 * 3600000).toISOString(),
      origin: { icao: 'LEPA', metarText: 'Viento de 230° a 8 kt', metarRaw: 'M', metarAge: 'hace 40 min', metarStale: false, tafText: null },
      destination: { icao: 'LEMD', metarText: null, metarStale: true, tafText: null },
      sigmets: null, pireps: null,
    };
    const h = aviationHtml(av, NOW);
    expect(h).toContain('Viento de 230° a 8 kt (hace 40 min)');
    expect(h).toContain('El último parte tiene más de 3 h: no se muestra');
    expect(h).toContain('Avisos oficiales no disponibles ahora');
    expect(h).toContain('Informes de pilotos no disponibles ahora');
    expect(h).toContain('descargado hace 2 horas');
  });
});

describe('timeline', () => {
  it('cada barra es un botón con el índice de su tramo; detalle con causas, altitud y ubicación', () => {
    const doc = dom(timelineHtml(view));
    const bars = [...doc.querySelectorAll('button[data-seg]')];
    expect(bars.length).toBeGreaterThan(3);
    expect(new Set(bars.map(b => b.dataset.seg))).toEqual(new Set(['0', '1', '2'])); // los tres tramos, por orden
    expect(doc.querySelector('#seg-detail')).not.toBeNull();
    const d = segmentDetailHtml(view.segments[1], 'PMI');
    for (const t of ['Min 42–54', 'Moderada', 'Causa probable', 'Cambio brusco del viento con la altura', 'Corriente de viento muy fuerte en altura', 'Altura del avión', '10,7 km (35.000 pies)', 'Ubicación aproximada', 'sobre el Golfo de León']) expect(d).toContain(t);
  });
  it('sin nombre de lugar usa km desde el origen; tramo nulo sin causas', () => {
    expect(segmentDetailHtml(seg(1, 0, 10), 'PMI')).toContain('a 180 km de PMI');
    expect(segmentDetailHtml(seg(0, 0, 10), 'PMI')).not.toContain('Causa probable');
  });
  it('rango de altitud y suelo', () => {
    expect(flText(300, 360)).toBe('entre 9,1 y 11 km');
    expect(flText(0, 0)).toBe('cerca del suelo');
    expect(flText(0, 90)).toBe('del suelo a unos 2,7 km');
  });
  it('tramo sin datos lo indica', () => {
    expect(segmentDetailHtml(seg(0, 0, 10, { missing: true }), 'PMI')).toContain('faltan datos');
  });
});

describe('condiciones por altitud', () => {
  it('filas FL300–FL400, destaca la más tranquila, marca el crucero y lleva el aviso', () => {
    const h = altitudeHtml(view.altitudes);
    for (const km of ['9,1 km', '9,8 km', '10,4 km', '11 km', '11,6 km', '12,2 km']) expect(h).toContain(km);
    expect(h).not.toContain('pies');
    expect(h).not.toMatch(/FL\d/);
    expect(h).toContain('Más tranquila');
    expect(h).toContain('altura prevista de tu vuelo');
    // Columna de la derecha: solo el porcentaje (cabe en una línea y queda alineado); el título lo explica.
    expect(h).toContain('<span class="share">% del trayecto</span>');
    expect(h).toContain('<span class="share">30 %</span>');
    expect(h).toContain('<span class="share">0 %</span>');
    expect(h).not.toContain('en el ');
    expect(h).toContain('La altitud real del vuelo depende del plan de vuelo, tráfico, control aéreo, peso y condiciones operativas.');
    expect(h).not.toMatch(/deber[ií]a volar/i);
  });
  it('vacía → nada', () => {
    expect(altitudeHtml([])).toBe('');
  });
});

describe('frescura', () => {
  it('distingue consulta realizada y ejecución del modelo', () => {
    const h = freshnessHtml(view, NOW, 'UTC');
    expect(h).toContain('Consulta realizada hace 18 min');
    expect(h).toContain('Previsión del tiempo calculada a las 00:00 (modelo europeo) y a las 06:00 (modelo estadounidense)');
    expect(h).toContain('Los dos modelos coinciden bastante');
  });
  it('sin hora de modelo no la inventa', () => {
    const h = freshnessHtml({ ...view, runs: {} }, NOW, 'UTC');
    expect(h).not.toContain('Previsión del tiempo calculada');
  });
});

describe('Aviation Weather', () => {
  it('METAR/TAF resumidos con el original desplegable; SIGMET; sin PIREP → mensaje prudente', () => {
    const av = {
      updated: '2026-09-24T10:00:00Z',
      origin: { iata: 'PMI', icao: 'LEPA', metarText: 'Viento de 230° a 8 kt', metarRaw: 'METAR LEPA …', tafText: ['Sin fenómenos significativos previstos'], tafRaw: 'TAF LEPA …' },
      destination: { iata: 'MAD', icao: 'LEMD', metarText: null, tafText: null },
      sigmets: [{ label: 'Turbulencia fuerte', levels: 'FL300–FL400', crosses: true, distanceKm: 0, raw: 'SIGMET …' }],
      pireps: [],
    };
    const h = aviationHtml(av, NOW);
    for (const t of ['LEPA', 'Viento de 230° a 8 kt', 'METAR LEPA …', 'TAF LEPA …', 'Turbulencia fuerte', 'FL300–FL400', 'cruza la ruta', 'No hay informes recientes disponibles en esta zona.', 'Sin parte meteorológico disponible']) expect(h).toContain(t);
    expect(h).not.toContain('no hay turbulencia');
  });
  it('sin datos → nada', () => {
    expect(aviationHtml(null)).toBe('');
  });
});

describe('pronóstico guardado', () => {
  it('franja clara, nunca como actualizado', () => {
    expect(offlineBanner(NOW - 2 * 3600000, NOW)).toContain('Pronóstico guardado · consultado hace 2 horas');
  });
});

describe('renderForecast', () => {
  it('monta todas las secciones y el aviso orientativo; escapa HTML', () => {
    const el = { innerHTML: '' };
    renderForecast(el, { ...view, title: '<b>x</b>' }, NOW);
    for (const id of ['trend', 'speak', 'timeline', 'seg-detail', 'altitudes']) expect(el.innerHTML).toContain(`id="${id}"`);
    for (const id of ['aviation', 'map']) expect(el.innerHTML).not.toContain(`id="${id}"`); // van a sus tarjetas (Tareas 6–8)
    expect(el.innerHTML).toContain('Estimación orientativa para pasajeros');
    expect(el.innerHTML).not.toContain('<b>x</b>');
    expect(el.innerHTML).not.toMatch(/no pone en peligro|no pasa nada/);
  });
});

import { flightShellHtml, forecastSectionHtml, forecastUnavailableHtml, FORECAST_UNAVAILABLE, forecastLoadingHtml, forecastNoteHtml, weatherAlertsHtml,
  segmentListHtml, explainHtml } from '../js/ui-forecast.js';
describe('la ficha primero; el pronóstico en su propia sección', () => {
  const flight = { al: 'IB', number: 'IB 1668', airline: 'Iberia', title: 'x', route: 'Palma de Mallorca a Madrid', status: { text: 'Volando', tone: 'info', flying: true },
    o: 'PMI', a: 'MAD', duration: 90, dep: { date: '2026-09-25', time: '17:55', est: null, late: false, terminal: null, gate: 'D86' }, arr: null, aircraft: 'Airbus A321neo',
    radar: { state: 'volando', callsign: 'IBE1668', altM: 10668, kmh: 830, seenS: 2, remainingKm: 300 } };
  const punctuality = { current: { state: 'sin-datos', text: 'x', band: null, dep: null, arr: null, basis: null }, history: undefined, flight: 'IB1668', airline: 'Iberia', route: ['PMI', 'MAD'], dow: 4, slot: 2, since: '2026-09-24' };
  it('armazón: ficha (con el panel ADS-B), puntualidad y la sección de turbulencias «calculando»', () => {
    const html = flightShellHtml({ flight, punctuality });
    expect(html).toContain('class="flight"');
    expect(html).toContain('class="card now telemetry"'); // el radar no depende de la meteorología
    expect(html).toContain('id="punctuality"');
    const area = dom(html).querySelector('#forecast-area');
    expect(area.querySelector('.card h3.section').textContent).toBe('Turbulencias');
    expect(area.querySelector('.card .forecast-loading').textContent).toBe('Calculando la previsión de turbulencias…');
  });
  it('sin cupo en Open-Meteo (429): solo la sección lo dice, con Reintentar y cuándo', () => {
    const err = Object.assign(new Error('Demasiadas consultas seguidas: espera un minuto y vuelve a intentarlo.'), { rateLimited: true, retryAfterMs: 30000 });
    const html = forecastUnavailableHtml(err);
    expect(FORECAST_UNAVAILABLE).toBe('Previsión de turbulencias no disponible temporalmente');
    expect(html).toContain(`<strong>${FORECAST_UNAVAILABLE}</strong>`);
    expect(html).toContain('Open-Meteo ha recibido demasiadas consultas. Puedes reintentar en unos 30 s.');
    expect(html).toContain('<button type="button" id="forecast-retry" class="pill-btn">Reintentar</button>');
    expect(html).not.toContain('class="flight"');
    expect(dom(html).querySelector('.card h3.section').textContent).toBe('Turbulencias');
  });
  it('otros fallos (red, modelos): el mismo aviso con su motivo, y Reintentar', () => {
    const html = forecastUnavailableHtml(new Error('No se pudo conectar con el servicio del tiempo (Open-Meteo).'));
    expect(html).toContain(FORECAST_UNAVAILABLE);
    expect(html).toContain('No se pudo conectar con el servicio del tiempo (Open-Meteo).');
    expect(html).toContain('id="forecast-retry"');
  });
  it('la sección del pronóstico no incluye la ficha (se inserta sin tocarla)', () => {
    const html = forecastSectionHtml({ ...view, flight }, NOW);
    expect(html).not.toContain('class="flight"');
    for (const id of ['trend', 'timeline', 'altitudes']) expect(html).toContain(`id="${id}"`);
  });
});

describe('ficha con aviso (vuelo terminado, sin llegada, cancelado…): la sección Turbulencias sigue ahí', () => {
  it('encabezado Turbulencias y el motivo dentro de su sección', () => {
    const flight = { al: 'UX', title: 'UX 6030', route: 'y', tabs: [], status: { text: 'Ha llegado', tone: 'ok' }, o: 'PMI', a: 'MAD', duration: 75,
      dep: { date: '2026-09-25', time: '10:51', est: null, late: false, terminal: null, gate: null }, arr: null, aircraft: null, updatedAgo: 'hace 1 min', stale: false };
    const html = flightNoteHtml({ flight, punctuality: null, note: 'Este vuelo ya ha aterrizado.' });
    const area = dom(html).querySelector('#forecast-area');
    expect(area.querySelector('.card h3.section').textContent).toBe('Turbulencias');
    expect(area.querySelector('.card .note').textContent).toBe('Este vuelo ya ha aterrizado.'); // mismo texto (app.js lo compara)
    expect(area.querySelector('[data-card="turbulence"]')).toBeNull(); // sin pronóstico no hay tarjeta desplegable
  });
});


// Tarjeta de Turbulencias (spec 2026-10-20 §5.7, §9 bis «Barras», §10.2 y §10 bis.1).
describe('tarjeta de Turbulencias', () => {
  // Perfil en el aire de 120 puntos (como view.route de forecastView): nulo, moderado en el centro, ligero al final.
  const route = Array.from({ length: 120 }, (_, i) => ({ lat: 39, lon: 3 - i / 40, level: i >= 56 && i < 72 ? 2 : i >= 100 ? 1 : 0 }));
  const full = { ...view, durationMin: 119, route, segments: [seg(0, 0, 56), seg(2, 56, 72), seg(0, 72, 100), seg(1, 100, 119)],
    summary: { ...view.summary, moments: [{ startMin: 56, endMin: 72 }] } };
  const card = (v = full, opts) => dom(forecastSectionHtml(v, NOW, opts)).querySelector('details.card.turb[data-card="turbulence"]');
  it('es un <details> con el título «Turbulencias» (h3.section) en su summary', () => {
    const c = card();
    expect(c).not.toBeNull();
    expect(c.hasAttribute('open')).toBe(false);
    expect(c.querySelector(':scope > summary h3.section').textContent).toBe('Turbulencias');
    expect(card(full, { open: new Set(['turbulence']) }).hasAttribute('open')).toBe(true);
  });
  it('barras: como mucho 56, cada una un botón con un data-seg válido y su tramo y nivel en aria-label', () => {
    const bars = [...card().querySelectorAll(':scope > summary #timeline button.tbar')];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThanOrEqual(56);
    for (const b of bars) {
      expect(b.getAttribute('type')).toBe('button');
      expect(Number(b.dataset.seg)).toBeGreaterThanOrEqual(0);
      expect(Number(b.dataset.seg)).toBeLessThan(full.segments.length);
      expect(b.getAttribute('aria-label')).toMatch(/^Min \d+–\d+ · (Nula|Ligera|Moderada|Fuerte|Sin datos)$/);
    }
    expect(bars.some(b => b.classList.contains('lvl2') && b.dataset.seg === '1')).toBe(true);
    expect(bars.find(b => b.classList.contains('lvl2')).getAttribute('aria-label')).toBe('Min 56–72 · Moderada');
  });
  it('punto sin datos (level null) → barra rayada «missing»', () => {
    const holes = route.map((p, i) => (i < 10 ? { ...p, level: null } : p));
    const bars = [...card({ ...full, route: holes }).querySelectorAll('button.tbar')];
    expect(bars[0].className).toBe('tbar missing');
    expect(bars[0].getAttribute('aria-label')).toContain('Sin datos');
  });
  it('«General» con el titular coloreado por el nivel máximo y «Tramo más movido» (horas con la misma zona; si no, minutos)', () => {
    const tz = { originTz: 'Europe/Madrid', destinationTz: 'Europe/Madrid', depMs: Date.parse('2026-09-24T16:00:00Z') };
    const s = card({ ...full, ...tz }).querySelector(':scope > summary');
    expect(s.querySelector('.turb-general').textContent).toContain('General');
    expect(s.querySelector('.turb-general .v').textContent).toBe('Mayormente tranquilo');
    expect(s.querySelector('.turb-general').classList.contains('lvl-ink2')).toBe(true);
    expect(s.querySelector('.turb-span .k').textContent).toBe('Tramo más movido');
    expect(s.querySelector('.turb-span .v').textContent).toBe('18:56 – 19:12');
    // Eje: 3–4 marcas, en horas locales (con su minuto en data-min).
    const ticks = [...s.querySelectorAll('.ticks span')];
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(4);
    expect(ticks[0].textContent).toBe('18:00');
    expect(ticks.at(-1).dataset.min).toBe('119');
    const other = card({ ...full, ...tz, destinationTz: 'Atlantic/Canary' }).querySelector(':scope > summary');
    expect(other.querySelector('.turb-span').textContent).toContain('min 56–72');
    expect([...other.querySelectorAll('.ticks span')].map(t => t.textContent)).toEqual(['0′', '40′', '80′', '119′']);
  });
  it('sin turbulencia no hay «Tramo más movido»', () => {
    const calm = { ...full, summary: { headline: 'Tranquilo', maxLevel: 0, maxDurationMin: 0, moments: [], percentages: [100, 0, 0, 0] } };
    expect(card(calm).querySelector('.turb-span')).toBeNull();
    expect(card(calm).querySelector('.turb-general').classList.contains('lvl-ink0')).toBe(true);
  });
  it('preLanding: el chip exacto «Previsión mostrada antes del aterrizaje»; sin él, nada', () => {
    const chip = card(full, { preLanding: true }).querySelector(':scope > summary .chip');
    expect(chip.textContent).toBe('Previsión mostrada antes del aterrizaje');
    expect(forecastSectionHtml(full, NOW)).not.toContain('antes del aterrizaje');
  });
  it('avisos: 1 SIGMET que cruza la ruta → línea ámbar «1 aviso oficial (SIGMET)» con su etiqueta y «Ver detalles»', () => {
    const aviation = { sigmets: [{ label: 'Turbulencia fuerte', crosses: true, distanceKm: 0, raw: 'x' }], pireps: [] };
    const s = card({ ...full, aviation }).querySelector(':scope > summary');
    const warn = s.querySelector('.wx-alerts .tone-warn');
    expect(warn.textContent).toContain('1 aviso oficial (SIGMET)');
    expect(warn.textContent).toContain('Turbulencia fuerte');
    expect(warn.querySelector('svg.icon')).not.toBeNull();
    expect(s.querySelector('.wx-alerts [data-open="adv-weather"]').textContent).toBe('Ver detalles');
  });
  it('avisos: SIGMET que no cruza y PIREP → sin ámbar; null o vacíos → ninguna .wx-alerts', () => {
    const aviation = { sigmets: [{ label: 'Tormentas', crosses: false }], pireps: [{ label: 'Turbulencia ligera' }, { label: 'x' }] };
    const box = card({ ...full, aviation }).querySelector('.wx-alerts');
    expect(box.querySelector('.tone-warn')).toBeNull();
    expect(box.textContent).toContain('2 informes de pilotos cerca de la ruta');
    expect(card({ ...full, aviation: null }).querySelector('.wx-alerts')).toBeNull();
    expect(card({ ...full, aviation: { sigmets: null, pireps: null } }).querySelector('.wx-alerts')).toBeNull();
    expect(card(full).querySelector('.wx-alerts')).toBeNull();
    expect(dom(weatherAlertsHtml({ sigmets: [], pireps: [] })).querySelector('.wx-alerts')).toBeNull();
  });
  it('al desplegar: confianza con motivos, datos, reparto, tendencia, Escuchar (icono), tramos .seg-card, altitudes y ¿Qué significa?', () => {
    const body = card({ ...full, trend: 'Ha mejorado desde ayer' }).querySelector(':scope > .card-body');
    const t = body.textContent.replace(/\s+/g, ' ');
    for (const x of ['Confianza', 'Alta', ...view.confidence.reasons, 'Máximo previsto', 'Duración estimada', 'Momento', 'Nula 60 %', 'Ha mejorado desde ayer',
      'Condiciones por altitud', '¿Qué significa?']) expect(t).toContain(x);
    expect(body.querySelector('.sharebar')).not.toBeNull();
    const speak = body.querySelector('#speak');
    expect(speak.hidden).toBe(true); // app.js lo muestra si hay voz
    expect(speak.textContent.trim()).toBe('Escuchar previsión');
    expect(speak.querySelector('svg.icon')).not.toBeNull();
    const segs = [...body.querySelectorAll('#segments .seg-card')];
    expect(segs.map(li => li.querySelector('strong').textContent)).toEqual(['Min 56–72 · Moderada', 'Min 100–119 · Ligera']);
    expect(segs[0].textContent).toContain('Cambio brusco del viento con la altura');
    expect(body.querySelector('#altitudes h3.section').textContent).toBe('Condiciones por altitud');
    // Orden del cuerpo: confianza, datos, reparto, tendencia, Escuchar, tramos, altitudes, ¿Qué significa?
    expect(body.querySelector('.facts > :first-child dt').textContent).toBe('Confianza'); // la confianza, lo primero
    const order = ['.facts', '.sharebar', '#trend', '#speak', '#segments', '#altitudes', '.explain:not(.conf)'].map(sel => [...body.querySelectorAll('*')].indexOf(body.querySelector(sel)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
  it('sin tramos con turbulencia, la lista lo dice', () => {
    expect(segmentListHtml({ ...full, segments: [seg(0, 0, 119)] })).toContain('Ningún tramo con turbulencia.');
  });
  it('aviso legal fuera de la tarjeta, al final; sin #aviation ni #map; ningún emoji', () => {
    const doc = dom(`<div id="forecast-area">${forecastSectionHtml({ ...full, aviation: { sigmets: [{ label: 'x', crosses: true }], pireps: [] } }, NOW, { preLanding: true })}</div>`);
    const area = doc.querySelector('#forecast-area');
    expect(area.lastElementChild.className).toBe('disclaimer');
    expect(area.lastElementChild.textContent).toBe('Estimación orientativa para pasajeros a partir de modelos meteorológicos públicos. No es información operacional ni de seguridad.');
    expect(area.querySelector('#aviation, #map')).toBeNull();
    expect(area.innerHTML).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(explainHtml('Turbulento')).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it('estados sin pronóstico: calculando, no disponible y nota, en una tarjeta con el mismo título y sin emojis', () => {
    for (const html of [forecastLoadingHtml(), forecastUnavailableHtml(new Error('x')), forecastNoteHtml('Vuelo cancelado.')]) {
      const c = dom(html).querySelector('.card');
      expect(c.querySelector('h3.section').textContent).toBe('Turbulencias');
      expect(c.dataset.card).toBeUndefined();
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(dom(forecastNoteHtml('a < b')).querySelector('.note').textContent).toBe('a < b');
  });
});
