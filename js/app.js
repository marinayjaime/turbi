import { buildRoute } from './route.js';
import { localToUtcMs, formatLocal } from './time.js';
import { fetchRouteWeather, fetchTimezone } from './weather.js';
import { analyze, reliability } from './turbulence.js';
import { lookupFlight } from './flight.js';
import { fetchSchedule, pickLeg, tabDates, legDeparture, legArrival, flightStatus, isLate } from './schedule.js';
import { loadAirports, findAirport, searchAirports } from './airports.js';
import { nameSegments } from './places.js';
import { renderResult, esc, dateLabel } from './ui.js';
import { buildProfile } from './altitude.js';
import { forecastView, aviationView } from './forecast.js';
import { fetchModelRuns } from './models.js';
import { renderForecast, timelineHtml, segmentDetailHtml, freshnessHtml, aviationHtml, offlineBanner } from './ui-forecast.js';
import { recordSnapshot, forecastTrend, saveLast, loadLast, flightKey, agoText } from './storage.js';
import { loadAviation } from './aviation-weather.js';
import { renderMap } from './map.js';
import { buildSpeech, canSpeak, speak } from './speech.js';
import { currentPunctuality, fetchPunctuality, dowOf, slotOf } from './punctuality.js';
import { punctualityHtml } from './ui-punctuality.js';
import { aircraftName } from './plain.js';

const PUNCTUALITY_SINCE = '2026-09-24'; // primer día del histórico de puntualidad

const $ = id => document.getElementById(id);
const els = {
  queryView: $('query-view'), resultView: $('result-view'), form: $('query-form'),
  number: $('f-number'), origin: $('f-origin'), destination: $('f-destination'),
  date: $('f-date'), time: $('f-time'), manual: $('manual'), toggleManual: $('toggle-manual'),
  notice: $('notice'), airportsList: $('airports-list'), result: $('result'), back: $('back'),
  changeTime: $('change-time'), refresh: $('refresh'), loading: $('loading'), error: $('error'),
  errorMsg: $('error-msg'), retry: $('retry'), timeField: $('time-field'), savedLink: $('saved-link'),
};

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
  els.manual.hidden = !on;
  els.number.closest('.field').hidden = on;
  els.toggleManual.textContent = on ? 'Buscar por nº de vuelo' : 'Introducir a mano';
  setTimeNeeded(on, message);
}

async function airports() {
  if (!airportsDb) airportsDb = await loadAirports();
  return airportsDb;
}

async function scheduleQuery(schedule, date) {
  const leg = pickLeg(schedule.legs, date) ?? schedule.legs.find(l => l.d >= date);
  if (!leg) throw new Error('No tengo horarios de ese vuelo a partir de esa fecha.');
  const db = await airports();
  const origin = findAirport(db, leg.o);
  const destination = findAirport(db, leg.a);
  if (!origin || !destination) throw new Error(`No conozco el aeropuerto «${!origin ? leg.o : leg.a}».`);
  return { kind: 'schedule', number: `${schedule.al}${schedule.n}`, schedule, leg, origin, destination, date: leg.d };
}

async function resolveFlight() {
  const date = els.date.value, time = els.time.value;
  if (!date) throw new Error('Indica la fecha.');

  if (els.manual.hidden) {
    const number = els.number.value.trim();
    if (!number) throw new Error('Escribe el número de vuelo.');
    const schedule = await fetchSchedule(number);
    if (schedule) return scheduleQuery(schedule, date);
    const flight = await lookupFlight(number);
    if (!flight) {
      setManual(true, 'No encuentro ese vuelo, introdúcelo a mano.');
      return null;
    }
    if (els.timeField.hidden) {
      setTimeNeeded(true, 'No tengo el horario de este vuelo: indica la hora de salida.');
      els.time.focus();
      return null;
    }
    if (!time) throw new Error('Indica la hora de salida.');
    return { number: flight.number, airline: flight.airline, origin: flight.origin, destination: flight.destination, date, time };
  }

  if (!time) throw new Error('Indica la hora de salida.');

  if (!els.origin.value.trim() || !els.destination.value.trim()) throw new Error('Indica los aeropuertos de origen y destino.');
  const db = await airports();
  const origin = findAirport(db, els.origin.value);
  const destination = findAirport(db, els.destination.value);
  if (!origin) throw new Error(`No conozco el aeropuerto «${els.origin.value.trim()}».`);
  if (!destination) throw new Error(`No conozco el aeropuerto «${els.destination.value.trim()}».`);
  return { number: '', airline: '', origin, destination, date, time };
}

