import { buildRoute } from './route.js';
import { localToUtcMs, formatLocal } from './time.js';
import { fetchRouteWeather, allowRetry } from './weather.js';
import { analyze, reliability } from './turbulence.js';
import { lookupFlightResult, canonicalRoute, icaoCallsign } from './flight.js';
import { aliasOffer, adsbdbVetoes } from './aliases.js';
import { fetchAdb, adbTimes, adbInfo, adbPhysical, adbStatusText, sourceNote, adbPhysicalKey, adbRadarGate, adbPhase } from './adb.js';
import { fetchSchedule, loadAirlines, flightTitle, chooseLeg, legByKey, legDeparture, legArrival, flightStatus, isLate, legPhase, aenaFinal } from './schedule.js';
import { startStatusRefresh, refreshMode } from './status-refresh.js';
import { physicalFlightKey } from './physical-flight.js';
import { loadAirports, findAirport, searchAirports, timezoneOf } from './airports.js';
import { nameSegments } from './places.js';
import { renderResult, esc, flightCardHtml, missingDateText, thousands, signalHtml, tmOldHtml } from './ui.js';
import { distanceReference, startRemainingTicker, TICK_MS } from './radar-distance.js';
import { buildProfile } from './altitude.js';
import { forecastWindow } from './airtime.js';
import { forecastView, aviationView } from './forecast.js';
import { fetchModelRuns } from './models.js';
import { renderForecast, timelineHtml, segmentDetailHtml, freshnessHtml, aviationHtml, offlineBanner,
  flightShellHtml, flightNoteHtml, forecastSectionHtml, forecastUnavailableHtml, forecastLoadingHtml, forecastNoteHtml, segmentListHtml,
  weatherAlertsHtml } from './ui-forecast.js';
import { recordSnapshot, forecastTrend, saveLast, loadLast, flightKey, agoText } from './storage.js';
import { loadAviation } from './aviation-weather.js';
import { createRouteMap, wireMapCard, mapTitle, mapFactsHtml } from './map.js';
import { flightPhase, signalState, planeOnMap, positionAgeS, ageText, PLANE_MAX_AGE_S } from './card-model.js';
import { advancedFlightHtml, advancedHistoryHtml, ageSuffix } from './ui-advanced.js';
import { buildSpeech, canSpeak, speak } from './speech.js';
import { currentPunctuality, fetchPunctuality, fetchPastFlights, dowOf, slotOf } from './punctuality.js';
import { punctualityHtml } from './ui-punctuality.js';
import { aircraftName } from './plain.js';
import { loadAirlinePhotos, photoFor, operatorName } from './airline-photos.js';
import { wantsRadar, fetchRadar, fetchAdbRadar, withRadar, presentStatus, arrivalNote, radarNote, ENDED_ESTIMATED, NO_ARRIVAL_NOTE, LANDED_NOTE,
  rememberSighting, recallSighting, withLanding, rememberLanding, recallLanding, pollRadar, endedNote } from './radar.js';
import { turbiEstimate, etaSide, departureUtcMs, departureEstimate, recallEta, rememberEta } from './eta.js';
import { LIVE_BASE } from './config.js';
import { BUILD_ID } from './build.js';
import { icon } from './icons.js';

const PUNCTUALITY_SINCE = '2026-09-24'; // primer día del histórico de puntualidad

const $ = id => document.getElementById(id);
const els = {
  queryView: $('query-view'), resultView: $('result-view'), form: $('query-form'),
  number: $('f-number'), origin: $('f-origin'), destination: $('f-destination'),
  date: $('f-date'), time: $('f-time'), manual: $('manual'), toggleManual: $('toggle-manual'),
  notice: $('notice'), airportsList: $('airports-list'), result: $('result'), back: $('back'),
  changeTime: $('change-time'), refresh: $('refresh'), loading: $('loading'), error: $('error'),
  errorMsg: $('error-msg'), retry: $('retry'), timeField: $('time-field'), savedLink: $('saved-link'),
  updateNotice: $('update-notice'), updateApp: $('update-app'),
};

document.documentElement.dataset.turbiBuild = BUILD_ID;
// Barra de la ficha: «Nueva consulta» y «Actualizar» son botones de solo icono (su nombre accesible es el aria-label
// del HTML). Los SVG salen de js/icons.js para no duplicarlos en el HTML.
els.back.innerHTML = icon('back', { size: 24 });
els.refresh.innerHTML = icon('refresh', { size: 22 });

let lastQuery = null;
let runId = 0; // solo la consulta más reciente puede pintar
let airportsDb = null;
let currentView = null; // pronóstico v2 en pantalla (para la timeline interactiva)
// Cálculo simplificado (v1) pintado en la sección Turbulencias de ESTA ficha (no tiene currentView): §10.2 lo conserva
// igual que el v2 al aterrizar. Vuelve a null con cada búsqueda (run) y al quitar la ficha (clearFicha).
let legacyOnScreen = null;

function show(view) {
  els.queryView.hidden = view !== 'query';
  els.resultView.hidden = view !== 'result';
  els.loading.hidden = view !== 'loading';
  if (view !== 'error') els.error.hidden = true;
}

// canRetry: el fallo vino de la red (se puede repetir la misma consulta).
function showError(msg, canRetry = false) {
  show('query');
  els.errorMsg.textContent = msg;
  els.retry.hidden = !canRetry;
  els.error.hidden = false;
  if (canRetry) offerSaved();
}

// Sin conexión: ofrece abrir el último pronóstico guardado (dejando claro que no está actualizado).
function offerSaved() {
  const last = loadLast();
  els.savedLink.hidden = !last;
  if (last) els.savedLink.textContent = `Ver el último pronóstico guardado (${last.view.title} · ${agoText(Date.now() - last.savedAt)})`;
}

function setNotice(message = '') {
  els.notice.textContent = message;
  els.notice.hidden = !message;
}

// La hora solo se pide cuando no tenemos el horario del vuelo.
function setTimeNeeded(on, message = '') {
  els.timeField.hidden = !on;
  setNotice(message);
}

function setManual(on, message = '') {
  adsbRoute = null;
  aliasState = null;
  els.manual.hidden = !on;
  els.number.closest('.field').hidden = on;
  els.toggleManual.textContent = on ? 'Buscar por nº de vuelo' : 'Introducir a mano';
  setTimeNeeded(on, message);
}

// Número comercial que Aena publica con otro número (BA8462 → CJ8462): se ofrece y el usuario confirma.
// { input: número normalizado, date, offer, adsb (resultado de ADSBDB, para seguir si no lo confirma), accepted }
let aliasState = null;
// «No es este vuelo» para un número y fecha: no se vuelve a ofrecer al seguir (p. ej. al escoger un tramo de AeroDataBox).
let aliasDeclined = null;

// Ruta que ADSBDB da para el número escrito (no oficial): se enseña con origen y destino editables antes de consultar.
// { input: número normalizado, flight: ruta con aeropuertos canónicos }
let adsbRoute = null;
const numberKey = n => String(n).toUpperCase().replace(/\s+/g, '');

function showAdsbRoute(number, flight) {
  setManual(false);
  adsbRoute = { input: numberKey(number), flight };
  els.manual.hidden = false; // el nº de vuelo sigue visible, con origen y destino debajo
  els.origin.value = flight.origin.iata;
  els.destination.value = flight.destination.iata;
  setTimeNeeded(true, `Aena no publica este vuelo. Ruta según ADSBDB (no oficial): ${flight.origin.city} (${flight.origin.iata}) → `
    + `${flight.destination.city} (${flight.destination.iata}). Corrige origen o destino si no es correcta e indica la hora de salida.`);
  els.time.focus();
}

async function airports() {
  if (!airportsDb) airportsDb = await loadAirports();
  return airportsDb;
}

// Tramo que el usuario ha escogido para un número y una fecha con varios vuelos físicos ({ number, date, key }).
let legPick = null;

async function scheduleQuery(schedule, date) {
  // Solo el vuelo de la fecha pedida: si ese día no está, se dice (nunca se enseña otro día).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
  const number = `${schedule.al}${schedule.n}`;
  // Un número puede tener varios vuelos físicos esa fecha (p. ej. GRU → MAD y MAD → PEK): chooseLeg solo elige si
  // es seguro; si no, el usuario escoge por ruta.
  let { leg, choices } = chooseLeg(schedule.legs, date, Date.now());
  // Fecha pasada que Aena ya no publica: el vuelo sale del histórico (horas finales de Aena guardadas por Turbi).
  if (!leg && !choices.length && date < today) {
    const past = chooseLeg(await fetchPastFlights(schedule.al, schedule.n, date), date, Date.now());
    ({ leg, choices } = past);
  }
  const picked = legPick?.number === number && legPick.date === date ? legByKey(choices, legPick.key) : null;
  if (picked) leg = picked;
  const db = await airports();
  const options = choices.map(l => legOption(l, db));
  if (!leg && choices.length) return { kind: 'choose', number, schedule, date, options };
  if (!leg) {
    throw new Error(missingDateText(number, date, [...new Set(schedule.legs.map(l => l.d))].sort(), today));
  }
  const origin = findAirport(db, leg.o);
  const destination = findAirport(db, leg.a);
  if (!origin || !destination) throw new Error(`No conozco el aeropuerto «${!origin ? leg.o : leg.a}».`);
  return { kind: 'schedule', number, schedule, leg, origin, destination, date: leg.d, options, legKey: physicalFlightKey(leg) };
}

// Un tramo, para escogerlo por su ruta: «São Paulo → Madrid · llega 07:10 · Ha llegado».
function legOption(leg, db) {
  const city = iata => findAirport(db, iata)?.city ?? iata;
  const dep = legDeparture(leg), arr = legArrival(leg);
  const when = leg.sd && dep ? `sale ${dep.time}` : arr ? `llega ${arr.time}` : '';
  return { key: physicalFlightKey(leg), route: `${city(leg.o)} → ${city(leg.a)}`, iata: `${leg.o} → ${leg.a}`, when, status: flightStatus(leg).text };
}

