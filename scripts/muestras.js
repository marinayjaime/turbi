// Muestras LOCALES del rediseño de la ficha (spec 2026-10-20 §8 y §11, Tarea 9): pinta cada estado con objetos card y
// view literales y las MISMAS funciones de presentación que la app (flightCardHtml, flightShellHtml, flightNoteHtml,
// forecastSectionHtml, renderForecast, renderResult, mapCardHtml, advanced*), para capturarlo con Chrome sin interfaz y
// compararlo con la referencia. No calcula nada: los datos son de prueba y solo existen aquí (nunca en js/). El
// marcado de las pantallas (consulta, carga, barra de la ficha) se toma de index.html, no se copia.
// No se publica: no va al SHELL del service worker ni lo enlaza index.html.
import { flightCardHtml, renderResult } from '../js/ui.js';
import { flightShellHtml, flightNoteHtml, forecastSectionHtml, forecastUnavailableHtml, renderForecast, freshnessHtml,
  aviationHtml } from '../js/ui-forecast.js';
import { advancedFlightHtml, advancedHistoryHtml } from '../js/ui-advanced.js';
import { punctualityHtml } from '../js/ui-punctuality.js';
import { arrivalNote, LANDED_NOTE } from '../js/radar.js';
import { icon } from '../js/icons.js';

const MIN = 60000;
const DAY = '2026-10-20';
// Hora local de Madrid y Palma (CEST, UTC+2, ese día) → UTC en ms.
const at = (hhmm, date = DAY) => Date.parse(`${date}T${hhmm}:00+02:00`);
const iso = ms => new Date(ms).toISOString();
const PMI = [39.5517, 2.7388], MAD = [40.4719, -3.5626];

// ---- Pronóstico de prueba (view v2) ----
// segs: [[nivel, desde, hasta, extra]]; el perfil (route) tiene un punto por minuto, en línea recta entre aeropuertos,
// con el nivel del tramo que lo contiene (null en un tramo sin datos).
function forecast({ depMs, durationMin = 75, segs, headline, confidence = 'alta', coverage, aviation = AVIATION, trend = null,
  originTz = 'Europe/Madrid', destinationTz = 'Europe/Madrid', from = PMI, to = MAD } = {}) {
  const segments = segs.map(([level, startMin, endMin, extra = {}]) => ({
    level, startMin, endMin, causes: level ? ['vertical_shear', 'jet_stream'] : [], flMin: 340, flMax: 360,
    mid: { kmFromOrigin: Math.round(((startMin + endMin) / 2 / durationMin) * 540) }, ...extra,
  }));
  const route = Array.from({ length: durationMin + 1 }, (_, m) => {
    let s = segments[0];
    for (const x of segments) if (x.startMin <= m) s = x;
    const f = m / durationMin;
    return { lat: from[0] + (to[0] - from[0]) * f, lon: from[1] + (to[1] - from[1]) * f, level: s.missing ? null : s.level };
  });
  const maxLevel = Math.max(...segments.map(s => s.level));
  const share = l => Math.round((segments.filter(s => s.level === l).reduce((a, s) => a + s.endMin - s.startMin, 0) / durationMin) * 100);
  const rough = segments.filter(s => s.level === maxLevel && maxLevel > 0);
  return {
    v: 2, durationMin, depMs, originTz, destinationTz, originIata: 'PMI', route, segments, coverage, aviation, trend,
    summary: { headline, verdict: headline, maxLevel, maxDurationMin: rough.reduce((a, s) => a + s.endMin - s.startMin, 0),
      moments: rough.map(s => ({ startMin: s.startMin, endMin: s.endMin })), percentages: [0, 1, 2, 3].map(share) },
    confidence: { level: confidence, reasons: confidence === 'baja'
      ? ['faltan más de 3 días', 'los dos modelos coinciden poco'] : ['faltan menos de 24 h', 'los dos modelos coinciden bastante', 'cobertura meteorológica completa'] },
    altitudes: [300, 320, 340, 360, 380, 400].map((fl, i) => ({ flightLevel: fl, worst: [1, 1, Math.min(maxLevel, 2), 1, 0, 0][i],
      share: [0.3, 0.3, 0.4, 0.2, 0, 0][i], isCruise: fl === 360, calmest: fl >= 380 })),
    models: ['ECMWF', 'GFS'], agreement: { level: 'alta' }, queriedAt: depMs - 150 * MIN,
    runs: { ECMWF: Date.parse(`${DAY}T00:00:00Z`), GFS: Date.parse(`${DAY}T06:00:00Z`) },
  };
}
const AVIATION = {
  origin: { icao: 'LEPA', iata: 'PMI', metarText: 'Viento flojo del sur, despejado, 22 °C', metarAge: 'hace 20 min',
    metarRaw: 'LEPA 201530Z 18008KT CAVOK 22/14 Q1016', tafText: ['Sin cambios significativos'], tafRaw: 'TAF LEPA 201100Z 2012/2112 18010KT CAVOK' },
  destination: { icao: 'LEMD', iata: 'MAD', metarText: 'Viento del oeste, algunas nubes, 19 °C', metarAge: 'hace 10 min',
    metarRaw: 'LEMD 201600Z 27012KT FEW040 19/08 Q1018', tafText: ['Rachas de hasta 25 kt por la tarde'], tafRaw: 'TAF LEMD 201100Z 2012/2118 27012G25KT 9999 FEW040' },
  sigmets: [], pireps: [], updated: iso(at('15:30')),
};
const STRONG_AVIATION = { ...AVIATION, sigmets: [{ label: 'Turbulencia fuerte', levels: 'de 9 a 11 km', crosses: true, distanceKm: 0,
  raw: 'LECB SIGMET 3 VALID 201500/201900 LECM- SEV TURB FCST FL300/380', coords: [] }],
pireps: [{ label: 'Turbulencia moderada', altitude: '10,4 km', raw: 'UA /OV LEVC /FL340 /TP A320 /TB MOD', lat: 39.5, lon: -0.5 }] };

