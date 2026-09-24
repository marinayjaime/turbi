import { buildRoute } from './route.js';
import { localToUtcMs, formatLocal } from './time.js';
import { fetchRouteWeather, fetchTimezone } from './weather.js';
import { analyze, reliability } from './turbulence.js';
import { lookupFlight } from './flight.js';
import { fetchSchedule, pickLeg, tabDates, legDeparture, legArrival, flightStatus } from './schedule.js';
import { loadAirports, findAirport, searchAirports } from './airports.js';
import { nameSegments } from './places.js';
import { loadHistory, saveToHistory } from './history.js';
import { renderResult, renderHistory, esc } from './ui.js';

const $ = id => document.getElementById(id);
const els = {
  queryView: $('query-view'), resultView: $('result-view'), form: $('query-form'),
  number: $('f-number'), origin: $('f-origin'), destination: $('f-destination'),
  date: $('f-date'), time: $('f-time'), manual: $('manual'), toggleManual: $('toggle-manual'),
  notice: $('notice'), airportsList: $('airports-list'), history: $('history'),
  historyList: $('history-list'), result: $('result'), back: $('back'),
  changeTime: $('change-time'), refresh: $('refresh'), loading: $('loading'), error: $('error'),
  errorMsg: $('error-msg'), retry: $('retry'), timeField: $('time-field'),
};

let lastQuery = null;
let runId = 0; // solo la consulta más reciente puede pintar
let airportsDb = null;

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

function refreshHistory() {
  const entries = loadHistory();
  els.history.hidden = entries.length === 0;
  renderHistory(els.historyList, entries, entry => {
    setManual(!entry.number);
    if (entry.number && entry.kind !== 'schedule') setTimeNeeded(true);
    els.number.value = entry.number || '';
    els.origin.value = entry.origin.iata;
    els.destination.value = entry.destination.iata;
    els.date.value = entry.date;
    els.time.value = entry.time;
    submit();
  });
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
    dep: leg.sd ? { city: origin.city, date: leg.d, time: leg.sd, est: dep.time !== leg.sd ? dep.time : null, terminal: leg.td, gate: leg.g } : null,
    arr: arr ? { city: destination.city, date: arr.date, time: leg.sa, est: arr.time !== leg.sa ? arr.time : null, terminal: leg.ta } : null,
    aircraft: leg.ac,
  };
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
    const route = buildRoute(q.origin, q.destination, departureMs, durationMin);
    const flight = q.kind === 'schedule' ? flightCard(q, route.durationMin) : null;
    els.changeTime.hidden = Boolean(flight);
    const rel = reliability(departureMs, Date.now());
    const note = route.arrivalMs < Date.now() ? 'Este vuelo ya ha aterrizado.'
      : rel === null ? 'Falta más de una semana: vuelve a consultar más cerca de la fecha.'
      : q.leg?.st === 'CAN' ? 'Vuelo cancelado.'
      : null;
    if (note) {
      if (!flight) throw new Error(note);
      renderResult(els.result, { flight, note });
      show('result');
      return;
    }

    const weather = await fetchRouteWeather(route);
    if (stale()) return;
    const { segments, verdict } = analyze(route, weather);

    const time = formatLocal(departureMs, oTz);
    saveToHistory({ id: `${q.number || 'manual'}-${q.origin.iata}-${q.destination.iata}-${q.date}-${time}`,
      kind: q.kind ?? 'manual', number: q.number, origin: q.origin, destination: q.destination, date: q.date, time });

    const view = {
      title: `${q.origin.iata} → ${q.destination.iata}`,
      subtitle: [q.number, q.airline].filter(Boolean).join(' · ') || `${q.origin.city} → ${q.destination.city}`,
      times: `${formatLocal(route.departureMs, oTz)}–${formatLocal(route.arrivalMs, dTz)}`,
      verdict, reliability: rel, durationMin: route.durationMin, segments, flight,
    };
    renderResult(els.result, view);
    show('result');

    await nameSegments(segments, q.origin.iata);
    if (stale()) return;
    renderResult(els.result, view);
  } catch (err) {
    if (stale()) return;
    // fetch lanza TypeError sin conexión; su mensaje viene en inglés.
    const msg = err instanceof TypeError ? 'Sin conexión o el servicio no responde.' : err.message;
    showError(msg || 'Algo ha fallado. Inténtalo de nuevo.', true);
  }
}

async function submit() {
  els.error.hidden = true;
  try {
    const q = await resolveFlight();
    if (q) run(q);
  } catch (err) {
    showError(err instanceof TypeError ? 'Sin conexión o el servicio no responde.' : err.message);
  }
}

els.form.addEventListener('submit', e => { e.preventDefault(); submit(); });

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
    const results = searchAirports(await airports(), input.value);
    els.airportsList.innerHTML = results
      .map(a => `<option value="${esc(a.iata)}">${esc(a.city)} · ${esc(a.name)}</option>`).join('');
  });
}

els.back.addEventListener('click', () => { setNotice(); refreshHistory(); show('query'); });
els.changeTime.addEventListener('click', () => { setTimeNeeded(true); show('query'); els.time.focus(); });
// Actualizar vuelve a pedir el horario (retrasos, puerta, estado).
els.refresh.addEventListener('click', () => (lastQuery?.kind === 'schedule' ? submit() : lastQuery && run(lastQuery)));
els.retry.addEventListener('click', () => lastQuery && run(lastQuery));

// Valores por defecto: hoy y la próxima hora en punto.
const now = new Date();
els.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
els.time.value = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
refreshHistory();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
