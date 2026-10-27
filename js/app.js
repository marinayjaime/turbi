import { buildRoute, distanceKm } from './route.js';
import { localToUtcMs, formatLocal } from './time.js';
import { fetchRouteWeather, allowRetry } from './weather.js';
import { analyze, reliability } from './turbulence.js';
import { lookupFlightResult, canonicalRoute, icaoCallsign } from './flight.js';
import { aliasOffer, adsbdbVetoes } from './aliases.js';
import { fetchAdb, adbTimes, adbInfo, adbPhysical, adbStatusText, sourceNote, adbPhysicalKey, adbRadarGate, adbPhase, historyDue, withFr24Landing } from './adb.js';
import { fetchSchedule, loadAirlines, flightTitle, chooseLeg, legByKey, legDeparture, legArrival, flightStatus, isLate, legPhase, aenaFinal } from './schedule.js';
import { startStatusRefresh, refreshMode } from './status-refresh.js';
import { physicalFlightKey } from './physical-flight.js';
import { forecastDigest, legacyDigest, rememberTurb, recallTurb } from './turb-memory.js';
import { loadAirports, findAirport, searchAirports, timezoneOf } from './airports.js';
import { nameSegments } from './places.js';
import { renderResult, esc, flightCardHtml, missingDateText, thousands, signalHtml, tmOldHtml, calmHtml } from './ui.js';
import { calmScore } from './calm-score.js';
import { distanceReference, receivedRadar, startRemainingTicker, TICK_MS } from './radar-distance.js';
import { buildProfile } from './altitude.js';
import { forecastWindow } from './airtime.js';
import { forecastView, aviationView } from './forecast.js';
import { fetchModelRuns } from './models.js';
import { renderForecast, timelineHtml, segmentDetailHtml, freshnessHtml, aviationHtml, offlineBanner,
  flightShellHtml, flightNoteHtml, forecastSectionHtml, forecastUnavailableHtml, forecastLoadingHtml, forecastNoteHtml, segmentListHtml,
  weatherAlertsHtml, turbNowHtml, turbNowMarkHtml } from './ui-forecast.js';
import { recordSnapshot, forecastTrend, saveLast, loadLast, flightKey, agoText } from './storage.js';
import { loadAviation } from './aviation-weather.js';
import { createRouteMap, wireMapCard, mapTitle, mapHeroHtml } from './map.js';
import { flightPhase, mapPhase, signalState, planeOnMap, positionAgeS, ageText, monoNow, PLANE_MAX_AGE_S, PLANE_LAST_KNOWN_S, turbNow, sigmetAffectsFlight } from './card-model.js';
import { startLiveTracker, LIVE_INTERVAL_MS } from './live-tracker.js';
import { advancedFlightHtml, advancedHistoryHtml, ageSuffix } from './ui-advanced.js';
import { buildSpeech, canSpeak, speak } from './speech.js';
import { currentPunctuality, fetchPunctuality, fetchPastFlights, dowOf, slotOf } from './punctuality.js';
import { punctualityHtml } from './ui-punctuality.js';
import { aircraftName } from './plain.js';
import { loadAirlinePhotos, photoFor, operatorName, adbModel } from './airline-photos.js';
import { wantsRadar, fetchRadar, fetchAdbRadar, withRadar, presentStatus, arrivalNote, radarNote, ENDED_ESTIMATED, NO_ARRIVAL_NOTE, landedNote, recallLandingSource,
  rememberSighting, recallSighting, seenBefore, withLanding, rememberLanding, recallLanding, pollRadar, endedNote, fetchTrack, fetchAdbTrack, fetchAdbHistory,
  fetchFr24Discovery, fetchFr24Radar } from './radar.js';
import { discoveryKnown } from './fr24-discovery.js';
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

// Sin horario de Aena (ni alias confirmado): AeroDataBox (vía Render) → Flightradar24 (solo un vuelo que está volando
// ahora) → ADSBDB → entrada manual.
// adsb: resultado de ADSBDB si ya se consultó (para el veto del alias); si no, solo se consulta si AeroDataBox no da el vuelo.
async function afterAena(number, date, adsb = null) {
  const adb = await fetchAdb(number, date);
  if (adb.status === 'found' && adb.legs?.length) {
    const q = await adbQuery(number, date, adb);
    if (q !== undefined) return q;
  }
  const fr24 = await fr24Query(number, date);
  if (fr24) return fr24;
  let route = adsb ?? await lookupFlightResult(number);
  if (route.status === 'unknown') route = (await adsbdbByIcao(number)) ?? route;
  return adsbFallback(number, route);
}

// Ni Aena ni AeroDataBox tienen el vuelo: Flightradar24 (server/fr24-discover.mjs) lo da si está volando ahora con un
// único avión inequívoco, o si ya lo encontró antes (fecha reciente). Su ficha es la de lo que FR24 da de verdad.
// null = no (sigue ADSBDB, como siempre).
const okPlace = a => a && typeof a.iata === 'string' && typeof a.city === 'string' && typeof a.tz === 'string'
  && Number.isFinite(a.lat) && Number.isFinite(a.lon);