// Selector de tramo: pantalla para escoger (sin tramo elegido) o fila de rutas encima de la ficha (con tramo elegido).
function legSwitchHtml(q, { choose = false } = {}) {
  if (!(q.options?.length > 1)) return '';
  const date = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(Date.parse(`${q.date}T12:00:00Z`));
  const buttons = q.options.map(o => `<button type="button" class="leg-option${o.key === q.legKey ? ' selected' : ''}" data-leg-key="${esc(o.key)}"${
    o.key === q.legKey ? ' aria-current="true"' : ''}><strong>${esc(o.route)}</strong><small>${esc([o.iata, o.when, o.status].filter(Boolean).join(' · '))}</small></button>`).join('');
  const title = choose ? `<p class="leg-title">El ${esc(q.number.replace(/^(\w{2})/, '$1 '))} tiene ${q.options.length} vuelos el ${esc(date)}. ¿Cuál quieres ver?</p>`
    : `<p class="leg-title">Este número tiene ${q.options.length} vuelos el ${esc(date)}:</p>`;
  return `<nav class="leg-switch" aria-label="Tramos de este vuelo" data-number="${esc(q.number)}" data-date="${esc(q.date)}">${title}${buttons}</nav>`;
}

// «Aena publica este vuelo como CJ 8462 · BA CITYFLYER» + ruta(s) respaldada(s) + [Ver CJ 8462] / No es este vuelo.
function aliasOfferHtml(q, db) {
  const { alias, legs } = q.offer;
  const city = iata => findAirport(db, iata)?.city ?? iata;
  const target = `${alias.al} ${alias.n}`;
  const routes = [...new Set(legs.map(l => `${l.o}|${l.a}`))].map(r => r.split('|'))
    .map(([o, a]) => `<p class="alias-route"><strong>${esc(city(o))} → ${esc(city(a))}</strong> <small>${esc(o)} → ${esc(a)}</small></p>`).join('');
  return `<section class="alias-offer" aria-label="Vuelo publicado por Aena con otro número">
    <p class="leg-title">Aena publica este vuelo como ${esc(target)}${alias.name ? ` · ${esc(alias.name)}` : ''}</p>${routes}
    <button type="button" class="primary" data-alias="accept">Ver ${esc(target)}</button>
    <button type="button" class="link" data-alias="reject">No es este vuelo</button>
  </section>`;
}

// Pantalla de elección (selector de tramos, confirmación de un número comercial): aún no hay ficha, así que
// «Actualizar» y «Cambiar hora» no tienen sentido y se ocultan (run() los vuelve a poner con la ficha).
function showChoice(html) {
  lastQuery = null;
  ++runId; // nada de una consulta anterior puede pintar encima
  stopRadarPoll();
  stopStatusRefresh();
  clearFicha();
  currentView = null;
  els.refresh.hidden = true;
  els.changeTime.hidden = true;
  els.result.innerHTML = html;
  show('result');
}

async function showAliasOffer(q) {
  const html = aliasOfferHtml(q, await airports());
  showChoice(html);
}

function showLegChooser(q) {
  showChoice(legSwitchHtml(q, { choose: true }));
}

async function resolveFlight() {
  const date = els.date.value, time = els.time.value;
  if (!date) throw new Error('Indica la fecha.');

  // Segunda pulsación con la ruta de ADSBDB en pantalla (mismo número): origen y destino, tal como estén ahora.
  if (adsbRoute && adsbRoute.input === numberKey(els.number.value)) {
    if (!time) throw new Error('Indica la hora de salida.');
    const { origin, destination } = await typedAirports();
    const { flight } = adsbRoute;
    const same = origin.iata === flight.origin.iata && destination.iata === flight.destination.iata;
    // Si el usuario corrige la ruta, ya no es la de ADSBDB: se quita la nota (el número sigue siendo el suyo).
    return { number: flight.number, airline: flight.airline, origin, destination, date, time, ...(same ? { routeSource: 'adsbdb' } : {}) };
  }

  if (els.manual.hidden || adsbRoute) {
    const number = els.number.value.trim();
    if (!number) throw new Error('Escribe el número de vuelo.');
    const input = numberKey(number);
    // Candidato ya confirmado (mismo número y fecha): se vuelve a pedir con los datos de ahora.
    if (aliasState?.accepted && aliasState.input === input && aliasState.date === date) {
      const offer = await aliasOffer(number, date);
      if (offer) return scheduleQuery(offer.schedule, date);
      aliasState = null; // ya no hay candidato: búsqueda normal
    }
    const schedule = await fetchSchedule(number);
    if (schedule) return scheduleQuery(schedule, date);
    // Aena no publica el número: ¿lo asocia a otro que sí publica? Con candidato, ADSBDB (una sola vez) sirve de veto
    // si da otra ruta y de alternativa si el usuario no lo confirma.
    const declined = aliasDeclined?.input === input && aliasDeclined.date === date;
    const offer = declined ? null : await aliasOffer(number, date);
    let adsb = null;
    if (offer) {
      adsb = await lookupFlightResult(number);
      if (!adsbdbVetoes(adsb, offer.legs)) {
        aliasState = { input, date, offer, adsb, accepted: false };
        return { kind: 'alias', number: input, date, offer };
      }
    }
    return afterAena(number, date, adsb);
  }

  if (!time) throw new Error('Indica la hora de salida.');
  const { origin, destination } = await typedAirports();
  return { number: '', airline: '', origin, destination, date, time };
}

// Sin horario de Aena (ni alias confirmado): AeroDataBox (vía Render) → ADSBDB → entrada manual.
// adsb: resultado de ADSBDB si ya se consultó (para el veto del alias); si no, solo se consulta si AeroDataBox no da el vuelo.
async function afterAena(number, date, adsb = null) {
  const adb = await fetchAdb(number, date);
  if (adb.status === 'found' && adb.legs?.length) {
    const q = await adbQuery(number, date, adb);
    if (q !== undefined) return q;
  }
  let route = adsb ?? await lookupFlightResult(number);
  if (route.status === 'unknown') route = (await adsbdbByIcao(number)) ?? route;
  return adsbFallback(number, route);
}

// ADSBDB no conoce el número comercial tal cual (404), pero quizá sí su indicativo OACI: su catálogo de aerolíneas puede
// estar desactualizado (p. ej. un IATA reasignado). Traducción con el catálogo de Aena (airlines.json, OACI única para
// ese IATA) y UNA consulta con OACI + el mismo número. Solo vale si ADSBDB devuelve exactamente esa aerolínea (OACI) y
// ese indicativo; su IATA (y su nombre de aerolínea) se ignoran, porque pueden estar desactualizados. El número que se
// muestra sigue siendo el que escribió el usuario. null = nada (entrada manual, como siempre).
async function adsbdbByIcao(number) {
  const target = icaoCallsign(number, await loadAirlines());
  if (!target) return null;
  const r = await lookupFlightResult(target.callsign);
  if (r.status !== 'found' || r.airlineIcao !== target.icao || r.callsignIcao !== target.callsign) return null;
  return { ...r, flight: r.flight && { ...r.flight, number: numberKey(number), airline: '' } };
}

// Vuelo encontrado por AeroDataBox: sus aeropuertos y horarios del día (ADSBDB no manda sobre una instancia fechada).
// Varios tramos → el selector de siempre. undefined = no se puede usar (sigue ADSBDB).
async function adbQuery(number, date, adb) {
  const db = await airports();
  const legs = adb.legs;
  const physical = legs.map(adbPhysical);
  const keys = physical.map(physicalFlightKey);
  const input = numberKey(number);
  const picked = legPick?.number === input && legPick.date === date ? legs[keys.indexOf(legPick.key)] : null;
  if (!picked && legs.length > 1) {
    const city = iata => findAirport(db, iata)?.city ?? iata;
    const options = legs.map((l, i) => ({ key: keys[i], route: `${city(l.o)} → ${city(l.a)}`, iata: `${l.o} → ${l.a}`,
      when: `sale ${l.dep.sched.local.slice(11, 16)}`, status: adbStatusText(l.status) ?? '' }));
    return { kind: 'choose', number: input, date, options, legKey: null };
  }
  const leg = picked ?? legs[0];
  const origin = findAirport(db, leg.o), destination = findAirport(db, leg.a);
  if (!origin || !destination) {
    setManual(true, `AeroDataBox da la ruta ${leg.o} → ${leg.a}, pero no tengo alguno de esos aeropuertos: introdúcelo a mano.`);
    return null;
  }
  const { dep, durationMin } = adbTimes(leg);
  const meta = { number: adb.number ?? input, date: adb.date ?? date, fetchedAt: adb.fetchedAt, refreshedAt: adb.refreshedAt };
  return {
    kind: 'adb', number: leg.number || input, airline: leg.airline ?? '', origin, destination,
    date: dep.local.slice(0, 10), time: dep.local.slice(11, 16), depUtcMs: dep.utc, durationMin,
    routeSource: 'aerodatabox', adbInfo: adbInfo(adb, leg), adbLeg: leg, adbMeta: meta, adbKey: adbPhysicalKey(meta, leg),
  };
}

// Sin horario: la ruta de ADSBDB para revisar o, si no hay ruta utilizable, la entrada manual.
async function adsbFallback(number, adsb) {
  const flight = adsb.flight && canonicalRoute(adsb.flight, await airports());
  if (!flight) {
    setManual(true, adsb.flight
      ? `ADSBDB da la ruta ${adsb.flight.origin.iata} → ${adsb.flight.destination.iata}, pero no tengo alguno de esos aeropuertos: introdúcelo a mano.`
      : 'No encuentro ese vuelo, introdúcelo a mano.');
    return null;
  }
  showAdsbRoute(number, flight);
  return null;
}

// Origen y destino escritos en el formulario, resueltos en data/airports.json (con su zona horaria).
async function typedAirports() {
  if (!els.origin.value.trim() || !els.destination.value.trim()) throw new Error('Indica los aeropuertos de origen y destino.');
  const db = await airports();
  const origin = findAirport(db, els.origin.value);
  const destination = findAirport(db, els.destination.value);
  if (!origin) throw new Error(`No conozco el aeropuerto «${els.origin.value.trim()}».`);
  if (!destination) throw new Error(`No conozco el aeropuerto «${els.destination.value.trim()}».`);
  return { origin, destination };
}