const NORMAL = [[0, 0, 8], [1, 8, 30], [2, 30, 43], [1, 43, 62], [0, 62, 75]];

// ---- Fichas de prueba (card de buildFlight con los campos de card-model.js) ----
const PHOTO = { thumb: 'img/fotos-verificadas/IB%20Airbus%20A321neo.jpg', artist: 'Autor de prueba', license: 'CC BY-SA 4.0', page: '#' };
const base = over => ({
  al: 'IB', number: 'IB 1668', airline: 'Iberia', title: 'Iberia IB 1668', route: 'Palma de Mallorca a Madrid', tabs: [],
  o: 'PMI', a: 'MAD', cities: { o: 'Palma de Mallorca', a: 'Madrid' }, duration: 90, aircraft: 'Airbus A321neo', photo: PHOTO,
  source: 'aena', updatedAgo: 'hace 3 min', stale: false, past: false, gateChanged: false, operator: null,
  physicalKey: `PMI-MAD-${DAY}-17:55`, aenaCodes: { st: null, std: null, sta: null },
  dep: { date: DAY, time: '17:55', est: null, late: false, terminal: null, gate: null },
  arr: { date: DAY, time: '19:25', est: null, late: false, terminal: '4' },
  depMs: at('17:55'), arrMs: at('19:25'), km: 547, depFinal: false, arrFinal: false, ...over,
});
const sideP = (sched, time, delay, final, source, extra = {}) => ({ sched, time, delay, final, source, ...extra });
const onTime = { state: 'sin-cambios', text: 'Sin cambios sobre el horario programado', band: 'ok', basis: 'arr',
  dep: sideP('17:55', '17:55', 0, false, 'PMI'), arr: sideP('19:25', '19:25', 0, false, 'MAD', { beforeTakeoff: true }) };
const departed = { state: 'puntual', text: 'Salió puntual', band: 'ok', basis: 'dep', dep: sideP('17:55', '18:03', 8, true, 'PMI'), arr: null };
const volando = (now, over = {}) => ({ state: 'volando', altFt: 35000, altM: 10668, kmh: 812, remainingKm: 286, seenS: 20,
  checked: iso(now), callsign: 'IBE1668', match: 'indicativo', lat: 39.92, lon: 0.31, vRateFpm: 0, source: 'adsb.lol', ...over });
