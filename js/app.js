import { buildRoute } from './route.js';
import { localToUtcMs, formatLocal } from './time.js';
import { fetchRouteWeather, fetchTimezone } from './weather.js';
import { analyze, reliability } from './turbulence.js';
import { lookupFlight } from './flight.js';
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
  errorMsg: $('error-msg'), retry: $('retry'),
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

function setManual(on, message = '') {
  els.manual.hidden = !on;
  els.toggleManual.textContent = on ? 'Buscar por nº de vuelo' : 'Introducir a mano';
  els.notice.textContent = message;
  els.notice.hidden = !message;
}

function refreshHistory() {
  const entries = loadHistory();
  els.history.hidden = entries.length === 0;
  renderHistory(els.historyList, entries, entry => {
    setManual(!entry.number);
    els.number.value = entry.number || '';
    els.origin.value = entry.origin.iata;
    els.destination.value = entry.destination.iata;
    els.date.value = entry.date;
    els.time.value = entry.time;
    run({ ...entry });
  });
}

async function airports() {
  if (!airportsDb) airportsDb = await loadAirports();
  return airportsDb;
}

async function resolveFlight() {
  const date = els.date.value, time = els.time.value;
  if (!date || !time) throw new Error('Indica la fecha y la hora de salida.');

  if (els.manual.hidden) {
    const number = els.number.value.trim();
    if (!number) throw new Error('Escribe el número de vuelo.');
    const flight = await lookupFlight(number);
    if (!flight) {
      setManual(true, 'No encuentro ese vuelo, introdúcelo a mano.');
      return null;
    }
    return { number: flight.number, airline: flight.airline, origin: flight.origin, destination: flight.destination, date, time };
  }

  const db = await airports();
  const origin = findAirport(db, els.origin.value);
  const destination = findAirport(db, els.destination.value);
  if (!origin) throw new Error(`No conozco el aeropuerto «${els.origin.value.trim()}».`);
  if (!destination) throw new Error(`No conozco el aeropuerto «${els.destination.value.trim()}».`);
  return { number: '', airline: '', origin, destination, date, time };
}

async function run(q) {
  lastQuery = q;
  const token = ++runId;
  const stale = () => token !== runId;
  show('loading');
  try {
    const [oTz, dTz] = await Promise.all([fetchTimezone(q.origin), fetchTimezone(q.destination)]);
    if (stale()) return;
    const departureMs = localToUtcMs(q.date, q.time, oTz);
    const route = buildRoute(q.origin, q.destination, departureMs);
    if (route.arrivalMs < Date.now()) throw new Error('Ese vuelo ya ha aterrizado.');
    const rel = reliability(departureMs, Date.now());
    if (rel === null) throw new Error('Falta más de una semana: vuelve a consultar más cerca de la fecha.');

    const weather = await fetchRouteWeather(route);
    if (stale()) return;
    const { segments, verdict } = analyze(route, weather);

    saveToHistory({ id: `${q.number || 'manual'}-${q.origin.iata}-${q.destination.iata}-${q.date}-${q.time}`,
      number: q.number, origin: q.origin, destination: q.destination, date: q.date, time: q.time });

    const view = {
      title: `${q.origin.iata} → ${q.destination.iata}`,
      subtitle: [q.number, q.airline].filter(Boolean).join(' · ') || `${q.origin.city} → ${q.destination.city}`,
      times: `${formatLocal(route.departureMs, oTz)}–${formatLocal(route.arrivalMs, dTz)}`,
      verdict, reliability: rel, durationMin: route.durationMin, segments,
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

els.form.addEventListener('submit', async e => {
  e.preventDefault();
  els.error.hidden = true;
  try {
    const q = await resolveFlight();
    if (q) run(q);
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

els.back.addEventListener('click', () => { refreshHistory(); show('query'); });
els.changeTime.addEventListener('click', () => { show('query'); els.time.focus(); });
els.refresh.addEventListener('click', () => lastQuery && run(lastQuery));
els.retry.addEventListener('click', () => lastQuery && run(lastQuery));

// Valores por defecto: hoy y la próxima hora en punto.
const now = new Date();
els.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
els.time.value = `${String((now.getHours() + 1) % 24).padStart(2, '0')}:00`;
refreshHistory();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