// Salida en UTC y duración real (si el horario trae la llegada).
function flightTimes(q, oTz, dTz) {
  // Sin horario de Aena: la hora escrita o la de AeroDataBox (con su duración real, si la da).
  if (q.kind !== 'schedule') return { departureMs: q.depUtcMs ?? localToUtcMs(q.date, q.time, oTz), durationMin: q.durationMin ?? null };
  const dep = legDeparture(q.leg), arr = legArrival(q.leg);
  const arrMs = arr ? localToUtcMs(arr.date, arr.time, dTz) : null;
  if (!dep) {
    // Solo sabemos la llegada (origen extranjero): la salida se estima por la distancia.
    const est = buildRoute(q.origin, q.destination, 0).durationMin;
    return { departureMs: arrMs - est * 60000, durationMin: est };
  }
  const departureMs = departureUtcMs(q.leg, oTz); // final de Aena antes que la programada
  const dur = arrMs ? Math.round((arrMs - departureMs) / 60000) : null;
  return { departureMs, durationMin: dur > 0 && dur < 20 * 60 ? dur : null };
}

// eta: llegada estimada por Turbi (solo si Aena no publica la llegada); durationEstimated: la duración es un cálculo.
// depEstimate: lado «Salida estimada» cuando Aena solo da la llegada (departureEstimate).
function flightCard(q, durationMin, photos = null, eta = null, visibleArrivalMs = null, depEstimate = null) {
  const { leg, schedule, origin, destination } = q;
  const dep = legDeparture(leg), arr = legArrival(leg);
  const punctuality = currentPunctuality(leg);
  return {
    al: schedule.al,
    title: flightTitle(schedule),
    number: `${schedule.al} ${schedule.n}`, airline: schedule.name ?? null, photo: photoFor(photos, leg, schedule.al), operator: operatorName(photos, leg, schedule.al),
    route: `${origin.city} a ${destination.city}`,
    // Estado mostrado: con la misma llegada visible que la ficha (Aena o estimación Turbi); ver presentStatus.
    status: presentStatus({ leg, city: destination.city, visibleArrivalMs, arrivalSource: arr ? 'aena' : 'turbi' }),
    o: leg.o, a: leg.a, duration: durationMin, durationEstimated: !arr,
    dep: leg.sd ? { date: leg.d, time: leg.sd, est: dep.time !== leg.sd ? dep.time : null, late: isLate(leg, 'dep'), terminal: leg.td, gate: leg.g }
      : depEstimate,
    arr: arr ? { date: arr.date, time: leg.sa, est: arr.time !== leg.sa ? arr.time : null, late: isLate(leg, 'arr'), terminal: leg.ta } : etaSide(eta),
    aircraft: aircraftName(leg.ac),
    gateChanged: ['NPT', 'NPR'].includes(leg.std ?? leg.st),
    updatedAgo: !leg.past && schedule.updated ? agoText(Date.now() - Date.parse(schedule.updated)) : null,
    stale: !leg.past && schedule.updated ? Date.now() - Date.parse(schedule.updated) > 40 * 60000 : false,
    past: Boolean(leg.past),
    // Para el modelo de presentación (js/card-model.js): lo que ya deciden legPhase, currentPunctuality y eta.js, tal cual.
    ...presentationFields({ phase: legPhase(leg), punctuality, timeConfidence: eta?.confidence ?? null, source: 'aena', q,
      physicalKey: physicalFlightKey(leg), aenaCodes: { st: leg.st ?? null, std: leg.std ?? null, sta: leg.sta ?? null } }),
  };
}

// Campos del card que consume js/card-model.js (los mismos en Aena y AeroDataBox; el HTML actual no los usa).
// depFinal / arrFinal: hora real (final) de cada lado; cities: la ciudad de findAirport (null si no se conoce).
function presentationFields({ phase, punctuality = null, depFinal = punctuality?.dep?.final ?? false, arrFinal = punctuality?.arr?.final ?? false,
  timeConfidence = null, source, q, aircraftReg = null, aircraftHex = null, physicalKey, aenaCodes = null }) {
  return {
    phase, depFinal: Boolean(depFinal), arrFinal: Boolean(arrFinal), timeConfidence, punctuality, source,
    cities: { o: q.origin?.city ?? null, a: q.destination?.city ?? null }, aircraftReg, aircraftHex, physicalKey, aenaCodes,
  };
}

// Ficha de un vuelo de AeroDataBox (no es de Aena): horas del día según AeroDataBox (programada y, si cambia, la
// revisada o la real), modelo y estado tal como estaban al consultar; sin puerta, foto ni puntualidad. El pie dice la
// fuente y cuándo se consultó. El radar (si procede) se pinta encima con el mismo panel que los vuelos de Aena.
const ADB_TONES = { Delayed: 'warn', Canceled: 'bad', CanceledUncertain: 'bad', Diverted: 'bad', Arrived: 'ok' };
function adbCard(q, durationMin) {
  const leg = q.adbLeg;
  const m = String(leg.number || q.number).match(/^([A-Z0-9]{2})(\d+[A-Z]?)$/);
  const [al, n] = m ? [m[1], m[2]] : [String(q.number).slice(0, 2), String(q.number).slice(2)];
  const { dep, arr } = adbTimes(leg);
  const side = (sched, best) => (sched ? { date: sched.local.slice(0, 10), time: sched.local.slice(11, 16),
    est: best && best.utc !== sched.utc ? best.local.slice(11, 16) : null, late: Boolean(best && best.utc > sched.utc), terminal: null }
    : best ? { date: best.local.slice(0, 10), time: best.local.slice(11, 16), est: null, late: false, terminal: null } : null);
  const at = Date.parse(q.adbMeta.refreshedAt ?? q.adbMeta.fetchedAt);
  return {
    al, title: flightTitle({ name: leg.airline, al, n }), number: `${al} ${n}`, airline: leg.airline ?? null, photo: null, operator: null,
    route: `${q.origin.city} a ${q.destination.city}`,
    status: { text: adbStatusText(leg.status) ?? 'Horario de AeroDataBox', tone: ADB_TONES[leg.status] ?? 'info' },
    o: leg.o, a: leg.a, duration: durationMin, durationEstimated: false,
    dep: side(leg.dep.sched, dep), arr: side(leg.arr.sched, arr), aircraft: leg.aircraft ?? null,
    gateChanged: false, stale: false, past: false, sourceNote: `Horario según AeroDataBox · consultado ${agoText(Date.now() - at)}`,
    // Fase: traducción directa del estado de AeroDataBox; final: hora de pista. Sin puntualidad ni confianza (no hay ETA).
    ...presentationFields({ phase: adbPhase(leg.status), depFinal: leg.dep.runway, arrFinal: leg.arr.runway, source: 'aerodatabox', q,
      aircraftReg: leg.reg ?? null, aircraftHex: leg.modeS ?? null, physicalKey: q.adbKey }),
  };
}

// Situación de hoy (inmediata) + histórico (se carga después). Solo vuelos con horario de Aena.
function punctualityState(q) {
  const { leg, schedule } = q;
  return {
    current: currentPunctuality(leg), history: undefined, flight: q.number, airline: schedule.name ?? schedule.al,
    route: [leg.o, leg.a], dow: dowOf(leg.d), slot: leg.sd ? slotOf(leg.sd) : null, since: PUNCTUALITY_SINCE,
  };
}

// Por vuelo físico, no por número + fecha: dos tramos del mismo número el mismo día no comparten aterrizaje, señal ni ETA.
const etaKey = q => `${q.schedule.al}${q.schedule.n}|${physicalFlightKey(q.leg)}`;

// Llegada estimada por Turbi (Aena no publica la llegada), con la última ETA en vuelo de este vuelo para suavizar.
// (en el histórico, solo la última ETA calculada en vuelo que siga guardada: ver turbiEstimate).
function turbiEta(q, ctx, radar = null) {
  if (q.kind !== 'schedule' || !ctx) return null;
  return turbiEstimate({ leg: q.leg, ...ctx, radar, prev: recallEta(etaKey(q)) });
}

// Vuelo salido hacia un aeropuerto que no es de Aena: se pregunta al radar y se redibuja la ficha con lo que diga
// (estado ADS-B y, si la llegada es una estimación Turbi, esa estimación refinada en vuelo). Si el servidor sigue
// identificando el avión por su ruta, se vuelve a mirar en segundo plano (pollRadar) hasta tener un resultado
// definitivo, cambiar de búsqueda, desaparecer la ficha o agotar los sondeos. Solo se espera la primera respuesta.
let radarPoll = null;
function stopRadarPoll() { radarPoll?.cancel(); radarPoll = null; stopDistance(); }
// Distancia restante «en vivo» (js/radar-distance.js): solo repinta el número; cero peticiones.
// El contador de señal (más abajo) va con ella: se para y se reinicia a la vez, con cada lectura real.
let distanceTicker = null;
function stopDistance() { distanceTicker?.stop(); distanceTicker = null; stopSignal(); }

// Vuelo de AeroDataBox: «ha aterrizado» solo con la hora real (de pista) de llegada; si solo pasó la prevista, se dice así.
function adbArrivalNote(q, profile) {
  if (q.adbLeg?.arr?.runway) return 'Este vuelo ya ha aterrizado.';
  return profile.arrivalMs < Date.now() ? 'La hora prevista de llegada ya ha pasado: no se muestra la previsión de turbulencias.' : null;
}

// Clave del vuelo para avistamientos y aterrizajes guardados: el vuelo físico de Aena o el de AeroDataBox (nunca se mezclan).
const radarKey = q => (q.kind === 'adb' ? q.adbKey : etaKey(q));