const turbiArr = (time, note = 'Estimación Turbi actualizada en vuelo') => ({ date: DAY, time, estimated: true, note });
// Vuelo en curso con la llegada estimada por Turbi (Aena no la publica), el radar viéndolo y la salida real.
const inFlight = (now, over = {}) => base({
  phase: 'en-curso', status: { text: 'Volando', tone: 'info', flying: true }, timeConfidence: 'medium',
  dep: { date: DAY, time: '17:55', est: '18:03', late: true, terminal: null, gate: 'C52' }, arr: turbiArr('19:18'),
  depFinal: true, depMs: at('18:03'), arrMs: at('19:18'), punctuality: departed,
  radar: volando(now), radarReceivedAt: now, aenaCodes: { st: 'BOR', std: 'BOR', sta: null }, ...over,
});
const scheduled = over => base({ phase: 'pendiente', status: { text: 'Programado', tone: 'ok' }, timeConfidence: 'medium',
  punctuality: onTime, dep: { date: DAY, time: '17:55', est: null, late: false, terminal: null, gate: 'C52' }, ...over });

// Puntualidad (#punctuality) como la pinta app.js al empezar: situación de hoy y el historial aún buscándose.
const punctState = card => (card.source === 'aena' && card.punctuality ? {
  current: card.punctuality, history: undefined, flight: card.number.replace(' ', ''), airline: card.airline, route: [card.o, card.a],
  dow: 2, slot: 2, since: '2026-06-01' } : null);