// Salida en UTC y duración real (si el horario trae la llegada).
function flightTimes(q, oTz, dTz) {
  if (q.kind !== 'schedule') return { departureMs: localToUtcMs(q.date, q.time, oTz), durationMin: null };
  const dep = legDeparture(q.leg), arr = legArrival(q.leg);
  const arrMs = arr ? localToUtcMs(arr.date, arr.time, dTz) : null;
  if (!dep) {
    // Solo sabemos la llegada (origen extranjero): la salida se estima por la distancia.
    const est = buildRoute(q.origin, q.destination, 0).durationMin;
    return { departureMs: arrMs - est * 60000, durationMin: est };
  }
  const departureMs = localToUtcMs(dep.date, dep.time, oTz);
  const dur = arrMs ? Math.round((arrMs - departureMs) / 60000) : null;
  return { departureMs, durationMin: dur > 0 && dur < 20 * 60 ? dur : null };
}

function flightCard(q, durationMin) {
  const { leg, schedule, origin, destination } = q;
  const dep = legDeparture(leg), arr = legArrival(leg);
  return {
    al: schedule.al,
    title: `${schedule.name ?? schedule.al} ${schedule.al} ${schedule.n}`,
    route: `${origin.city} a ${destination.city}`,
    tabs: tabDates(schedule.legs, leg.d).map(date => ({ date, active: date === leg.d })),
    status: flightStatus(leg),
    o: leg.o, a: leg.a, duration: durationMin,
    dep: leg.sd ? { date: leg.d, time: leg.sd, est: dep.time !== leg.sd ? dep.time : null, late: isLate(leg, 'dep'), terminal: leg.td, gate: leg.g } : null,
    arr: arr ? { date: arr.date, time: leg.sa, est: arr.time !== leg.sa ? arr.time : null, late: isLate(leg, 'arr'), terminal: leg.ta } : null,
    aircraft: aircraftName(leg.ac),
  };
}

// Situación de hoy (inmediata) + histórico (se carga después). Solo vuelos con horario de Aena.
function punctualityState(q) {
  const { leg, schedule } = q;
  return {
    current: currentPunctuality(leg), history: undefined, flight: q.number, airline: schedule.name ?? schedule.al,
    route: [leg.o, leg.a], dow: dowOf(leg.d), slot: leg.sd ? slotOf(leg.sd) : null, since: PUNCTUALITY_SINCE,
    dayLabel: leg.d === new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date()) ? 'Hoy' : dateLabel(leg.d),
  };
}

async function loadPunctualityHistory(q, punct, stale) {
  punct.history = await fetchPunctuality(q.schedule.al, q.schedule.n, `${q.leg.o}-${q.leg.a}`);
  const el = $in('punctuality');
  if (!stale() && el) el.innerHTML = punctualityHtml(punct);
}