// Radar de un vuelo de AeroDataBox: mismo sondeo, mismo panel y misma distancia restante que los de Aena. Solo si la
// regla compartida (adbRadarGate) lo permite: dentro de la ventana del vuelo. Sin exigir transpondedor ni indicativo:
// con Flightradar24 el servidor lo busca por su número comercial (sin FR24, el servidor responde «no-aplica»).
async function showAdbRadar(q, flight, stale, ctx) {
  if (!flight || !LIVE_BASE) return;
  if (adbRadarGate(q.adbLeg, q.adbMeta, Date.now(), { plannedMin: ctx?.plannedMin, requireIdentifier: false }).mode === 'none') return;
  stopRadarPoll();
  const cardVisible = () => Boolean(els.result.querySelector('.flight')) && !els.result.closest('[hidden]');
  const poll = pollRadar({
    fetchOnce: ({ poll: isPoll }) => fetchAdbRadar(q.adbMeta.number, q.adbMeta.date, q.adbKey, undefined, undefined, { poll: isPoll }),
    onResult: radar => paintRadar(q, flight, radar, ctx, stale),
    isActive: () => !stale() && cardVisible(),
  });
  radarPoll = poll;
  await poll.first;
}

async function showRadar(q, flight, stale, ctx = null) {
  if (q.kind === 'adb') return showAdbRadar(q, flight, stale, ctx);
  if (!flight || flight.stale || !q.leg || q.leg.past) return;
  if (!wantsRadar(q.leg, undefined, { originTz: timezoneOf(q.origin), destTz: timezoneOf(q.destination), plannedMin: ctx?.plannedMin })) return;
  stopRadarPoll();
  q.etaCtx = ctx;
  const cardVisible = () => Boolean(els.result.querySelector('.flight')) && !els.result.closest('[hidden]');
  const poll = pollRadar({
    // El mismo vuelo físico en la primera consulta y en todos los sondeos.
    fetchOnce: ({ poll: isPoll }) => fetchRadar(q.schedule.al, q.schedule.n, undefined, undefined, { poll: isPoll, leg: physicalFlightKey(q.leg) }),
    onResult: radar => paintRadar(q, flight, radar, ctx, stale),
    isActive: () => !stale() && cardVisible(),
  });
  radarPoll = poll;
  await poll.first;
}

function paintRadar(q, flight, radar, ctx, stale) {
  // Aena ya confirmó la llegada (o canceló/desvió): ninguna lectura ADS-B, ni una respuesta tardía, la contradice.
  if (q.kind === 'schedule' && aenaFinal(q.leg)) return;
  if (radar) q.lastRadar = radar;
  flight = q.flightBase ?? flight; // la tarjeta con el último estado de Aena (refrescado)
  rememberSighting(radarKey(q), radar);
  rememberLanding(radarKey(q), radar);
  let card = withRadar(flight, radar, recallSighting(radarKey(q)));
  if (flight.arr?.estimated) {
    const eta = turbiEta(q, ctx, radar);
    rememberEta(etaKey(q), eta);
    // Nueva ETA visible → el estado se recalcula con ella (y el radar, si lo ve, sigue mandando).
    // La hora principal («Llega en») y la «Confianza» de la ficha siguen a esa misma ETA (js/card-model.js): arrMs es
    // la llegada visible en UTC y timeConfidence, la confianza que ya da eta.js (como en flightCard).
    const base = etaSide(eta)
      ? { ...flight, arr: etaSide(eta), arrMs: eta.ms, timeConfidence: eta.confidence ?? null,
        status: presentStatus({ leg: q.leg, city: q.destination.city, visibleArrivalMs: eta.ms }) }
      : { ...flight, arr: null, arrMs: null, timeConfidence: eta?.confidence ?? null,
        status: presentStatus({ leg: q.leg, city: q.destination.city, visibleArrivalMs: null }) };
    card = withRadar(base, radar, recallSighting(radarKey(q)));
  }
  // Aterrizaje confirmado (ahora o antes, guardado): gana a «volando» y a «Ha salido»; nunca a Aena.
  const landedAt = recallLanding(radarKey(q));
  card = withLanding(card, landedAt, q.kind === 'adb' ? {} : q.leg);
  // Momento en que llegó esta lectura «volando» (envejecimiento de «Última señal» y del avión en js/card-model.js); el
  // mismo instante que toma la distancia animada como referencia.
  const receivedAt = Date.now();
  if (card !== flight && card.radar?.state === 'volando') card = { ...card, radarReceivedAt: receivedAt };
  const el = els.result.querySelector('.flight');
  if (stale() || card === flight || !el) return;
  // Cada lectura real es la nueva referencia de la distancia y de la señal (las anteriores se descartan en el acto).
  stopDistance();
  // Solo se sustituye la tarjeta .flight (con su estado: repaintFlight): la sección Turbulencias no se toca.
  repaintFlight(card, stale);
  if (card.radar?.state === 'volando') {
    distanceTicker = startRemainingTicker({
      ref: distanceReference(card.radar, receivedAt),
      isActive: () => !stale() && !els.result.closest('[hidden]'),
      render: km => {
        const value = els.result.querySelector('.tm-remaining');
        if (!value?.firstChild) return false;
        value.firstChild.textContent = thousands(km);
        return true;
      },
    });
  }
  // El aviso de llegada no puede contradecir al radar (en el aire) ni a un aterrizaje confirmado.
  const note = els.result.querySelector('.note');
  const replacement = Number.isFinite(landedAt) ? LANDED_NOTE : radarNote(radar);
  if (replacement && [ENDED_ESTIMATED, NO_ARRIVAL_NOTE].includes(note?.textContent)) note.textContent = replacement;
  // Aterrizado según el radar con el pronóstico de esta consulta en pantalla: se conserva, con su etiqueta (§10.2).
  if (card.radar?.state === 'aterrizado' && forecastOnScreen() && !$in('forecast-area').querySelector('.pre-landing')) {
    paintPreLanding();
  }
}

// Estado oficial de Aena mientras el vuelo está en curso (js/status-refresh.js): solo /flights/AL/N.json, siempre el
// mismo vuelo físico, sin ADS-B ni meteorología. Se para con la llegada final, cancelado/desviado, otra búsqueda,
// otro tramo o al salir de la ficha.
let statusRefresh = null;
function stopStatusRefresh() { statusRefresh?.stop(); statusRefresh = null; }

// Refresco del estado de Aena (puerta, estado, horas) de la ficha: continuo en curso o desde 6 h antes de la salida;
// un solo intento si los datos son de hace más de 30 min y el vuelo queda más lejos (refreshMode). Nunca terminado,
// cancelado ni desviado, ni un vuelo del histórico.
function watchAena(q, stale) {
  stopStatusRefresh();
  if (q.kind !== 'schedule' || q.leg.past || !LIVE_BASE) return;
  // Salida (estimada o programada) en UTC; sin salida publicada (origen extranjero), la llegada.
  const dep = legDeparture(q.leg), arr = legArrival(q.leg);
  const depMs = dep ? localToUtcMs(dep.date, dep.time, timezoneOf(q.origin)) : arr ? localToUtcMs(arr.date, arr.time, timezoneOf(q.destination)) : null;
  const mode = refreshMode({ phase: legPhase(q.leg), depMs, updatedMs: Date.parse(q.schedule.updated ?? ''), nowMs: Date.now() });
  if (mode === 'none') return;
  const { al, n } = q.schedule;
  const getJson = async url => {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' }); return res.ok ? await res.json() : null; } catch { return null; }
  };
  statusRefresh = startStatusRefresh({
    key: physicalFlightKey(q.leg),
    initialUpdated: q.schedule.updated,
    fetchLive: () => getJson(`${LIVE_BASE}/flights/${al}/${n}.json`),
    fetchPages: () => getJson(`data/flights/${al}/${n}.json`),
    isOver: aenaFinal,
    isActive: () => !stale() && Boolean(els.result.querySelector('.flight')) && !els.result.closest('[hidden]'),
    onLeg: (leg, updated) => { applyAenaLeg(q, leg, updated, stale).catch(() => {}); },
    once: mode === 'once',
  });
}

// El tramo de Aena refrescado (el MISMO vuelo físico): pasa a ser el de la consulta y se repinta solo la tarjeta.
async function applyAenaLeg(q, leg, updated, stale) {
  if (stale() || physicalFlightKey(leg) !== physicalFlightKey(q.leg)) return;
  q.leg = leg; // q es lastQuery: «Actualizar» y cualquier acción posterior usan ya el estado nuevo
  q.schedule = { ...q.schedule, updated: updated ?? q.schedule.updated };
  const { flight, officialMs, eta, departureMs } = await buildFlight(q);
  if (stale()) return;
  q.flightBase = flight;
  const el = els.result.querySelector('.flight');
  if (!el) return;
  if (aenaFinal(leg)) {
    // Aena gana: fuera la telemetría, el radar y la distancia animada.
    stopRadarPoll();
    repaintFlight(flight, stale);
    const flags = [leg.st, leg.std, leg.sta];
    // Llegada final con el pronóstico de esta consulta ya pintado: se conserva con «Previsión mostrada antes del
    // aterrizaje» (§10.2), sin calcular ni pedir nada. Cancelado o desviado: la nota, aunque lo hubiera.
    if (!flags.includes('CAN') && !flags.includes('DES') && forecastOnScreen()) {
      paintPreLanding();
      return;
    }
    const note = flags.includes('CAN') ? 'Vuelo cancelado.' : flags.includes('DES') ? 'Vuelo desviado.'
      : endedNote(leg) ?? arrivalNote({ leg, officialMs, eta, departureMs, nowMs: Date.now() });
    const area = $in('forecast-area');
    if (note && area) area.innerHTML = forecastNoteHtml(note); // la nota, en la tarjeta con el título «Turbulencias»
    return;
  }
  // Sin estado final: con el radar mostrando «Volando», su telemetría manda y no se toca (la distancia sigue su curso).
  if (q.lastRadar?.state === 'volando') return;
  if (q.lastRadar) paintRadar(q, flight, q.lastRadar, q.etaCtx, stale);
  else repaintFlight(flight, stale);
}