// ---- Estados ----
// Cada uno devuelve { now, card?, kind, ... }: kind decide qué se pinta (ficha con pronóstico, con nota, …).
const STATES = {
  programado: () => ({ now: at('15:40'), card: scheduled(), view: forecast({ depMs: at('18:05'), segs: NORMAL, headline: 'Algo de movimiento' }) }),
  'en-curso': () => {
    const now = at('18:36');
    return { now, card: inFlight(now), view: forecast({ depMs: at('18:08'), segs: [[0, 0, 6], [1, 6, 28], [2, 28, 40], [1, 40, 70]], durationMin: 70, headline: 'Algo de movimiento' }) };
  },
  finalizado: () => ({ now: at('19:40'), preLanding: true, card: base({
    phase: 'terminado', status: { text: 'Ha llegado', tone: 'ok' }, timeConfidence: 'high',
    dep: { date: DAY, time: '17:55', est: '18:03', late: true, terminal: null, gate: 'C52' }, arr: { date: DAY, time: '19:25', est: '19:21', late: false, terminal: '4' },
    depFinal: true, arrFinal: true, depMs: at('18:03'), arrMs: at('19:21'), aenaCodes: { st: 'IBK', std: 'BOR', sta: 'IBK' },
    punctuality: { state: 'puntual', text: 'Llegó puntual', band: 'ok', basis: 'arr', dep: sideP('17:55', '18:03', 8, true, 'PMI'), arr: sideP('19:25', '19:21', -4, true, 'MAD') },
  }), view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 6], [1, 6, 28], [2, 28, 38], [1, 38, 70]], headline: 'Algo de movimiento' }) }),
  // Lectura del radar de hace más de STALE_MIN: «Sin señal reciente», celdas atenuadas y su antigüedad (§10 bis.2).
  'sin-senal': () => {
    const now = at('18:36');
    return { now, card: inFlight(now, { radar: volando(now, { seenS: 12 * 60 + 20 }), timeConfidence: 'low',
      arr: turbiArr('19:18', 'Última estimación Turbi disponible (hace 12 min, sin señal de radar desde entonces)') }),
    view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 6], [1, 6, 70]], headline: 'Mayormente tranquilo' }) };
  },
  localizando: () => ({ now: at('18:12'), card: inFlight(at('18:12'), { radar: { state: 'localizando' }, status: { text: 'Ha salido', tone: 'info' } }),
    view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 70]], headline: 'Tranquilo' }) }),
  'turb-fuerte': () => ({ now: at('15:40'), card: scheduled(), view: forecast({ depMs: at('18:05'), headline: 'Turbulento', aviation: STRONG_AVIATION,
    segs: [[0, 0, 6], [1, 6, 17], [2, 17, 24], [3, 24, 38], [2, 38, 48], [1, 48, 75]] }) }),
  // Confianza baja de la hora (estimación Turbi sin radar reciente): la línea «La información puede ser limitada…».
  'conf-baja': () => {
    const now = at('18:36');
    return { now, card: inFlight(now, { radar: { state: 'reciente', ageMin: 14 }, timeConfidence: 'low',
      status: { text: 'Última señal: volando hace 14 min', tone: 'info' },
      arr: turbiArr('19:22', 'Última estimación Turbi disponible (hace 14 min, sin señal de radar desde entonces)'), arrMs: at('19:22') }),
    view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 6], [1, 6, 70]], headline: 'Mayormente tranquilo', confidence: 'media' }) };
  },
  // Información incompleta: sin foto, ni modelo, ni ciudades, ni puntualidad, ni confianza, ni puerta; datos del
  // pronóstico incompletos (tramo rayado).
  incompleto: () => ({ now: at('15:40'), card: scheduled({ photo: null, aircraft: null, cities: null, punctuality: null, timeConfidence: null,
    al: 'ZZ', dep: { date: DAY, time: '17:55', est: null, late: false, terminal: null, gate: null }, arr: null, arrMs: null }),
  view: forecast({ depMs: at('18:05'), coverage: 0.7, headline: 'Algo de movimiento',
    segs: [[0, 0, 8], [1, 8, 30], [0, 30, 52, { missing: true }], [2, 52, 62], [0, 62, 75]] }) }),
  'aena-antigua': () => ({ now: at('17:50'), card: scheduled({ stale: true, updatedAgo: 'hace 2 h', status: { text: 'Embarcando', tone: 'info' } }),
    view: forecast({ depMs: at('18:05'), segs: NORMAL, headline: 'Algo de movimiento' }) }),
  'solo-adb': () => ({ now: at('15:40'), card: base({
    al: 'BA', number: 'BA 500', airline: 'British Airways', title: 'British Airways BA 500', o: 'LHR', a: 'LIS',
    cities: { o: 'Londres', a: 'Lisboa' }, route: 'Londres a Lisboa', photo: null, aircraft: 'Airbus A320neo', source: 'aerodatabox',
    sourceNote: 'Horario según AeroDataBox · consultado hace 4 min', updatedAgo: null, phase: 'pendiente',
    status: { text: 'Programado', tone: 'info' }, timeConfidence: null, punctuality: null, aircraftReg: 'G-TTNA', aircraftHex: '406b0f',
    dep: { date: DAY, time: '17:10', est: '17:25', late: true, terminal: null }, arr: { date: DAY, time: '19:55', est: '20:05', late: true, terminal: null },
    depMs: at('18:25'), arrMs: at('21:05'), km: 1564,
  }), view: forecast({ depMs: at('18:35'), durationMin: 150, originTz: 'Europe/London', destinationTz: 'Europe/Lisbon', headline: 'Mayormente tranquilo',
    segs: [[0, 0, 20], [1, 20, 60], [0, 60, 150]] }) }),
  retrasado: () => ({ now: at('15:40'), card: scheduled({
    status: { text: 'Retrasado · sale 18:40', tone: 'warn' }, dep: { date: DAY, time: '17:55', est: '18:40', late: true, terminal: null, gate: 'C52' },
    arr: { date: DAY, time: '19:25', est: '20:10', late: true, terminal: '4' }, depMs: at('18:40'), arrMs: at('20:10'),
    punctuality: { state: 'retrasado', text: 'Llegada prevista con 45 min de retraso', band: 'late', basis: 'arr',
      dep: sideP('17:55', '18:40', 45, false, 'PMI', { alt: ['18:30'] }), arr: sideP('19:25', '20:10', 45, false, 'MAD', { beforeTakeoff: true }) },
  }), view: forecast({ depMs: at('18:50'), segs: NORMAL, headline: 'Algo de movimiento' }) }),
  cancelado: () => ({ now: at('15:40'), note: 'Vuelo cancelado.', card: scheduled({ phase: 'cancelado', status: { text: 'Cancelado', tone: 'bad' },
    timeConfidence: null, punctuality: { state: 'cancelado', text: 'Vuelo cancelado', band: 'bad', dep: null, arr: null, basis: null },
    aenaCodes: { st: 'CAN', std: 'CAN', sta: 'CAN' } }) }),
  desviado: () => ({ now: at('18:50'), card: inFlight(at('18:50'), { status: { text: 'Desviado', tone: 'bad' }, radar: null, radarReceivedAt: null,
    timeConfidence: null, punctuality: { state: 'desviado', text: 'Vuelo desviado', band: 'bad', dep: null, arr: null, basis: null } }),
  view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 6], [1, 6, 70]], headline: 'Mayormente tranquilo' }) }),
  tramos: () => ({ now: at('15:40'), legs: true, card: scheduled(), view: forecast({ depMs: at('18:05'), segs: NORMAL, headline: 'Algo de movimiento' }) }),
  alias: () => ({ now: at('15:40'), alias: true }),
  'aterrizado-adsb': () => {
    const now = at('19:20');
    return { now, preLanding: true, card: inFlight(now, { status: { text: 'Aterrizado', tone: 'ok', note: 'Confirmado por radar ADS-B', landing: 'confirmed-landed' },
      radar: { state: 'aterrizado' }, radarReceivedAt: now, arr: turbiArr('19:16'), arrMs: at('19:16'), timeConfidence: 'medium' }),
    view: forecast({ depMs: at('18:08'), durationMin: 70, segs: [[0, 0, 6], [1, 6, 28], [2, 28, 40], [1, 40, 70]], headline: 'Algo de movimiento' }) };
  },
  // Consultado ya aterrizado (Aena final): la nota de arrivalNote sustituye al pronóstico.
  'aterrizado-oficial': () => {
    const now = at('19:50');
    const card = STATES.finalizado().card;
    return { now, card, note: arrivalNote({ leg: { st: 'IBK', sta: 'IBK' }, officialMs: card.arrMs, nowMs: now }) ?? LANDED_NOTE };
  },
  'prev-no-disponible': () => ({ now: at('15:40'), card: scheduled(), unavailable: { message: 'Sin conexión o el servicio no responde.' } }),
  simplificado: () => ({ now: at('15:40'), card: scheduled(), legacy: { verdict: 'movimiento', reliability: 'alta', durationMin: 75, sectionOnly: true,
    segments: [{ level: 0, startMin: 0, endMin: 20, cause: null }, { level: 2, startMin: 20, endMin: 35, cause: 'ellrod' }, { level: 1, startMin: 35, endMin: 75, cause: 'shear' }] } }),
  semana: () => ({ now: at('15:40'), note: 'Falta más de una semana: vuelve a consultar más cerca de la fecha.', card: scheduled({
    dep: { date: '2026-10-30', time: '17:55', est: null, late: false, terminal: null, gate: null }, arr: { date: '2026-10-30', time: '19:25', est: null, late: false, terminal: '4' },
    depMs: at('17:55', '2026-10-30') + 60 * MIN, arrMs: at('19:25', '2026-10-30') + 60 * MIN, punctuality: null }) }),
  consulta: () => ({ screen: 'query' }),
  carga: () => ({ screen: 'loading' }),
  // Pronóstico guardado sin conexión: cabecera simple (sin ficha), franja ámbar y la tarjeta de Turbulencias.
  'sin-conexion': () => ({ now: at('15:40'), saved: true,
    view: { ...forecast({ depMs: at('18:05'), segs: NORMAL, headline: 'Algo de movimiento' }), flight: null, title: 'PMI → MAD',
      subtitle: 'IB 1668 · Iberia', times: '17:55–19:25', saved: at('12:10') } }),
};