async function run(q) {
  lastQuery = q;
  const token = ++runId;
  const stale = () => token !== runId;
  show('loading');
  try {
    const [oTz, dTz] = await Promise.all([fetchTimezone(q.origin), fetchTimezone(q.destination)]);
    if (stale()) return;
    const { departureMs, durationMin } = flightTimes(q, oTz, dTz);
    const profile = buildProfile(q.origin, q.destination, departureMs, durationMin);
    const flight = q.kind === 'schedule' ? flightCard(q, profile.durationMin) : null;
    const punct = flight ? punctualityState(q) : null;
    els.changeTime.hidden = Boolean(flight);
    const rel = reliability(departureMs, Date.now());
    const note = profile.arrivalMs < Date.now() ? 'Este vuelo ya ha aterrizado.'
      : rel === null ? 'Falta más de una semana: vuelve a consultar más cerca de la fecha.'
      : q.leg?.st === 'CAN' ? 'Vuelo cancelado.'
      : null;
    if (note) {
      if (!flight) throw new Error(note);
      currentView = null;
      renderResult(els.result, { flight, note });
      els.result.querySelector('.flight')?.insertAdjacentHTML('afterend', `<section id="punctuality">${punctualityHtml(punct)}</section>`);
      show('result');
      await safely(() => loadPunctualityHistory(q, punct, stale));
      return;
    }

    const times = `${formatLocal(profile.departureMs, oTz)}–${formatLocal(profile.arrivalMs, dTz)}`;
    let view;
    try {
      view = await forecastView({ q, profile, flight, times, nowMs: Date.now() });
    } catch (err) {
      // Sin red o sin cupo, el cálculo simplificado tampoco podría: se muestra el error.
      // (getJson ya convierte los fallos de red en errores en español; un TypeError aquí sería un fallo de código.)
      if (/No se pudo conectar|Demasiadas consultas/.test(err.message)) throw err;
      if (stale()) return;
      return await runLegacy(q, departureMs, durationMin, flight, rel, oTz, dTz, stale);
    }
    if (stale()) return;
    Object.assign(view, { punctuality: punct, originTz: oTz, destinationTz: dTz });
    showForecast(view, q, stale).catch(() => { if (!stale()) showError('Algo ha fallado al mostrar el pronóstico.', true); });
  } catch (err) {
    if (stale()) return;
    // fetch lanza TypeError sin conexión; su mensaje viene en inglés.
    const network = err instanceof TypeError;
    const msg = network ? 'Sin conexión o el servicio no responde.' : err.message;
    showError(msg || 'Algo ha fallado. Inténtalo de nuevo.', network || err.retryable === true);
  }
}

// Cálculo v1 (una capa, modelo automático de Open-Meteo): respaldo si los modelos ECMWF/GFS no dan datos.
async function runLegacy(q, departureMs, durationMin, flight, rel, oTz, dTz, stale) {
  const route = buildRoute(q.origin, q.destination, departureMs, durationMin);
  const weather = await fetchRouteWeather(route);
  if (stale()) return;
  const { segments, verdict } = analyze(route, weather);
  const view = {
    title: `${q.origin.iata} → ${q.destination.iata}`,
    subtitle: [q.number, q.airline].filter(Boolean).join(' · ') || `${q.origin.city} → ${q.destination.city}`,
    times: `${formatLocal(route.departureMs, oTz)}–${formatLocal(route.arrivalMs, dTz)}`,
    verdict, reliability: rel, durationMin: route.durationMin, segments, flight,
  };
  currentView = null;
  const paint = () => {
    renderResult(els.result, view);
    els.result.insertAdjacentHTML('afterbegin', '<p class="note-small">Cálculo simplificado: los modelos ECMWF y GFS no han dado datos para esta ruta.</p>');
  };
  paint();
  show('result');
  await nameSegments(segments, q.origin.iata);
  if (!stale()) paint();
}

const $in = id => els.result.querySelector(`#${id}`);
const safely = async fn => { try { await fn(); } catch { /* mejora opcional: si falla, no pasa nada */ } };

// Pinta el pronóstico y después, sin bloquear, añade lo secundario (cada cosa solo actualiza su hueco).
async function showForecast(view, q, stale, saved = false) {
  currentView = view;
  // Guardado: la tendencia era la de aquel momento, así que no se muestra.
  renderForecast(els.result, saved ? { ...view, saved, trend: null } : view, Date.now());
  show('result');
  const speakBtn = $in('speak');
  if (canSpeak()) {
    speakBtn.hidden = false;
    speakBtn.onclick = () => speak(buildSpeech({ from: view.fromCity, to: view.toCity, summary: view.summary, confidence: view.confidence.level }));
  }
  if (saved) return; // guardado: tal cual, sin pedir nada a la red

  saveLast(view, view.queriedAt);
  await safely(async () => {
    const snaps = recordSnapshot(flightKey(q), { t: view.queriedAt, maxLevel: view.summary.maxLevel, verdict: view.summary.verdict, confidence: view.confidence.level });
    view.trend = forecastTrend(snaps, Date.now());
    const el = $in('trend');
    if (view.trend && el) { el.textContent = view.trend; el.hidden = false; }
  });
  await Promise.all([
    safely(async () => { if (view.punctuality) await loadPunctualityHistory(q, view.punctuality, stale); }),
    safely(async () => {
      await nameSegments(view.segments, view.originIata);
      if (stale()) return;
      $in('timeline').innerHTML = timelineHtml(view);
    }),
    safely(async () => {
      view.runs = await fetchModelRuns(view.models);
      if (!stale()) $in('fresh').innerHTML = freshnessHtml(view, Date.now());
    }),
    safely(async () => {
      view.aviation = aviationView(await loadAviation(), view, Date.now());
      if (!stale()) $in('aviation').innerHTML = aviationHtml(view.aviation, Date.now());
    }),
  ]);
  if (stale()) return;
  saveLast(view, view.queriedAt);
  safely(() => renderMap($in('map'), view));
}