async function loadPunctualityHistory(q, punct, stale) {
  if (!punct) return; // sin puntualidad (vuelos que no son de Aena)
  punct.history = await fetchPunctuality(q.schedule.al, q.schedule.n, `${q.leg.o}-${q.leg.a}`);
  const el = $in('punctuality');
  if (!stale() && el) el.innerHTML = punctualityHtml(punct);
}

// La tarjeta del vuelo a partir de q (y su tramo de Aena). Se usa al buscar y en cada refresco del estado de Aena
// (sin tocar la meteorología). Zonas horarias de data/airports.json: nunca se piden por la red.
async function buildFlight(q) {
  const oTz = timezoneOf(q.origin), dTz = timezoneOf(q.destination);
  const { departureMs, durationMin } = flightTimes(q, oTz, dTz);
  // profile: horario de BLOQUE (oficial o estimado). Lo usan la ficha, la ETA, el radar y los avisos: no se toca.
  const profile = buildProfile(q.origin, q.destination, departureMs, durationMin);
  // forecastProfile: solo para el pronóstico de turbulencias, sobre la ventana EN EL AIRE (js/airtime.js). Con AeroDataBox,
  // sus horas de pista (reales) mandan.
  const runway = q.kind === 'adb' ? q.adbLeg : null;
  const air = forecastWindow({ km: profile.km, blockDepartureMs: profile.departureMs, blockArrivalMs: profile.arrivalMs,
    runwayDepartureMs: runway?.dep?.runway?.utc ?? null, runwayArrivalMs: runway?.arr?.runway?.utc ?? null });
  const forecastProfile = buildProfile(q.origin, q.destination, air.forecastTakeoffMs, air.forecastAirborneMin);
  // Llegada: la de Aena si la publica; si no, estimación Turbi (salida + duración estimada, en la hora del destino).
  const etaCtx = { depUtcMs: departureMs, plannedMin: profile.durationMin, tz: dTz };
  const eta = turbiEta(q, etaCtx);
  // La llegada visible (una sola fuente para la ficha, el estado y el aviso): Aena o la estimación Turbi.
  const official = q.kind === 'schedule' ? legArrival(q.leg) : null;
  const officialMs = official ? localToUtcMs(official.date, official.time, dTz) : null;
  const visibleArrivalMs = officialMs ?? (eta?.source === 'turbi' ? eta.ms : null);
  // Aterrizaje ADS-B ya confirmado; si Aena ya dio un estado final, manda Aena.
  const landedAt = q.kind === 'schedule' && !aenaFinal(q.leg) ? recallLanding(etaKey(q)) : q.kind === 'adb' ? recallLanding(q.adbKey) : null;
  const flight = q.kind === 'schedule'
    ? withLanding(flightCard(q, profile.durationMin, await loadAirlinePhotos(), eta, visibleArrivalMs,
      departureEstimate({ leg: q.leg, arrivalUtcMs: officialMs, plannedMin: profile.durationMin, tz: oTz })), landedAt, q.leg)
    : q.kind === 'adb' ? withLanding(adbCard(q, profile.durationMin), landedAt, {}) : null;
  // Para js/card-model.js (cuentas «Sale en / Llega en / Duración»): la salida y la llegada visibles en UTC, sin calcular
  // nada nuevo. En AeroDataBox, la llegada visible es su mejor hora (adbTimes), la misma que muestra la ficha.
  const arrMs = q.kind === 'adb' ? adbTimes(q.adbLeg).arr?.utc ?? null : visibleArrivalMs;
  if (flight) Object.assign(flight, { depMs: departureMs, arrMs, km: profile.km });
  return { oTz, dTz, departureMs, durationMin, profile, forecastProfile, air, etaCtx, eta, officialMs, landedAt, flight };
}

// handoff: traspaso de «Actualizar» (refreshHandoff). Solo si la consulta nueva es del MISMO vuelo físico se conserva
// la presentación (mapa, desplegables, scroll, sin pantalla de carga); la consulta es exactamente la de siempre.
async function run(q, handoff = null) {
  lastQuery = q;
  const token = ++runId;
  stopRadarPoll(); // la búsqueda anterior deja de sondear el radar
  stopStatusRefresh(); // y de refrescar el estado de Aena
  const same = handoff && handoff.key === physicalOf(q) ? handoff : null;
  // El mapa se queda fuera de clearFicha y lo recoge mountMap con el armazón nuevo. Dos pulsaciones seguidas: la
  // segunda hereda el que conservó la primera y aún no se montó (si no, clearFicha lo destruiría).
  const kept = same ? (keptMap ?? keepMap()) : null;
  if (kept) keptMap = null;
  clearFicha(); // y su mapa
  keptMap = kept;
  if (same) reopen = new Set(same.open);
  const stale = () => token !== runId;
  els.refresh.hidden = false;
  if (!same) show('loading'); // «Actualizar» del mismo vuelo: la ficha sigue a la vista mientras se consulta
  try {
    const { oTz, dTz, departureMs, durationMin, profile, forecastProfile, etaCtx, eta, officialMs, landedAt, flight } = await buildFlight(q);
    if (stale()) return;
    const punct = flight && q.kind === 'schedule' ? punctualityState(q) : null; // la puntualidad es de Aena
    els.changeTime.hidden = Boolean(flight) || q.routeSource === 'aerodatabox'; // con AeroDataBox la hora no es del usuario
    const rel = reliability(departureMs, Date.now());
    // Aviso de llegada: solo con la llegada que muestra la ficha (Aena o estimación Turbi visible), nunca con la
    // duración interna de buildProfile. En la consulta manual (sin horario de Aena) se usa la del perfil, como antes.
    const arrived = q.kind === 'schedule'
      ? arrivalNote({ leg: q.leg, officialMs, eta, departureMs, nowMs: Date.now() })
      : q.kind === 'adb' ? adbArrivalNote(q, profile)
      : profile.arrivalMs < Date.now() ? 'Este vuelo ya ha aterrizado.' : null;
    const landedNote = Number.isFinite(landedAt) && [ENDED_ESTIMATED, NO_ARRIVAL_NOTE].includes(arrived) ? LANDED_NOTE : null;
    const note = landedNote ?? arrived ?? (rel === null ? 'Falta más de una semana: vuelve a consultar más cerca de la fecha.'
      : q.leg?.st === 'CAN' || ['Canceled', 'CanceledUncertain'].includes(q.adbLeg?.status) ? 'Vuelo cancelado.'
      : null);
    if (note) {
      if (!flight) throw new Error(note);
      currentView = null;
      els.result.innerHTML = legSwitchHtml(q) + flightNoteHtml({ flight, punctuality: punct, note }); // la sección Turbulencias, con el motivo
      show('result');
      initFicha(q, flight, stale);
      if (same) restoreScroll(same.scrollY);
      watchAena(q, stale);
      await Promise.all([safely(() => loadPunctualityHistory(q, punct, stale)), safely(() => showRadar(q, flight, stale, etaCtx))]);
      return;
    }

    // Vuelo con horario de Aena: la ficha primero (Aena, horas, foto, estado, puntualidad, radar); el pronóstico
    // de turbulencias se carga aparte en su sección. Un fallo meteorológico nunca sustituye la ficha.
    if (flight) {
      currentView = null;
      els.result.innerHTML = legSwitchHtml(q) + flightShellHtml({ flight, punctuality: punct });
      show('result');
      initFicha(q, flight, stale);
      if (same) restoreScroll(same.scrollY);
      watchAena(q, stale);
      const ctx = { q, profile, forecastProfile, flight, punct, oTz, dTz, etaCtx, departureMs, durationMin, rel, stale };
      lastForecastCtx = ctx;
      await Promise.all([
        safely(() => loadPunctualityHistory(q, punct, stale)),
        safely(() => showRadar(q, flight, stale, etaCtx)),
        loadForecastSection(ctx),
      ]);
      return;
    }

    // Consulta manual (sin horario de Aena): no hay ficha; el pronóstico es todo el resultado, como antes.
    const times = `${formatLocal(profile.departureMs, oTz)}–${formatLocal(profile.arrivalMs, dTz)}`; // horas de bloque
    let view;
    try {
      view = await forecastView({ q, profile: forecastProfile, flight, times, nowMs: Date.now() });
    } catch (err) {
      // Sin red o sin cupo, el cálculo simplificado tampoco podría: se muestra el error.
      // (getJson ya convierte los fallos de red en errores en español; un TypeError aquí sería un fallo de código.)
      if (/No se pudo conectar|Demasiadas consultas/.test(err.message)) throw err;
      if (stale()) return;
      return await runLegacy(q, forecastProfile, times, flight, rel, stale);
    }
    if (stale()) return;
    Object.assign(view, { punctuality: punct, originTz: oTz, destinationTz: dTz, etaCtx });
    showForecast(view, q, stale).catch(() => { if (!stale()) showError('Algo ha fallado al mostrar el pronóstico.', true); });
  } catch (err) {
    if (stale()) return;
    dropKeptMap(); // el error sustituye a la ficha: el mapa conservado que no llegó a montarse, fuera
    // fetch lanza TypeError sin conexión; su mensaje viene en inglés.
    const network = err instanceof TypeError;
    const msg = network ? 'Sin conexión o el servicio no responde.' : err.message;
    showError(msg || 'Algo ha fallado. Inténtalo de nuevo.', network || err.retryable === true);
  }
}

let lastForecastCtx = null;
const isWeatherUnavailable = err => err?.rateLimited || err instanceof TypeError || /No se pudo conectar|Demasiadas consultas/.test(err?.message ?? '');