async function fr24Query(number, date) {
  if (!LIVE_BASE || !discoveryKnown(date, Date.now())) return null;
  const r = await fetchFr24Discovery(numberKey(number), date);
  if (!['found', 'known'].includes(r?.state) || typeof r.key !== 'string' || !okPlace(r.origin) || !okPlace(r.destination)) return null;
  const place = a => ({ iata: a.iata, name: a.name ?? a.city, city: a.city, lat: a.lat, lon: a.lon, tz: a.tz });
  return { kind: 'fr24', number: r.number, airline: '', origin: place(r.origin), destination: place(r.destination), date, fr24: r, fr24Key: r.key,
    routeSource: 'fr24' };
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
  const adbLeg = picked ?? legs[0];
  const origin = findAirport(db, adbLeg.o), destination = findAirport(db, adbLeg.a);
  if (!origin || !destination) {
    setManual(true, `AeroDataBox da la ruta ${adbLeg.o} → ${adbLeg.a}, pero no tengo alguno de esos aeropuertos: introdúcelo a mano.`);
    return null;
  }
  const meta = { number: adb.number ?? input, date: adb.date ?? date, fetchedAt: adb.fetchedAt, refreshedAt: adb.refreshedAt };
  // Vuelo que ya debería haber terminado: Flightradar24 (Flight Summary) puede confirmar cómo terminó, con sus horas reales.
  // Si no lo confirma (o falla), la ficha sigue con lo de AeroDataBox; nunca se da por aterrizado por la hora.
  const leg = historyDue(adbLeg, Date.now())
    ? withFr24Landing(adbLeg, await fetchAdbHistory(meta.number, meta.date, adbPhysicalKey(meta, adbLeg))) : adbLeg;
  const { dep, durationMin } = adbTimes(leg);
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
// revisada o la real), modelo y estado tal como estaban al consultar; sin puerta ni puntualidad. El pie dice la
// fuente y cuándo se consultó. El radar (si procede) se pinta encima con el mismo panel que los vuelos de Aena.
const ADB_TONES = { Delayed: 'warn', Canceled: 'bad', CanceledUncertain: 'bad', Diverted: 'bad', Arrived: 'ok' };
function adbCard(q, durationMin, photos = null) {
  const leg = q.adbLeg;
  const m = String(leg.number || q.number).match(/^([A-Z0-9]{2})(\d+[A-Z]?)$/);
  const [al, n] = m ? [m[1], m[2]] : [String(q.number).slice(0, 2), String(q.number).slice(2)];
  const { dep, arr } = adbTimes(leg);
  const side = (sched, best) => (sched ? { date: sched.local.slice(0, 10), time: sched.local.slice(11, 16),
    est: best && best.utc !== sched.utc ? best.local.slice(11, 16) : null, late: Boolean(best && best.utc > sched.utc), terminal: null }
    : best ? { date: best.local.slice(0, 10), time: best.local.slice(11, 16), est: null, late: false, terminal: null } : null);
  const at = Date.parse(q.adbMeta.refreshedAt ?? q.adbMeta.fetchedAt);
  return {
    al, title: flightTitle({ name: leg.airline, al, n }), number: `${al} ${n}`, airline: leg.airline ?? null,
    // Foto con las mismas reglas que Aena, solo si AeroDataBox dice que la aerolínea del número es la que opera y el
    // número da un código seguro (con «HTY203» los dos primeros caracteres serían otra aerolínea).
    photo: m && leg.codeshareStatus === 'IsOperator' ? photoFor(photos, { op: al, model: adbModel(leg.aircraft) }) : null, operator: null,
    route: `${q.origin.city} a ${q.destination.city}`,
    status: { text: adbStatusText(leg.status) ?? 'Horario de AeroDataBox', tone: ADB_TONES[leg.status] ?? 'info' },
    o: leg.o, a: leg.a, duration: durationMin, durationEstimated: false,
    dep: side(leg.dep.sched, dep), arr: side(leg.arr.sched, arr), aircraft: fr24Model(leg) ?? leg.aircraft ?? null,
    gateChanged: false, stale: false, past: false,
    sourceNote: `Horario según AeroDataBox${leg.closedBy === 'fr24' ? ' · aterrizaje según Flightradar24' : ''} · consultado ${agoText(Date.now() - at)}`,
    // Fase: traducción directa del estado de AeroDataBox; final: hora de pista. Sin puntualidad ni confianza (no hay ETA).
    ...presentationFields({ phase: adbPhase(leg.status), depFinal: leg.dep.runway, arrFinal: leg.arr.runway, source: 'aerodatabox', q,
      aircraftReg: leg.fr24?.reg ?? leg.reg ?? null, aircraftHex: leg.modeS ?? null, physicalKey: q.adbKey }),
  };
}

// Modelo que dio Flightradar24 al cerrar el vuelo (código OACI, p. ej. A339), solo si Turbi lo conoce; si no, el de AeroDataBox.
function fr24Model(leg) {
  const name = leg.closedBy === 'fr24' && leg.fr24?.type ? aircraftName(leg.fr24.type) : null;
  return name && !name.startsWith('modelo ') ? name : null;
}

// Ficha de un vuelo que solo encontró Flightradar24 (fr24Query): lo que FR24 da de verdad, nada más. Ruta, avión,
// matrícula y operadora; mientras vuela, su ETA como «Llegada prevista» (no hay horario programado: los hitos programados
// quedan «Pendiente»); cerrado con Flight Summary, despegue y aterrizaje reales. Sin terminal, puerta ni puntualidad.
// Foto solo de la aerolínea del número (si FR24 dice que es la que opera) y del modelo exacto: ninguna de relleno.
function fr24Card(q, photos = null, airlines = null) {
  const r = q.fr24;
  const m = String(r.number).match(/^([A-Z0-9]{2})(\d+[A-Z]?)$/);
  const [al, n] = m ? [m[1], m[2]] : [String(r.number).slice(0, 2), String(r.number).slice(2)];
  const operates = Boolean(m && r.operatingAs && airlines?.[r.operatingAs] === al);
  const name = operates ? photos?.airlines?.[al] ?? null : null;
  const known = r.type ? aircraftName(r.type) : null;
  const model = known && !known.startsWith('modelo ') ? known : null;
  const exact = operates && model ? photoFor(photos, { op: al, model }) : null;
  const h = r.history ?? null;
  const takeoffMs = h?.state === 'landed' ? Date.parse(h.takeoff) : NaN, landedMs = h?.state === 'landed' ? Date.parse(h.landed) : NaN;
  const landed = Number.isFinite(takeoffMs) && Number.isFinite(landedMs);
  const etaMs = Date.parse(r.eta ?? '');
  const day = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms);
  // unscheduled: no es una hora programada (js/card-model.js deja «Pendiente» la programada de ese lado).
  const side = (ms, tz, extra = {}) => ({ date: day(ms, tz), time: formatLocal(ms, tz), est: null, late: false, terminal: null, unscheduled: true, ...extra });
  const dep = landed ? side(takeoffMs, q.origin.tz) : null;
  const arr = landed ? side(landedMs, q.destination.tz)
    : Number.isFinite(etaMs) ? side(etaMs, q.destination.tz, { est: formatLocal(etaMs, q.destination.tz), note: `Hora local de ${q.destination.city} · según Flightradar24` }) : null;
  const diverted = h?.state === 'diverted';
  const card = {
    al, title: flightTitle({ name, al, n }), number: `${al} ${n}`, airline: name,
    photo: exact && !exact.representative ? exact : null, operator: null,
    route: `${q.origin.city} a ${q.destination.city}`,
    status: diverted ? { text: 'Desviado', tone: 'bad' } : { text: 'Visto en vuelo por Flightradar24', tone: 'info' },
    o: q.origin.iata, a: q.destination.iata, duration: landed ? Math.round((landedMs - takeoffMs) / 60000) : null, durationEstimated: false,
    dep, arr, aircraft: model, gateChanged: false, stale: false, past: false,
    sourceNote: `Vuelo encontrado por Flightradar24 · sin horario publicado${landed ? ' · aterrizaje según Flightradar24' : ''}`,
    ...presentationFields({ phase: diverted ? 'cancelado' : landed ? 'terminado' : 'en-curso', depFinal: landed, arrFinal: landed, source: 'fr24', q,
      aircraftReg: r.reg ?? null, aircraftHex: r.hex ?? null, physicalKey: q.fr24Key }),
    depMs: landed ? takeoffMs : null, arrMs: landed ? landedMs : Number.isFinite(etaMs) ? etaMs : null, km: Math.round(distanceKm(q.origin, q.destination)),
  };
  return landed ? withLanding(card, landedMs, {}, 'fr24') : card;
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

// El vuelo físico ya se vio en el aire (o aterrizar) antes, para el mapa (mapPhase): en Aena, por número, fecha y ruta,
// porque su clave cambia cuando Aena retira la salida (de la hora de salida a la de llegada, physicalFlightKey); en
// AeroDataBox, su clave, que no cambia.
const flownPrefix = q => (q.kind === 'schedule' ? `${q.schedule.al}${q.schedule.n}|${q.leg.d}|${q.leg.o}|${q.leg.a}|` : radarKey(q));
// Clave del vuelo para avistamientos y aterrizajes guardados: el vuelo físico de Aena o el de AeroDataBox (nunca se mezclan).
const radarKey = q => (q.kind === 'adb' ? q.adbKey : q.kind === 'fr24' ? q.fr24Key : etaKey(q));
// La ficha se ve (y es la de este documento: un módulo antiguo de la app nunca pinta ni pide nada).
const cardVisible = () => els.result.isConnected && Boolean(els.result.querySelector('.flight')) && !els.result.closest('[hidden]');

// ---- Seguimiento en vivo con Flightradar24 (js/live-tracker.js; decisión del controlador, 21/10/2026) ----
// Con la ficha recibiendo «volando» de FR24, UN solo seguidor por ficha (identidad: tipo de consulta + vuelo físico)
// vuelve a pedir cada 45 s EXACTAMENTE la misma consulta del radar (fetchOnce de showRadar / showAdbRadar, sin ?poll) y
// pinta la respuesta por el camino de siempre (paintRadar → withRadar/withLanding → repaintFlight → avión y estela).
// Nunca dos temporizadores ni dos caminos de consulta: los repintados no crean otro y «Actualizar» del mismo vuelo
// físico conserva el mismo (en espera mientras rehace la ficha; luego él mismo hace la consulta: adoptLive). Se para con otra búsqueda, «Nueva consulta»,
// otro tramo, clearFicha, Aena final, cancelado o desviado, aterrizado, 401/403 o un «no-aplica». Pestaña oculta: cero
// peticiones. Un fallo no se pinta: la ficha se queda con la última lectura real.
let live = null; // { key, ctx: { q, flight, ctx, stale, fetchOnce }, tracker }
const liveKey = q => (physicalOf(q) ? `${q.kind}|${physicalOf(q)}` : null);
function stopLive() { live?.tracker.stop(); live = null; }
// El vuelo ya no está en curso para seguirlo: Aena final, cancelado o desviado, o la ficha ya terminada (aterrizado).
const liveOver = q => (q?.kind === 'schedule' && aenaFinal(q.leg)) || endedBadly(q) || ['finalizado', 'cancelado'].includes(flightPhase(shownCard ?? {}));
// Tras cada respuesta del sondeo de la ficha (la primera, la de «Actualizar» o la de «Localizando…»).
function followLive(q, flight, ctx, stale, radar, fetchOnce) {
  const key = liveKey(q);
  if (live?.tracker.stopped) live = null; // uno que se paró solo (aterrizado, 401/403…) no impide crear otro
  if (live && live.key !== key) stopLive();
  if (live) return; // ya hay UNA autoridad para este vuelo físico: ningún sondeo la sustituye ni la duplica
  if (radar?.state !== 'volando' || radar.source !== 'fr24' || !key || stale() || liveOver(q)) return;
  const c = { q, flight, ctx, stale, fetchOnce };
  const tracker = startLiveTracker({
    key,
    fetchOnce: () => c.fetchOnce({ poll: false }),
    onReading: r => paintRadar(c.q, c.flight, r, c.ctx, c.stale),
    // Fallo de la consulta de «Actualizar»: paintRadar conserva la última lectura real sobre la base nueva de Aena.
    onFailure: r => paintRadar(c.q, c.flight, r, c.ctx, c.stale),
    isActive: () => !c.stale() && cardVisible(),
    isOver: () => liveOver(c.q),
    // Si deja de ir al día (fallo, espera, pausa, parada) o vuelve, el avión puede pasar a atenuado o dejar de estarlo.
    onChange: () => { if (routeMap && shownCard) showPlane(routeMap, shownCard); },
    now: monoNow,
  });
  live = { key, ctx: c, tracker };
}
// «Actualizar» del mismo vuelo físico con el seguidor ya en marcha: la consulta de la ficha nueva la hace ESE seguidor
// (refresh; con una petición suya en curso, se usa esa), nunca un pollRadar aparte. Así nunca hay dos caminos de
// consulta del mismo vuelo, ni aunque una petición tarde minutos. → true si lo ha tomado.
function adoptLive(q, flight, ctx, stale, fetchOnce) {
  if (live?.tracker.stopped) live = null;
  if (!live || live.key !== liveKey(q) || stale()) return false;
  Object.assign(live.ctx, { q, flight, ctx, stale, fetchOnce });
  live.tracker.refresh();
  if (live.tracker.stopped) live = null;
  return true;
}
// El sondeo de esta consulta no llega a arrancar o se agota sin respuesta útil: un seguidor en espera (traspaso de
// «Actualizar») sale de ella como tras un fallo (siguiente intento a los 90 s), nunca se queda parado.
function liveIdle() { if (live?.tracker.held) live.tracker.feed(null); }
// El seguimiento va al día para la ficha en pantalla: la lectura siguiente está al llegar.
const liveOnTime = () => Boolean(live && live.tracker.onTime && live.key === liveKey(lastQuery));
document.addEventListener('visibilitychange', () => {
  live?.tracker.onVisibility();
  if (live?.tracker.stopped) live = null;
});

// Radar de un vuelo de AeroDataBox: mismo sondeo, mismo panel y misma distancia restante que los de Aena. Solo si la
// regla compartida (adbRadarGate) lo permite: dentro de la ventana del vuelo. Sin exigir transpondedor ni indicativo:
// con Flightradar24 el servidor lo busca por su número comercial (sin FR24, el servidor responde «no-aplica»).
async function showAdbRadar(q, flight, stale, ctx) {
  if (!flight || !LIVE_BASE) { liveIdle(); return; }
  if (adbRadarGate(q.adbLeg, q.adbMeta, Date.now(), { plannedMin: ctx?.plannedMin, requireIdentifier: false }).mode === 'none') { liveIdle(); return; }
  stopRadarPoll();
  const fetchOnce = ({ poll: isPoll }) => fetchAdbRadar(q.adbMeta.number, q.adbMeta.date, q.adbKey, undefined, undefined, { poll: isPoll });
  if (adoptLive(q, flight, ctx, stale, fetchOnce)) return;
  const poll = pollRadar({
    fetchOnce,
    onResult: radar => { paintRadar(q, flight, radar, ctx, stale); followLive(q, flight, ctx, stale, radar, fetchOnce); },
    onGiveUp: () => { if (!stale()) liveIdle(); },
    isActive: () => !stale() && cardVisible(),
  });
  radarPoll = poll;
  await poll.first;
}

// Radar de un vuelo que solo encontró Flightradar24: el mismo sondeo, panel y seguimiento en vivo que AeroDataBox, con
// /radar-fr24 (el radar de siempre en el servidor para ese vuelo físico ya descubierto). Solo si FR24 lo da ahora.
async function showFr24Radar(q, flight, stale) {
  if (!flight || !LIVE_BASE || q.fr24?.state !== 'found') { liveIdle(); return; }
  stopRadarPoll();
  const fetchOnce = ({ poll: isPoll }) => fetchFr24Radar(q.fr24.number, q.fr24.date, q.fr24Key, undefined, undefined, { poll: isPoll });
  if (adoptLive(q, flight, null, stale, fetchOnce)) return;
  const poll = pollRadar({
    fetchOnce,
    onResult: radar => { paintRadar(q, flight, radar, null, stale); followLive(q, flight, null, stale, radar, fetchOnce); },
    onGiveUp: () => { if (!stale()) liveIdle(); },
    isActive: () => !stale() && cardVisible(),
  });
  radarPoll = poll;
  await poll.first;
}

async function showRadar(q, flight, stale, ctx = null) {
  if (q.kind === 'adb') return showAdbRadar(q, flight, stale, ctx);
  if (q.kind === 'fr24') return showFr24Radar(q, flight, stale);
  if (!flight || flight.stale || !q.leg || q.leg.past) { liveIdle(); return; }
  if (!wantsRadar(q.leg, undefined, { originTz: timezoneOf(q.origin), destTz: timezoneOf(q.destination), plannedMin: ctx?.plannedMin })) { liveIdle(); return; }
  stopRadarPoll();
  q.etaCtx = ctx;
  // El mismo vuelo físico en la primera consulta, en todos los sondeos y en el seguimiento en vivo.
  const fetchOnce = ({ poll: isPoll }) => fetchRadar(q.schedule.al, q.schedule.n, undefined, undefined, { poll: isPoll, leg: physicalFlightKey(q.leg) });
  if (adoptLive(q, flight, ctx, stale, fetchOnce)) return;
  const poll = pollRadar({
    fetchOnce,
    onResult: radar => { paintRadar(q, flight, radar, ctx, stale); followLive(q, flight, ctx, stale, radar, fetchOnce); },
    onGiveUp: () => { if (!stale()) liveIdle(); },
    isActive: () => !stale() && cardVisible(),
  });
  radarPoll = poll;
  await poll.first;
}

// La tarjeta del vuelo con una lectura del radar ya «al recibirla» (atReceipt), sobre la base de Aena de AHORA (flight):
// withRadar, la ETA Turbi refinada si la llegada es estimada (raw: la lectura tal como llegó; remember: guardarla),
// withLanding y el fr24Id de un aterrizaje de FR24. Es el camino de siempre de paintRadar; también lo usa la última
// lectura real cuando la respuesta nueva falla.
function radarCard(q, flight, atReceipt, ctx, raw = atReceipt, { remember = true } = {}) {
  let card = withRadar(flight, atReceipt, recallSighting(radarKey(q)));
  if (flight.arr?.estimated) {
    const eta = turbiEta(q, ctx, raw);
    if (remember) rememberEta(etaKey(q), eta);
    // Nueva ETA visible → el estado se recalcula con ella (y el radar, si lo ve, sigue mandando).
    // La hora principal («Llega en») y la «Confianza» de la ficha siguen a esa misma ETA (js/card-model.js): arrMs es
    // la llegada visible en UTC y timeConfidence, la confianza que ya da eta.js (como en flightCard).
    const base = etaSide(eta)
      ? { ...flight, arr: etaSide(eta), arrMs: eta.ms, timeConfidence: eta.confidence ?? null,
        status: presentStatus({ leg: q.leg, city: q.destination.city, visibleArrivalMs: eta.ms }) }
      : { ...flight, arr: null, arrMs: null, timeConfidence: eta?.confidence ?? null,
        status: presentStatus({ leg: q.leg, city: q.destination.city, visibleArrivalMs: null }) };
    card = withRadar(base, atReceipt, recallSighting(radarKey(q)));
  }
  // Aterrizaje confirmado (ahora o antes, guardado): gana a «volando» y a «Ha salido»; nunca a Aena.
  card = withLanding(card, recallLanding(radarKey(q)), q.kind === 'schedule' ? q.leg : {}, recallLandingSource(radarKey(q)));
  // Aterrizado con una lectura de Flightradar24 de este vuelo físico: su fr24Id se queda en la tarjeta solo para pedir la
  // estela («Ruta realizada», syncTrack). No cambia el estado, los textos ni la fuente.
  if (card.radar?.state === 'aterrizado' && raw?.state === 'aterrizado' && raw.source === 'fr24' && typeof raw.fr24Id === 'string' && !card.radar.fr24Id) {
    card = { ...card, radar: { ...card.radar, fr24Id: raw.fr24Id } };
  }
  return card;
}

// Distancia restante animada desde la lectura «volando» de la tarjeta (su instante monotónico de recepción).
function startDistance(card, stale) {
  if (card.radar?.state !== 'volando') return;
  distanceTicker = startRemainingTicker({
    ref: distanceReference(card.radar, card.radarReceivedMono),
    now: monoNow,
    isActive: () => !stale() && !els.result.closest('[hidden]'),
    render: km => {
      const value = els.result.querySelector('.tm-remaining');
      if (!value?.firstChild) return false;
      value.firstChild.textContent = thousands(km);
      return true;
    },
  });
}

function paintRadar(q, flight, radar, ctx, stale) {
  // Aena ya confirmó la llegada (o canceló/desvió): ninguna lectura ADS-B, ni una respuesta tardía, la contradice.
  if (q.kind === 'schedule' && aenaFinal(q.leg)) return;
  flight = q.flightBase ?? flight; // la tarjeta con el último estado de Aena (refrescado)
  // Una respuesta fallida (sin respuesta o «no disponible») con una lectura real de este vuelo físico en la ficha no se
  // pinta encima: no borra telemetría ni avión. En el traspaso de «Actualizar» (la ficha nueva aún sin radar) la tarjeta
  // se rehace sobre la base NUEVA de Aena con esa última lectura real y su instante de recepción (sigue envejeciendo; el
  // avión, quieto donde estaba).
  if ((!radar || radar.state === 'no-disponible') && lastFix && lastFix.physicalKey === flight.physicalKey) {
    if (stale() || !shownCard || shownCard.radar || shownCard === lastFix || !els.result.querySelector('.flight')) return;
    let card = radarCard(q, flight, lastFix.radar, ctx, lastFix.radar, { remember: false });
    if (card.radar?.state !== 'volando') { repaintFlight(card, stale); return; } // p. ej. aterrizaje ya guardado
    card = { ...card, radarReceivedMono: lastFix.radarReceivedMono };
    q.lastRadar ??= lastFix.radar; // el refresco de Aena trata la ficha como «volando», igual que con la lectura real
    lastFix = card;
    stopDistance();
    repaintFlight(card, stale);
    startDistance(card, stale);
    return;
  }
  if (radar) q.lastRadar = radar;
  rememberSighting(radarKey(q), radar);
  rememberLanding(radarKey(q), radar);
  // La lectura tal como vale al recibirla (receivedRadar) y el instante MONOTÓNICO de recepción: de ahí envejecen
  // «Última señal», el avión del mapa y la distancia, sin el reloj civil del móvil.
  const receivedMono = monoNow();
  const atReceipt = receivedRadar(radar, Date.now());
  let card = radarCard(q, flight, atReceipt, ctx, radar);
  const landedAt = recallLanding(radarKey(q));
  const landedSource = recallLandingSource(radarKey(q));
  // Instante (monotónico) en que llegó esta lectura «volando» (envejecimiento de «Última señal» y del avión en
  // js/card-model.js); el mismo que toma la distancia animada como referencia.
  if (card !== flight && card.radar?.state === 'volando') card = { ...card, radarReceivedMono: receivedMono };
  const el = els.result.querySelector('.flight');
  if (stale() || card === flight || !el) return;
  // Última posición real conocida de esta ficha (la que se queda quieta y atenuada si la lectura siguiente no la trae).
  if (planeOnMap(card.radar, card.radarReceivedMono, receivedMono)) lastFix = card;
  // Cada lectura real es la nueva referencia de la distancia y de la señal (las anteriores se descartan en el acto).
  stopDistance();
  // Solo se sustituye la tarjeta .flight (con su estado: repaintFlight): la sección Turbulencias no se toca.
  repaintFlight(card, stale);
  startDistance(card, stale);
  // El aviso de llegada no puede contradecir al radar (en el aire) ni a un aterrizaje confirmado.
  const note = els.result.querySelector('.note');
  const replacement = Number.isFinite(landedAt) ? landedNote(landedSource) : radarNote(radar);
  if (replacement && [ENDED_ESTIMATED, NO_ARRIVAL_NOTE].includes(note?.textContent)) note.textContent = replacement;
  // Aterrizado según el radar: repaintFlight ya quitó la tarjeta Turbulencias (syncTurbArea) y el pronóstico que se vio
  // antes queda como «Turbulencias estimadas» en el Resumen del vuelo. Sin pedir nada.
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
    // Aena gana: fuera la telemetría, el radar (también su seguimiento en vivo) y la distancia animada.
    stopRadarPoll();
    stopLive();
    // Llegada final, cancelado o desviado: repaintFlight quita la tarjeta Turbulencias (syncTurbArea), sin calcular ni
    // pedir nada; si aterrizó, el pronóstico visto antes va al Resumen del vuelo.
    repaintFlight(flight, stale);
    if (turbOver(flight)) return;
    const flags = [leg.st, leg.std, leg.sta];
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
      departureEstimate({ leg: q.leg, arrivalUtcMs: officialMs, plannedMin: profile.durationMin, tz: oTz })), landedAt, q.leg, recallLandingSource(etaKey(q)))
    : q.kind === 'adb' ? (q.adbLeg.closedBy === 'fr24'
      ? withLanding(adbCard(q, profile.durationMin, await loadAirlinePhotos()), q.adbLeg.arr.runway.utc, {}, 'fr24') // cerrado por FR24
      : withLanding(adbCard(q, profile.durationMin, await loadAirlinePhotos()), landedAt, {}, recallLandingSource(q.adbKey))) : null;
  // Para js/card-model.js (cuentas «Sale en / Llega en / Duración»): la salida y la llegada visibles en UTC, sin calcular
  // nada nuevo. En AeroDataBox, la llegada visible es su mejor hora (adbTimes), la misma que muestra la ficha.
  const arrMs = q.kind === 'adb' ? adbTimes(q.adbLeg).arr?.utc ?? null : visibleArrivalMs;
  if (flight) Object.assign(flight, { depMs: departureMs, arrMs, km: profile.km, seenFlying: seenBefore(flownPrefix(q)) });
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
  // El mapa se queda fuera de clearFicha y lo recoge syncMap con el armazón nuevo. Dos pulsaciones seguidas: la
  // segunda hereda el que conservó la primera y aún no se montó (si no, clearFicha lo destruiría).
  const kept = same ? (keptMap ?? keepMap()) : null;
  if (kept) keptMap = null;
  // El seguimiento en vivo y la última posición real del MISMO vuelo físico pasan a la ficha nueva (el seguidor, en espera
  // hasta la primera respuesta de esta consulta: nunca dos a la vez).
  const keptLive = same && live?.key === liveKey(q) && !live.tracker.stopped ? live : null;
  const keptFix = same ? lastFix : null;
  // El Calm Score del último pronóstico válido del MISMO vuelo físico se queda hasta que llegue el nuevo (sin parpadeo).
  const keptCalmScore = same ? currentView?.calm ?? keptCalm : null;
  if (keptLive) live = null;
  clearFicha(); // y su mapa
  keptCalm = keptCalmScore;
  keptMap = kept;
  lastFix = keptFix;
  if (keptLive) { live = keptLive; live.tracker.hold(); }
  if (same) reopen = new Set(same.open);
  if (same && trackAsked?.failed) trackAsked = null; // «Actualizar» reintenta la estela solo si la anterior falló
  const stale = () => token !== runId;
  els.refresh.hidden = false;
  if (!same) show('loading'); // «Actualizar» del mismo vuelo: la ficha sigue a la vista mientras se consulta
  try {
    if (q.kind === 'fr24') { await runFr24(q, same, stale); return; }
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
    const landedText = Number.isFinite(landedAt) && [ENDED_ESTIMATED, NO_ARRIVAL_NOTE].includes(arrived)
      ? landedNote(recallLandingSource(radarKey(q))) : null;
    const note = landedText ?? arrived ?? (rel === null ? 'Falta más de una semana: vuelve a consultar más cerca de la fecha.'
      : q.leg?.st === 'CAN' || ['Canceled', 'CanceledUncertain'].includes(q.adbLeg?.status) ? 'Vuelo cancelado.'
      : null);
    if (note) {
      if (!flight) throw new Error(note);
      currentView = null;
      keptCalm = null; // sin pronóstico que calcular: tampoco el número del anterior
      els.result.innerHTML = legSwitchHtml(q) + flightNoteHtml({ flight: withTurbEstimate(flight), punctuality: punct, note }); // Turbulencias con el motivo (terminado: initFicha la quita)
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
      els.result.innerHTML = legSwitchHtml(q) + flightShellHtml({ flight: withCalm(withTurbEstimate(flight)), punctuality: punct });
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
      if (err?.serviceUnavailable) throw err;
      if (stale()) return;
      return await runLegacy(q, forecastProfile, times, flight, rel, stale);
    }
    if (stale()) return;
    Object.assign(view, { punctuality: punct, originTz: oTz, destinationTz: dTz, etaCtx });
    showForecast(view, q, stale).catch(() => { if (!stale()) showError('Algo ha fallado al mostrar el pronóstico.', true); });
  } catch (err) {
    if (stale()) return;
    dropKeptMap(); // el error sustituye a la ficha: el mapa conservado que no llegó a montarse, fuera
    stopLive();
    // fetch lanza TypeError sin conexión; su mensaje viene en inglés.
    const network = err instanceof TypeError;
    const msg = network ? 'Sin conexión o el servicio no responde.' : err.message;
    showError(msg || 'Algo ha fallado. Inténtalo de nuevo.', network || err.retryable === true);
  }
}