async function submit() {
  els.error.hidden = true;
  if (navigator.onLine === false) {
    // Sin red ni el horario ni adsbdb responden: decir «no encuentro ese vuelo» sería engañoso.
    lastQuery = null; // «Reintentar» debe buscar lo que hay escrito, no la consulta anterior
    showError('Sin conexión: no se puede consultar el pronóstico ahora.', true);
    return;
  }
  show('loading'); // buscar el vuelo también puede tardar unos segundos
  try {
    const q = await resolveFlight();
    if (q) run(q);
    else show('query');
  } catch (err) {
    showError(err instanceof TypeError ? 'Sin conexión o el servicio no responde.' : err.message);
  }
}

els.form.addEventListener('submit', e => { e.preventDefault(); submit(); });

// Timeline: al tocar un tramo se muestra su detalle (otra vez para ocultarlo).
els.result.addEventListener('click', e => {
  const btn = e.target.closest('button[data-seg]');
  if (!btn || !currentView) return;
  const detail = $in('seg-detail');
  const selected = btn.classList.contains('selected');
  els.result.querySelectorAll('button[data-seg]').forEach(b => b.classList.remove('selected'));
  if (selected) { detail.hidden = true; return; }
  btn.classList.add('selected');
  detail.innerHTML = segmentDetailHtml(currentView.segments[Number(btn.dataset.seg)], currentView.originIata);
  detail.hidden = false;
});

// Pestañas de fechas de la ficha del vuelo.
els.result.addEventListener('click', async e => {
  const tab = e.target.closest('button[data-date]');
  if (!tab || lastQuery?.kind !== 'schedule') return;
  els.date.value = tab.dataset.date;
  try {
    run(await scheduleQuery(lastQuery.schedule, tab.dataset.date));
  } catch (err) {
    showError(err.message);
  }
});

els.toggleManual.addEventListener('click', () => setManual(els.manual.hidden));

for (const input of [els.origin, els.destination]) {
  input.addEventListener('input', async () => {
    let db;
    try { db = await airports(); } catch { return; } // sin lista: simplemente no hay sugerencias
    const results = searchAirports(db, input.value);
    els.airportsList.innerHTML = results
      .map(a => `<option value="${esc(a.iata)}">${esc(a.city)} · ${esc(a.name)}</option>`).join('');
  });
}

els.back.addEventListener('click', () => { setNotice(); show('query'); });
els.savedLink.addEventListener('click', () => {
  const last = loadLast();
  if (!last) return;
  runId++; // una consulta en curso ya no debe pintar encima
  showForecast(last.view, null, () => true, last.savedAt).catch(() => {});
});
window.addEventListener('offline', offerSaved);
window.addEventListener('online', () => { els.savedLink.hidden = true; });
els.changeTime.addEventListener('click', () => { setTimeNeeded(true); show('query'); els.time.focus(); });
// Actualizar vuelve a pedir el horario (retrasos, puerta, estado).
els.refresh.addEventListener('click', () => (lastQuery?.kind === 'schedule' ? submit() : lastQuery && run(lastQuery)));
els.retry.addEventListener('click', () => (lastQuery ? run(lastQuery) : submit()));

// Valores por defecto: hoy y la próxima hora en punto.
const now = new Date();
els.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
els.time.value = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
if (navigator.onLine === false) offerSaved();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