// Sección de turbulencias de la ficha: pronóstico (o cálculo simplificado si los modelos no dan datos). Si Open-Meteo
// falla (429, red…), solo esta sección lo dice, con «Reintentar»; la ficha no se toca.
async function loadForecastSection(ctx) {
  const { q, profile, forecastProfile, flight, punct, oTz, dTz, etaCtx, rel, stale } = ctx;
  const area = () => $in('forecast-area');
  if (!area()) return;
  area().innerHTML = forecastLoadingHtml();
  const times = `${formatLocal(profile.departureMs, oTz)}–${formatLocal(profile.arrivalMs, dTz)}`; // horas de bloque
  let view;
  try {
    view = await forecastView({ q, profile: forecastProfile, flight, times, nowMs: Date.now() });
  } catch (err) {
    if (stale() || !area()) return;
    if (!isWeatherUnavailable(err)) {
      // Los modelos ECMWF/GFS no dan datos: cálculo simplificado (v1), también dentro de la sección (su tarjeta ya
      // dice que es el cálculo simplificado).
      try {
        // La MISMA ventana en el aire que el pronóstico v2.
        const route = buildRoute(q.origin, q.destination, forecastProfile.departureMs, forecastProfile.durationMin);
        const { segments, verdict } = analyze(route, await fetchRouteWeather(route));
        if (stale() || !area()) return;
        const legacy = { verdict, reliability: rel, durationMin: route.durationMin, segments, sectionOnly: true };
        legacyOnScreen = legacy; // en pantalla: al aterrizar se conserva con su etiqueta (§10.2), como el v2
        // Con el vuelo ya aterrizado (ahora o mientras se calculaba o se ponían los lugares), con la etiqueta, como el v2.
        const preLanding = () => Boolean(area().querySelector('.pre-landing')) || (Boolean(shownCard) && flightPhase(shownCard) === 'finalizado');
        paintLegacySection(legacy, { preLanding: preLanding() });
        await nameSegments(segments, q.origin.iata);
        // Solo si la tarjeta sigue ahí: una nota que la sustituyó entre medias (cancelado, desviado) no se pisa.
        if (!stale() && area()?.querySelector('[data-card="turbulence"]')) paintLegacySection(legacy, { preLanding: preLanding() });
        return;
      } catch (err2) {
        if (stale() || !area()) return;
        area().innerHTML = forecastUnavailableHtml(err2 instanceof TypeError ? new Error('Sin conexión o el servicio no responde.') : err2);
        return;
      }
    }
    area().innerHTML = forecastUnavailableHtml(err instanceof TypeError ? new Error('Sin conexión o el servicio no responde.') : err);
    return;
  }
  if (stale() || !area()) return;
  Object.assign(view, { punctuality: punct, originTz: oTz, destinationTz: dTz, etaCtx });
  currentView = view;
  // Si el radar ya dio el vuelo por aterrizado mientras se calculaba, el pronóstico llega con su etiqueta (§10.2).
  paintForecastSection(view, { preLanding: Boolean(shownCard) && flightPhase(shownCard) === 'finalizado' });
  await safely(() => forecastExtras(view, q, stale));
}

// Cálculo v1 (una capa, modelo automático de Open-Meteo): respaldo si los modelos ECMWF/GFS no dan datos.
// air: el perfil en el aire (forecastProfile), el mismo que el pronóstico v2; times: horas de bloque que se muestran.
async function runLegacy(q, air, times, flight, rel, stale) {
  const route = buildRoute(q.origin, q.destination, air.departureMs, air.durationMin);
  const weather = await fetchRouteWeather(route);
  if (stale()) return;
  const { segments, verdict } = analyze(route, weather);
  const view = {
    title: `${q.origin.iata} → ${q.destination.iata}`,
    subtitle: [q.number, q.airline, sourceNote(q)].filter(Boolean).join(' · ') || `${q.origin.city} → ${q.destination.city}`,
    times,
    verdict, reliability: rel, durationMin: route.durationMin, segments, flight,
  };
  currentView = null;
  const paint = () => {
    renderResult(els.result, view);
    // La línea «Cálculo simplificado…» ya va en la tarjeta de Turbulencias (renderResult).
    if (q.adbInfo) els.result.insertAdjacentHTML('afterbegin', `<p class="note-small">${esc(q.adbInfo)}</p>`);
  };
  paint();
  show('result');
  await nameSegments(segments, q.origin.iata);
  if (!stale()) paint();
}

const $in = id => els.result.querySelector(`#${id}`);
const safely = async fn => { try { await fn(); } catch { /* mejora opcional: si falla, no pasa nada */ } };

// ---- Presentación de la ficha (rediseño, spec 2026-10-20 §9 bis, §10.2 y §10 bis) ----
// Solo cómo se pinta: nada de aquí decide cuándo se consulta el radar o Aena, qué nota se muestra ni la ETA.
let shownCard = null; // la tarjeta del vuelo que hay en pantalla (armazón, repaintFlight o pronóstico guardado)
let routeMap = null; // el mapa Leaflet de la ficha: uno solo, sobre el #map de la ficha actual
let mapToken = 0; // un mapa que termina de crearse cuando su ficha ya no está se destruye en el acto
let signalTimer = null;

function destroyMap() { mapToken++; routeMap?.destroy(); routeMap = null; }
// La ficha deja de estar (otra búsqueda, «Nueva consulta», pantalla de elección, pronóstico guardado): fuera su mapa
// (también uno conservado por «Actualizar» que aún no se montó), el avión retenido y los desplegables pendientes.
// No va en stopRadarPoll: applyAenaLeg para el radar con la llegada final y el mapa se queda («Ruta realizada»).
function clearFicha() { destroyMap(); dropKeptMap(); releasePlane(); reopen.clear(); stopSignal(); shownCard = null; legacyOnScreen = null; }

// ---- «Actualizar» del mismo vuelo físico (decisión de 20/10/2026; solo presentación) ----
// La consulta es la de siempre (submit → run: Aena, radar con su pollRadar, pronóstico, puntualidad); solo cambia cómo
// se sustituye la ficha si es del MISMO vuelo físico (physicalFlightKey del tramo de Aena o adbKey de AeroDataBox):
// el #map-card con su mapa Leaflet pasa a la ficha nueva (sin destruirlo, recentrarlo ni cambiar el zoom), los
// desplegables abiertos se vuelven a abrir, el scroll se restaura y no se muestra la pantalla de carga. Otra clave u
// otra clase de consulta: como siempre.
const physicalOf = q => (q?.kind === 'schedule' ? physicalFlightKey(q.leg) : q?.kind === 'adb' ? q.adbKey : null);
function refreshHandoff() {
  const key = physicalOf(lastQuery);
  if (!key || !els.result.querySelector('.flight')) return null;
  return { key, open: openCards(), scrollY: document.scrollingElement?.scrollTop ?? 0 };
}
function restoreScroll(y) {
  const scroller = document.scrollingElement;
  if (scroller && scroller.scrollTop !== y) scroller.scrollTop = y;
}
// El mapa de la ficha en pantalla, con la tarjeta que lo pintó (su avión): routeMap queda libre para clearFicha. Sin
// mapa (Leaflet no ha cargado o aún se está creando), nada: mountMap crea uno, como siempre.
let keptMap = null;
function keepMap() {
  const node = $in('map-card');
  if (!routeMap || !node) return null;
  const kept = { node, map: routeMap, card: shownCard };
  routeMap = null;
  return kept;
}
function dropKeptMap() { keptMap?.map.destroy(); keptMap = null; }
// El #map-card recién pintado se sustituye por el conservado. Sus botones ya están cableados (wireMapCard busca
// routeMap al pulsar): no se vuelven a cablear. Sin fitBounds ni otro L.map. El pronóstico anterior se quita (si el
// nuevo falla, no queda coloreado con datos viejos) y lo vuelve a poner forecastExtras.
function adoptMap(fresh) {
  const { node, map, card: prev } = keptMap;
  keptMap = null;
  fresh.replaceWith(node);
  routeMap = map;
  const title = node.querySelector('.card-title');
  if (title) title.textContent = mapTitle(flightPhase(shownCard));
  paintMapFacts(shownCard);
  map.invalidate();
  // Como recién creado: la ruta sin colorear, sin SIGMET ni PIREP; el pronóstico nuevo la colorea (forecastExtras).
  map.clearForecast();
  holdPlane(prev);
}
// Avión del traspaso: mientras la ficha nueva no tenga lectura del radar, el marcador se queda con la posición anterior,
// solo mientras siga vigente (planeOnMap, 60 s); al caducar se quita (temporizador al vencimiento; cero peticiones). La
// primera lectura lo suelta (showPlane): misma identidad → map.js anima desde lo que se ve; otra → salto directo.
let heldPlane = null, heldTimer = null;
function releasePlane() { if (heldTimer !== null) clearTimeout(heldTimer); heldTimer = null; heldPlane = null; }
function holdPlane(prev) {
  releasePlane();
  const now = Date.now();
  if (!planeOnMap(prev?.radar, prev?.radarReceivedAt, now)) { routeMap?.setPlane(null); return; }
  heldPlane = prev;
  const expire = () => {
    heldTimer = null;
    if (heldPlane !== prev) return;
    // Por redondeo aún vigente: se espera un segundo más.
    if (planeOnMap(prev.radar, prev.radarReceivedAt, Date.now())) { heldTimer = setTimeout(expire, TICK_MS); return; }
    heldPlane = null;
    routeMap?.setPlane(null);
  };
  heldTimer = setTimeout(expire, Math.max(0, (PLANE_MAX_AGE_S - positionAgeS(prev.radar, prev.radarReceivedAt, now)) * 1000) + 1);
}

// Desplegables abiertos al pulsar «Actualizar» aún no repintados: se abren al aparecer (una vez cada uno: si el
// usuario lo cierra después, se queda cerrado) y hasta entonces cuentan como abiertos en los repintados intermedios.
let reopen = new Set();
function reopenCards() {
  if (!reopen.size) return;
  for (const d of els.result.querySelectorAll('details[data-card]')) if (reopen.delete(d.dataset.card)) d.open = true;
}

// Qué desplegables (data-card) están abiertos en toda la ficha, Detalles avanzados incluidos (y los pendientes).
const openCards = () => new Set([...reopen, ...[...els.result.querySelectorAll('details[data-card][open]')].map(d => d.dataset.card)]);

function wireSpeak(view) {
  const btn = $in('speak');
  if (!btn || !canSpeak()) return;
  btn.hidden = false;
  btn.onclick = () => speak(buildSpeech({ from: view.fromCity, to: view.toCity, summary: view.summary, confidence: view.confidence.level }));
}