// Vuelo que solo encontró Flightradar24: su ficha (fr24Card) y su radar; sin horario no hay ventana de vuelo que
// pronosticar, así que la tarjeta Turbulencias lo dice (y Calm Score no se calcula). Sin puntualidad (no es de Aena).
const FR24_ONLY_NOTE = 'Vuelo encontrado por Flightradar24 sin horario publicado: no se muestra la previsión de turbulencias.';
async function runFr24(q, same, stale) {
  const flight = fr24Card(q, await loadAirlinePhotos(), await loadAirlines());
  if (stale()) return;
  currentView = null;
  keptCalm = null;
  els.changeTime.hidden = true;
  const note = flightPhase(flight) === 'finalizado' ? landedNote('fr24') : FR24_ONLY_NOTE;
  els.result.innerHTML = flightNoteHtml({ flight: withTurbEstimate(flight), punctuality: null, note });
  show('result');
  initFicha(q, flight, stale);
  if (same) restoreScroll(same.scrollY);
  await safely(() => showRadar(q, flight, stale, null));
}

let lastForecastCtx = null;
// Open-Meteo caído (red, timeout, 429, 5xx; ver js/weather.js): sin cálculo simplificado, que volvería a consultarlo.
const isWeatherUnavailable = err => err?.serviceUnavailable === true || err instanceof TypeError;