// Selector de tramos y oferta de alias: el marcado de app.js (legSwitchHtml / aliasOfferHtml, no exportadas) con las
// mismas clases y atributos, solo para verlas aquí.
const LEGS = `<nav class="leg-switch" aria-label="Tramos de este vuelo">${[
  ['Barcelona → Palma de Mallorca', 'BCN → PMI · sale 15:05 · Ha llegado', false],
  ['Palma de Mallorca → Madrid', 'PMI → MAD · sale 17:55 · Programado', true]].map(([r, s, sel]) => `<button type="button" class="leg-option${
  sel ? ' selected' : ''}"${sel ? ' aria-current="true"' : ''}><strong>${r}</strong><small>${s}</small></button>`).join('')}</nav>`;
const ALIAS = `<section class="alias-offer" aria-label="Vuelo publicado por Aena con otro número">
    <p class="leg-title">Aena publica este vuelo como IB 1668 · Iberia</p><p class="alias-route"><strong>Palma de Mallorca → Madrid</strong> <small>PMI → MAD</small></p>
    <button type="button" class="primary" data-alias="accept">Ver IB 1668</button>
    <button type="button" class="link" data-alias="reject">No es este vuelo</button>
  </section>`;

function index(root) {
  root.innerHTML = `<div class="muestras-index">${Object.keys(STATES).map(id => `<a href="scripts/muestras.html?estado=${id}">${id}</a>`).join('<br>')}</div>`;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get('estado');
  const root = document.getElementById('muestras');
  if (!STATES[id]) { index(root); return; }
  // Las pantallas, tal cual están en index.html.
  const doc = new DOMParser().parseFromString(await (await fetch('index.html')).text(), 'text/html');
  root.replaceWith(doc.querySelector('main'));
  const $ = sel => document.querySelector(sel);
  $('#back').innerHTML = icon('back', { size: 24 });
  $('#refresh').innerHTML = icon('refresh', { size: 22 });
  const s = STATES[id]();
  const show = name => { for (const v of ['query-view', 'result-view', 'loading']) $(`#${v}`).hidden = v !== name; };
  if (s.screen === 'query') { show('query-view'); return; }
  if (s.screen === 'loading') { show('loading'); return; }
  show('result-view');
  $('#change-time').hidden = true;
  const result = $('#result');
  // Desplegables abiertos: ?abrir=advanced,turbulence (los mismos data-card que conserva el repintado).
  const open = new Set((params.get('abrir') ?? '').split(',').filter(Boolean));
  if (s.alias) { $('#refresh').hidden = true; result.innerHTML = ALIAS; return; }
  if (s.saved) { $('#change-time').hidden = false; renderForecast(result, s.view, s.now); return; }

  const { card, now } = s;
  const punct = punctState(card);
  result.innerHTML = (s.legs ? LEGS : '') + (s.note ? flightNoteHtml({ flight: card, punctuality: punct, note: s.note })
    : flightShellHtml({ flight: card, punctuality: punct }));
  // Como repaintFlight: la ficha con la hora de la muestra (los armazones la pintan con Date.now()).
  $('.flight').outerHTML = flightCardHtml(card, { nowMs: now, open, punctualityBody: punct ? punctualityHtml(punct) : '' });
  const area = $('#forecast-area');
  if (s.view) area.innerHTML = forecastSectionHtml(s.view, now, { preLanding: Boolean(s.preLanding), open });
  else if (s.unavailable) area.innerHTML = forecastUnavailableHtml(s.unavailable);
  else if (s.legacy) renderResult(area, s.legacy);
  // Detalles avanzados, como paintAdvancedFlight / paintHistory / paintAviation y forecastExtras (#fresh).
  $('[data-card="advanced"]').open = open.has('advanced');
  $('#adv-flight').innerHTML = advancedFlightHtml(card, { open, nowMs: now });
  $('#adv-history').innerHTML = advancedHistoryHtml({ queriedAt: s.view?.queriedAt, aenaUpdatedAgo: card.updatedAgo ?? null, trend: s.view?.trend ?? null }, now, { open });
  if (s.view) {
    $('#aviation').innerHTML = aviationHtml(s.view.aviation, now);
    $('details[data-card="adv-weather"]').hidden = false;
    $('#fresh').innerHTML = freshnessHtml(s.view, now);
  }
}

main().finally(() => document.documentElement.setAttribute('data-listo', ''));