// Detalles avanzados: las categorías de la ficha (#adv-flight) y el historial (#adv-history), con lo que ya hay.
function paintAdvancedFlight(card, open = openCards()) {
  const el = $in('adv-flight');
  if (el) el.innerHTML = advancedFlightHtml(card, { open, nowMs: Date.now() });
  reopenCards();
}
function paintHistory(view = currentView, open = openCards()) {
  const el = $in('adv-history');
  if (el) el.innerHTML = advancedHistoryHtml({ queriedAt: view?.queriedAt, aenaUpdatedAgo: shownCard?.updatedAgo ?? null, trend: view?.trend ?? null }, Date.now(), { open });
  reopenCards();
}
// METAR/TAF, SIGMET y PIREP en «El tiempo en los aeropuertos»: la categoría solo se ve con contenido.
function paintAviation(view) {
  const el = $in('aviation');
  if (!el) return;
  el.innerHTML = aviationHtml(view.aviation, Date.now());
  const cat = el.closest('details[data-card="adv-weather"]');
  if (cat) cat.hidden = !el.innerHTML.trim();
}

// §10.2: ¿está en pantalla el pronóstico de ESTA consulta, v2 o cálculo simplificado v1? (currentView y legacyOnScreen
// vuelven a null al empezar cada búsqueda.)
const forecastOnScreen = () => Boolean((currentView || legacyOnScreen) && $in('forecast-area')?.querySelector('[data-card="turbulence"]'));
// El pronóstico en pantalla, conservado tras el aterrizaje con «Previsión mostrada antes del aterrizaje». Sin peticiones.
function paintPreLanding() {
  if (currentView) paintForecastSection(currentView, { preLanding: true });
  else if (legacyOnScreen) paintLegacySection(legacyOnScreen, { preLanding: true });
}
// La tarjeta del cálculo simplificado (renderResult con sectionOnly) en #forecast-area, conservando sus desplegables.
function paintLegacySection(legacy, { preLanding = false } = {}) {
  const area = $in('forecast-area');
  if (!area) return;
  const tmp = { innerHTML: '' };
  renderResult(tmp, legacy, { preLanding, open: openCards() });
  area.innerHTML = tmp.innerHTML;
  reopenCards();
}
// Pinta (o repinta) la tarjeta de Turbulencias con la vista ya calculada, conservando sus desplegables. Sin peticiones.
function paintForecastSection(view, { preLanding = false } = {}) {
  const area = $in('forecast-area');
  if (!area) return;
  area.innerHTML = forecastSectionHtml(view, Date.now(), { preLanding, open: openCards() });
  reopenCards();
  wireSpeak(view);
}

// Mapa de la ficha (Ruta prevista / Radar / Ruta realizada): se crea en cuanto se pinta el armazón, con la ruta en
// círculo máximo (sin meteorología) y los aeropuertos; setForecast la colorea cuando hay pronóstico y setPlane pone o
// quita el avión. Leaflet es prescindible: si no carga, la tarjeta se queda sin mapa y nada más cambia.
function mountMap(q, stale) {
  const card = $in('map-card'), el = $in('map');
  if (!card || !el || !q?.origin || !q?.destination) { dropKeptMap(); return; } // sin hueco: el conservado, fuera
  if (keptMap) { adoptMap(card); return; } // «Actualizar» del mismo vuelo físico: el mapa de antes, tal cual
  destroyMap();
  const token = mapToken;
  wireMapCard(card, { invalidate: () => routeMap?.invalidate() }); // el mapa aún se está creando: se busca al pulsar
  let route;
  try { route = buildRoute(q.origin, q.destination, 0).points; } catch { return; }
  createRouteMap(el, { origin: q.origin, destination: q.destination, route }).then(m => {
    if (token !== mapToken || stale()) { m.destroy(); return; }
    routeMap = m;
    if (currentView?.route) m.setForecast(currentView);
    showPlane(m, shownCard);
  }).catch(() => {});
}

// Avión en el mapa: posición real de 60 s o menos (planeOnMap) y la identidad de esa lectura (vuelo físico + avión
// por su fr24Id de Flightradar24, por transpondedor o, si no, indicativo), para que el mapa no anime entre dos aviones o
// dos vuelos distintos: un cambio de fr24Id coloca el avión directamente.
const planeIdentity = card => `${card?.physicalKey ?? ''}|${card?.radar?.fr24Id ?? card?.radar?.hex ?? card?.radar?.callsign ?? ''}`;
function showPlane(map, card) {
  // Traspaso de «Actualizar»: la ficha nueva aún sin lectura del radar (y sin terminar) no quita el avión retenido.
  if (heldPlane && card && !card.radar && !['finalizado', 'cancelado'].includes(flightPhase(card))) return;
  releasePlane();
  map?.setPlane(card ? planeOnMap(card.radar, card.radarReceivedAt, Date.now()) : null, { identity: planeIdentity(card) });
}

// Indicativo, Avión e Identificación bajo el mapa (mapFactsHtml): solo en el aire con el radar «volando».
function paintMapFacts(card) {
  const el = $in('map-facts');
  if (el) el.innerHTML = mapFactsHtml(card);
}

// Lo común del armazón (ficha con pronóstico o con nota): Detalles avanzados y el mapa.
function initFicha(q, flight, stale) {
  shownCard = flight;
  paintAdvancedFlight(flight);
  paintMapFacts(flight);
  paintHistory(null);
  mountMap(q, stale);
  startSignal(flight, stale);
}

// Repinta la tarjeta del vuelo SIN perder estado (§9 bis): los desplegables abiertos, el nodo #punctuality ya cargado
// (su historial llega aparte) y el scroll. Con ella, Detalles avanzados, el título del mapa, el avión y la señal.
// Sustituye a todos los `outerHTML = flightCardHtml(...)`: no cambia cuándo ni por qué se repinta.
function repaintFlight(card, stale) {
  const el = els.result.querySelector('.flight');
  if (!el) return;
  const open = openCards();
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0, resultTop = els.result.scrollTop;
  const punct = el.querySelector('#punctuality');
  punct?.remove();
  el.outerHTML = flightCardHtml(card, { open, nowMs: Date.now() });
  const slot = els.result.querySelector('.flight #punctuality');
  if (punct && slot) slot.replaceWith(punct);
  shownCard = card;
  paintAdvancedFlight(card, open);
  paintHistory(currentView, open);
  const title = $in('map-card')?.querySelector('.card-title');
  if (title) title.textContent = mapTitle(flightPhase(card));
  paintMapFacts(card);
  showPlane(routeMap, card);
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  if (els.result.scrollTop !== resultTop) els.result.scrollTop = resultTop;
  startSignal(card, stale);
}

// Contador de señal (§10 bis.2): como el radar deja de sondear tras una lectura «volando», la ficha envejece en
// pantalla. Temporizador encadenado de 1 s (como el de la distancia, nunca setInterval) mientras haya «volando» y la
// ficha se vea: repinta el indicador y «Última señal» cuando cambia el texto, marca «Ahora» como antigua desde
// STALE_MIN y quita el avión del mapa cuando su posición pasa de 60 s. En Detalles avanzados solo reescribe los textos
// de antigüedad (.adv-signal y .adv-age): #adv-flight entero se repinta solo si cambia el nivel de la señal o el avión
// sale del mapa (la posición pasa a llevar su antigüedad), para no perder el foco ni un toque cada segundo. Cero peticiones.
function stopSignal() { if (signalTimer !== null) clearTimeout(signalTimer); signalTimer = null; }
function startSignal(card, stale) {
  stopSignal();
  const first = signalState(card?.radar, card?.radarReceivedAt, Date.now());
  if (!first) return; // solo «volando» con instante de recepción
  let plane = planeOnMap(card.radar, card.radarReceivedAt, Date.now()) !== null;
  let painted = null;
  let level = first.level; // el nivel con el que se pintó #adv-flight (initFicha / repaintFlight)
  const tick = () => {
    signalTimer = null;
    const flight = els.result.querySelector('.flight');
    if (stale() || shownCard !== card || !flight || els.result.closest('[hidden]')) return;
    const now = Date.now();
    const sig = signalState(card.radar, card.radarReceivedAt, now);
    if (!sig) return;
    const key = `${sig.level}|${sig.text}`;
    const planeGone = plane && !planeOnMap(card.radar, card.radarReceivedAt, now);
    if (planeGone) { plane = false; routeMap?.setPlane(null); }
    if (key !== painted) { painted = key; paintSignal(flight, sig); }
    if (sig.level !== level || planeGone) { level = sig.level; paintAdvancedFlight(card); } else paintAdvancedAge(sig, positionAgeS(card.radar, card.radarReceivedAt, now));
    signalTimer = setTimeout(tick, TICK_MS);
  };
  signalTimer = setTimeout(tick, TICK_MS);
}
// Solo los textos de antigüedad de Datos ADS-B (mismo texto que advancedFlightHtml): el resto de #adv-flight no se toca.
function paintAdvancedAge(sig, posAgeS) {
  const el = $in('adv-flight');
  if (!el) return;
  const value = el.querySelector('.adv-signal .v');
  if (value && value.textContent !== `hace ${sig.text}`) value.textContent = `hace ${sig.text}`;
  // La posición lleva su propia antigüedad (data-pos): la de posAgeS, no la del último mensaje.
  for (const age of el.querySelectorAll('.adv-age')) {
    const text = ageSuffix(age.hasAttribute('data-pos') && posAgeS !== null ? { text: ageText(posAgeS) } : sig);
    if (age.textContent !== text) age.textContent = text;
  }
}
// Solo el indicador, la celda «Última señal» y la marca de lectura antigua: la distancia (.tm-remaining) es del otro
// contador y no se toca. Mismo HTML que la tarjeta (signalHtml / tmOldHtml de js/ui.js).
function paintSignal(flight, sig) {
  const indicator = flight.querySelector('.signal');
  if (indicator) indicator.outerHTML = signalHtml(sig);
  const cell = flight.querySelector('.tm-signal .tm-value');
  if (cell) cell.textContent = sig.text;
  const stale = sig.level === 'stale';
  flight.querySelector('.now')?.classList.toggle('aged', stale);
  const grid = flight.querySelector('.tm-grid');
  grid?.classList.toggle('is-stale', stale);
  flight.querySelector('.tm-old')?.remove();
  if (stale) grid?.insertAdjacentHTML('afterend', tmOldHtml(sig));
}