// Sección de turbulencias de la ficha: pronóstico (o cálculo simplificado si los modelos no dan datos). Si Open-Meteo
// falla (429, red…), solo esta sección lo dice, con «Reintentar»; la ficha no se toca.
async function loadForecastSection(ctx) {
  const { q, profile, forecastProfile, flight, punct, oTz, dTz, etaCtx, rel, stale } = ctx;
  const area = () => $in('forecast-area');
  if (!area()) return;
  // Vuelo ya terminado (o cancelado/desviado): ni tarjeta ni pronóstico calculado a posteriori (ninguna consulta).
  if (turbOver(shownCard)) { syncTurbArea(); return; }
  area().innerHTML = forecastLoadingHtml();
  // Sin pronóstico nuevo válido (error, cálculo simplificado o aterrizaje entre medias), el número del anterior se va.
  const dropKeptCalm = () => { if (keptCalm && !stale()) { keptCalm = null; paintCalm(); } };
  const times = `${formatLocal(profile.departureMs, oTz)}–${formatLocal(profile.arrivalMs, dTz)}`; // horas de bloque
  let view;
  try {
    view = await forecastView({ q, profile: forecastProfile, flight, times, nowMs: Date.now() });
  } catch (err) {
    if (stale() || !area()) return;
    dropKeptCalm();
    if (turbOver(shownCard)) { syncTurbArea(); return; } // aterrizó mientras se calculaba
    if (!isWeatherUnavailable(err)) {
      // Los modelos ECMWF/GFS no dan datos: cálculo simplificado (v1), también dentro de la sección (su tarjeta ya
      // dice que es el cálculo simplificado).
      try {
        // La MISMA ventana en el aire que el pronóstico v2.
        const route = buildRoute(q.origin, q.destination, forecastProfile.departureMs, forecastProfile.durationMin);
        const { segments, verdict } = analyze(route, await fetchRouteWeather(route));
        if (stale() || !area()) return;
        if (turbOver(shownCard)) { syncTurbArea(); return; }
        const legacy = { verdict, reliability: rel, durationMin: route.durationMin, segments, sectionOnly: true };
        paintLegacySection(legacy);
        rememberForecast(q, legacyDigest(legacy, Date.now()));
        await nameSegments(segments, q.origin.iata);
        // Solo si la tarjeta sigue ahí: un aterrizaje o una nota entre medias (cancelado, desviado) no se pisa.
        if (!stale() && area()?.querySelector('[data-card="turbulence"]')) paintLegacySection(legacy);
        return;
      } catch (err2) {
        if (stale() || !area() || turbOver(shownCard)) return;
        area().innerHTML = forecastUnavailableHtml(err2 instanceof TypeError ? new Error('Sin conexión o el servicio no responde.') : err2);
        return;
      }
    }
    area().innerHTML = forecastUnavailableHtml(err instanceof TypeError ? new Error('Sin conexión o el servicio no responde.') : err);
    return;
  }
  if (stale() || !area()) return;
  // Aterrizado mientras se calculaba: un pronóstico que llega después no se pinta ni se guarda como el del vuelo.
  if (turbOver(shownCard)) { dropKeptCalm(); syncTurbArea(); return; }
  Object.assign(view, { punctuality: punct, originTz: oTz, destinationTz: dTz, etaCtx });
  view.calm = calmOf(view); // una vez por pronóstico: ni la posición ni el estado del vuelo lo cambian
  currentView = view;
  keptCalm = null;
  paintForecastSection(view);
  paintCalm();
  rememberForecast(q, forecastDigest(view));
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
let routeMap = null; // el mapa (MapLibre) de la ficha: uno solo, sobre el #map del mapa protagonista (heroNode)
let heroNode = null; // el #map-card del mapa: fuera del HTML que se repinta, colocado en el #map-slot de la ficha
let mapFailed = false; // el mapa de esta ficha no se pudo crear (sin MapLibre, WebGL o red): no se reintenta en cada repintado
let mapToken = 0; // un mapa que termina de crearse cuando su ficha ya no está se destruye en el acto
let signalTimer = null;

function destroyMap() { mapToken++; routeMap?.destroy(); routeMap = null; heroNode?.remove(); heroNode = null; }
// La ficha deja de estar (otra búsqueda, «Nueva consulta», pantalla de elección, pronóstico guardado): fuera su mapa
// (también uno conservado por «Actualizar» que aún no se montó), el avión retenido y los desplegables pendientes.
// No va en stopRadarPoll: applyAenaLeg para el radar con la llegada final y el mapa se queda («Ruta realizada»). También
// el seguimiento en vivo y la última posición real conocida.
function clearFicha() { destroyMap(); mapFailed = false; dropKeptMap(); stopPlaneTimer(); stopLive(); lastFix = null; reopen.clear(); stopSignal(); shownCard = null; }

// ---- «Actualizar» del mismo vuelo físico (decisión de 20/10/2026; solo presentación) ----
// La consulta es la de siempre (submit → run: Aena, radar con su pollRadar, pronóstico, puntualidad); solo cambia cómo
// se sustituye la ficha si es del MISMO vuelo físico (physicalFlightKey del tramo de Aena o adbKey de AeroDataBox):
// el mapa (#map-card, MapLibre) pasa a la ficha nueva (sin destruirlo, recentrarlo ni cambiar el zoom), los
// desplegables abiertos se vuelven a abrir, el scroll se restaura y no se muestra la pantalla de carga. Otra clave u
// otra clase de consulta: como siempre.
const physicalOf = q => (q?.kind === 'schedule' ? physicalFlightKey(q.leg) : q?.kind === 'adb' ? q.adbKey : q?.kind === 'fr24' ? q.fr24Key : null);
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
// mapa (MapLibre no ha cargado o aún se está creando), nada: mountMap crea uno, como siempre.
let keptMap = null;
function keepMap() {
  const node = heroNode;
  if (!routeMap || !node) return null;
  const kept = { node, map: routeMap, card: shownCard };
  routeMap = null;
  heroNode = null; // sigue en pantalla hasta que se pinte la ficha nueva (no lo destruye clearFicha)
  return kept;
}
function dropKeptMap() { keptMap?.map.destroy(); keptMap = null; }
// El mapa conservado va al #map-slot de la ficha nueva. Sus botones ya están cableados (wireMapCard busca routeMap al
// pulsar): no se vuelven a cablear. Sin encuadrar ni otro mapa. El pronóstico anterior se quita (si el nuevo falla, no
// queda coloreado con datos viejos) y lo vuelve a poner forecastExtras.
function adoptMap(slot) {
  const { node, map, card: prev } = keptMap;
  keptMap = null;
  slot.replaceChildren(node);
  heroNode = node;
  routeMap = map;
  const title = node.querySelector('.card-title');
  if (title) title.textContent = mapTitle(mapPhase(shownCard) ?? flightPhase(shownCard));
  map.invalidate();
  // Como recién creado: la ruta sin colorear, sin SIGMET ni PIREP; el pronóstico nuevo la colorea (forecastExtras).
  map.clearForecast();
  // El avión de antes se queda con su última posición real (lastFix, conservada por run) mientras siga vigente.
  if (!lastFix && planeOnMap(prev?.radar, prev?.radarReceivedMono, monoNow())) lastFix = prev;
  showPlane(map, shownCard);
}
// Última posición REAL conocida de esta ficha (lastFix: la última tarjeta con «volando» y posición; decisión del
// controlador, 21/10/2026): si la lectura actual no trae posición (localizando, sin datos, estimada, «reciente», un
// traspaso de «Actualizar» aún sin respuesta), el avión se queda EXACTAMENTE ahí mientras tenga ≤ 180 s, quieto y
// con su frescura real (atenuado según withDim). Nunca de otro vuelo físico ni de otro avión, ni con la
// ficha terminada o cancelada. Pasados 180 s, fuera. planeTimer: un solo temporizador al siguiente cambio (60 s: deja
// de ser fresca; 180 s: desaparece); cero peticiones.
let lastFix = null, planeTimer = null;
function stopPlaneTimer() { if (planeTimer !== null) clearTimeout(planeTimer); planeTimer = null; }
function planeFor(card) {
  if (!card) return null;
  const pos = card.radar?.state === 'volando' ? planeOnMap(card.radar, card.radarReceivedMono, monoNow()) : null;
  if (pos) return { pos, from: card };
  const fix = lastFix;
  if (!fix || fix.physicalKey !== card.physicalKey || ['finalizado', 'cancelado'].includes(flightPhase(card))) return null;
  const id = planeIdentity(card);
  if (!id.endsWith('|') && id !== planeIdentity(fix)) return null; // la lectura actual es de otro avión
  const old = planeOnMap(fix.radar, fix.radarReceivedMono, monoNow());
  return old ? { pos: old, from: fix } : null;
}
// Estilo (decisión del controlador, ronda 1): pasados 60 s la posición NO es fresca (ni anima ni prolonga la estela),
// pero solo se ATENÚA cuando falta una lectura esperada: sin seguimiento al día (parado, en espera, en pausa o tras un
// fallo) o con más de 60 + 45 s (la lectura del ciclo ya debería haber llegado). Con el seguimiento al día, quieta y sin
// atenuar hasta la lectura siguiente.
const DIM_ON_TIME_S = PLANE_MAX_AGE_S + LIVE_INTERVAL_MS / 1000;
function withDim(seen) {
  if (!seen) return null;
  const ageS = positionAgeS(seen.from.radar, seen.from.radarReceivedMono, monoNow());
  const dim = !seen.pos.fresh && (!liveOnTime() || !(ageS <= DIM_ON_TIME_S));
  return { ...seen, ageS, pos: { ...seen.pos, dim } };
}
// Vuelve a mirar el avión cuando cambie su frescura (60 s), cuando deba atenuarse al día (105 s) o caduque (180 s), con
// la ficha que haya entonces.
function schedulePlane(map, seen) {
  stopPlaneTimer();
  if (!seen) return;
  const { ageS } = seen;
  if (!Number.isFinite(ageS)) return;
  const limit = seen.pos.fresh ? PLANE_MAX_AGE_S : !seen.pos.dim && ageS <= DIM_ON_TIME_S ? DIM_ON_TIME_S : PLANE_LAST_KNOWN_S;
  planeTimer = setTimeout(() => { planeTimer = null; if (routeMap === map && shownCard) showPlane(map, shownCard); },
    Math.max(0, (limit - ageS) * 1000) + 1);
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
  if (el) el.innerHTML = advancedFlightHtml(card, { open, monoMs: monoNow() });
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

// Vuelo terminado, cancelado o desviado: la tarjeta Turbulencias desaparece entera (#forecast-area vacío y oculto, sin
// dejar hueco). Nunca se calcula un pronóstico después: lo que se pronosticó ANTES de aterrizar queda, si lo hay, como
// «Turbulencias estimadas» en el Resumen del vuelo (withTurbEstimate).
const turbOver = card => Boolean(card) && ['finalizado', 'cancelado'].includes(flightPhase(card));
function syncTurbArea(card = shownCard) {
  const area = $in('forecast-area');
  if (!area || !turbOver(card)) return;
  if (area.innerHTML) area.innerHTML = '';
  area.hidden = true;
}
// El último pronóstico válido de ESTE vuelo físico (js/turb-memory.js), solo en un vuelo aterrizado: cancelado y
// desviado (fase «cancelado») nunca lo llevan.
function withTurbEstimate(card) {
  if (!card || flightPhase(card) !== 'finalizado') return card;
  const t = recallTurb(card.physicalKey);
  return t ? { ...card, turbEstimate: t } : card;
}
// Se guarda el pronóstico mostrado solo mientras el vuelo no ha terminado, con la clave de su vuelo físico.
function rememberForecast(q, digest) {
  if (!turbOver(shownCard)) rememberTurb(physicalOf(q), digest);
}
// Calm Score del pronóstico v2 en pantalla (js/calm-score.js), con el color de su titular (como «General»). El cálculo
// simplificado (v1) no lo lleva: sin el Turbi Index por punto no es comparable. Va en la cabecera de la ficha: lo lleva
// cada repintado (withCalm) y, al llegar el pronóstico, paintCalm lo pone sin repintar el resto.
function calmOf(view) {
  const k = calmScore(view);
  return k && { ...k, level: view.summary.maxLevel };
}
// keptCalm: el del pronóstico anterior del mismo vuelo durante «Actualizar», hasta que el nuevo llega (o falla).
let keptCalm = null;
// calmSigmet: aclaración en la explicación si un SIGMET podría afectar al vuelo (el número no cambia).
const withCalm = card => {
  const calm = currentView?.calm ?? keptCalm;
  return card && calm ? { ...card, calm, calmSigmet: sigmetAffectsFlight(currentView?.aviation) } : card;
};
function paintCalm() {
  const status = els.result.querySelector('.flight .hero-status');
  if (!status || !shownCard) return;
  const open = openCards().has('calm');
  status.querySelector('.calm')?.remove();
  status.insertAdjacentHTML('beforeend', calmHtml(withCalm(shownCard), open));
}
// La tarjeta del cálculo simplificado (renderResult con sectionOnly) en #forecast-area, conservando sus desplegables.
function paintLegacySection(legacy) {
  const area = $in('forecast-area');
  if (!area) return;
  const tmp = { innerHTML: '' };
  renderResult(tmp, legacy, { open: openCards() });
  area.innerHTML = tmp.innerHTML;
  reopenCards();
}
// Pinta (o repinta) la tarjeta de Turbulencias con la vista ya calculada, conservando sus desplegables. Sin peticiones.
function paintForecastSection(view) {
  const area = $in('forecast-area');
  if (!area) return;
  area.innerHTML = forecastSectionHtml(view, Date.now(), { open: openCards() });
  reopenCards();
  wireSpeak(view);
  paintNow();
}

// «Ahora» en la tarjeta de Turbulencias (vuelo en curso con pronóstico v2; turbNow de js/card-model.js). Posición: la
// del avión que se ve en el mapa (planeFor: las mismas reglas de 60/180 s y de la última posición real conocida,
// lastFix); sin ella, la distancia restante de esa misma lectura mientras siga vigente (≤ PLANE_LAST_KNOWN_S). Sin nada
// de eso, ni marcador ni texto. Cero peticiones y ningún temporizador propio: lo llaman el pintado del pronóstico, cada
// repintado de la ficha (cada lectura real) y el contador de señal de 1 s que ya existe (así se quita a tiempo).
function nowOnForecast(card = shownCard, view = currentView) {
  if (!card || !view?.route || flightPhase(card) !== 'en-curso') return null;
  const seen = planeFor(card);
  const from = seen?.from ?? card;
  if (from.radar?.state !== 'volando') return null;
  const ageS = signalState(from.radar, from.radarReceivedMono, monoNow())?.ageS;
  const remainingKm = Number.isFinite(ageS) && ageS <= PLANE_LAST_KNOWN_S ? from.radar.remainingKm : null;
  return turbNow(view, { pos: seen?.pos ?? null, remainingKm });
}
function paintNow() {
  const timeline = $in('timeline'), slot = $in('turb-now');
  if (!timeline || !slot) return;
  const now = nowOnForecast();
  if (!now) {
    for (const el of timeline.querySelectorAll('.tnow, .tnow-past')) el.remove();
    if (!slot.hidden) { slot.hidden = true; slot.innerHTML = ''; }
    return;
  }
  // El marcador solo se desplaza (transición CSS) cuando ya estaba: recién puesto, aparece en su sitio.
  timeline.style.setProperty('--now-x', `${(Math.min(1, Math.max(0, now.frac)) * 100).toFixed(2)}%`);
  if (!timeline.querySelector('.tnow')) timeline.querySelector('.tchart')?.insertAdjacentHTML('beforeend', turbNowMarkHtml());
  const html = turbNowHtml(now);
  if (slot.dataset.html !== html) { slot.innerHTML = html; slot.dataset.html = html; }
  slot.hidden = false;
}

// Mapa del vuelo (Radar / Ruta realizada; js/map.js): SOLO en el aire o aterrizado con evidencia real (mapPhase,
// js/card-model.js: nunca por haber pasado la hora de salida ni embarcando). La ficha deja el hueco #map-slot y aquí se pone el mapa: se crea al
// pintarla en esa fase o al entrar en ella con la ficha abierta (repaintFlight), se conserva entre repintados y en
// «Actualizar», y se quita si la ficha deja de tenerlo (cancelada o desviada). Antes de volar, ni mapa ni hueco. Ruta
// en círculo máximo (sin meteorología) y aeropuertos; setForecast la colorea cuando hay pronóstico y setPlane pone o
// quita el avión. MapLibre es prescindible: si no carga, el hueco queda vacío (no ocupa sitio) y nada más cambia.
function syncMap(q, stale) {
  const slot = $in('map-slot');
  if (!slot || !q?.origin || !q?.destination) { destroyMap(); dropKeptMap(); return; } // sin hueco: sin mapa
  if (heroNode) {
    if (heroNode.parentNode !== slot) { slot.replaceChildren(heroNode); routeMap?.invalidate(); }
    return;
  }
  if (keptMap) { adoptMap(slot); return; } // «Actualizar» del mismo vuelo físico: el mapa de antes, tal cual
  if (!mapFailed) mountMap(q, stale, slot);
}
function mountMap(q, stale, slot) {
  destroyMap();
  slot.innerHTML = mapHeroHtml(mapPhase(shownCard ?? {}) ?? flightPhase(shownCard ?? {}));
  heroNode = slot.firstElementChild;
  const card = heroNode, el = heroNode.querySelector('#map');
  const token = mapToken;
  // El mapa aún se está creando: se busca al pulsar.
  wireMapCard(card, { expanded: on => routeMap?.expanded?.(on) }, loadTrackOnDemand);
  let route;
  try { route = buildRoute(q.origin, q.destination, 0).points; } catch { return; }
  createRouteMap(el, { origin: q.origin, destination: q.destination, route }).then(m => {
    if (token !== mapToken || stale()) { m.destroy(); return; }
    routeMap = m;
    if (currentView?.route) m.setForecast(currentView);
    showPlane(m, shownCard);
  }).catch(() => {
    // Sin mapa: fuera su nodo (el hueco vacío no ocupa sitio) y la ficha sigue igual, con todos los datos en texto.
    if (token !== mapToken) return;
    mapFailed = true;
    destroyMap();
  });
}

// Avión en el mapa: posición real de 60 s o menos (planeOnMap) y la identidad de esa lectura (vuelo físico + avión
// por su fr24Id de Flightradar24, por transpondedor o, si no, indicativo), para que el mapa no anime entre dos aviones o
// dos vuelos distintos: un cambio de fr24Id coloca el avión directamente.
const planeIdentity = card => `${card?.physicalKey ?? ''}|${card?.radar?.fr24Id ?? card?.radar?.hex ?? card?.radar?.callsign ?? ''}`;
function showPlane(map, card) {
  const seen = withDim(planeFor(card));
  const before = planeTimes.map === map ? planeTimes.utc : null;
  map?.setPlane(seen?.pos ?? null, { identity: seen ? planeIdentity(seen.from) : planeIdentity(card) });
  notePlaneTime(map, seen ? readingUtc(seen.from.radar) : null, before);
  if (map && map === routeMap) schedulePlane(map, seen);
  syncTrack(map, card);
}

// ---- Estela real del vuelo (Flightradar24 Flight Tracks; solo presentación) ----
// Con un fr24Id en la lectura del radar y el mapa sin estela de esa identidad (planeIdentity: vuelo físico + fr24Id), se
// pide UNA vez /track (Aena) o /track-adb (AeroDataBox) con el mismo ?leg= y se pinta hasta la posición del avión en
// pantalla, nunca más allá. Cada posición real nueva del mismo avión (planeOnMap) la prolonga. Otra identidad: la estela
// se borra y se pide la nueva. Vuelo ya aterrizado («finalizado», nunca cancelado ni desviado) sin fr24Id en la ficha: se
// pide UNA vez igualmente y la identidad la da el fr24Id de la respuesta (el que el servidor asoció a este vuelo físico):
// la ruta realizada, sin avión. trackAsked va con el mapa: «Actualizar» del mismo vuelo (que conserva el mapa) no la
// vuelve a pedir, salvo que la anterior fallara o se descartara; los sondeos, nunca.
// Horas SIEMPRE del servidor (nunca el reloj del móvil): la de una posición es checked − posAgeS; las de la estela, las
// de FR24 (times).
let trackAsked = null; // { map, identity, failed, onDemand? }
let trackLast = null; // { map, ms }: hora (UTC del servidor) del último punto real de la estela
let planeTimes = { map: null, utc: null, fromUtc: null }; // hora de la posición del avión en pantalla y de la anterior
const readingUtc = radar => {
  const checked = typeof radar?.checked === 'string' ? Date.parse(radar.checked) : NaN;
  return radar?.state === 'volando' && Number.isFinite(checked) && Number.isFinite(radar.posAgeS) && radar.posAgeS >= 0 ? checked - radar.posAgeS * 1000 : null;
};
// Tras setPlane: una lectura nueva que el mapa anima desde la anterior guarda la hora de la anterior (fromUtc): mientras se
// desplaza, el avión está entre las dos y la estela no puede pasar de la primera.
function notePlaneTime(map, utc, before) {
  if (!map) return;
  if (!map.planeState?.().shown) { planeTimes = { map, utc: null, fromUtc: null }; return; }
  if (planeTimes.map === map && utc === planeTimes.utc) return; // repintado de la misma lectura
  planeTimes = { map, utc, fromUtc: map.planeState().moving ? before : null };
}
// Hasta qué hora se puede pintar la estela: sin avión, toda; con el avión de esta identidad, la de su posición en
// pantalla (la de la lectura anterior si aún se desplaza). null: no se sabe (u otro avión) → no se pinta todavía.
function trailLimit(map, identity) {
  const st = map.planeState?.();
  if (!st?.shown) return Infinity;
  if (st.identity !== identity || planeTimes.map !== map) return null;
  const ms = st.moving ? planeTimes.fromUtc : planeTimes.utc;
  return Number.isFinite(ms) ? ms : null;
}
const endedBadly = q => (q?.kind === 'schedule' ? [q.leg?.st, q.leg?.std, q.leg?.sta].some(f => f === 'CAN' || f === 'DES')
  : q?.kind === 'adb' ? ['Canceled', 'CanceledUncertain', 'Diverted'].includes(q.adbLeg?.status)
  : q?.kind === 'fr24' ? q.fr24?.history?.state === 'diverted' : true);
function syncTrack(map, card) {
  if (!map?.setTrack || !card?.physicalKey) return;
  const fr24Id = typeof card.radar?.fr24Id === 'string' && card.radar.fr24Id ? card.radar.fr24Id : null;
  const own = `${card.physicalKey}|`;
  if (!fr24Id) {
    // Ruta realizada de un vuelo aterrizado: una sola petición; si ya hay estela de este vuelo físico, se queda.
    if (flightPhase(card) !== 'finalizado' || endedBadly(lastQuery) || map.trackIdentity()?.startsWith(own)) return;
    const asked = trackAsked?.map === map && trackAsked.identity.startsWith(own);
    if (asked && !(trackAsked.failed && trackAsked.identity !== `${own}*`)) return;
    const ended = trackAsked = { map, identity: `${own}*`, failed: false };
    requestTrack(map, card, null, ended).catch(() => { ended.failed = true; });
    return;
  }
  const identity = planeIdentity(card);
  if (map.trackIdentity() === identity) {
    // Solo una posición FRESCA (≤ 60 s) y real de esta identidad la prolonga; una vieja, nunca.
    const pos = planeOnMap(card.radar, card.radarReceivedMono, monoNow()), ms = readingUtc(card.radar);
    if (pos?.fresh && Number.isFinite(ms) && trackLast?.map === map && ms > trackLast.ms) { map.extendTrack([pos.lat, pos.lon], { identity, fresh: true }); trackLast.ms = ms; }
    return;
  }
  if (map.trackIdentity() !== null) map.clearTrack(); // otro avión u otro vuelo físico: nunca se mezclan
  if (trackAsked?.map === map && trackAsked.identity === identity) return;
  const asked = trackAsked = { map, identity, failed: false };
  requestTrack(map, card, fr24Id, asked).catch(() => { asked.failed = true; });
}
// Ruta realizada de un vuelo histórico que no estaba guardada: solo al ampliar el mapa (el usuario quiere verla) y una vez.
function loadTrackOnDemand() {
  const asked = trackAsked;
  if (!asked?.onDemand || asked.map !== routeMap || !shownCard || physicalOf(lastQuery) !== asked.onDemand) return;
  const next = trackAsked = { map: asked.map, identity: asked.identity, failed: false };
  requestTrack(next.map, shownCard, null, next, { load: true }).catch(() => { next.failed = true; });
}

// fr24Id: el de la lectura (la respuesta tiene que ser de ese) o null (aterrizado: se acepta el de la respuesta).
// load: el usuario pidió la ruta realizada (ver loadTrackOnDemand).
async function requestTrack(map, card, fr24Id, asked, { load = false } = {}) {
  const q = lastQuery, key = physicalOf(q);
  const r = q?.kind === 'schedule' ? await fetchTrack(q.schedule.al, q.schedule.n, physicalFlightKey(q.leg))
    : q?.kind === 'adb' ? await fetchAdbTrack(q.adbMeta.number, q.adbMeta.date, q.adbKey, undefined, undefined, { load }) : null;
  // Vuelo histórico sin estela guardada: no se descarga sola (cuesta); queda pendiente de que se amplíe el mapa.
  if (r?.state === 'on-demand' && trackAsked === asked && physicalOf(lastQuery) === key) { asked.onDemand = key; return; }
  const ok = r?.state === 'found' && typeof r.fr24Id === 'string' && (fr24Id === null || r.fr24Id === fr24Id)
    && Array.isArray(r.points) && Array.isArray(r.times) && r.times.length === r.points.length;
  // Cualquier descarte (no hay estela, otra ficha, mapa en traspaso, aún sin hora del avión): «Actualizar» lo reintenta.
  asked.failed = true;
  if (!ok || trackAsked !== asked || physicalOf(lastQuery) !== key) return;
  if (map !== routeMap && map !== keptMap?.map) return;
  // La ficha en pantalla o, durante «Actualizar» (clearFicha la deja a null), la que pintó el mapa conservado.
  const cur = shownCard ?? (map === keptMap?.map ? keptMap.card : null);
  if (cur?.physicalKey !== card.physicalKey) return;
  const identity = `${card.physicalKey}|${r.fr24Id}`;
  if (cur.radar?.fr24Id && planeIdentity(cur) !== identity) return; // la ficha ya va con otro avión
  const limit = trailLimit(map, identity);
  if (limit === null) return;
  const kept = r.points.map((p, i) => [p, r.times[i] * 1000]).filter(([p, ms]) => Array.isArray(p) && Number.isFinite(ms) && ms <= limit);
  if (!kept.length) return;
  asked.failed = false;
  map.setTrack(kept.map(([p]) => p), { identity });
  trackLast = { map, ms: kept.at(-1)[1] };
  if (cur.radar?.fr24Id) syncTrack(map, cur); // hasta el avión, si está en el mapa
}

// Lo común del armazón (ficha con pronóstico o con nota): Detalles avanzados y el mapa.
function initFicha(q, flight, stale) {
  shownCard = flight;
  syncTurbArea(flight);
  paintAdvancedFlight(flight);
  paintHistory(null);
  syncMap(q, stale);
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
  heroNode?.remove(); // el mapa se conserva (syncMap lo vuelve a poner en el hueco de la ficha nueva, si lo tiene)
  el.outerHTML = flightCardHtml(withCalm(withTurbEstimate(card)), { open, nowMs: Date.now(), monoMs: monoNow(), mapSlot: true });
  const slot = els.result.querySelector('.flight #punctuality');
  if (punct && slot) slot.replaceWith(punct);
  shownCard = card;
  syncTurbArea(card);
  paintAdvancedFlight(card, open);
  paintHistory(currentView, open);
  syncMap(lastQuery, stale);
  const title = $in('map-card')?.querySelector('.card-title');
  if (title) title.textContent = mapTitle(mapPhase(card) ?? flightPhase(card));
  showPlane(routeMap, card);
  paintNow();
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  if (els.result.scrollTop !== resultTop) els.result.scrollTop = resultTop;
  startSignal(card, stale);
}

// Contador de señal (§10 bis.2): entre dos lecturas (el seguimiento en vivo pide una cada 45 s; sin él, el radar deja de
// sondear tras «volando») la ficha envejece en pantalla. Temporizador encadenado de 1 s (como el de la distancia, nunca
// setInterval) mientras haya «volando» y la ficha se vea, con el reloj MONOTÓNICO: repinta el indicador y «Última señal»
// cuando cambia el texto y marca «Ahora» como antigua desde STALE_MIN. En Detalles avanzados solo reescribe los textos
// de antigüedad (.adv-signal y .adv-age): #adv-flight entero se repinta solo si cambia el nivel de la señal o la posición
// deja de ser fresca (pasa a llevar su antigüedad), para no perder el foco ni un toque cada segundo. El avión del mapa
// lo lleva schedulePlane. Cero peticiones.
function stopSignal() { if (signalTimer !== null) clearTimeout(signalTimer); signalTimer = null; }
function startSignal(card, stale) {
  stopSignal();
  const first = signalState(card?.radar, card?.radarReceivedMono, monoNow());
  if (!first) return; // solo «volando» con instante de recepción
  let fresh = planeOnMap(card.radar, card.radarReceivedMono, monoNow())?.fresh === true;
  let painted = null;
  let level = first.level; // el nivel con el que se pintó #adv-flight (initFicha / repaintFlight)
  const tick = () => {
    signalTimer = null;
    const flight = els.result.querySelector('.flight');
    if (stale() || shownCard !== card || !flight || els.result.closest('[hidden]')) return;
    const now = monoNow();
    const sig = signalState(card.radar, card.radarReceivedMono, now);
    if (!sig) return;
    const key = `${sig.level}|${sig.text}`;
    const aged = fresh && planeOnMap(card.radar, card.radarReceivedMono, now)?.fresh !== true;
    if (aged) fresh = false;
    if (key !== painted) { painted = key; paintSignal(flight, sig); }
    if (sig.level !== level || aged) { level = sig.level; paintAdvancedFlight(card); } else paintAdvancedAge(sig, positionAgeS(card.radar, card.radarReceivedMono, now));
    paintNow(); // «Ahora» se quita en cuanto su posición deja de valer (sin temporizador propio)
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
  syncMap(q, stale); // consulta manual: un vuelo aún por hacer, sin mapa
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
      paintNow(); // el marcador vive dentro de #timeline
      $in('segments').innerHTML = segmentListHtml(view); // la lista de tramos, con los lugares
    }),
    safely(async () => {
      view.runs = await fetchModelRuns(view.models);
      if (!stale()) $in('fresh').innerHTML = freshnessHtml(view, Date.now());
    }),
    safely(async () => {
      view.aviation = aviationView(await loadAviation(), view, Date.now());
      if (stale()) return;
      const wx = $in('wx-alerts'); // no está si el vuelo aterrizó entre medias (sin tarjeta Turbulencias)
      if (wx) wx.innerHTML = weatherAlertsHtml(view.aviation); // línea compacta de avisos en la tarjeta (§10 bis.1)
      paintAviation(view); // el detalle, en Detalles avanzados
      if (view === currentView) paintCalm(); // la aclaración del Calm Score si algún SIGMET podría afectar al vuelo
    }),
  ]);
  if (stale()) return;
  saveLast(view, view.queriedAt);
  // El mapa ya está (si la ficha lo lleva): ahora la ruta coloreada por nivel y los avisos. Si MapLibre aún no ha
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