// Pinta el pronóstico y después, sin bloquear, añade lo secundario (cada cosa solo actualiza su hueco).
async function showForecast(view, q, stale, saved = false) {
  currentView = view;
  // Guardado: la tendencia era la de aquel momento, así que no se muestra.
  const shown = saved ? { ...view, saved, trend: null } : view;
  renderForecast(els.result, shown, Date.now());
  show('result');
  wireSpeak(view);
  // Detalles avanzados con lo que ya trae la vista (frescura, Aviation Weather y, si hay ficha, sus datos).
  shownCard = view.flight ?? null;
  if (shownCard) paintAdvancedFlight(shownCard);
  paintHistory(shown);
  const fresh = $in('fresh');
  if (fresh) fresh.innerHTML = freshnessHtml(view, Date.now());
  paintAviation(view);
  if (saved) return; // guardado: tal cual, sin pedir nada a la red (ni el mapa)
  mountMap(q, stale);
  await forecastExtras(view, q, stale);
}

// Lo que completa el pronóstico ya pintado: voz, tendencia, lugares, hora de los modelos, meteorología aeronáutica,
// mapa y guardado para sin conexión. (Puntualidad y radar van con la ficha, no aquí.)
async function forecastExtras(view, q, stale) {
  wireSpeak(view);
  saveLast(view, view.queriedAt);
  await safely(async () => {
    const snaps = recordSnapshot(flightKey(q), { t: view.queriedAt, maxLevel: view.summary.maxLevel, verdict: view.summary.verdict, confidence: view.confidence.level });
    view.trend = forecastTrend(snaps, Date.now());
    const el = $in('trend');
    if (view.trend && el) { el.textContent = view.trend; el.hidden = false; }
    if (!stale()) paintHistory(view); // la consulta y la tendencia, también en «Historial de actualizaciones»
  });
  await Promise.all([
    safely(async () => {
      await nameSegments(view.segments, view.originIata);
      if (stale()) return;
      $in('timeline').innerHTML = timelineHtml(view);
      $in('segments').innerHTML = segmentListHtml(view); // la lista de tramos, con los lugares
    }),
    safely(async () => {
      view.runs = await fetchModelRuns(view.models);
      if (!stale()) $in('fresh').innerHTML = freshnessHtml(view, Date.now());
    }),
    safely(async () => {
      view.aviation = aviationView(await loadAviation(), view, Date.now());
      if (stale()) return;
      $in('wx-alerts').innerHTML = weatherAlertsHtml(view.aviation); // línea compacta de avisos en la tarjeta (§10 bis.1)
      paintAviation(view); // el detalle, en Detalles avanzados
    }),
  ]);
  if (stale()) return;
  saveLast(view, view.queriedAt);
  // El mapa ya está (se crea con el armazón): ahora la ruta coloreada por nivel y los avisos. Si Leaflet aún no ha
  // cargado, mountMap aplica currentView al crearlo.
  if (routeMap && view === currentView) safely(async () => routeMap.setForecast(view));
}

// handoff: el traspaso de «Actualizar» (refreshHandoff), que llega hasta run; sin él, la búsqueda de siempre.
async function submit(handoff = null) {
  els.error.hidden = true;
  if (navigator.onLine === false) {
    // Sin red ni el horario ni adsbdb responden: decir «no encuentro ese vuelo» sería engañoso.
    lastQuery = null; // «Reintentar» debe buscar lo que hay escrito, no la consulta anterior
    showError('Sin conexión: no se puede consultar el pronóstico ahora.', true);
    return;
  }
  if (!handoff) show('loading'); // buscar el vuelo también puede tardar unos segundos
  try {
    const q = await resolveFlight();
    if (q?.kind === 'choose') showLegChooser(q);
    else if (q?.kind === 'alias') await showAliasOffer(q);
    else if (q) run(q, handoff);
    else show('query');
  } catch (err) {
    showError(err instanceof TypeError ? 'Sin conexión o el servicio no responde.' : err.message);
  }
}

els.form.addEventListener('submit', e => { e.preventDefault(); submit(); });

// Escoger otro tramo del mismo número y fecha (por su ruta): se recuerda y se vuelve a consultar.
els.result.addEventListener('click', e => {
  const btn = e.target.closest('button[data-leg-key]');
  if (!btn) return;
  const nav = btn.closest('.leg-switch');
  legPick = { number: nav.dataset.number, date: nav.dataset.date, key: btn.dataset.legKey };
  submit();
});

// Candidato de número comercial: confirmarlo abre el vuelo de Aena; si no, se sigue con ADSBDB (ya consultado).
els.result.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-alias]');
  if (!btn || !aliasState) return;
  if (btn.dataset.alias === 'accept') {
    aliasState.accepted = true;
    submit();
    return;
  }
  const { adsb, date, input } = aliasState;
  aliasState = null;
  aliasDeclined = { input, date };
  show('loading');
  try {
    const q = await afterAena(els.number.value.trim(), date, adsb);
    if (q?.kind === 'choose') showLegChooser(q);
    else if (q) run(q);
    else show('query');
  } catch (err) { showError(err.message); }
});

// Timeline: al tocar un tramo se muestra su detalle (otra vez para ocultarlo). Se resaltan todas las barras del tramo.
els.result.addEventListener('click', e => {
  // #seg-detail está dentro del <summary> de la tarjeta: tocar su texto no debe plegarla ni desplegarla.
  if (e.target.closest('#seg-detail')) { e.preventDefault(); return; }
  const btn = e.target.closest('button[data-seg]');
  if (!btn || !currentView) return;
  const detail = $in('seg-detail');
  const selected = btn.classList.contains('selected');
  els.result.querySelectorAll('button[data-seg]').forEach(b => b.classList.remove('selected'));
  if (selected) { detail.hidden = true; return; }
  els.result.querySelectorAll(`button[data-seg="${btn.dataset.seg}"]`).forEach(b => b.classList.add('selected'));
  detail.innerHTML = segmentDetailHtml(currentView.segments[Number(btn.dataset.seg)], currentView.originIata);
  detail.hidden = false;
});

els.toggleManual.addEventListener('click', () => setManual(Boolean(adsbRoute) || els.manual.hidden));
// Otro número: la ruta de ADSBDB del anterior deja de valer.
els.number.addEventListener('input', () => {
  if (aliasState && aliasState.input !== numberKey(els.number.value)) aliasState = null;
  if (aliasDeclined && aliasDeclined.input !== numberKey(els.number.value)) aliasDeclined = null;
  if (!adsbRoute || adsbRoute.input === numberKey(els.number.value)) return;
  setManual(false);
});

for (const input of [els.origin, els.destination]) {
  input.addEventListener('input', async () => {
    let db;
    try { db = await airports(); } catch { return; } // sin lista: simplemente no hay sugerencias
    const results = searchAirports(db, input.value);
    els.airportsList.innerHTML = results
      .map(a => `<option value="${esc(a.iata)}">${esc(a.city)} · ${esc(a.name)}</option>`).join('');
  });
}

els.back.addEventListener('click', () => { stopRadarPoll(); stopStatusRefresh(); clearFicha(); setNotice(); show('query'); });
els.savedLink.addEventListener('click', () => {
  const last = loadLast();
  if (!last) return;
  runId++; // una consulta en curso ya no debe pintar encima
  stopRadarPoll();
  stopStatusRefresh();
  clearFicha();
  els.refresh.hidden = false;
  showForecast(last.view, null, () => true, last.savedAt).catch(() => {});
});
window.addEventListener('offline', offerSaved);
window.addEventListener('online', () => { els.savedLink.hidden = true; });
els.changeTime.addEventListener('click', () => { setTimeNeeded(true); show('query'); els.time.focus(); });
// Actualizar vuelve a pedir el horario (retrasos, puerta, estado) y el radar; con el mismo vuelo físico, la ficha
// conserva su mapa, sus desplegables y el scroll (refreshHandoff).
els.refresh.addEventListener('click', () => (['schedule', 'adb'].includes(lastQuery?.kind) ? submit(refreshHandoff()) : lastQuery && run(lastQuery)));
els.retry.addEventListener('click', () => (lastQuery ? run(lastQuery) : submit()));
// Reintentar solo la sección de turbulencias (la ficha se queda como está).
els.result.addEventListener('click', e => {
  if (e.target.closest('#forecast-retry') && lastForecastCtx) { allowRetry(); loadForecastSection(lastForecastCtx); }
});
// «Ver detalles» de la línea de avisos (tarjeta de Turbulencias, §10 bis.1): abre Detalles avanzados y «El tiempo en
// los aeropuertos» y lleva hasta ella. El botón está dentro del <summary>: no pliega ni despliega la tarjeta.
els.result.addEventListener('click', e => {
  if (!e.target.closest('[data-open="adv-weather"]')) return;
  e.preventDefault();
  const adv = els.result.querySelector('details[data-card="advanced"]');
  const weather = els.result.querySelector('details[data-card="adv-weather"]');
  if (!adv || !weather) return;
  adv.open = true;
  weather.open = true;
  const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  weather.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
});

// Valores por defecto: hoy y la próxima hora en punto.
const now = new Date();
els.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
els.time.value = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
if (navigator.onLine === false) offerSaved();

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    const offerUpdate = worker => {
      if (!worker || !hadController || !els.updateNotice) return;
      els.updateNotice.hidden = false;
      els.updateApp.onclick = () => worker.postMessage({ type: 'SKIP_WAITING' });
    };
    if (reg.waiting) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') offerUpdate(worker); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const key = `turbi-reloaded-${BUILD_ID}`;
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      location.reload();
    });
    // Comprueba al abrir la app instalada, sin esperar al ciclo de actualización del navegador.
    reg.update().catch(() => {});
  } catch { /* la app sigue funcionando sin instalación PWA */ }
}

registerServiceWorker();
