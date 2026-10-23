// @vitest-environment jsdom
// Flujo real de la app (js/app.js sobre index.html), con la red simulada por URL: la ficha no depende de Open-Meteo
// y «Actualizar» reutiliza el pronóstico en caché.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_BASE } from '../js/config.js';
import { formatLocal } from '../js/time.js';
import { FORECAST_UNAVAILABLE } from '../js/ui-forecast.js';
import { normalizeFlights } from '../server/aerodatabox.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';

const MAD = 'Europe/Madrid';
const dayOf = ms => new Intl.DateTimeFormat('en-CA', { timeZone: MAD }).format(ms);
const json = body => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const notFound = { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
const tooMany = { ok: false, status: 429, headers: { get: k => (k.toLowerCase() === 'retry-after' ? '30' : null) }, json: async () => ({}) };

// Open-Meteo simulado con tiempo tranquilo: una ubicación por coordenada, todas las horas pedidas.
const calm = v => (v.startsWith('wind_speed') ? 15 : v.startsWith('wind_direction') ? 270
  : v.startsWith('temperature_') ? { 400: -25, 300: -40, 250: -50, 200: -55, 150: -58 }[v.match(/_(\d+)hPa/)[1]]
  : v.startsWith('vertical_velocity') ? 0 : v === 'cape' ? 0 : v === 'weather_code' ? 1 : 0);
function openMeteoOk(url) {
  const u = new URL(url);
  const lats = u.searchParams.get('latitude').split(',').map(Number);
  const lons = u.searchParams.get('longitude').split(',').map(Number);
  const vars = u.searchParams.get('hourly').split(',');
  const times = [];
  for (let t = Date.parse(`${u.searchParams.get('start_hour')}:00Z`); t <= Date.parse(`${u.searchParams.get('end_hour')}:00Z`); t += 3600000) {
    times.push(new Date(t).toISOString().slice(0, 16));
  }
  const body = lats.map((lat, i) => ({ latitude: lat, longitude: lons[i], elevation: 100,
    hourly: Object.fromEntries([['time', times], ...vars.map(v => [v, times.map(() => calm(v))])]) }));
  return json(body.length === 1 ? body[0] : body);
}

const RADAR_FLYING = { state: 'volando', callsign: 'IBE715', altM: 10668, altFt: 35000, kmh: 830, vRateFpm: 0,
  seenS: 2, remainingKm: 300, source: 'adsb.lol' };

let calls;
function network({ flights, radar = null, openMeteo, adsbdb = {}, aliases = null, schedule = {}, radarAdb = null, airlines = null }) {
  const radars = Array.isArray(radar) ? [...radar] : null;
  calls = [];
  return vi.fn(async url => {
    url = String(url);
    calls.push(url);
    if (url === 'data/airports.json') return json(JSON.parse(readFileSync('data/airports.json', 'utf8')));
    if (url === 'data/airline-photos.json') return json(JSON.parse(readFileSync('data/airline-photos.json', 'utf8')));
    const f = url.match(/^data\/flights\/(\w+)\/(\d+)\.json$/);
    if (f && flights[`${f[1]}${f[2]}`]) return json(flights[`${f[1]}${f[2]}`]);
    if (url.startsWith(`${LIVE_BASE}/radar-adb/`)) return radarAdb ? json(typeof radarAdb === 'function' ? radarAdb(url) : radarAdb) : notFound;
    if (url.startsWith(`${LIVE_BASE}/radar/`)) return radars ? json(radars.length > 1 ? radars.shift() : radars[0]) : radar ? json(radar) : notFound;
    const cs = url.match(/^https:\/\/api\.adsbdb\.com\/v0\/callsign\/(\w+)$/);
    if (cs) return typeof adsbdb[cs[1]] === 'function' ? adsbdb[cs[1]]() : adsbdb[cs[1]] ? json(adsbdb[cs[1]]) : notFound;
    if (url === 'data/flights/_aliases.json') return aliases ? json(aliases) : notFound;
    if (url === 'data/flights/airlines.json') return airlines ? json(airlines) : notFound;
    const sch = url.match(new RegExp(`^${LIVE_BASE}/schedule/(\\w+)/([\\d-]+)\\.json$`));
    if (sch) { const r = schedule[`${sch[1]}|${sch[2]}`]; return typeof r === 'function' ? r() : r ? json(r) : notFound; }
    if (url.startsWith('https://api.open-meteo.com/v1/forecast')) return openMeteo(url);
    if (url.startsWith('https://api.open-meteo.com/data/')) return json({ last_run_initialisation_time: Math.floor(Date.now() / 1000) - 6 * 3600 });
    return notFound; // Render, puntualidad, METAR, nombres de lugares: sin datos en la prueba
  });
}

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`No llegó: ${what}\n${document.querySelector('#result')?.textContent?.replace(/\s+/g, ' ').slice(0, 400)}`);
}

// Espera a que no haya peticiones nuevas durante 300 ms (la app terminó de completar la ficha).
async function networkIdle() {
  let n = -1;
  while (n !== calls.length) { n = calls.length; await new Promise(r => setTimeout(r, 300)); }
}

async function openApp(fetchStub) {
  // La app de la prueba anterior sigue viva sobre su DOM ya desconectado (con su .flight): sin esto, sus contadores de
  // 1 s (señal, distancia) y su refresco de Aena seguirían reprogramándose y podrían saltar sobre el reloj simulado de
  // la prueba siguiente. Su ficha oculta es «el usuario ya no la ve»: se paran solos en su siguiente vuelta.
  document.getElementById('result-view')?.setAttribute('hidden', '');
  const html = readFileSync('index.html', 'utf8');
  document.documentElement.innerHTML = html.slice(html.indexOf('<head'), html.lastIndexOf('</html>'));
  vi.stubGlobal('fetch', fetchStub);
  vi.resetModules();
  await import('../js/app.js');
}

async function search(number, date) {
  document.getElementById('f-number').value = number;
  document.getElementById('f-date').value = date;
  document.getElementById('query-form').dispatchEvent(new Event('submit', { cancelable: true }));
}

const $ = sel => document.querySelector(sel);
const area = () => $('#forecast-area')?.textContent.replace(/\s+/g, ' ') ?? '';
// Ruta de la ficha «Origen a Destino», con las ciudades que la ficha muestra bajo los códigos (.route-codes).
const routeText = () => [...document.querySelectorAll('#result .route-codes .rc span')].map(s => s.textContent).join(' a ');

// Almacenamiento del navegador en memoria, vacío en cada prueba (el localStorage propio de Node no sirve aquí).
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    clear: () => m.clear(), key: i => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Open-Meteo falla (429) y el radar ADS-B responde', () => {
  it('ficha visible, panel de radar correcto y solo la sección de turbulencias avisa', async () => {
    const dep = Date.now() - 60 * 60000; // salió hace una hora; Aena no publica la llegada (Londres)
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    const leg = { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, td: 'T4', g: 'S32', st: 'BOR', ac: 'A21N' };
    await openApp(network({
      flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } },
      radar: RADAR_FLYING,
      openMeteo: () => tooMany,
    }));
    await search('IB715', d);
    await until(() => area().includes(FORECAST_UNAVAILABLE) && $('.telemetry'), 'aviso de la sección y panel de radar');

    expect($('#result .flight').textContent).toContain('IB 715');
    const panel = $('.telemetry').textContent.replace(/\s+/g, ' ');
    for (const txt of ['830', '10.700', '300', 'Radar ADS-B', 'IBE715']) expect(panel).toContain(txt);
    expect($('#result .flight .status').textContent).toContain('En vuelo'); // «Volando» lo dice el chip del estado
    expect(area()).toContain('Puedes reintentar en unos 30 s');
    expect($('#forecast-retry')).not.toBeNull();
    expect($('.calm')).toBeNull(); // sin pronóstico, ningún Calm Score
    expect($('#error').hidden).toBe(true); // ningún error general sustituye la ficha
    expect($('#result-view').hidden).toBe(false);
    expect(calls.some(u => u.startsWith(`${LIVE_BASE}/radar/IB/715.json`))).toBe(true);
  });
});

describe('Actualizar con un pronóstico válido en caché', () => {
  it('reutiliza el pronóstico: ninguna consulta nueva a Open-Meteo', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    const leg = { d: tomorrow, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${tomorrow}T17:55`, sa: '19:25', ea: `${tomorrow}T19:25`,
      td: 'N', ta: 'T4', g: 'D', st: 'SCH', ac: 'A21N' };
    await openApp(network({
      flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } },
      openMeteo: openMeteoOk,
    }));
    await search('IB1668', tomorrow);
    await until(() => $('#forecast-area .forecast-loading') === null && $('#forecast-area')?.children.length && !area().includes(FORECAST_UNAVAILABLE)
      && $('#fresh')?.textContent.trim(), 'pronóstico completo');
    await networkIdle();
    const openMeteoCalls = () => calls.filter(u => u.startsWith('https://api.open-meteo.com/'));
    const first = openMeteoCalls().length;
    expect(first).toBeGreaterThan(0);
    expect(openMeteoCalls().some(u => u.includes('models=ecmwf_ifs025'))).toBe(true);
    expect(openMeteoCalls().some(u => u.includes('models=gfs_seamless'))).toBe(true);
    const before = calls.length;
    const oldArea = $('#forecast-area');

    document.getElementById('refresh').click();
    await until(() => calls.slice(before).includes('data/flights/IB/1668.json'), 'la nueva consulta a Aena');
    // Ficha y pronóstico nuevos (otro nodo), no los de la primera búsqueda que siguen en pantalla hasta repintar.
    await until(() => $('#forecast-area') && $('#forecast-area') !== oldArea && !$('#forecast-area .forecast-loading')
      && $('#fresh')?.textContent.trim(), 'pronóstico repintado');
    await networkIdle();

    expect(openMeteoCalls()).toHaveLength(first); // ni pronóstico ni meta.json: todo de la caché
    expect($('#result .flight').textContent).toContain('IB 1668');
    expect($('#turb-now').hidden).toBe(true); // antes del despegue: solo la previsión, sin «Ahora»
    expect($('#timeline .tnow')).toBeNull();
    expect(area()).not.toContain(FORECAST_UNAVAILABLE);
  });
});

// La ficha completa: tarjeta del vuelo, título Turbulencias y su sección. Tiene que estar siempre.
const shell = () => ({ flight: Boolean($('#result .flight')), turbulencias: [...document.querySelectorAll('#result h3.section')].some(h => h.textContent === 'Turbulencias'),
  area: Boolean($('#forecast-area')), error: !$('#error').hidden });
const SHELL_OK = { flight: true, turbulencias: true, area: true, error: false };
// Vuelo terminado, cancelado o desviado: sin tarjeta Turbulencias (#forecast-area vacío y oculto), con el mapa y
// Detalles avanzados en su sitio.
const TURB_GONE = { flight: true, turbulencias: false, area: true, error: false };
function turbGone() {
  expect(shell()).toEqual(TURB_GONE);
  expect($('#forecast-area').hidden).toBe(true);
  expect($('#forecast-area').innerHTML).toBe(''); // y sin «Ahora» (#turb-now vive en la tarjeta)
  expect($('#map-card')).not.toBeNull();
  expect($('details[data-card="advanced"]')).not.toBeNull();
}
// «Turbulencias estimadas» del Resumen del vuelo (null si no está).
function turbEstimate() {
  const el = $('.flight-summary [data-fs="turbulence"]');
  return el ? [...el.querySelectorAll('.k, .v > span')].map(e => e.textContent).join(' ') : null;
}
const radarCalls = () => calls.filter(u => u.includes('/radar/'));
// Avanza el reloj simulado; entre temporizador y temporizador se resuelven las promesas (cada sondeo programa el siguiente).
async function advance(ms) { await vi.advanceTimersByTimeAsync(ms); await networkIdle(); }

// Reloj virtual completamente controlado (sin shouldAdvanceTime): solo avanza con vi.advanceTimersByTimeAsync, nunca
// con el tiempo real que tarde la máquina. Para esperar se ceden vueltas del bucle de eventos real (setImmediate no se
// simula): se resuelven promesas, fetch simulado e import sin mover el reloj virtual ni un milisegundo.
const FROZEN_FAKES = ['setTimeout', 'clearTimeout', 'Date', 'performance'];
const frozenClock = now => vi.useFakeTimers({ toFake: FROZEN_FAKES, ...(now === undefined ? {} : { now }) });
const realTurn = () => new Promise(r => setImmediate(r));
async function untilFrozen(check, what, turns = 2000) {
  for (let i = 0; i < turns; i++) { if (check()) return; await realTurn(); }
  throw new Error(`No llegó (reloj virtual parado en ${new Date(Date.now()).toISOString()}): ${what}`);
}
// Red en reposo con el reloj parado: 50 vueltas seguidas sin peticiones nuevas.
async function networkIdleFrozen() {
  for (let n = calls.length, quiet = 0; quiet < 50; quiet = calls.length === n ? quiet + 1 : 0, n = calls.length) await realTurn();
}
const ryanairLeg = (minAgo = 45) => {
  const dep = Date.now() - minAgo * 60000;
  const d = dayOf(dep), sd = formatLocal(dep, MAD);
  return { d, leg: { d, o: 'PMI', a: 'LBA', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: '738W', op: 'FR' } };
};

describe('radar: el servidor identifica el avión por su ruta en segundo plano (1–2 min)', () => {
  it('identificando a los 0 s y a los 20 s; termina a los 90 s → «Volando» y panel ADS-B sin recargar; la ficha sigue entera', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      const IDENT = { state: 'sin-datos', identifying: true };
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: [IDENT, IDENT, IDENT, IDENT, { ...RADAR_FLYING, callsign: 'RYR12AB', hex: 'abc123', match: 'ruta' }],
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => radarCalls().length === 1 && area().includes(FORECAST_UNAVAILABLE), 'ficha y primera respuesta');
      expect(shell()).toEqual(SHELL_OK);
      expect($('.telemetry')).toBeNull();
      await advance(20000);
      expect(radarCalls()).toHaveLength(2); // a los 20 s sigue identificando…
      expect($('.telemetry')).toBeNull();
      await advance(40000);
      expect(radarCalls()).toHaveLength(4); // …y se sigue mirando (40 s, 60 s)
      await advance(30000); // 90 s: la identificación ha terminado
      await until(() => $('.telemetry'), 'panel ADS-B tras la identificación');
      expect($('.telemetry').textContent).toContain('RYR12AB');
      expect($('#result .flight .status').textContent).toContain('En vuelo'); // con el radar volando, lo dice el chip del estado
      expect(shell()).toEqual(SHELL_OK); // actualizar .flight no se lleva la sección Turbulencias
      expect(area()).toContain(FORECAST_UNAVAILABLE);
      expect(radarCalls().slice(1).every(u => new URL(u).searchParams.get('poll') === '1')).toBe(true);
      expect(new Set(radarCalls().map(u => new URL(u).searchParams.get('leg'))).size).toBe(1); // siempre el mismo vuelo físico
      await advance(300000);
      expect(radarCalls()).toHaveLength(5); // resultado definitivo: no hay más consultas
    } finally { vi.useRealTimers(); }
  });
  it('429 en el servidor (temporal): la ficha sigue, dice «Localizando», el sondeo espera la pausa y el panel llega solo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      const IDENT = { state: 'sin-datos', callsign: 'RYR2311', identifying: true };
      const TEMP = { ...IDENT, temporary: true, retryAfterSec: 100 };
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: [IDENT, TEMP, IDENT, { ...RADAR_FLYING, callsign: 'RYR12AB', hex: 'abc123', match: 'ruta' }],
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => radarCalls().length === 1 && $('.radar.muted'), 'primera respuesta');
      expect($('.radar.muted').textContent).toBe('Buscando el avión en el radar…'); // no «Sin señal ADS-B»
      await advance(20000);
      expect(radarCalls()).toHaveLength(2); // el servidor dice: 429, reanudo en 100 s
      expect(shell()).toEqual(SHELL_OK);
      expect($('.radar.muted').textContent).toBe('Buscando el avión en el radar…');
      await advance(90000);
      expect(radarCalls()).toHaveLength(2); // no pregunta antes de que acabe la pausa del servidor
      await advance(15000);
      expect(radarCalls()).toHaveLength(3); // tras la pausa, sigue sondeando
      await advance(20000);
      await until(() => $('.telemetry'), 'panel ADS-B tras la reanudación');
      expect($('.telemetry').textContent).toContain('RYR12AB');
      expect(shell()).toEqual(SHELL_OK);
      await advance(600000);
      expect(radarCalls()).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });
  it('FR4586: la primera consulta agota los 20 s del navegador; el sondeo ve «fase direct» y el panel llega sin recargar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      const flying = { ...leg, sta: 'FLY' }; // Aena ya dice «Volando», como en el caso real
      const answers = [{ state: 'sin-datos', identifying: true, phase: 'direct' }, { state: 'sin-datos', identifying: true, phase: 'identify' },
        { ...RADAR_FLYING, callsign: 'RYR12EV', hex: '4d221d', match: 'ruta' }];
      const base = network({ flights: { FR4586: { name: 'Ryanair', updated: new Date().toISOString(), legs: [flying] } }, openMeteo: () => tooMany });
      let radarN = 0;
      const stub = vi.fn((url, o) => {
        const u = String(url);
        if (!u.startsWith(`${LIVE_BASE}/radar/`)) return base(url, o);
        calls.push(u);
        if (radarN++ === 0) return Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')); // abandono a los 20 s
        return Promise.resolve(json(answers[Math.min(radarN - 2, answers.length - 1)]));
      });
      await openApp(stub);
      await search('FR4586', d);
      await until(() => radarCalls().length === 1 && $('#result .flight'), 'ficha y primera consulta (sin respuesta)');
      expect(shell()).toEqual(SHELL_OK);
      await advance(20000);
      expect(radarCalls()).toHaveLength(2); // la app no se rinde por el timeout
      expect(new URL(radarCalls()[1]).searchParams.get('poll')).toBe('1');
      expect($('.radar.muted')?.textContent).toBe('Buscando el avión en el radar…'); // también con Aena en «Volando»
      await advance(40000);
      await until(() => $('.telemetry'), 'panel ADS-B');
      expect($('.telemetry').textContent).toContain('RYR12EV');
      expect(shell()).toEqual(SHELL_OK);
      await advance(600000);
      expect(radarCalls()).toHaveLength(4); // resultado definitivo: se acabó
    } finally { vi.useRealTimers(); }
  });
  it('identificación ambigua o fallida: el servidor deja de decir «identificando» y la app deja de preguntar', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: [{ state: 'sin-datos', identifying: true }, { state: 'sin-datos', identifying: true }, { state: 'sin-datos' }],
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => radarCalls().length === 1, 'primera respuesta');
      await advance(400000);
      expect(radarCalls()).toHaveLength(3);
      expect($('.telemetry')).toBeNull();
      expect(shell()).toEqual(SHELL_OK);
    } finally { vi.useRealTimers(); }
  });
  it('una búsqueda nueva detiene el sondeo de la anterior', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      const tomorrow = dayOf(Date.now() + 24 * 3600000);
      const other = { d: tomorrow, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${tomorrow}T17:55`, sa: '19:25', ea: `${tomorrow}T19:25`, st: 'SCH', ac: 'A21N' };
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] },
          IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [other] } },
        radar: { state: 'sin-datos', identifying: true },
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => radarCalls().length === 1, 'primera respuesta');
      await advance(20000);
      expect(radarCalls()).toHaveLength(2);
      await search('IB1668', tomorrow);
      await until(() => $('#result .flight')?.textContent.includes('IB 1668'), 'ficha de la segunda búsqueda');
      await advance(400000);
      expect(radarCalls()).toHaveLength(2); // ni un sondeo más del primer vuelo
      expect(shell()).toEqual(SHELL_OK);
    } finally { vi.useRealTimers(); }
  });
  it('«Nueva consulta» (la ficha ya no se ve) también detiene el sondeo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const { d, leg } = ryanairLeg();
      await openApp(network({ flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: { state: 'sin-datos', identifying: true }, openMeteo: () => tooMany }));
      await search('FR2311', d);
      await until(() => radarCalls().length === 1, 'primera respuesta');
      $('#back').click();
      await advance(400000);
      expect(radarCalls()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('flujo DOM completo: la ficha y la sección Turbulencias están siempre', () => {
  const tomorrowLeg = () => {
    const t = dayOf(Date.now() + 24 * 3600000);
    return { d: t, leg: { d: t, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${t}T17:55`, sa: '19:25', ea: `${t}T19:25`, td: 'N', ta: 'T4', st: 'SCH', ac: 'A21N' } };
  };
  it('ANTES de que respondan el radar y Open-Meteo ya están .flight, «Turbulencias» y #forecast-area', async () => {
    const { d, leg } = ryanairLeg();
    let releaseRadar, releaseMeteo;
    const base = network({ flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany });
    const stub = vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); return new Promise(r => { releaseRadar = () => r(json(RADAR_FLYING)); }); }
      if (u.startsWith('https://api.open-meteo.com/v1/forecast')) { calls.push(u); return new Promise(r => { releaseMeteo = () => r(tooMany); }); }
      return base(url, o);
    });
    await openApp(stub);
    await search('FR2311', d);
    await until(() => $('#result .flight') && releaseRadar, 'ficha con el radar pendiente');
    expect(shell()).toEqual(SHELL_OK);
    expect(area()).toContain('Calculando la previsión de turbulencias');
    releaseRadar();
    await until(() => $('.telemetry'), 'panel del radar');
    expect(shell()).toEqual(SHELL_OK); // tras actualizar la tarjeta con el radar
    await until(() => releaseMeteo, 'consulta a Open-Meteo');
    releaseMeteo();
    await until(() => area().includes(FORECAST_UNAVAILABLE), 'aviso de Open-Meteo');
    expect(shell()).toEqual(SHELL_OK); // tras el error de Open-Meteo
    expect($('#forecast-retry')).not.toBeNull();
  });
  it('Open-Meteo correcto: previsión dentro de la sección', async () => {
    const { d, leg } = tomorrowLeg();
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: openMeteoOk }));
    await search('IB1668', d);
    await until(() => $('#forecast-area [data-card="turbulence"]'), 'previsión');
    expect(shell()).toEqual(SHELL_OK);
    expect(area()).not.toContain(FORECAST_UNAVAILABLE);
  });
  it('tocar una barra abre su detalle y resalta todo su tramo sin plegar ni desplegar la tarjeta; tocar el detalle tampoco', async () => {
    const { d, leg } = tomorrowLeg();
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: openMeteoOk }));
    await search('IB1668', d);
    await until(() => $('#forecast-area [data-card="turbulence"]'), 'previsión');
    await networkIdle(); // nameSegments ya ha repintado #timeline
    const card = $('#forecast-area [data-card="turbulence"]');
    const bar = $('#timeline button[data-seg]');
    bar.click();
    expect($('#seg-detail').hidden).toBe(false);
    expect(card.open).toBe(false); // un <button> dentro del summary no abre la tarjeta
    const same = [...document.querySelectorAll(`#timeline button[data-seg="${bar.dataset.seg}"]`)];
    expect(same.length).toBeGreaterThan(1);
    expect(same.every(b => b.classList.contains('selected'))).toBe(true);
    expect(document.querySelectorAll('#timeline button.selected')).toHaveLength(same.length);
    $('#seg-detail').firstElementChild.click();
    expect(card.open).toBe(false); // tocar el texto del detalle no pliega ni despliega la tarjeta
    $('#forecast-area .turb-head').click();
    expect(card.open).toBe(true); // control: el resto del summary sí la despliega
    $('#seg-detail').firstElementChild.click();
    expect(card.open).toBe(true);
  });
  it('Open-Meteo sin respuesta (timeout): la sección lo explica y ofrece Reintentar', async () => {
    const { d, leg } = tomorrowLeg();
    const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: timeout }));
    await search('IB1668', d);
    await until(() => area().includes(FORECAST_UNAVAILABLE), 'aviso de timeout');
    expect(area()).toContain('No se pudo conectar con el servicio del tiempo');
    expect($('#forecast-retry')).not.toBeNull();
    expect(shell()).toEqual(SHELL_OK);
  });
  it('vuelo cancelado: ficha y sección con el motivo', async () => {
    const { d, leg } = tomorrowLeg();
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [{ ...leg, st: 'CAN', std: 'CAN' }] } }, openMeteo: openMeteoOk }));
    await search('IB1668', d);
    await until(() => $('#result .flight'), 'ficha');
    await networkIdle();
    expect($('#result .status').textContent).toContain('Cancelado');
    turbGone(); // cancelado: sin tarjeta Turbulencias ni resumen de turbulencias
    expect(turbEstimate()).toBeNull();
  });
});

describe('la sección Turbulencias aparece siempre en la ficha de un vuelo (salvo terminado)', () => {
  it('vuelo ya aterrizado (Aena) y Open-Meteo con 429: ficha y puntualidad, sin la sección Turbulencias', async () => {
    const dep = Date.now() - 4 * 3600000, arr = dep + 75 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD), sa = formatLocal(arr, MAD);
    const leg = { d, o: 'PMI', a: 'MAD', sd, ed: `${d}T${sd}`, sa, ea: `${dayOf(arr)}T${sa}`, st: 'LND', std: 'BOR', sta: 'LND', ac: '738W' };
    await openApp(network({ flights: { UX6031: { name: 'Air Europa', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany }));
    await search('UX6031', d);
    await until(() => $('#result .flight'), 'ficha');
    await networkIdle();
    turbGone();
    expect($('#punctuality')).not.toBeNull();
    expect($('#error').hidden).toBe(true);
  });
});

describe('la ficha nunca espera al radar', () => {
  it('con el radar sin responder (cola de adsb.lol), la ficha y la sección Turbulencias ya están', async () => {
    const dep = Date.now() - 40 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    const leg = { d, o: 'PMI', a: 'LBA', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: '738W', op: 'FR' };
    const base = network({ flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany });
    const stub = vi.fn((url, o) => (String(url).startsWith(`${LIVE_BASE}/radar/`) ? (calls.push(String(url)), new Promise(() => {})) : base(url, o)));
    await openApp(stub);
    await search('FR2311', d);
    await until(() => $('#result .flight') && area().includes(FORECAST_UNAVAILABLE), 'ficha y sección sin esperar al radar');
    expect(calls.some(u => u.includes('/radar/'))).toBe(true); // el radar sigue pendiente
    expect($('#result-view').hidden).toBe(false);
    expect([...document.querySelectorAll('#result h3')].map(h => h.textContent)).toContain('Turbulencias');
  });
});

describe('distancia restante en vivo (interpolación visual entre lecturas ADS-B reales)', () => {
  const remaining = () => $('.tm-remaining')?.textContent.replace(/\s+/g, ' ').trim();
  const speed = () => [...document.querySelectorAll('.tm-cell')].find(c => c.textContent.includes('Velocidad'))?.querySelector('.tm-value').textContent;
  const flyingLeg = n => {
    const dep = Date.now() - 60 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    return { d, leg: { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: 'A21N', n } };
  };
  it('1-2, 5-6, 8) baja cada segundo, la velocidad no cambia, nunca «Aterrizado», nunca negativa y cero peticiones nuevas', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { d, leg } = flyingLeg('715');
      await openApp(network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } },
        radar: { ...RADAR_FLYING, remainingKm: 366, kmh: 900, seenS: 0, checked: new Date().toISOString() }, openMeteo: () => tooMany }));
      await search('IB715', d);
      await until(() => $('.telemetry'), 'panel ADS-B');
      await networkIdle();
      expect(remaining()).toBe('366km');
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(remaining()).toBe('351km'); // 900 km/h → 15 km por minuto
      expect(speed()).toBe('900km/h'); // la velocidad es la última medida, sin tocar
      await vi.advanceTimersByTimeAsync(3600000); // una hora sin lecturas nuevas
      expect(remaining()).toBe('291km'); // quieta a los 5 min de antigüedad; nunca a 0 ni negativa
      expect($('#result .flight .status').textContent).toContain('En vuelo'); // nunca pasa a «Aterrizado» por el paso del tiempo
      expect($('#result .status')?.textContent ?? '').not.toContain('Aterrizado');
      expect(calls.slice(before).filter(u => u.includes('/radar/') || u.includes('adsb.lol'))).toHaveLength(0); // 8) cero peticiones
    } finally { vi.useRealTimers(); }
  });
  it('3) una lectura real nueva (Actualizar) sustituye la estimación en el acto y sigue desde ahí', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { d, leg } = flyingLeg('715');
      const readings = [{ ...RADAR_FLYING, remainingKm: 366, kmh: 900 }, { ...RADAR_FLYING, remainingKm: 300, kmh: 880 }];
      await openApp(network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, radar: readings, openMeteo: () => tooMany }));
      await search('IB715', d);
      await until(() => $('.telemetry'), 'panel ADS-B');
      await vi.advanceTimersByTimeAsync(20000);
      expect(remaining()).toBe('361km');
      $('#refresh').click();
      await until(() => remaining() === '300km', 'la lectura nueva');
      await vi.advanceTimersByTimeAsync(60000);
      expect(remaining()).toBe('285km'); // 880 km/h desde 300, no desde la estimación anterior
    } finally { vi.useRealTimers(); }
  });
  it('7) cambiar de vuelo cancela el temporizador anterior (no pinta sus km en la ficha nueva)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const a = flyingLeg('715'), b = flyingLeg('3166');
      const radar = [{ ...RADAR_FLYING, remainingKm: 366, kmh: 900 }, { ...RADAR_FLYING, callsign: 'IBE3166', remainingKm: 800, kmh: 720 }];
      await openApp(network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [a.leg] },
        IB3166: { name: 'Iberia', updated: new Date().toISOString(), legs: [b.leg] } }, radar, openMeteo: () => tooMany }));
      await search('IB715', a.d);
      await until(() => $('.telemetry'), 'panel del primer vuelo');
      await vi.advanceTimersByTimeAsync(5000);
      await search('IB3166', b.d);
      await until(() => $('.telemetry')?.textContent.includes('IBE3166'), 'panel del segundo vuelo');
      const seenValues = new Set();
      for (let i = 0; i < 30; i++) { await vi.advanceTimersByTimeAsync(1000); seenValues.add(remaining()); }
      for (const v of seenValues) expect(Number(v.replace(/\D/g, ''))).toBeGreaterThan(780); // solo 800 → 794 (720 km/h)
      $('#back').click(); // Nueva consulta
      const last = remaining();
      await vi.advanceTimersByTimeAsync(30000);
      expect(remaining()).toBe(last);
    } finally { vi.useRealTimers(); }
  });
});

describe('un número con varios vuelos físicos la misma fecha (CA898: GRU → MAD y MAD → PEK)', () => {
  const at = ms => ({ d: dayOf(ms), t: formatLocal(ms, MAD) });
  it('llegada ya terminada + salida en el aire → ficha de MAD → Pekín (no «Ha llegado») y selector de ruta', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-26T11:00:00Z'), shouldAdvanceTime: true }); // 13:00 en Madrid
    try {
    const arr = at(Date.now() - 5 * 3600000), dep = at(Date.now() - 30 * 60000);
    const inbound = { d: arr.d, o: 'GRU', a: 'MAD', sd: null, sa: arr.t, ea: `${arr.d}T${arr.t}`, st: 'LND', sta: 'LND', ac: '789' };
    const outbound = { d: dep.d, o: 'MAD', a: 'PEK', sd: dep.t, ed: `${dep.d}T${dep.t}`, st: 'BOR', std: 'BOR', ac: '789' };
    await openApp(network({ flights: { CA898: { name: 'Air China', updated: new Date().toISOString(), legs: [inbound, outbound] } }, openMeteo: () => tooMany }));
    await search('CA898', dep.d);
    await until(() => $('#result .flight'), 'ficha');
    expect(routeText()).toContain('Madrid a');
    expect($('#result .flight').textContent).not.toContain('Ha llegado');
    const options = [...document.querySelectorAll('.leg-switch .leg-option')];
    expect(options).toHaveLength(2);
    expect(options.find(b => b.classList.contains('selected')).textContent).toContain('MAD → PEK');
    expect(shell()).toEqual(SHELL_OK);
    } finally { vi.useRealTimers(); }
  });
  it('dos tramos futuros el mismo día → se pregunta por ruta; al escoger, se ve ese tramo', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    const inbound = { d: tomorrow, o: 'GRU', a: 'MAD', sd: null, sa: '07:10', ea: `${tomorrow}T07:10`, st: 'SCH', sta: 'SCH', ac: '789' };
    const outbound = { d: tomorrow, o: 'MAD', a: 'PEK', sd: '12:30', ed: `${tomorrow}T12:30`, st: 'SCH', std: 'SCH', ac: '789' };
    await openApp(network({ flights: { CA898: { name: 'Air China', updated: new Date().toISOString(), legs: [outbound, inbound] } }, openMeteo: () => tooMany }));
    await search('CA898', tomorrow);
    await until(() => $('.leg-switch'), 'selector de tramos');
    expect($('#result .flight')).toBeNull(); // no se escoge en silencio
    const options = [...document.querySelectorAll('.leg-option')];
    expect(options.map(b => b.querySelector('small').textContent.split(' · ')[0])).toEqual(['GRU → MAD', 'MAD → PEK']); // por hora
    options[1].click();
    await until(() => $('#result .flight'), 'ficha del tramo escogido');
    expect($('#result .leg-option.selected').textContent).toContain('MAD → PEK');
    expect(routeText()).toContain('Madrid a');
    expect(shell()).toEqual(SHELL_OK);
  });
  it('un vuelo normal (un solo tramo ese día) sigue igual: sin selector', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    const leg = { d: tomorrow, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${tomorrow}T17:55`, sa: '19:25', ea: `${tomorrow}T19:25`, st: 'SCH', ac: 'A21N' };
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany }));
    await search('IB1668', tomorrow);
    await until(() => $('#result .flight'), 'ficha');
    expect($('.leg-switch')).toBeNull();
  });
});

describe('radar por tramo: la app pide exactamente el vuelo físico que muestra', () => {
  it('6) cada tramo sondea con su ?leg; cambiar de tramo cancela el sondeo del anterior', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: Date.parse('2026-09-26T12:00:00Z'), shouldAdvanceTime: true });
    try {
      const D = '2026-09-26';
      // Los dos en curso a la vez: la app no elige sola; el usuario escoge por ruta.
      const inbound = { d: D, o: 'GRU', a: 'MAD', sd: null, sa: '15:10', ea: `${D}T15:10`, st: 'FLY', sta: 'FLY', ac: '789' };
      const outbound = { d: D, o: 'MAD', a: 'PEK', sd: '13:30', ed: `${D}T13:35`, st: 'BOR', std: 'BOR', ac: '789' };
      await openApp(network({ flights: { CA898: { name: 'Air China', updated: new Date().toISOString(), legs: [inbound, outbound] } },
        radar: { state: 'sin-datos', identifying: true }, openMeteo: () => tooMany }));
      await search('CA898', D);
      await until(() => $('.leg-switch') && !$('#result .flight'), 'pantalla para escoger tramo');
      expect(radarCalls()).toHaveLength(0); // sin tramo escogido, ni una consulta al radar
      [...document.querySelectorAll('.leg-option')].find(b => b.textContent.includes('GRU → MAD')).click();
      await until(() => radarCalls().length === 1, 'radar del tramo GRU → MAD');
      const legOf = u => new URL(u).searchParams.get('leg');
      const kIn = legOf(radarCalls()[0]);
      expect(kIn).toBe('2026-09-26|GRU|MAD|L15:10');
      await advance(40000);
      expect(radarCalls().every(u => legOf(u) === kIn)).toBe(true); // los sondeos conservan el mismo tramo
      const before = radarCalls().length;
      [...document.querySelectorAll('.leg-option')].find(b => b.textContent.includes('MAD → PEK')).click();
      await until(() => radarCalls().length > before, 'radar del tramo MAD → PEK');
      await advance(300000);
      const after = radarCalls().slice(before);
      expect(after.every(u => legOf(u) === '2026-09-26|MAD|PEK|13:30')).toBe(true); // ni un sondeo más del tramo anterior
      expect(after.length).toBeGreaterThan(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('refresco del estado oficial de Aena mientras el vuelo está en curso (sin ADS-B ni meteorología)', () => {
  const T = Date.parse('2026-09-26T12:00:00Z'); // 14:00 en Madrid
  const D = '2026-09-26';
  // FR1526 MLA → BCN (llegada a un aeropuerto de Aena), en el aire.
  const flyLeg = over => ({ d: D, o: 'MLA', a: 'BCN', sd: null, sa: '14:40', ea: `${D}T14:40`, st: 'FLY', sta: 'FLY', ac: '738W', ...over });
  // Render simulado: `render.legs` y `render.updated` se cambian durante la prueba; `render.fail` = sin respuesta.
  function app({ legs, radar = null, render }) {
    const base = network({ flights: { FR1526: { name: 'Ryanair', updated: new Date(T).toISOString(), legs } }, radar, openMeteo: openMeteoOk });
    return vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/flights/`)) {
        calls.push(u);
        if (render.fail) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(json({ name: 'Ryanair', updated: render.updated, legs: render.legs }));
      }
      return base(url, o);
    });
  }
  const renderCalls = () => calls.filter(u => u.startsWith(`${LIVE_BASE}/flights/`));
  const meteoCalls = () => calls.filter(u => u.includes('open-meteo'));
  const statusText = () => $('#result .status')?.textContent ?? '';
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: T, shouldAdvanceTime: true });

  it('1) FLY → el siguiente ciclo de Render trae LND → «En tierra» sin recargar; 9) sin volver a pedir la meteorología', async () => {
    fake();
    try {
      const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
      await openApp(app({ legs: [flyLeg()], render }));
      await search('FR1526', D);
      await until(() => $('#result .flight'), 'ficha');
      await networkIdle();
      const meteo = meteoCalls().length;
      const before = renderCalls().length;
      await advance(300000);
      expect(renderCalls()).toHaveLength(before); // nada antes de updated + 10 min + 20 s
      render.legs = [flyLeg({ st: 'LND', sta: 'LND' })];
      render.updated = new Date(T + 600000).toISOString();
      await advance(330000); // 630 s
      await until(() => statusText().includes('En tierra'), 'estado En tierra');
      // Aterrizado: fuera la tarjeta Turbulencias; lo pronosticado antes va al Resumen del vuelo.
      turbGone();
      expect(turbEstimate()).toContain('Turbulencias estimadas');
      expect(meteoCalls()).toHaveLength(meteo); // ni una consulta más a Open-Meteo
      const after = renderCalls().length;
      await advance(3600000);
      expect(renderCalls()).toHaveLength(after); // 7) llegada final: se acabó el refresco
    } finally { vi.useRealTimers(); }
  });
  it('2) FLY → IBK / OPF / BOR de llegada → «Ha llegado»', async () => {
    for (const sta of ['IBK', 'OPF', 'BOR']) {
      fake();
      try {
        const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
        await openApp(app({ legs: [flyLeg()], render }));
        await search('FR1526', D);
        await until(() => $('#result .flight'), 'ficha');
        render.legs = [flyLeg({ st: sta, sta })];
        render.updated = new Date(T + 600000).toISOString();
        await advance(650000);
        await until(() => statusText().includes('Ha llegado'), `Ha llegado (${sta})`);
      } finally { vi.useRealTimers(); }
    }
  });
  it('3) radar «Volando» con distancia animada → Aena LND: fuera telemetría, radar y distancia; una respuesta tardía del radar no la repinta', async () => {
    fake();
    try {
      const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
      const base = app({ legs: [flyLeg()], render });
      let radarN = 0, releaseLate;
      const stub = vi.fn((url, o) => {
        const u = String(url);
        if (!u.startsWith(`${LIVE_BASE}/radar/`)) return base(url, o);
        calls.push(u);
        radarN++;
        if (radarN === 1) return Promise.resolve(json({ state: 'sin-datos', identifying: true }));
        if (radarN === 2) return new Promise(r => { releaseLate = () => r(json({ ...RADAR_FLYING, remainingKm: 250, kmh: 800 })); }); // se queda en el aire
        return Promise.resolve(json({ ...RADAR_FLYING, remainingKm: 250, kmh: 800 }));
      });
      await openApp(stub);
      await search('FR1526', D);
      await until(() => radarN === 1, 'primera consulta del radar');
      await advance(20000); // sondeo del radar: pendiente
      expect(radarN).toBe(2);
      render.legs = [flyLeg({ st: 'LND', sta: 'LND' })];
      render.updated = new Date(T + 600000).toISOString();
      await advance(610000);
      await until(() => statusText().includes('En tierra'), 'En tierra');
      releaseLate(); // la respuesta tardía del radar («volando») llega ahora
      await advance(5000);
      expect($('.telemetry')).toBeNull();
      expect(statusText()).toContain('En tierra');
      const radarBefore = calls.filter(u => u.includes('/radar/')).length;
      await advance(600000);
      expect(calls.filter(u => u.includes('/radar/'))).toHaveLength(radarBefore); // radar parado
      expect($('.tm-remaining')).toBeNull(); // sin distancia animada
    } finally { vi.useRealTimers(); }
  });
  it('3b) con la telemetría «Volando» ya pintada, Aena LND la quita y para la distancia animada', async () => {
    fake();
    try {
      const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
      await openApp(app({ legs: [flyLeg()], radar: { ...RADAR_FLYING, remainingKm: 250, kmh: 800 }, render }));
      await search('FR1526', D);
      await until(() => $('.telemetry'), 'telemetría');
      render.legs = [flyLeg({ st: 'LND', sta: 'LND' })];
      render.updated = new Date(T + 600000).toISOString();
      await advance(630000);
      await until(() => statusText().includes('En tierra'), 'En tierra');
      expect($('.telemetry')).toBeNull();
      expect($('.tm-remaining')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('4) un fallo de red no borra ni cambia el último estado; después se recupera', async () => {
    fake();
    try {
      const render = { updated: new Date(T).toISOString(), legs: [flyLeg()], fail: true };
      await openApp(app({ legs: [flyLeg()], render }));
      await search('FR1526', D);
      await until(() => $('#result .flight'), 'ficha');
      const before = statusText();
      await advance(900000);
      expect(statusText()).toBe(before);
      expect(shell()).toEqual(SHELL_OK);
      render.fail = false;
      render.legs = [flyLeg({ st: 'LND', sta: 'LND' })];
      render.updated = new Date(Date.now()).toISOString();
      await advance(130000);
      await until(() => statusText().includes('En tierra'), 'En tierra tras recuperarse');
    } finally { vi.useRealTimers(); }
  });
  it('5) CA898 con dos tramos: el refresco solo mira el tramo elegido (la llegada del otro no lo cambia)', async () => {
    fake();
    try {
      const inbound = { d: D, o: 'GRU', a: 'MAD', sd: null, sa: '07:10', ea: `${D}T07:10`, st: 'LND', sta: 'LND', ac: '789' };
      const outbound = { d: D, o: 'MAD', a: 'PEK', sd: '13:30', ed: `${D}T13:35`, st: 'BOR', std: 'BOR', ac: '789' };
      const render = { updated: new Date(T).toISOString(), legs: [inbound, outbound] };
      const base = network({ flights: { CA898: { name: 'Air China', updated: new Date(T).toISOString(), legs: [inbound, outbound] } }, openMeteo: openMeteoOk });
      await openApp(vi.fn((url, o) => {
        const u = String(url);
        if (u.startsWith(`${LIVE_BASE}/flights/`)) { calls.push(u); return Promise.resolve(json({ updated: render.updated, legs: render.legs })); }
        return base(url, o);
      }));
      await search('CA898', D);
      await until(() => $('#result .flight'), 'ficha');
      expect($('.leg-option.selected').textContent).toContain('MAD → PEK');
      render.legs = [{ ...inbound, st: 'IBK', sta: 'IBK' }, outbound]; // cambia solo el OTRO tramo
      render.updated = new Date(T + 600000).toISOString();
      await advance(700000);
      expect(statusText()).not.toContain('Ha llegado');
      expect($('.leg-option.selected').textContent).toContain('MAD → PEK');
    } finally { vi.useRealTimers(); }
  });
  it('6) cambiar de vuelo o «Nueva consulta» cancela el refresco; 7) un vuelo ya terminado no refresca; 8) cero consultas al radar por el refresco', async () => {
    fake();
    try {
      const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
      const tomorrow = '2026-09-27';
      const other = { d: tomorrow, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${tomorrow}T17:55`, sa: '19:25', ea: `${tomorrow}T19:25`, st: 'SCH', ac: 'A21N' };
      const flights = { FR1526: { name: 'Ryanair', updated: new Date(T).toISOString(), legs: [flyLeg()] },
        IB1668: { name: 'Iberia', updated: new Date(T).toISOString(), legs: [other] },
        FR1527: { name: 'Ryanair', updated: new Date(T).toISOString(), legs: [flyLeg({ st: 'LND', sta: 'LND' })] } };
      const base = network({ flights, openMeteo: openMeteoOk });
      await openApp(vi.fn((url, o) => {
        const u = String(url);
        const m = u.match(/\/flights\/(\w+)\/(\d+)\.json$/);
        if (u.startsWith(`${LIVE_BASE}/flights/`)) { calls.push(u); return Promise.resolve(json(m[1] + m[2] === 'FR1526' ? { updated: render.updated, legs: render.legs } : flights[m[1] + m[2]])); }
        return base(url, o);
      }));
      await search('FR1526', D);
      await until(() => $('#result .flight'), 'ficha');
      const radarBefore = calls.filter(u => u.includes('/radar/')).length;
      // Las búsquedas también descargan el horario de Render una vez: solo cuentan las peticiones posteriores.
      const count = code => renderCalls().filter(u => u.includes(code)).length;
      const fr1526 = count('/FR/1526');
      await search('IB1668', tomorrow); // otro vuelo
      await until(() => $('#result .flight')?.textContent.includes('IB 1668'), 'otro vuelo');
      await advance(3600000);
      expect(count('/FR/1526')).toBe(fr1526); // 6) el refresco del vuelo anterior se canceló
      expect(count('/IB/1668')).toBe(1); // 7) vuelo futuro: solo la búsqueda, ningún refresco
      expect(calls.filter(u => u.includes('/radar/'))).toHaveLength(radarBefore); // 8)
      await search('FR1527', D); // ya aterrizado según Aena
      await until(() => $('#result .flight')?.textContent.includes('FR 1527'), 'vuelo terminado');
      await advance(3600000);
      expect(count('/FR/1527')).toBe(1); // 7) vuelo terminado: solo la búsqueda
      await search('FR1526', D);
      await until(() => $('#result .flight')?.textContent.includes('FR 1526'), 'FR1526 otra vez');
      const again = count('/FR/1526');
      $('#back').click(); // «Nueva consulta»
      await advance(3600000);
      expect(count('/FR/1526')).toBe(again);
    } finally { vi.useRealTimers(); }
  });
});

// Vuelos fuera de Aena (regresión: los aeropuertos de ADSBDB no traían zona horaria → «Falta la zona horaria…»).
// Respuestas simuladas con la forma real de ADSBDB; coordenadas y nombres distintos a propósito de data/airports.json,
// para comprobar que la app usa siempre los aeropuertos canónicos.
const AIRPORTS_DB = JSON.parse(readFileSync('data/airports.json', 'utf8'));
const adsbdbAirport = iata => ({ iata_code: iata, icao_code: 'XXXX', name: `ADSBDB ${iata}`, municipality: `Ciudad ${iata}`,
  latitude: AIRPORTS_DB[iata][2] + 0.5, longitude: AIRPORTS_DB[iata][3] + 0.5, country_iso_name: 'XX', elevation: 0 });
const adsbdbRoute = (iata, icao, name, o, a) => ({ response: { flightroute: {
  callsign: iata, callsign_icao: icao, callsign_iata: iata,
  airline: { name, icao: icao.slice(0, 3), iata: iata.slice(0, 2) },
  origin: adsbdbAirport(o), destination: adsbdbAirport(a),
} } });
const submitForm = () => document.getElementById('query-form').dispatchEvent(new Event('submit', { cancelable: true }));
const typeInto = (id, value) => {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
};

describe('vuelo fuera de Aena: ADSBDB → hora → pronóstico', () => {
  const CASES = [
    ['UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG', 'UO/625'],
    ['S73033', 'SBI3033', 'S7 Airlines', 'DME', 'UUD', 'S7/3033'],
    ['LH505', 'DLH505', 'Lufthansa', 'GRU', 'MUC', 'LH/505'],
  ];
  it.each(CASES)('%s: ruta de ADSBDB con aeropuertos canónicos y pronóstico sin errores', async (number, icao, airline, o, a, aenaPath) => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    await openApp(network({ flights: {}, adsbdb: { [number]: adsbdbRoute(number, icao, airline, o, a) }, openMeteo: openMeteoOk }));
    await search(number, tomorrow);

    // 1) Aena no lo tiene → ADSBDB (con el número tal cual) → ruta para revisar, origen/destino editables y hora.
    await until(() => !$('#time-field').hidden, 'petición de la hora de salida');
    expect($('#notice').textContent).toContain('Ruta según ADSBDB (no oficial)');
    expect($('#notice').textContent).toContain(`${AIRPORTS_DB[o][1]} (${o}) → ${AIRPORTS_DB[a][1]} (${a})`);
    expect($('#manual').hidden).toBe(false);
    expect($('#number-field').hidden).toBe(false);
    expect($('#f-origin').value).toBe(o);
    expect($('#f-destination').value).toBe(a);
    expect($('#error').hidden).toBe(true);
    expect(calls).toContain(`data/flights/${aenaPath}.json`);

    // 2) Hora → pronóstico.
    $('#f-time').value = '10:00';
    submitForm();
    await until(() => $('#result .route')?.textContent === `${o} → ${a}`, 'pronóstico de la ruta');
    await networkIdle();
    expect($('#error').hidden).toBe(true);
    expect($('#result-view').hidden).toBe(false);
    const sub = $('#result .sub').textContent;
    expect(sub).toContain(`${number} · ${airline} · ruta según ADSBDB (no oficial)`);

    // ADSBDB: una sola consulta, con el número escrito por el usuario. Ni radar ni adsb.lol.
    const adsbdbCalls = calls.filter(u => u.includes('adsbdb.com'));
    expect(adsbdbCalls).toEqual([`https://api.adsbdb.com/v0/callsign/${number}`]);
    expect(calls.some(u => u.includes('/radar/') || u.includes('adsb.lol'))).toBe(false);
    // El pronóstico parte de las coordenadas de data/airports.json, no de las de ADSBDB.
    const meteo = calls.find(u => u.startsWith('https://api.open-meteo.com/v1/forecast'));
    const lats = new URL(meteo).searchParams.get('latitude').split(',').map(Number);
    expect(lats[0]).toBeCloseTo(AIRPORTS_DB[o][2], 3);
  });

  it('origen o destino corregido: se usa el escrito y desaparece la nota de ADSBDB', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    await openApp(network({ flights: {}, adsbdb: { LH505: adsbdbRoute('LH505', 'DLH505', 'Lufthansa', 'GRU', 'MUC') }, openMeteo: openMeteoOk }));
    await search('LH505', tomorrow);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    $('#f-destination').value = 'FRA';
    $('#f-time').value = '10:00';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'GRU → FRA', 'pronóstico con el destino corregido');
    expect($('#result .sub').textContent).toContain('LH505 · Lufthansa');
    expect($('#result .sub').textContent).not.toContain('ADSBDB');
    expect(calls.filter(u => u.includes('adsbdb.com'))).toHaveLength(1);
  });

  it('aeropuerto de ADSBDB que no está en data/airports.json → entrada manual, sin ruta', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    const body = adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG');
    body.response.flightroute.destination.iata_code = 'ZZZ';
    await openApp(network({ flights: {}, adsbdb: { UO625: body }, openMeteo: openMeteoOk }));
    await search('UO625', tomorrow);
    await until(() => !$('#manual').hidden, 'entrada manual');
    expect($('#number-field').hidden).toBe(true);
    expect($('#notice').textContent).toContain('introdúcelo a mano');
    expect($('#f-origin').value).toBe('');
    expect($('#f-destination').value).toBe('');
    expect(calls.some(u => u.startsWith('https://api.open-meteo.com/'))).toBe(false);
  });

  it('ADSBDB no conoce el número → entrada manual', async () => {
    await openApp(network({ flights: {}, openMeteo: openMeteoOk }));
    await search('XX9999', dayOf(Date.now() + 24 * 3600000));
    await until(() => !$('#manual').hidden, 'entrada manual');
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
  });

  it('otro número tras ver la ruta: la ruta anterior deja de valer y se consulta el nuevo', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    await openApp(network({ flights: {}, adsbdb: {
      UO625: adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG'),
      LH505: adsbdbRoute('LH505', 'DLH505', 'Lufthansa', 'GRU', 'MUC'),
    }, openMeteo: openMeteoOk }));
    await search('UO625', tomorrow);
    await until(() => !$('#time-field').hidden, 'ruta de UO625');
    typeInto('f-number', 'LH505');
    expect($('#manual').hidden).toBe(true);
    expect($('#time-field').hidden).toBe(true);
    submitForm();
    await until(() => $('#f-origin').value === 'GRU' && !$('#manual').hidden, 'ruta de LH505');
    expect($('#f-destination').value).toBe('MUC');
  });
});

describe('vuelo de Aena sin nombre de aerolínea (fuera de su catálogo)', () => {
  it('JU571: la ficha dice «JU 571», nunca «JU JU 571»', async () => {
    const tomorrow = dayOf(Date.now() + 24 * 3600000);
    const leg = { d: tomorrow, o: 'MAD', a: 'BEG', sd: '12:30', ed: `${tomorrow}T12:30`, td: 'T1', g: 'B21', st: 'SCH', std: 'SCH', ac: 'BCS3', op: 'JU' };
    await openApp(network({ flights: { JU571: { name: null, updated: new Date().toISOString(), legs: [leg] } }, openMeteo: openMeteoOk }));
    await search('JU571', tomorrow);
    await until(() => $('#result .flight'), 'ficha');
    expect($('#result .flight h2').textContent).toBe('JU 571');
    expect($('#result').textContent).not.toMatch(/JU\s+JU/);
    expect($('#result').textContent).not.toContain('null');
  });
});

// C: número comercial que Aena publica con otro número (BA8462 → CJ8462, BA CityFlyer). Datos simulados con la forma
// real de _aliases.json y de los horarios; nada del código depende de este número.
describe('número comercial asociado por Aena: confirmación antes de usarlo', () => {
  const tomorrow = () => dayOf(Date.now() + 24 * 3600000);
  const ALIASES = { updated: new Date().toISOString(), aliases: {
    BA8462: { al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: dayOf(Date.now()) } } };
  const cjLeg = (d, o = 'IBZ', a = 'LCY', sd = '10:45') => ({ d, o, a, sd, ed: `${d}T${sd}`, td: null, g: null, st: 'SCH', std: 'SCH', ac: 'E190', op: 'CJ' });
  const CJ = d => ({ CJ8462: { name: 'BA CITYFLYER', updated: new Date().toISOString(), legs: [cjLeg(d), cjLeg(d, 'LCY', 'IBZ', '07:00')] } });
  const offerText = () => $('.alias-offer')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
  const click = sel => $(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const adsbCalls = () => calls.filter(u => u.includes('adsbdb.com'));

  it('BA8462: se ofrece CJ 8462 con la ruta respaldada; «Ver CJ 8462» abre la ficha de Aena (solo IBZ → LCY)', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES, adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'candidato');
    expect(offerText()).toContain('Aena publica este vuelo como CJ 8462 · BA CITYFLYER');
    expect(offerText()).toContain('Ibiza (Eivissa) → London IBZ → LCY');
    expect(offerText()).not.toContain('LCY → IBZ');
    expect($('[data-alias="accept"]').textContent).toBe('Ver CJ 8462');
    expect($('[data-alias="reject"]').textContent).toBe('No es este vuelo');
    expect(adsbCalls()).toEqual(['https://api.adsbdb.com/v0/callsign/BA8462']);
    click('[data-alias="accept"]');
    await until(() => $('#result .flight'), 'ficha de CJ 8462');
    expect($('#result .flight h2').textContent).toBe('CJ 8462');
    expect(routeText()).toContain('Ibiza (Eivissa) a London');
    expect($('.leg-switch')).toBeNull(); // la otra ruta del número (LCY → IBZ) no se ofrece
    expect(adsbCalls()).toHaveLength(1);
    expect(calls.some(u => u.includes('/radar/') && !u.includes('/CJ/'))).toBe(false);
  });

  it('«No es este vuelo»: sigue con la ruta de ADSBDB ya consultada (sin otra consulta)', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES, adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'candidato');
    click('[data-alias="reject"]');
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    expect($('#notice').textContent).toContain('Ruta según ADSBDB (no oficial)');
    expect($('#f-origin').value).toBe('IBZ');
    expect(adsbCalls()).toHaveLength(1);
    // Buscar otra vez con la ruta en pantalla no vuelve a ofrecer el candidato: sigue el camino de ADSBDB.
    $('#f-time').value = '10:45';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'IBZ → LCY', 'pronóstico por ADSBDB');
    expect($('.alias-offer')).toBeNull();
  });

  it('ADSBDB da otra ruta → veto absoluto: no se ofrece el candidato', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES, adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'LHR', 'IBZ') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    expect($('.alias-offer')).toBeNull();
    expect($('#f-origin').value).toBe('LHR');
  });

  it('ADSBDB no lo conoce (404) → el candidato se ofrece solo con la evidencia de Aena', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'candidato');
    expect(offerText()).not.toContain('ADSBDB'); // ninguna corroboración atribuida a ADSBDB
  });

  it('ADSBDB con fallo temporal (503) → se ofrece; si no se confirma, entrada manual (no se inventa ruta)', async () => {
    const d = tomorrow();
    const unavailable = () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) });
    await openApp(network({ flights: CJ(d), aliases: ALIASES, adsbdb: { BA8462: unavailable }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'candidato');
    expect(offerText()).not.toContain('ADSBDB');
    click('[data-alias="reject"]');
    await until(() => !$('#manual').hidden, 'entrada manual');
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
  });

  it('fecha en la que el vuelo solo va por una ruta sin evidencia → ningún candidato (búsqueda normal)', async () => {
    const d = tomorrow();
    const flights = { CJ8462: { name: 'BA CITYFLYER', updated: new Date().toISOString(), legs: [cjLeg(d, 'LCY', 'IBZ', '07:00')] } };
    await openApp(network({ flights, aliases: ALIASES, adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    expect($('.alias-offer')).toBeNull();
  });

  it('sin _aliases.json (primera publicación o fallo) → búsqueda normal por ADSBDB', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    expect($('.alias-offer')).toBeNull();
  });
});

// «Actualizar» y «Cambiar hora» solo tienen sentido con una ficha o un pronóstico: nunca en una pantalla de elección
// (confirmación de un número comercial o selector de tramos).
describe('controles de la ficha: nunca en pantallas de elección', () => {
  const visible = id => !document.getElementById(id).hidden;
  const controls = () => ({ refresh: visible('refresh'), changeTime: visible('change-time') });
  const tomorrow = () => dayOf(Date.now() + 24 * 3600000);
  const ALIASES = () => ({ updated: new Date().toISOString(), aliases: {
    BA8462: { al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: dayOf(Date.now()) } } });
  const CJ = d => ({ CJ8462: { name: 'BA CITYFLYER', updated: new Date().toISOString(),
    legs: [{ d, o: 'IBZ', a: 'LCY', sd: '10:45', ed: `${d}T10:45`, st: 'SCH', std: 'SCH', ac: 'E190', op: 'CJ' }] } });
  const click = sel => $(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('confirmación de alias: sin «Actualizar» ni «Cambiar hora»; al confirmar, la ficha recupera «Actualizar»', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES(), adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: () => tooMany }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'confirmación');
    expect(controls()).toEqual({ refresh: false, changeTime: false });
    click('[data-alias="accept"]');
    await until(() => $('#result .flight'), 'ficha de CJ 8462');
    expect(controls()).toEqual({ refresh: true, changeTime: false }); // ficha de Aena: la hora es la de Aena
  });

  it('«No es este vuelo» → pronóstico por ADSBDB: vuelven «Actualizar» y «Cambiar hora»', async () => {
    const d = tomorrow();
    await openApp(network({ flights: CJ(d), aliases: ALIASES(), adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'confirmación');
    click('[data-alias="reject"]');
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    $('#f-time').value = '10:45';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'IBZ → LCY', 'pronóstico');
    expect(controls()).toEqual({ refresh: true, changeTime: true });
  });

  it('selector de tramos: sin «Actualizar» ni «Cambiar hora»; al escoger, la ficha recupera «Actualizar»', async () => {
    const d = tomorrow();
    const inbound = { d, o: 'GRU', a: 'MAD', sd: null, sa: '07:10', ea: `${d}T07:10`, st: 'SCH', sta: 'SCH', ac: '789' };
    const outbound = { d, o: 'MAD', a: 'PEK', sd: '12:30', ed: `${d}T12:30`, st: 'SCH', std: 'SCH', ac: '789' };
    // Primero un pronóstico manual (con los dos controles visibles), para comprobar que el selector no los hereda.
    await openApp(network({ flights: { CA898: { name: 'Air China', updated: new Date().toISOString(), legs: [outbound, inbound] } },
      adsbdb: { UO625: adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG') }, openMeteo: openMeteoOk }));
    await search('UO625', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    $('#f-time').value = '10:00';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'HND → HKG', 'pronóstico manual');
    expect(controls()).toEqual({ refresh: true, changeTime: true });
    typeInto('f-number', 'CA898');
    await search('CA898', d);
    await until(() => $('.leg-switch') && !$('#result .flight'), 'selector de tramos');
    expect(controls()).toEqual({ refresh: false, changeTime: false });
    document.querySelectorAll('.leg-option')[1].click();
    await until(() => $('#result .flight'), 'ficha del tramo escogido');
    expect(controls()).toEqual({ refresh: true, changeTime: false });
  });
});

// AeroDataBox (vía Render): Aena → alias → AeroDataBox → ADSBDB → manual. Respuestas con la forma real (normalizada).
describe('horario de AeroDataBox cuando Aena no publica el vuelo', () => {
  const tomorrow = () => dayOf(Date.now() + 24 * 3600000);
  // UO625 HND 10:00 (+09:00) → HKG 13:05 (+08:00): 4 h 05 min.
  const raw = (d, over = {}) => ({ number: 'UO 625', callSign: 'HKE625', status: 'Expected', codeshareStatus: 'IsOperator', airline: { name: 'Hong Kong Express' },
    departure: { airport: { iata: 'HND' }, scheduledTime: { utc: `${d} 01:00Z`, local: `${d} 10:00+09:00` } },
    arrival: { airport: { iata: 'HKG' }, scheduledTime: { utc: `${d} 05:05Z`, local: `${d} 13:05+08:00` } }, aircraft: { model: 'Airbus A321neo' }, ...over });
  const found = (d, legs) => ({ status: 'found', source: 'aerodatabox', number: 'UO625', date: d, fetchedAt: new Date().toISOString(), legs: normalizeFlights(legs) });
  const schCalls = () => calls.filter(u => u.includes('/schedule/'));
  const adsbCalls = () => calls.filter(u => u.includes('adsbdb.com'));

  it('UO625: sin pedir la hora, ficha y pronóstico con aeropuertos y horario del día; ni ADSBDB ni radar (vuelo de mañana)', async () => {
    const d = tomorrow();
    await openApp(network({ flights: {}, schedule: { [`UO625|${d}`]: found(d, [raw(d)]) }, adsbdb: { UO625: adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG') }, openMeteo: openMeteoOk }));
    await search('UO625', d);
    await until(() => $('#result .flight') && $('#forecast-area [data-card="turbulence"]'), 'ficha y pronóstico');
    await networkIdle();
    expect($('#time-field').hidden).toBe(true); // no se pidió la hora
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect($('#result .flight h2').textContent).toBe('UO 625');
    for (const t of ['Hong Kong Express · Airbus A321neo', 'Programado', 'HND', 'HKG', '10:00 Salida programada', '10:00 Programada Salida', '13:05 Programada Llegada',
      'Horario según AeroDataBox · consultado hace un momento']) expect(card).toContain(t);
    expect(routeText()).toBe('Tokyo a Hong Kong');
    expect(card).not.toMatch(/Aena|Puerta de embarque/);
    expect(calls).toContain('data/flights/UO/625.json'); // Aena primero
    expect(schCalls()).toEqual([`${LIVE_BASE}/schedule/UO625/${d}.json`]);
    expect(adsbCalls()).toEqual([]);
    expect(calls.some(u => u.includes('/radar/') || u.includes('adsb.lol'))).toBe(false);
    expect(document.getElementById('change-time').hidden).toBe(true);
    // Open-Meteo con las coordenadas de data/airports.json y la duración real (4 h 05 min).
    const meteo = calls.find(u => u.startsWith('https://api.open-meteo.com/v1/forecast'));
    expect(Number(new URL(meteo).searchParams.get('latitude').split(',')[0])).toBeCloseTo(AIRPORTS_DB.HND[2], 3);
    // «Actualizar» y una segunda búsqueda: ni Render ni ADSBDB (caché del navegador).
    $('#refresh').click();
    await networkIdle();
    await search('UO625', d);
    await until(() => $('#result .flight h2')?.textContent === 'UO 625', 'segunda búsqueda');
    await networkIdle();
    expect(schCalls()).toHaveLength(1);
    expect(adsbCalls()).toEqual([]);
  });

  it('varios tramos el mismo día → selector; al escoger, ese tramo', async () => {
    const d = tomorrow();
    const second = raw(d, { departure: { airport: { iata: 'HKG' }, scheduledTime: { utc: `${d} 07:00Z`, local: `${d} 15:00+08:00` } },
      arrival: { airport: { iata: 'BKK' }, scheduledTime: { utc: `${d} 10:00Z`, local: `${d} 17:00+07:00` } } });
    await openApp(network({ flights: {}, schedule: { [`UO625|${d}`]: found(d, [raw(d), second]) }, openMeteo: openMeteoOk }));
    await search('UO625', d);
    await until(() => $('.leg-switch'), 'selector');
    const options = [...document.querySelectorAll('.leg-option')];
    expect(options.map(o => o.querySelector('small').textContent)).toEqual(['HND → HKG · sale 10:00 · Programado', 'HKG → BKK · sale 15:00 · Programado']);
    options[1].click();
    await until(() => routeText().includes('Hong Kong a Bangkok'), 'ficha del tramo escogido');
    expect(schCalls()).toHaveLength(1);
  });

  it('AeroDataBox sin el vuelo (not_found) → ruta de ADSBDB y hora manual, como antes', async () => {
    const d = tomorrow();
    await openApp(network({ flights: {}, schedule: { [`UO625|${d}`]: { status: 'not_found', legs: [], fetchedAt: new Date().toISOString() } },
      adsbdb: { UO625: adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG') }, openMeteo: openMeteoOk }));
    await search('UO625', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    expect($('#notice').textContent).toContain('Ruta según ADSBDB (no oficial)');
    expect(adsbCalls()).toHaveLength(1);
  });

  it('Render sin AeroDataBox (no disponible / error) → ADSBDB sin romper el flujo', async () => {
    const d = tomorrow();
    for (const r of [{ status: 'unavailable', reason: 'http-429' }, () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) })]) {
      await openApp(network({ flights: {}, schedule: { [`UO625|${d}`]: r }, adsbdb: { UO625: adsbdbRoute('UO625', 'HKE625', 'Hong Kong Express', 'HND', 'HKG') }, openMeteo: openMeteoOk }));
      await search('UO625', d);
      await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
      expect($('#f-origin').value).toBe('HND');
    }
  });

  it('aeropuerto de AeroDataBox que no está en data/airports.json → entrada manual', async () => {
    const d = tomorrow();
    await openApp(network({ flights: {}, schedule: { [`UO625|${d}`]: found(d, [raw(d, { arrival: { airport: { iata: 'ZZZ' }, scheduledTime: { utc: `${d} 05:05Z`, local: `${d} 13:05+08:00` } } })]) }, openMeteo: openMeteoOk }));
    await search('UO625', d);
    await until(() => !$('#manual').hidden, 'entrada manual');
    expect($('#notice').textContent).toBe('AeroDataBox da la ruta HND → ZZZ, pero no tengo alguno de esos aeropuertos: introdúcelo a mano.');
  });

  it('vuelo de Aena → nunca se consulta AeroDataBox', async () => {
    const d = tomorrow();
    const leg = { d, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${d}T17:55`, sa: '19:25', ea: `${d}T19:25`, st: 'SCH', ac: 'A21N' };
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany }));
    await search('IB1668', d);
    await until(() => $('#result .flight'), 'ficha de Aena');
    await networkIdle();
    expect(schCalls()).toEqual([]);
  });

  it('alias de Aena: primero la confirmación (sin AeroDataBox); «No es este vuelo» → AeroDataBox', async () => {
    const d = tomorrow();
    const ALIASES = { updated: new Date().toISOString(), aliases: { BA8462: { al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: d } } };
    const cj = { CJ8462: { name: 'BA CITYFLYER', updated: new Date().toISOString(), legs: [{ d, o: 'IBZ', a: 'LCY', sd: '10:45', ed: `${d}T10:45`, st: 'SCH', std: 'SCH', ac: 'E190', op: 'CJ' }] } };
    const ba = raw(d, { number: 'BA 8462', airline: { name: 'British Airways' }, departure: { airport: { iata: 'IBZ' }, scheduledTime: { utc: `${d} 08:45Z`, local: `${d} 10:45+02:00` } },
      arrival: { airport: { iata: 'LCY' }, scheduledTime: { utc: `${d} 11:20Z`, local: `${d} 12:20+01:00` } }, aircraft: { model: 'Embraer 190' } });
    await openApp(network({ flights: cj, aliases: ALIASES, schedule: { [`BA8462|${d}`]: found(d, [ba]) },
      adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'confirmación');
    expect(schCalls()).toEqual([]);
    $('[data-alias="reject"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await until(() => $('#result .flight h2')?.textContent === 'BA 8462', 'ficha por AeroDataBox');
    expect($('#result .flight .hero-sub').textContent).toContain('British Airways');
    expect(routeText()).toContain('Ibiza (Eivissa) a London');
    expect($('#result .flight .foot').textContent).toContain('Horario según AeroDataBox');
    expect(schCalls()).toHaveLength(1);
    expect(adsbCalls()).toHaveLength(1); // solo el veto del alias
  });

  it('tras «No es este vuelo», escoger un tramo de AeroDataBox no vuelve a ofrecer el alias', async () => {
    const d = tomorrow();
    const ALIASES = { updated: new Date().toISOString(), aliases: { BA8462: { al: 'CJ', n: '8462', name: 'BA CITYFLYER', routes: [['IBZ', 'LCY']], lastEvidence: d } } };
    const cj = { CJ8462: { name: 'BA CITYFLYER', updated: new Date().toISOString(), legs: [{ d, o: 'IBZ', a: 'LCY', sd: '10:45', ed: `${d}T10:45`, st: 'SCH', std: 'SCH', ac: 'E190', op: 'CJ' }] } };
    const leg = (o, a, h, oOff, aOff) => raw(d, { number: 'BA 8462', airline: { name: 'British Airways' },
      departure: { airport: { iata: o }, scheduledTime: { utc: `${d} ${String(h - oOff).padStart(2, '0')}:00Z`, local: `${d} ${String(h).padStart(2, '0')}:00+0${oOff}:00` } },
      arrival: { airport: { iata: a }, scheduledTime: { utc: `${d} ${String(h - oOff + 2).padStart(2, '0')}:00Z`, local: `${d} ${String(h - oOff + 2 + aOff).padStart(2, '0')}:00+0${aOff}:00` } } });
    await openApp(network({ flights: cj, aliases: ALIASES, schedule: { [`BA8462|${d}`]: found(d, [leg('IBZ', 'LCY', 10, 2, 1), leg('LCY', 'EDI', 15, 1, 1)]) },
      adsbdb: { BA8462: adsbdbRoute('BA8462', 'BAW8462', 'British Airways', 'IBZ', 'LCY') }, openMeteo: openMeteoOk }));
    await search('BA8462', d);
    await until(() => $('.alias-offer'), 'confirmación');
    $('[data-alias="reject"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await until(() => $('.leg-switch'), 'selector de tramos de AeroDataBox');
    document.querySelectorAll('.leg-option')[1].click();
    await until(() => routeText().includes('London a Ingliston, Edinburgh'), 'tramo escogido');
    expect($('.alias-offer')).toBeNull();
    expect(schCalls()).toHaveLength(1);
  });
});

// Radar de vuelos de AeroDataBox: misma ficha, mismo panel y mismo sondeo que Aena; solo si hay transpondedor o indicativo.
describe('radar de un vuelo de AeroDataBox (sin Aena)', () => {
  // GA89 AMS (+02:00) → CGK (+07:00), salió hace 2 h y llega dentro de 10 h (horas relativas a ahora).
  const fmt = (ms, offH) => { const t = new Date(ms + offH * 3600000).toISOString(); return `${t.slice(0, 10)} ${t.slice(11, 16)}${offH >= 0 ? '+' : '-'}${String(Math.abs(offH)).padStart(2, '0')}:00`; };
  const utc = ms => `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)}Z`;
  const dep = Math.floor((Date.now() - 2 * 3600000) / 60000) * 60000, arr = dep + 12 * 3600000;
  const d = fmt(dep, 2).slice(0, 10);
  const raw = (over = {}) => ({ number: 'GA 89', callSign: 'GIA89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' },
    departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: utc(dep), local: fmt(dep, 2) } },
    arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: utc(arr), local: fmt(arr, 7) } },
    aircraft: { model: 'Boeing 777', reg: 'PK-GIK', modeS: '8A04C1' }, ...over });
  const entry = r => ({ status: 'found', source: 'aerodatabox', number: 'GA89', date: d, fetchedAt: new Date().toISOString(), legs: normalizeFlights([r]) });
  const FLYING = { state: 'volando', callsign: 'GIA89', hex: '8a04c1', match: 'transpondedor', altFt: 37000, altM: 11278, kmh: 905, vRateFpm: 0,
    seenS: 3, remainingKm: 9300, source: 'adsb.lol' };
  const radarCalls = () => calls.filter(u => u.includes('/radar-adb/'));
  const open = async (r, radarAdb) => {
    await openApp(network({ flights: {}, schedule: { [`GA89|${d}`]: entry(r) }, radarAdb, openMeteo: () => tooMany }));
    await search('GA89', d);
    await until(() => $('#result .flight'), 'ficha de AeroDataBox');
  };

  it('en el aire con transpondedor: ficha + panel «Volando» con velocidad, altitud, distancia y señal; pide el vuelo físico exacto', async () => {
    await open(raw(), FLYING);
    await until(() => $('.telemetry'), 'panel del radar');
    const panel = $('.telemetry').textContent.replace(/\s+/g, ' ');
    for (const t of ['905', '11.300', '9.300', 'Radar ADS-B', 'Última señal 3 s', 'GIA89']) expect(panel).toContain(t);
    expect($('#result .flight .status').textContent).toContain('En vuelo');
    expect($('#result .flight h2').textContent).toBe('GA 89');
    expect($('#result .flight').textContent).not.toContain('Aena');
    const key = `adb|GA89|${d}|AMS|CGK|${new Date(dep).toISOString().slice(0, 16)}Z`;
    expect(radarCalls()[0]).toBe(`${LIVE_BASE}/radar-adb/GA89/${d}.json?leg=${encodeURIComponent(key)}`);
    expect(calls.some(u => u.includes('/radar/'))).toBe(false); // nunca el radar de Aena
    expect(calls.filter(u => u.includes('/schedule/'))).toHaveLength(1); // AeroDataBox: nada más que la consulta del horario
  });
  // Con Flightradar24 el servidor lo busca por su número comercial: la app ya no exige transpondedor ni indicativo
  // (adbRadarGate con requireIdentifier: false). Si el servidor no tiene FR24 (flujo antiguo), responde «no-aplica».
  it('sin transpondedor ni indicativo: pide el radar (FR24 lo busca por número) y lo pinta si vuela', async () => {
    const fr24 = { ...FLYING, hex: '8A04C1', match: 'fr24', source: 'fr24', fr24Id: '4a4a4a4a' };
    await open(raw({ callSign: null, aircraft: { model: 'Boeing 777' } }), fr24);
    await until(() => $('.telemetry'), 'panel del radar');
    expect(radarCalls()).toHaveLength(1);
  });
  it('Flightradar24: el panel y Detalles avanzados atribuyen los datos a Flightradar24, sin «ADS-B» ni «adsb.lol»', async () => {
    await open(raw({ callSign: null, aircraft: { model: 'Boeing 777' } }), { ...FLYING, hex: '8A04C1', match: 'fr24', source: 'fr24', fr24Id: '4a4a4a4a' });
    await until(() => $('.telemetry') && $('#adv-flight')?.textContent.includes('Flightradar24'), 'panel y detalles con Flightradar24');
    expect($('.telemetry').textContent).toContain('Flightradar24');
    expect($('.telemetry').textContent).not.toContain('ADS-B');
    expect($('#adv-flight').textContent).not.toMatch(/ADS-B|adsb\.lol/);
  });
  it('Flightradar24 confirma el aterrizaje: «Confirmado por Flightradar24», sin «ADS-B»', async () => {
    await open(raw(), { state: 'aterrizado', callsign: 'GIA89', seenS: 30, distanceKm: 2, source: 'fr24', fr24Id: '4a4a4a4a' });
    await until(() => $('#result .flight .status')?.textContent.includes('Aterrizado'), 'aterrizado');
    expect($('#result .flight').textContent).toContain('Confirmado por Flightradar24');
    expect($('#result .flight').textContent).not.toContain('ADS-B');
  });
  it('sin transpondedor ni indicativo y el servidor sin FR24 («no-aplica»): ficha sin radar ni «Sin señal»', async () => {
    await open(raw({ callSign: null, aircraft: { model: 'Boeing 777' } }), { state: 'no-aplica' });
    await networkIdle();
    expect(radarCalls()).toHaveLength(1);
    expect($('.telemetry')).toBeNull();
    expect($('#result .flight').textContent).not.toContain('Sin señal');
  });
  it('sin señal (el servidor no lo ve): «Sin señal ADS-B reciente», sin inventar nada', async () => {
    await open(raw(), { state: 'sin-datos' });
    await until(() => $('.radar.muted'), 'aviso de radar');
    expect($('.radar.muted').textContent).toBe('Sin señal ADS-B reciente para este vuelo.');
    expect($('.telemetry')).toBeNull();
  });
  it('estado antiguo pero con hora real de despegue y sin señal (caso GA89): «Sin señal ADS-B reciente para este vuelo.»', async () => {
    const old = new Date(Date.now() - 2 * 3600000).toISOString();
    const withRunway = raw({ callSign: 'GIA089', aircraft: { model: 'Boeing 777' }, departure: { ...raw().departure, runwayTime: { utc: utc(dep + 60000), local: fmt(dep + 60000, 2) } } });
    await openApp(network({ flights: {}, schedule: { [`GA89|${d}`]: { ...entry(withRunway), fetchedAt: old } }, radarAdb: { state: 'sin-datos' }, openMeteo: () => tooMany }));
    await search('GA89', d);
    await until(() => $('.radar.muted'), 'aviso de radar');
    expect($('.radar.muted').textContent).toBe('Sin señal ADS-B reciente para este vuelo.');
    expect(radarCalls()).toHaveLength(1);
  });
  it('estado de AeroDataBox no confirmado (departureConfirmed: false): ni panel ni «sin señal»', async () => {
    await open(raw({ status: 'Expected' }), { state: 'sin-datos', departureConfirmed: false });
    await networkIdle();
    expect(radarCalls()).toHaveLength(1);
    expect($('.radar.muted')).toBeNull();
  });
  it('aterrizado según ADS-B → «Aterrizado»', async () => {
    await open(raw(), { state: 'aterrizado', callsign: 'GIA89', seenS: 30, distanceKm: 2, source: 'adsb.lol' });
    await until(() => $('#result .flight .status')?.textContent.includes('Aterrizado'), 'aterrizado');
  });
  it('cambio de avión aceptado por indicativo: se dice en el panel', async () => {
    await open(raw(), { ...FLYING, hex: '8a0500', match: 'indicativo', aircraftChanged: true });
    await until(() => $('.telemetry'), 'panel');
    expect($('.telemetry').textContent).toContain('no es el que AeroDataBox tenía asignado a este vuelo');
  });
  it('«Actualizar»: vuelve a pedir el radar, pero no el horario de AeroDataBox (caché del navegador)', async () => {
    await open(raw(), FLYING);
    await until(() => $('.telemetry'), 'panel');
    await networkIdle();
    $('#refresh').click();
    await until(() => radarCalls().length === 2, 'radar de nuevo');
    expect(calls.filter(u => u.includes('/schedule/'))).toHaveLength(1);
  });
});

// ADSBDB no conoce el número comercial (404) pero sí su indicativo OACI, traducido con el catálogo de Aena.
describe('ADSBDB por indicativo OACI (catálogo de Aena) cuando no conoce el número comercial', () => {
  const tomorrow = () => dayOf(Date.now() + 24 * 3600000);
  const CAT = { JAF: 'TB', VLG: 'VY', IBE: 'IB' };
  // Respuesta real de ADSBDB para JAF2632 (27/09/2026): aerolínea con IATA desactualizado (JF, «Jetairfly»).
  const jaf = (over = {}) => { const b = adsbdbRoute('JF2632', 'JAF2632', 'Jetairfly', 'OUD', 'BRU'); Object.assign(b.response.flightroute.airline, { icao: 'JAF', iata: 'JF' }); Object.assign(b.response.flightroute, over); return b; };
  const unknown = () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({ response: 'unknown callsign' }) });
  const adsbCalls = () => calls.filter(u => u.includes('adsbdb.com'));
  const catCalls = () => calls.filter(u => u === 'data/flights/airlines.json');
  const schCalls = () => calls.filter(u => u.includes('/schedule/'));
  const open = async (number, { adsbdb, airlines = CAT }) => {
    const d = tomorrow();
    await openApp(network({ flights: {}, airlines, adsbdb, openMeteo: openMeteoOk,
      schedule: { [`${number}|${d}`]: { status: 'not_found', legs: [], fetchedAt: new Date().toISOString() } } }));
    await search(number, d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB o entrada manual');
    await networkIdle();
    return d;
  };

  it('traducción única: TB2632 → JAF2632 → OUD → BRU; número del usuario, ruta no oficial y editable, hora manual · ADSBDB 2, AeroDataBox 0', async () => {
    const d = await open('TB2632', { adsbdb: { TB2632: unknown, JAF2632: jaf() } });
    expect($('#notice').textContent).toContain('Ruta según ADSBDB (no oficial): Ahl Angad (OUD) → Zaventem (BRU)');
    expect([$('#f-origin').value, $('#f-destination').value]).toEqual(['OUD', 'BRU']);
    expect($('#number-field').hidden).toBe(false);
    expect(adsbCalls()).toEqual(['https://api.adsbdb.com/v0/callsign/TB2632', 'https://api.adsbdb.com/v0/callsign/JAF2632']);
    expect(catCalls()).toHaveLength(1);
    expect(schCalls()).toEqual([`${LIVE_BASE}/schedule/TB2632/${d}.json`]); // la única, servida de la caché (not_found)
    $('#f-time').value = '09:00';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'OUD → BRU', 'pronóstico');
    expect($('#result .sub').textContent).toContain('TB2632 · ruta según ADSBDB (no oficial)');
    expect($('#result .sub').textContent).not.toMatch(/JF2632|Jetairfly/);
    expect(adsbCalls()).toHaveLength(2);
    expect(schCalls()).toHaveLength(1);
    expect(calls.some(u => u.includes('/radar') || u.includes('adsb.lol'))).toBe(false);
  });
  it('IATA sin traducción en el catálogo → entrada manual · ADSBDB 1', async () => {
    await open('TB2632', { adsbdb: { TB2632: unknown, JAF2632: jaf() }, airlines: { VLG: 'VY' } });
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
    expect(adsbCalls()).toHaveLength(1);
  });
  it('IATA con dos OACI → no se intenta · ADSBDB 1', async () => {
    await open('TB2632', { adsbdb: { TB2632: unknown, JAF2632: jaf() }, airlines: { ...CAT, XTB: 'TB' } });
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
    expect(adsbCalls()).toHaveLength(1);
  });
  it('primera consulta con error temporal (503 / timeout) → sin traducción ni segundo intento · ADSBDB 1', async () => {
    for (const first of [() => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }), () => { throw new DOMException('t', 'TimeoutError'); }]) {
      await open('TB2632', { adsbdb: { TB2632: first, JAF2632: jaf() } });
      expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
      expect(adsbCalls()).toEqual(['https://api.adsbdb.com/v0/callsign/TB2632']);
      expect(catCalls()).toHaveLength(0);
    }
  });
  it('respuesta con otra aerolínea (airline.icao distinto) → rechazada · ADSBDB 2', async () => {
    const other = jaf(); other.response.flightroute.airline.icao = 'XXX';
    await open('TB2632', { adsbdb: { TB2632: unknown, JAF2632: other } });
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
    expect(adsbCalls()).toHaveLength(2);
  });
  it('respuesta con otro indicativo (callsign_icao distinto) → rechazada · ADSBDB 2', async () => {
    await open('TB2632', { adsbdb: { TB2632: unknown, JAF2632: jaf({ callsign_icao: 'JAF2633' }) } });
    expect($('#notice').textContent).toBe('No encuentro ese vuelo, introdúcelo a mano.');
    expect(adsbCalls()).toHaveLength(2);
  });
  it('sufijo conservado: TB2632A → JAF2632A (nunca JAF2632) · ADSBDB 2', async () => {
    await open('TB2632A', { adsbdb: { TB2632A: unknown, JAF2632A: jaf({ callsign_icao: 'JAF2632A', callsign: 'JAF2632A' }), JAF2632: jaf() } });
    expect(adsbCalls()).toEqual(['https://api.adsbdb.com/v0/callsign/TB2632A', 'https://api.adsbdb.com/v0/callsign/JAF2632A']);
    expect($('#f-origin').value).toBe('OUD');
  });
  it('el número original sí lo conoce ADSBDB → no se traduce nada · ADSBDB 1, catálogo 0', async () => {
    await open('TB2632', { adsbdb: { TB2632: adsbdbRoute('TB2632', 'JAF2632', 'TUI fly Belgium', 'OUD', 'BRU') } });
    expect(adsbCalls()).toHaveLength(1);
    expect(catCalls()).toHaveLength(0);
  });
});

// Vuelos programados: refresco de Aena (puerta, estado, horas) desde 6 h antes de la salida, y datos stale (> 30 min,
// p. ej. la copia de GitHub Pages mientras Render despertaba) → se busca una versión más reciente enseguida.
describe('refresco de Aena para vuelos programados y datos stale', () => {
  const T = Date.parse('2026-09-26T12:00:00Z'); // 14:00 en Madrid
  const D = '2026-09-26';
  const iso = ms => new Date(ms).toISOString();
  const leg = (sd, over = {}) => ({ d: D, o: 'PMI', a: 'MAD', sd, ed: `${D}T${sd}`, sa: '23:30', ea: `${D}T23:30`, td: 'N', ta: 'T4', g: null, st: 'SCH', std: 'SCH', sta: null, ac: 'A21N', ...over });
  // Pages: la copia publicada (updated = pagesUpdated). Render: `render` (fail = dormido / sin respuesta).
  function app({ pagesLeg, pagesUpdated, render }) {
    const base = network({ flights: { IB1668: { name: 'Iberia', updated: pagesUpdated, legs: [pagesLeg] } }, openMeteo: () => tooMany });
    return vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/flights/`)) {
        calls.push(u);
        return render.fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(json({ name: 'Iberia', updated: render.updated, legs: render.legs }));
      }
      return base(url, o);
    });
  }
  const renderCalls = () => calls.filter(u => u.startsWith(`${LIVE_BASE}/flights/`));
  const card = () => $('#result .flight')?.textContent.replace(/\s+/g, ' ') ?? '';
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: T, shouldAdvanceTime: true });

  it('programado a 2 h + datos de Aena de hace 4 h (Render dormido) → refresca enseguida: puerta, estado y «actualizados» nuevos', async () => {
    fake();
    try {
      const render = { fail: true, updated: iso(T), legs: [leg('16:00', { g: 'D5', st: 'EMB', std: 'EMB' })] };
      await openApp(app({ pagesLeg: leg('16:00'), pagesUpdated: iso(T - 4 * 3600000), render }));
      await search('IB1668', D);
      await until(() => $('#result .flight'), 'ficha');
      expect(card()).toContain('hace 4 horas'); // la copia vieja de GitHub Pages, dicha como tal
      expect(card()).toContain('Aún sin asignar');
      render.fail = false; // Render ya despertó
      await advance(6000);
      await until(() => card().includes('D5'), 'puerta nueva');
      expect(card()).toContain('Embarcando');
      expect(card()).toContain('Datos actualizados hace un momento');
      expect(card()).not.toContain('hace 4 horas');
      expect(renderCalls().length).toBeGreaterThanOrEqual(2); // la carga inicial (sin respuesta) y el refresco
    } finally { vi.useRealTimers(); }
  });
  it('programado a 8 h con datos al día → sin refresco continuo (ni una consulta más en 1 h)', async () => {
    frozenClock(T);
    try {
      const render = { fail: false, updated: iso(T - 5 * 60000), legs: [leg('22:00')] };
      await openApp(app({ pagesLeg: leg('22:00'), pagesUpdated: iso(T - 5 * 60000), render }));
      await search('IB1668', D);
      await untilFrozen(() => $('#result .flight'), 'ficha');
      await networkIdleFrozen();
      expect(Date.now()).toBe(T); // nada del montaje ha movido el reloj virtual
      const before = renderCalls().length;
      await vi.advanceTimersByTimeAsync(3600000); // 1 h virtual: cada temporizador corre en su instante, sin esperar
      await networkIdleFrozen();
      expect(Date.now()).toBe(T + 3600000);
      expect(renderCalls()).toHaveLength(before);
      expect(vi.getTimerCount()).toBe(0); // ningún sondeo programado queda vivo
    } finally { vi.useRealTimers(); }
  });
  it('programado a 8 h con datos de hace 4 h → un solo intento de traer datos nuevos, y nada más', async () => {
    fake();
    try {
      const render = { fail: true, updated: iso(T), legs: [leg('22:00', { g: 'C3' })] };
      await openApp(app({ pagesLeg: leg('22:00'), pagesUpdated: iso(T - 4 * 3600000), render }));
      await search('IB1668', D);
      await until(() => $('#result .flight'), 'ficha');
      await networkIdle();
      const before = renderCalls().length;
      render.fail = false;
      await advance(6000);
      await until(() => card().includes('C3'), 'datos nuevos');
      expect(renderCalls()).toHaveLength(before + 1);
      await advance(3600000);
      expect(renderCalls()).toHaveLength(before + 1); // una sola vez
    } finally { vi.useRealTimers(); }
  });
});

// Pronóstico sobre la ventana EN EL AIRE (js/airtime.js); la ficha y lo oficial siguen con las horas de bloque.
import { forecastWindow } from '../js/airtime.js';
import { hourKey } from '../js/weather.js';
import { distanceKm } from '../js/route.js';
import { localToUtcMs } from '../js/time.js';
describe('pronóstico con el tiempo en el aire, no con el de bloque', () => {
  const tomorrow = () => dayOf(Date.now() + 24 * 3600000);
  const ap = c => ({ lat: AIRPORTS_DB[c][2], lon: AIRPORTS_DB[c][3] });
  const km = distanceKm(ap('MAD'), ap('PMI'));
  // IB1667 simulado: MAD 15:45 → PMI 17:10 (85 min de bloque).
  const leg = d => ({ d, o: 'MAD', a: 'PMI', sd: '15:45', ed: `${d}T15:45`, sa: '17:10', ea: `${d}T17:10`, td: 'T4', ta: 'T', g: null, st: 'SCH', std: 'SCH', sta: 'SCH', ac: 'A320' });
  const flights = d => ({ IB1667: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg(d)] } });
  const modelCalls = () => calls.filter(u => u.startsWith('https://api.open-meteo.com/v1/forecast') && u.includes('models='));
  const legacyCalls = () => calls.filter(u => u.startsWith('https://api.open-meteo.com/v1/forecast') && !u.includes('models='));
  const range = u => { const p = new URL(u).searchParams; return [p.get('start_hour'), p.get('end_hour')]; };
  // Minuto de cada marca del eje (data-min): el texto es la hora local cuando origen y destino comparten zona.
  const ticks = () => [...document.querySelectorAll('#forecast-area .ticks span')].map(s => Number(s.dataset.min));
  const windowFor = d => {
    const dep = localToUtcMs(d, '15:45', 'Europe/Madrid'), arr = localToUtcMs(d, '17:10', 'Europe/Madrid');
    return forecastWindow({ km, blockDepartureMs: dep, blockArrivalMs: arr });
  };

  it('IB1667 MAD → PMI: la ficha sigue en 15:45 → 17:10; ECMWF/GFS reciben la ventana en el aire (≈ 55 min) y los minutos del pronóstico también', async () => {
    const d = tomorrow();
    await openApp(network({ flights: flights(d), openMeteo: openMeteoOk }));
    await search('IB1667', d);
    await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
    await networkIdle();
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect(card).toContain('15:45 Programada Salida');
    expect(card).toContain('17:10 Programada Llegada'); // hora oficial, no la del pronóstico
    expect(card).not.toMatch(/16:5\d (Programada|Prevista) Llegada/);
    const w = windowFor(d);
    expect(w.forecastAirborneMin).toBeGreaterThan(54);
    expect(w.forecastAirborneMin).toBeLessThan(60);
    expect(modelCalls().length).toBeGreaterThan(0);
    for (const u of modelCalls()) expect(range(u)).toEqual([hourKey(w.forecastTakeoffMs - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
    expect(Math.max(...ticks())).toBeLessThanOrEqual(w.forecastAirborneMin); // la línea de tiempo del pronóstico: ≈ 55′, no 85′
    expect(Math.max(...ticks())).toBeLessThan(60);
  });

  it('salida y llegada ESTIMADAS de Aena: la ficha las conserva (16:05 → 17:30) y el pronóstico encaja el aire en ese bloque', async () => {
    const d = tomorrow();
    const late = { ...leg(d), ed: `${d}T16:05`, ea: `${d}T17:30`, st: 'RET', std: 'RET' };
    await openApp(network({ flights: { IB1667: { name: 'Iberia', updated: new Date().toISOString(), legs: [late] } }, openMeteo: openMeteoOk }));
    await search('IB1667', d);
    await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
    await networkIdle();
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect(card).toContain('15:45 Programada Salida 16:05 Prevista Salida');
    expect(card).toContain('17:10 Programada Llegada 17:30 Prevista Llegada');
    const w = forecastWindow({ km, blockDepartureMs: localToUtcMs(d, '16:05', 'Europe/Madrid'), blockArrivalMs: localToUtcMs(d, '17:30', 'Europe/Madrid') });
    for (const u of modelCalls()) expect(range(u)).toEqual([hourKey(w.forecastTakeoffMs - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
  });

  it('fallback legacy (ECMWF/GFS sin datos): la MISMA ventana en el aire', async () => {
    const d = tomorrow();
    const noData = url => { const r = openMeteoOk(url); const body = r.json; return { ...r, json: async () => {
      const b = await body(); const strip = x => ({ ...x, hourly: Object.fromEntries(Object.entries(x.hourly).map(([k, v]) => [k, k === 'time' ? v : v.map(() => null)])) });
      return Array.isArray(b) ? b.map(strip) : strip(b); } }; };
    await openApp(network({ flights: flights(d), openMeteo: url => (url.includes('models=') ? noData(url) : openMeteoOk(url)) }));
    await search('IB1667', d);
    await until(() => area().includes('Cálculo simplificado'), 'cálculo simplificado');
    const w = windowFor(d);
    expect(legacyCalls().length).toBeGreaterThan(0);
    for (const u of legacyCalls()) expect(range(u)).toEqual([hourKey(w.forecastTakeoffMs - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
    expect(Math.max(...ticks())).toBeLessThan(60);
  });

  it('AeroDataBox en el aire con hora de pista de salida: el pronóstico empieza en el despegue real (y la llegada real, al aterrizar, lo cierra)', async () => {
    const d = dayOf(Date.now());
    const dep = Date.now() - 30 * 60000, arr = dep + 85 * 60000; // bloque 85 min; salió de calzos hace 30 min
    const rwyDep = dep + 20 * 60000; // despegó hace 10 min (real)
    const t = (ms, off) => ({ utc: `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)}Z`,
      local: `${new Date(ms + off * 3600000).toISOString().slice(0, 10)} ${new Date(ms + off * 3600000).toISOString().slice(11, 16)}+0${off}:00` });
    const raw = over => ({ number: 'XX 100', status: 'EnRoute', airline: { name: 'Prueba' }, callSign: 'XXX100',
      departure: { airport: { iata: 'MAD' }, scheduledTime: t(dep, 2), runwayTime: t(rwyDep, 2) },
      arrival: { airport: { iata: 'PMI' }, scheduledTime: t(arr, 2) }, ...over });
    const entry = r => ({ status: 'found', source: 'aerodatabox', number: 'XX100', date: dayOf(dep), fetchedAt: new Date().toISOString(), legs: normalizeFlights([r]) });
    await openApp(network({ flights: {}, openMeteo: openMeteoOk, schedule: { [`XX100|${dayOf(dep)}`]: entry(raw()) } }));
    await search('XX100', dayOf(dep));
    await until(() => modelCalls().length, 'pronóstico');
    await networkIdle();
    const takeoff = Math.floor(rwyDep / 60000) * 60000; // la hora de pista, al minuto
    const w = forecastWindow({ km, blockDepartureMs: Math.floor(dep / 60000) * 60000, blockArrivalMs: Math.floor(arr / 60000) * 60000, runwayDepartureMs: takeoff });
    expect(w.source).toBe('pista-salida');
    for (const u of modelCalls()) expect(range(u)).toEqual([hourKey(takeoff - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
    await until(() => ticks().length, 'línea de tiempo');
    expect(Math.max(...ticks())).toBeLessThanOrEqual(w.forecastAirborneMin); // ≈ 55′ de vuelo, no los 65′ que quedaban de bloque
    // Con hora de pista de llegada ya ha aterrizado: sin pronóstico (la ventana con las dos pistas está en tests/airtime.test.js).
    localStorage.clear(); // otra consulta de AeroDataBox (la caché del navegador guardaría la anterior)
    const landed = raw({ status: 'Arrived', arrival: { airport: { iata: 'PMI' }, scheduledTime: t(arr, 2), runwayTime: t(rwyDep + 48 * 60000, 2) } });
    await openApp(network({ flights: {}, openMeteo: openMeteoOk, schedule: { [`XX100|${dayOf(dep)}`]: entry(landed) } }));
    await search('XX100', dayOf(dep));
    await until(() => $('#result .flight'), 'ficha');
    await networkIdle();
    turbGone(); // ya aterrizado y sin resumen guardado (almacenamiento vacío): ni tarjeta ni «Turbulencias estimadas»
    expect(turbEstimate()).toBeNull();
    expect(calls.filter(u => u.includes('open-meteo'))).toEqual([]); // nada calculado a posteriori
  });

  it('AeroDataBox sin horas de pista: estimación en el aire (no el bloque completo)', async () => {
    const d = tomorrow();
    const dep = localToUtcMs(d, '10:00', 'Europe/Madrid'), arr = dep + 85 * 60000;
    const t = (ms, off) => ({ utc: `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)}Z`,
      local: `${new Date(ms + off * 3600000).toISOString().slice(0, 10)} ${new Date(ms + off * 3600000).toISOString().slice(11, 16)}+0${off}:00` });
    const raw = { number: 'XX 101', status: 'Expected', airline: { name: 'Prueba' },
      departure: { airport: { iata: 'MAD' }, scheduledTime: t(dep, 2) }, arrival: { airport: { iata: 'PMI' }, scheduledTime: t(arr, 2) } };
    await openApp(network({ flights: {}, openMeteo: openMeteoOk,
      schedule: { [`XX101|${d}`]: { status: 'found', source: 'aerodatabox', number: 'XX101', date: d, fetchedAt: new Date().toISOString(), legs: normalizeFlights([raw]) } } }));
    await search('XX101', d);
    await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
    await networkIdle();
    const w = forecastWindow({ km, blockDepartureMs: dep, blockArrivalMs: arr });
    for (const u of modelCalls()) expect(range(u)).toEqual([hourKey(w.forecastTakeoffMs - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
    expect($('#result .flight').textContent.replace(/\s+/g, ' ')).toContain('10:00 Salida programada'); // la ficha, con su hora
    expect(Math.max(...ticks())).toBeLessThanOrEqual(w.forecastAirborneMin); // ≈ 55′, no los 85′ del bloque
  });

  it('consulta manual: sigue funcionando; se muestran las horas escritas y el pronóstico va sobre la ventana en el aire', async () => {
    const d = tomorrow();
    await openApp(network({ flights: {}, adsbdb: { XX200: adsbdbRoute('XX200', 'XXX200', 'Prueba', 'MAD', 'PMI') }, openMeteo: openMeteoOk }));
    await search('XX200', d);
    await until(() => !$('#time-field').hidden, 'ruta de ADSBDB');
    $('#f-time').value = '10:00';
    submitForm();
    await until(() => $('#result .route')?.textContent === 'MAD → PMI', 'pronóstico');
    await networkIdle();
    expect($('#result .sub').textContent).toMatch(/· 10:00–/); // la hora escrita (bloque), no la del despegue estimado
    expect(Math.max(...ticks())).toBeLessThan(60);
  });
});

// Integración del rediseño (Tarea 8): repintado con estado, mapa con el avión, señal en vivo y previsión tras aterrizar.
// Leaflet se simula con un `L` falso: se cuentan los mapas creados y destruidos y los marcadores del avión.
function fakeLeaflet() {
  // view: llamadas que mueven la vista (fitBounds, setView, setZoom); path: todas las posiciones de cada marcador.
  const log = { maps: 0, mapsRemoved: 0, markers: [], view: [] };
  const layer = () => ({ addTo() { return this; }, bindTooltip() { return this; }, remove() {} });
  const L = {
    map: () => {
      log.maps++;
      return { fitBounds() { log.view.push('fitBounds'); }, setView() { log.view.push('setView'); }, setZoom() { log.view.push('setZoom'); },
        invalidateSize() {}, remove() { log.mapsRemoved++; } };
    },
    tileLayer: layer, polyline: layer, polygon: layer, circleMarker: layer,
    latLngBounds: () => ({ pad() { return this; } }),
    divIcon: o => o,
    marker: ll => {
      // rot: el .plane-rot del icono (rotación y atenuado de «última posición conocida»).
      const cls = new Set();
      const rot = { style: {}, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) } };
      const m = { ...layer(), ll, path: [ll], removed: false, rot, cls, setLatLng(p) { this.ll = p; this.path.push(p); return this; }, remove() { this.removed = true; },
        getElement() { return { querySelector: () => rot }; } };
      log.markers.push(m);
      return m;
    },
  };
  return { L, log };
}
const planeOnScreen = log => log.markers.some(m => !m.removed);
// El avión está y es la «última posición conocida» (60–180 s): quieto y atenuado (.plane-old).
const planeDimmed = log => log.markers.some(m => !m.removed && m.cls.has('plane-old'));

describe('integración del rediseño: repintado, mapa, señal en vivo y previsión tras aterrizar', () => {
  const flyingLeg = () => {
    const dep = Date.now() - 60 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    return { d, leg: { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: 'A21N' } };
  };
  const flights = leg => ({ IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } });

  it('el orden de bloques es fijo: selector, .flight, Turbulencias, mapa y Detalles avanzados', async () => {
    const { L } = fakeLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    await openApp(network({ flights: flights(leg), radar: RADAR_FLYING, openMeteo: () => tooMany }));
    await search('IB715', d);
    await until(() => $('.telemetry') && area().includes(FORECAST_UNAVAILABLE), 'ficha completa');
    const blocks = [...$('#result').children].map(c => (c.matches('.summary') ? '.flight' : c.matches('.disclaimer') ? 'disclaimer' : c.id || c.dataset.card));
    expect(blocks).toEqual(['.flight', 'forecast-area', 'map-card', 'advanced', 'disclaimer']);
    expect($('#map-card .card-title').textContent).toBe('Radar'); // en curso
  });

  it('repintado conserva desplegables: «Horario» abierto y el historial de puntualidad siguen tras una lectura «volando»', async () => {
    const { d, leg } = flyingLeg();
    let releaseRadar;
    const base = network({ flights: flights(leg), openMeteo: () => tooMany });
    await openApp(vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); return new Promise(r => { releaseRadar = () => r(json(RADAR_FLYING)); }); }
      return base(url, o);
    }));
    await search('IB715', d);
    await until(() => $('#punctuality')?.textContent.includes('Todavía no hay suficiente historial') && releaseRadar, 'historial cargado');
    $('details[data-card="schedule"]').open = true;
    $('details[data-card="advanced"]').open = true;
    releaseRadar();
    await until(() => $('.telemetry'), 'panel ADS-B');
    expect($('details[data-card="schedule"]').open).toBe(true);
    expect($('details[data-card="advanced"]').open).toBe(true);
    expect($('#punctuality').textContent).toContain('Todavía no hay suficiente historial'); // el nodo cargado, no uno vacío
    expect($('#adv-flight [data-card="adv-adsb"]')).not.toBeNull(); // Detalles avanzados también se repinta
  });

  // Ventana de 180 s (decisión del controlador, 21/10/2026; antes el avión se quitaba a los 60 s): entre 60 y 180 s es la
  // última posición conocida, quieta y atenuada; después, fuera.
  it('señal envejece: «old» a los 6 min, «stale» y .aged a los 13; el avión se atenúa pasados 60 s y se quita pasados 180 s; cero peticiones', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { L, log } = fakeLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      await openApp(network({ flights: flights(leg), radar: { ...RADAR_FLYING, seenS: 5, posAgeS: 5, lat: 51.2, lon: -0.9 }, openMeteo: () => tooMany }));
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1, 'panel ADS-B y mapa');
      await networkIdle();
      expect($('[data-signal-level="live"]')).not.toBeNull();
      expect(planeOnScreen(log)).toBe(true); // posición de 5 s: el avión está en el mapa
      const before = calls.length;
      expect(planeDimmed(log)).toBe(false);
      await vi.advanceTimersByTimeAsync(60000); // 65 s de antigüedad
      expect(planeDimmed(log)).toBe(true); // última posición conocida: quieta y atenuada
      expect($('[data-signal-level="live"]')).not.toBeNull(); // la señal aún se considera reciente (< 300 s)
      await vi.advanceTimersByTimeAsync(120000); // 185 s
      expect(planeOnScreen(log)).toBe(false); // se quita: solo la ruta y los aeropuertos
      await vi.advanceTimersByTimeAsync(3 * 60000); // 6 min y 5 s
      expect($('[data-signal-level="old"]')).not.toBeNull();
      expect($('.flight .tm-signal .tm-value').textContent).toBe('6 min');
      expect($('.flight .now').classList.contains('aged')).toBe(false);
      await vi.advanceTimersByTimeAsync(7 * 60000); // 13 min
      expect($('[data-signal-level="stale"]')).not.toBeNull();
      expect($('.flight .now').classList.contains('aged')).toBe(true);
      expect($('#adv-flight').textContent).toContain('hace 13 min'); // Detalles avanzados tampoco parece actual
      expect(planeOnScreen(log)).toBe(false);
      // El contador no pide nada: solo puede haber refrescos de Aena (su propio temporizador), nunca radar ni meteorología.
      expect(calls.slice(before).filter(u => !u.includes('/flights/'))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('seenS 1 y posAgeS 50: el avión se atenúa a los ~10 s y desaparece a los ~130 s (manda la posición); cero peticiones', async () => {
    frozenClock();
    try {
      const { L, log } = fakeLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      const t0 = Date.now();
      await openApp(network({ flights: flights(leg), radar: { ...RADAR_FLYING, seenS: 1, posAgeS: 50, lat: 51.2, lon: -0.9 }, openMeteo: () => tooMany }));
      await search('IB715', d);
      await untilFrozen(() => $('.telemetry') && log.maps === 1, 'panel ADS-B y mapa');
      await networkIdleFrozen();
      expect(Date.now()).toBe(t0); // la lectura llegó con el reloj parado: posición de 50 s exactos
      expect(planeOnScreen(log)).toBe(true);
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(9999); // posición de 59,999 s
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
      await vi.advanceTimersByTimeAsync(2); // 60,001 s: la posición pasa de 60 s con el último mensaje de hace ~11 s
      expect(planeDimmed(log)).toBe(true);
      expect($('[data-signal-level="live"]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(119998); // 179,999 s
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(true);
      await vi.advanceTimersByTimeAsync(2); // 180,001 s
      expect(planeOnScreen(log)).toBe(false);
      // Pendientes solo los propios de «volando»: refresco de Aena y los contadores de 1 s (señal y distancia); el del
      // avión ya no, porque no queda nada que mostrar.
      expect(vi.getTimerCount()).toBe(3);
      expect(calls.slice(before).filter(u => !u.includes('/flights/'))).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('primeros 60 s: el contador solo reescribe «Última señal» (Detalles avanzados no se repinta: ni foco ni toques se pierden)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { L, log } = fakeLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      await openApp(network({ flights: flights(leg), radar: { ...RADAR_FLYING, seenS: 5, posAgeS: 5, lat: 51.2, lon: -0.9 }, openMeteo: () => tooMany }));
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1, 'panel ADS-B y mapa');
      await networkIdle();
      $('details[data-card="advanced"]').open = true;
      const adsb = $('#adv-flight [data-card="adv-adsb"]');
      adsb.open = true;
      const signal = () => $('#adv-flight .adv-signal .v').textContent;
      const position = () => [...document.querySelectorAll('#adv-flight .kv')].find(r => r.querySelector('.k').textContent === 'Posición').querySelector('.v').textContent;
      const first = signal();
      await vi.advanceTimersByTimeAsync(30000);
      expect($('#adv-flight [data-card="adv-adsb"]')).toBe(adsb); // el mismo nodo: no se ha repintado #adv-flight
      expect(signal()).not.toBe(first); // pero «Última señal» sí avanza
      expect(signal()).toMatch(/^hace \d+ s$/);
      expect(position()).toBe('51.2000, -0.9000'); // el avión aún está en el mapa: la posición, sin antigüedad
      await vi.advanceTimersByTimeAsync(30000); // 65 s: el avión pasa a última posición conocida (atenuado)
      expect(planeDimmed(log)).toBe(true);
      expect($('#adv-flight [data-card="adv-adsb"]')).not.toBe(adsb); // ahora sí se repinta (una vez), conservando lo abierto
      expect($('#adv-flight [data-card="adv-adsb"]').open).toBe(true);
      expect(position()).toBe('51.2000, -0.9000 · hace 1 min');
      const repainted = $('#adv-flight [data-card="adv-adsb"]');
      await vi.advanceTimersByTimeAsync(60000); // 2 min: mismo nivel («live»), sin repintar; el texto sigue al día
      expect($('#adv-flight [data-card="adv-adsb"]')).toBe(repainted);
      expect(position()).toBe('51.2000, -0.9000 · hace 2 min');
      expect(signal()).toBe('hace 2 min');
    } finally { vi.useRealTimers(); }
  });

  it('el contador reescribe el span de la posición con su antigüedad (posAgeS), sin repintar el bloque', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { L, log } = fakeLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      await openApp(network({ flights: flights(leg), radar: { ...RADAR_FLYING, seenS: 1, posAgeS: 50, lat: 51.2, lon: -0.9 }, openMeteo: () => tooMany }));
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1, 'panel ADS-B y mapa');
      await networkIdle();
      $('details[data-card="advanced"]').open = true;
      const position = () => [...document.querySelectorAll('#adv-flight .kv')].find(r => r.querySelector('.k').textContent === 'Posición').querySelector('.v');
      await vi.advanceTimersByTimeAsync(15000); // la posición ya tiene más de 60 s: el avión se atenúa y se repinta una vez
      expect(planeDimmed(log)).toBe(true);
      const adsb = $('#adv-flight [data-card="adv-adsb"]');
      const span = position().querySelector('.adv-age[data-pos]');
      expect(span.textContent).toBe(' · hace 1 min');
      await vi.advanceTimersByTimeAsync(60000);
      expect($('#adv-flight [data-card="adv-adsb"]')).toBe(adsb); // el mismo nodo: sin repintar
      expect(position().querySelector('.adv-age[data-pos]')).toBe(span);
      expect(span.textContent).toBe(' · hace 2 min'); // 50 + 75 s, no los ~76 s de la señal
    } finally { vi.useRealTimers(); }
  });

  it('bajo el mapa, en el aire con el radar «volando»: Indicativo, Avión e Identificación', async () => {
    const { L } = fakeLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    await openApp(network({ flights: flights(leg), radar: { ...RADAR_FLYING, match: 'ruta' }, openMeteo: () => tooMany }));
    await search('IB715', d);
    await until(() => $('.telemetry') && $('#map-facts')?.textContent.trim(), 'datos bajo el mapa');
    const facts = [...document.querySelectorAll('#map-facts .kv')].map(r => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]);
    expect(facts).toEqual([['Indicativo', 'IBE715'], ['Avión', 'Airbus A321neo'], ['Identificación', 'Por ruta']]);
  });

  it('mapa sin coordenadas: la tarjeta del mapa existe y no hay avión', async () => {
    const { L, log } = fakeLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    await openApp(network({ flights: flights(leg), radar: RADAR_FLYING, openMeteo: () => tooMany }));
    await search('IB715', d);
    await until(() => $('.telemetry') && log.maps === 1, 'panel ADS-B y mapa');
    await networkIdle();
    expect($('#map-card #map')).not.toBeNull();
    expect(log.markers).toHaveLength(0);
  });

  it('otra búsqueda o «Nueva consulta» destruyen el mapa: nunca dos mapas a la vez', async () => {
    const { L, log } = fakeLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    await openApp(network({ flights: flights(leg), radar: RADAR_FLYING, openMeteo: () => tooMany }));
    await search('IB715', d);
    await until(() => log.maps === 1, 'primer mapa');
    await search('IB715', d);
    await until(() => log.maps === 2, 'segundo mapa');
    expect(log.mapsRemoved).toBe(1);
    $('#back').click();
    expect(log.mapsRemoved).toBe(2);
  });

  it('«Ver detalles» de los avisos abre Detalles avanzados y «El tiempo en los aeropuertos»', async () => {
    const t = dayOf(Date.now() + 24 * 3600000);
    const leg = { d: t, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${t}T17:55`, sa: '19:25', ea: `${t}T19:25`, st: 'SCH', ac: 'A21N' };
    const base = network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: openMeteoOk });
    const pirep = { items: [{ lat: 40, lon: -0.5, fl: 360, t: Date.now() - 600000, int: 'MOD', raw: 'UA /OV x' }] };
    await openApp(vi.fn((url, o) => (String(url) === 'data/aviation/pirep.json' ? (calls.push(String(url)), Promise.resolve(json(pirep))) : base(url, o))));
    await search('IB1668', t);
    await until(() => $('[data-open="adv-weather"]'), 'línea de avisos');
    const weather = $('details[data-card="adv-weather"]');
    expect(weather.hidden).toBe(false); // con #aviation relleno, la categoría se ve
    expect(weather.open).toBe(false);
    $('[data-open="adv-weather"]').click();
    expect($('details[data-card="advanced"]').open).toBe(true);
    expect(weather.open).toBe(true);
  });

  it('sin datos de Aviation Weather, «El tiempo en los aeropuertos» no se ve', async () => {
    const t = dayOf(Date.now() + 24 * 3600000);
    const leg = { d: t, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${t}T17:55`, sa: '19:25', ea: `${t}T19:25`, st: 'SCH', ac: 'A21N' };
    await openApp(network({ flights: { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: openMeteoOk }));
    await search('IB1668', t);
    await until(() => $('#forecast-area [data-card="turbulence"]') && $('#fresh')?.textContent.trim(), 'pronóstico completo');
    await networkIdle();
    expect($('#aviation').innerHTML).toBe('');
    expect($('details[data-card="adv-weather"]').hidden).toBe(true);
    expect(document.querySelectorAll('#fresh')).toHaveLength(1); // un único #fresh, en Detalles avanzados
    expect($('#adv-sources #fresh').textContent).toContain('Consulta realizada');
  });

  // Al terminar el vuelo la tarjeta Turbulencias desaparece; lo pronosticado ANTES del aterrizaje (el último pronóstico
  // válido de ese vuelo físico) queda como «Turbulencias estimadas» en el Resumen del vuelo. Nunca se calcula después.
  describe('Turbulencias al terminar el vuelo: «Turbulencias estimadas» en el Resumen del vuelo', () => {
    const T = Date.parse('2026-09-26T12:00:00Z');
    const D = '2026-09-26';
    const flyLeg = over => ({ d: D, o: 'MLA', a: 'BCN', sd: null, sa: '14:40', ea: `${D}T14:40`, st: 'FLY', sta: 'FLY', ac: '738W', ...over });
    const KEY = physicalFlightKey(flyLeg());
    const STORE = 'turbi-turb-estimates';
    const stored = () => JSON.parse(localStorage.getItem(STORE) ?? '{}');
    function app(render, radar = null, openMeteo = openMeteoOk) {
      const base = network({ flights: { FR1526: { name: 'Ryanair', updated: new Date(T).toISOString(), legs: [flyLeg()] } }, radar, openMeteo });
      return vi.fn((url, o) => {
        const u = String(url);
        if (u.startsWith(`${LIVE_BASE}/flights/`)) { calls.push(u); return Promise.resolve(json({ name: 'Ryanair', updated: render.updated, legs: render.legs })); }
        return base(url, o);
      });
    }
    const meteoCalls = () => calls.filter(u => u.includes('open-meteo'));
    const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: T, shouldAdvanceTime: true });
    // Aena trae otro estado en el siguiente ciclo de Render (630 s).
    async function aena(render, over) {
      render.legs = [flyLeg(over)];
      render.updated = new Date(T + 600000).toISOString();
      await advance(630000);
    }

    it('en curso con pronóstico → Aena LND: fuera Turbulencias, «Turbulencias estimadas» en el resumen, sin Open-Meteo y con «Ruta realizada»', async () => {
      fake();
      try {
        const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
        await openApp(app(render));
        await search('FR1526', D);
        await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
        await networkIdle();
        expect(shell()).toEqual(SHELL_OK); // en curso: la tarjeta Turbulencias, como siempre
        expect($('.flight-summary')).toBeNull();
        // Guardado con la clave del vuelo físico, solo el resumen (nada del pronóstico completo).
        expect(Object.keys(stored())).toEqual([KEY]);
        expect(Object.keys(stored()[KEY]).sort()).toEqual(['confidence', 'headline', 'maxDurationMin', 'maxLevel', 'percentages', 'queriedAt', 'verdict']);
        const meteo = meteoCalls().length;
        await aena(render, { st: 'LND', sta: 'LND' });
        await until(() => ($('#result .status')?.textContent ?? '').includes('En tierra'), 'En tierra');
        turbGone();
        expect(area()).not.toContain('Previsión mostrada antes del aterrizaje');
        expect(turbEstimate()).toBe('Turbulencias estimadas Tranquilo No se estimó turbulencia relevante');
        expect([...$('#result').children].map(c => c.id || c.dataset.card || c.className)).toEqual(['summary', 'forecast-area', 'map-card', 'advanced', 'disclaimer']);
        expect(meteoCalls()).toHaveLength(meteo);
        expect($('#map-card .card-title').textContent).toBe('Ruta realizada');
      } finally { vi.useRealTimers(); }
    });

    it('aterriza según Flightradar24 (lectura «aterrizado»), sin recargar y con localStorage roto: misma transición', async () => {
      fake();
      const broken = () => { throw new DOMException('denegado', 'SecurityError'); };
      vi.stubGlobal('localStorage', { getItem: broken, setItem: broken, removeItem: broken, clear: broken, key: broken, length: 0 });
      try {
        const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
        let releaseRadar;
        const base = app(render);
        await openApp(vi.fn((url, o) => {
          const u = String(url);
          if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); return new Promise(r => { releaseRadar = () => r(json({ state: 'aterrizado', seenS: 30, source: 'fr24' })); }); }
          return base(url, o);
        }));
        await search('FR1526', D);
        await until(() => $('#forecast-area [data-card="turbulence"]') && releaseRadar, 'pronóstico');
        await networkIdle();
        const meteo = meteoCalls().length;
        releaseRadar();
        await until(() => $('#forecast-area').hidden, 'Turbulencias fuera tras el aterrizaje');
        turbGone();
        expect($('#result .status').textContent).toContain('Aterrizado');
        expect(turbEstimate()).toContain('Turbulencias estimadas'); // sin almacenamiento, el de esta sesión
        expect(meteoCalls()).toHaveLength(meteo);
        expect($('#error').hidden).toBe(true);
      } finally { vi.useRealTimers(); }
    });

    // ECMWF/GFS sin datos → cálculo simplificado (v1) dentro de la sección.
    const modelsEmpty = url => {
      const r = openMeteoOk(url);
      if (!url.includes('models=')) return r;
      const body = r.json;
      const strip = x => ({ ...x, hourly: Object.fromEntries(Object.entries(x.hourly).map(([k, v]) => [k, k === 'time' ? v : v.map(() => null)])) });
      return { ...r, json: async () => { const b = await body(); return Array.isArray(b) ? b.map(strip) : strip(b); } };
    };

    it('cálculo simplificado (v1) y Aena LND: su resumen (sin confianza ni porcentajes) en «Turbulencias estimadas»', async () => {
      fake();
      try {
        const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
        await openApp(app(render, null, modelsEmpty));
        await search('FR1526', D);
        await until(() => area().includes('Cálculo simplificado') && $('#forecast-area [data-card="turbulence"]'), 'cálculo simplificado');
        await networkIdle();
        const d = stored()[KEY];
        expect(d).toMatchObject({ headline: 'Tranquilo', verdict: 'tranquilo', maxLevel: 0 });
        expect(d).not.toHaveProperty('confidence');
        expect(d).not.toHaveProperty('percentages');
        const meteo = meteoCalls().length;
        await aena(render, { st: 'LND', sta: 'LND' });
        await until(() => ($('#result .status')?.textContent ?? '').includes('En tierra'), 'En tierra');
        turbGone();
        expect(turbEstimate()).toBe('Turbulencias estimadas Tranquilo No se estimó turbulencia relevante');
        expect(meteoCalls()).toHaveLength(meteo);
      } finally { vi.useRealTimers(); }
    });

    it('cancelado (v2) o desviado (v1) tras un pronóstico: fuera Turbulencias y sin «Turbulencias estimadas»', async () => {
      for (const [flag, openMeteo, status] of [['CAN', openMeteoOk, 'Cancelado'], ['DES', modelsEmpty, 'Desviado']]) {
        fake();
        try {
          localStorage.clear();
          const render = { updated: new Date(T).toISOString(), legs: [flyLeg()] };
          await openApp(app(render, null, openMeteo));
          await search('FR1526', D);
          await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
          await networkIdle();
          expect(stored()[KEY]).toBeTruthy(); // el pronóstico del vuelo existe, pero no describe el vuelo realizado
          await aena(render, { st: flag, sta: flag });
          await until(() => ($('#result .status')?.textContent ?? '').includes(status), status);
          turbGone();
          expect(turbEstimate()).toBeNull();
          expect($('.flight-summary')).toBeNull();
          expect(document.querySelectorAll('#result .disclaimer')).toHaveLength(1); // ni el aviso legal (§5.7)
          expect($('#result').lastElementChild.className).toBe('disclaimer');
        } finally { vi.useRealTimers(); }
      }
    });

    it('abre un vuelo ya terminado: sin resumen guardado, nada (ni Open-Meteo); con él, el de ESE vuelo físico y no el de otro tramo', async () => {
      const dep = Date.now() - 4 * 3600000, arr = dep + 75 * 60000;
      const d = dayOf(dep), sd = formatLocal(dep, MAD), sa = formatLocal(arr, MAD);
      const leg = { d, o: 'PMI', a: 'MAD', sd, ed: `${d}T${sd}`, sa, ea: `${dayOf(arr)}T${sa}`, st: 'LND', std: 'BOR', sta: 'LND', ac: '738W' };
      const other = { ...leg, sd: formatLocal(dep - 3 * 3600000, MAD) }; // el mismo número, otro tramo del día
      const flights = { UX6031: { name: 'Air Europa', updated: new Date().toISOString(), legs: [leg] } };
      await openApp(network({ flights, openMeteo: openMeteoOk }));
      await search('UX6031', d);
      await until(() => $('#result .flight'), 'ficha');
      await networkIdle();
      turbGone();
      expect(turbEstimate()).toBeNull();
      expect(meteoCalls()).toHaveLength(0); // nada calculado a posteriori
      expect($('#map-card .card-title').textContent).toBe('Ruta realizada');

      const at = Date.now() - 5 * 3600000;
      localStorage.setItem(STORE, JSON.stringify({
        [physicalFlightKey(leg)]: { headline: 'Mayormente tranquilo', verdict: 'tranquilo', maxLevel: 1, maxDurationMin: 9, percentages: [90, 10, 0, 0], confidence: 'media', queriedAt: at },
        [physicalFlightKey(other)]: { headline: 'Turbulento', verdict: 'turbulento', maxLevel: 3, maxDurationMin: 20, percentages: [50, 20, 20, 10], confidence: 'alta', queriedAt: at },
      }));
      await openApp(network({ flights, openMeteo: openMeteoOk }));
      await search('UX6031', d);
      await until(() => turbEstimate(), 'Turbulencias estimadas');
      await networkIdle();
      expect(turbEstimate()).toBe('Turbulencias estimadas Mayormente tranquilo Máximo estimado: Ligera · ≈ 10 min');
      turbGone();
      expect(meteoCalls()).toHaveLength(0);
    });
  });
});

// «Actualizar» del MISMO vuelo físico (decisión de 20/10/2026, solo presentación): misma consulta que siempre (Aena,
// radar, pronóstico…), pero la ficha conserva su mapa Leaflet (sin recrearlo, recentrarlo ni cambiar el zoom), sus
// desplegables abiertos y el avión, que se desplaza de la posición A que se ve a la nueva lectura real B.
describe('«Actualizar» conserva el mapa de la ficha y mueve el avión de A a B', () => {
  const A = { ...RADAR_FLYING, hex: 'abc123', seenS: 2, posAgeS: 2, lat: 51.0, lon: -1.0 };
  const B = { ...A, lat: 51.4, lon: -0.6 };
  const flyingLeg = () => {
    const dep = Date.now() - 60 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    return { d, leg: { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: 'A21N' } };
  };
  // Radar: una respuesta por consulta, en orden (null = 404, sin respuesta); la última se repite.
  function app(answers, data, openMeteo = () => tooMany) {
    const base = network({ flights: data, openMeteo });
    let i = 0;
    return vi.fn((url, o) => {
      const u = String(url);
      if (!u.startsWith(`${LIVE_BASE}/radar/`)) return base(url, o);
      calls.push(u);
      const r = answers[Math.min(i++, answers.length - 1)];
      return Promise.resolve(r ? json(r) : notFound);
    });
  }
  // Primera carga con el avión en A: ficha, panel ADS-B, un mapa y el marcador en pantalla.
  async function firstLoad(answers, { openMeteo, data } = {}) {
    const { L, log } = fakeLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    data ??= { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } };
    await openApp(app(answers, data, openMeteo));
    await search('IB715', d);
    await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión en A');
    await networkIdle();
    return { log, data, leg };
  }
  const at = p => [p.lat, p.lon];
  const strictlyBetween = (p, a, b) => p[0] > Math.min(a.lat, b.lat) && p[0] < Math.max(a.lat, b.lat)
    && p[1] > Math.min(a.lon, b.lon) && p[1] < Math.max(a.lon, b.lon);
  const within = (p, a, b) => p[0] >= Math.min(a.lat, b.lat) && p[0] <= Math.max(a.lat, b.lat)
    && p[1] >= Math.min(a.lon, b.lon) && p[1] <= Math.max(a.lon, b.lon);
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
  const refreshed = log => until(() => radarCalls().length === 2 && log.markers.some(m => !m.removed && m.ll[0] === B.lat && m.ll[1] === B.lon), 'el avión en B');

  it('vuelve a consultar el radar una vez por pulsación y ninguna automática después', async () => {
    fake();
    try {
      const { log } = await firstLoad([A, B]);
      expect(radarCalls()).toHaveLength(1);
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(radarCalls()).toHaveLength(2);
      expect(new URL(radarCalls()[1]).searchParams.get('poll')).toBeNull(); // la consulta de siempre, no un sondeo
      await advance(600000);
      expect(radarCalls()).toHaveLength(2); // ningún sondeo nuevo
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('no destruye el mapa ni muestra la pantalla de carga: un solo L.map y ningún remove', async () => {
    fake();
    try {
      const { log } = await firstLoad([A, B]);
      const node = $('#map-card');
      $('#refresh').click();
      expect($('#loading').hidden).toBe(true); // la ficha sigue a la vista mientras se consulta
      expect($('#result-view').hidden).toBe(false);
      await refreshed(log);
      await networkIdle();
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
      expect($('#map-card')).toBe(node); // el mismo nodo, con su mapa, dentro de la ficha nueva
      expect(document.querySelectorAll('#map-card')).toHaveLength(1);
      expect($('#map-card .card-title').textContent).toBe('Radar');
      expect($('#map-facts').textContent).toContain('IBE715');
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('A → B: el MISMO marcador pasa por posiciones intermedias y termina en B', async () => {
    fake();
    try {
      const { log } = await firstLoad([A, B]);
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(log.markers).toHaveLength(1);
      const { path } = log.markers[0];
      expect(path[0]).toEqual(at(A));
      expect(path.at(-1)).toEqual(at(B));
      expect(path.slice(1, -1).filter(p => strictlyBetween(p, A, B)).length).toBeGreaterThan(0);
      expect(path.every(p => within(p, A, B))).toBe(true); // de A a B, nunca más allá de B
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('conserva zoom y centro: ningún fitBounds, setView ni setZoom tras «Actualizar»', async () => {
    fake();
    try {
      const { log } = await firstLoad([A, B]);
      const before = log.view.length;
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(log.view.slice(before)).toEqual([]);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('conserva los desplegables abiertos: Horario, Turbulencias (se repinta con el pronóstico) y Detalles avanzados', async () => {
    fake();
    try {
      // Tras «Actualizar», el radar primero localiza (repinta .flight) y a los 20 s da el aterrizaje (repinta .flight y
      // quita Turbulencias): repintados posteriores reales para comprobar que lo cerrado sigue cerrado.
      await firstLoad([A, { state: 'sin-datos', identifying: true }, { state: 'aterrizado', seenS: 30 }], { openMeteo: openMeteoOk });
      await until(() => $('#forecast-area [data-card="turbulence"]'), 'pronóstico');
      await networkIdle();
      for (const c of ['schedule', 'turbulence', 'advanced']) $(`details[data-card="${c}"]`).open = true;
      const oldArea = $('#forecast-area');
      $('#refresh').click();
      await until(() => radarCalls().length === 2 && $('#forecast-area') !== oldArea && $('#forecast-area [data-card="turbulence"]'), 'Turbulencias repintada');
      await networkIdle();
      for (const c of ['schedule', 'turbulence', 'advanced']) expect($(`details[data-card="${c}"]`).open, c).toBe(true);
      // Ya aplicados: si el usuario cierra uno, el repintado siguiente (otro nodo) no lo vuelve a abrir.
      const schedule = $('details[data-card="schedule"]');
      schedule.open = false;
      await advance(25000);
      await until(() => $('#forecast-area').hidden, 'aterrizaje repintado');
      expect(radarCalls()).toHaveLength(3);
      expect($('details[data-card="turbulence"]')).toBeNull(); // aterrizado: sin tarjeta Turbulencias
      expect($('details[data-card="schedule"]')).not.toBe(schedule);
      expect($('details[data-card="schedule"]').open).toBe(false);
      expect($('details[data-card="advanced"]').open).toBe(true);
    } finally { vi.useRealTimers(); }
  }, 30000);

  // Caduca a los 180 s (ventana de última posición conocida; antes 60 s).
  it('posición anterior caducada (> 180 s): B se coloca directamente, con un marcador nuevo y sin intermedias', async () => {
    fake();
    try {
      const { log } = await firstLoad([{ ...A, posAgeS: 5 }, B]);
      await vi.advanceTimersByTimeAsync(180000);
      expect(planeOnScreen(log)).toBe(false);
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(log.markers).toHaveLength(2);
      expect(log.markers[1].path).toEqual([at(B)]);
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('otro avión (otro transpondedor e indicativo): salto directo a B, sin intermedias', async () => {
    fake();
    try {
      const other = { ...B, hex: 'def456', callsign: 'IBE9XX' };
      const { log } = await firstLoad([A, other]);
      $('#refresh').click();
      await until(() => radarCalls().length === 2 && log.markers[0].ll[0] === B.lat, 'el otro avión en B');
      await networkIdle();
      expect(log.markers).toHaveLength(1);
      expect(log.markers[0].path).toEqual([at(A), at(B)]);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('«Actualizar» que lleva a OTRO vuelo físico (otro tramo): el mapa se destruye y se crea otro, como siempre', async () => {
    fake();
    try {
      const { log, data, leg } = await firstLoad([A, B]);
      const sd = formatLocal(Date.now() - 50 * 60000, MAD); // otra hora de salida: otro vuelo físico
      data.IB715 = { ...data.IB715, legs: [{ ...leg, sd, ed: `${leg.d}T${sd}` }] };
      $('#refresh').click();
      await until(() => log.maps === 2, 'segundo mapa');
      await networkIdle();
      expect(log.mapsRemoved).toBe(1);
      expect(document.querySelectorAll('#map-card')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('sin posición nueva (la misma lectura): el marcador ni se mueve ni se recrea', async () => {
    fake();
    try {
      const { log } = await firstLoad([A, A]);
      $('#refresh').click();
      await until(() => radarCalls().length === 2, 'segunda consulta al radar');
      await networkIdle();
      expect(log.markers).toHaveLength(1);
      expect(log.markers[0].path).toEqual([at(A)]);
      expect(planeOnScreen(log)).toBe(true);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('el radar no responde: el avión anterior se queda mientras su posición siga vigente y se quita al caducar', async () => {
    fake();
    try {
      const { log } = await firstLoad([{ ...A, posAgeS: 5 }, null]);
      $('#refresh').click();
      await until(() => radarCalls().length === 2, 'segunda consulta al radar');
      await networkIdle();
      expect(log.maps).toBe(1);
      expect(log.markers).toHaveLength(1);
      expect(log.markers[0].path).toEqual([at(A)]);
      expect(planeOnScreen(log)).toBe(true);
      await vi.advanceTimersByTimeAsync(60000); // la posición A pasa de 60 s: última posición conocida, atenuada
      expect(planeDimmed(log)).toBe(true);
      expect(log.markers[0].path).toEqual([at(A)]); // quieta, exactamente donde estaba
      await vi.advanceTimersByTimeAsync(120000); // pasa de 180 s
      expect(planeOnScreen(log)).toBe(false);
      expect(log.maps).toBe(1); // se quita el avión, no el mapa
      expect(log.mapsRemoved).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('dos pulsaciones seguidas (la segunda antes de que se monte la primera): el mismo mapa, sin recrearlo ni tocar la vista', async () => {
    fake();
    try {
      // Las fotos de aerolínea fallan en la primera carga (no se guardan) y en la segunda quedan en espera: la primera
      // «Actualizar» se queda en buildFlight con el mapa conservado aún sin montar mientras llega la segunda.
      const { L, log } = fakeLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      const base = app([A, B, B], { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } });
      let photos = 0, release;
      await openApp(vi.fn((url, o) => {
        if (String(url) !== 'data/airline-photos.json') return base(url, o);
        calls.push(String(url));
        if (photos++ === 0) return Promise.reject(new TypeError('fallo'));
        return new Promise(r => { release = () => r(json({})); });
      }));
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión en A');
      await networkIdle();
      const views = log.view.length;
      $('#refresh').click();
      await until(() => release, 'primera «Actualizar» esperando en buildFlight');
      $('#refresh').click();
      await networkIdle();
      release();
      await refreshed(log);
      await networkIdle();
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
      expect(log.view.slice(views)).toEqual([]);
      expect(log.markers).toHaveLength(1); // el mismo avión, de A a B
      expect(document.querySelectorAll('#map-card')).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  // Flightradar24 (server/fr24-radar.mjs): la identidad del avión es su fr24Id (luego hex o indicativo).
  const FA = { ...A, source: 'fr24', match: 'fr24', fr24Id: '3c4d5e6f', hex: '3423C1', callsign: 'IBE715' };
  const FB = { ...FA, lat: B.lat, lon: B.lon };
  it('FR24: «Actualizar» del mismo vuelo (mismo fr24Id) conserva el mapa y anima entre dos posiciones reales', async () => {
    fake();
    try {
      const { log } = await firstLoad([FA, FB]);
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
      expect(log.markers).toHaveLength(1);
      const { path } = log.markers[0];
      expect(path[0]).toEqual(at(FA));
      expect(path.at(-1)).toEqual(at(FB));
      expect(path.slice(1, -1).filter(p => strictlyBetween(p, FA, FB)).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('FR24: cambio de fr24Id (mismo hex e indicativo) → el avión se coloca directamente en B, sin animar', async () => {
    fake();
    try {
      const { log } = await firstLoad([FA, { ...FB, fr24Id: '7a8b9c0d', fr24IdChanged: true }]);
      $('#refresh').click();
      await refreshed(log);
      await networkIdle();
      expect(log.markers).toHaveLength(1);
      expect(log.markers[0].path).toEqual([at(FA), at(FB)]);
    } finally { vi.useRealTimers(); }
  }, 30000);
});

// Estela real del vuelo (FR24 Flight Tracks, server/fr24-track.mjs): con un fr24Id en la lectura del radar del vuelo en
// pantalla, la app pide UNA vez /track (Aena) o /track-adb (AeroDataBox) con el mismo ?leg= y la pinta; cada posición
// real nueva del mismo avión la prolonga. «Actualizar» no la vuelve a pedir; otro fr24Id la reinicia. Sin estela (no
// encontrada, no disponible, sin FR24), la ruta prevista sigue como siempre.
describe('estela real del vuelo en el mapa (FR24 Flight Tracks)', () => {
  function trackLeaflet() {
    const log = { maps: 0, mapsRemoved: 0, markers: [], view: [], lines: [] };
    const layer = () => ({ addTo() { return this; }, bindTooltip() { return this; }, remove() {} });
    const L = {
      map: () => { log.maps++; return { fitBounds() { log.view.push('fitBounds'); }, setView() { log.view.push('setView'); }, setZoom() { log.view.push('setZoom'); },
        invalidateSize() {}, remove() { log.mapsRemoved++; } }; },
      tileLayer: layer, polygon: layer, circleMarker: layer,
      polyline: (coords, o = {}) => ({ coords, o, live: false, addTo() { this.live = true; log.lines.push(this); return this; }, bindTooltip() { return this; },
        remove() { this.live = false; }, setLatLngs(c) { this.coords = c; return this; }, bringToFront() { return this; } }),
      latLngBounds: () => ({ pad() { return this; } }),
      divIcon: o => o,
      marker: ll => {
        const cls = new Set();
        const rot = { style: {}, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) } };
        const m = { ...layer(), ll, path: [ll], removed: false, rot, cls, setLatLng(p) { this.ll = p; this.path.push(p); return this; }, remove() { this.removed = true; },
          getElement() { return { querySelector: () => rot }; } };
        log.markers.push(m); return m; },
    };
    return { L, log };
  }
  const trails = log => log.lines.filter(l => l.live && !l.o.dashArray);
  const trackCalls = () => calls.filter(u => u.includes('/track/') || u.includes('/track-adb/'));
  const flyingLeg = () => {
    const dep = Date.now() - 60 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    return { d, leg: { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: 'A21N' } };
  };
  const FA = { ...RADAR_FLYING, source: 'fr24', match: 'fr24', fr24Id: '3c4d5e6f', hex: '3423C1', seenS: 2, posAgeS: 2, lat: 51.0, lon: -1.0 };
  const FB = { ...FA, lat: 51.4, lon: -0.6 };
  // Estela de FR24 hasta «ahora» (el último punto, más reciente que la posición del avión, no debe dibujarse).
  const track = (id = '3c4d5e6f', over = {}) => {
    const s = Math.floor(Date.now() / 1000);
    return { state: 'found', fr24Id: id, source: 'fr24', points: [[40.47, -3.56], [45, -2], [50.9, -1.1], [51.05, -0.95]],
      times: [s - 3000, s - 1500, s - 60, s + 25], lastAt: new Date((s + 25) * 1000).toISOString(), ...over };
  };
  // Radar: una respuesta por consulta (la última se repite); tracks: una por petición a /track (null = 404). Cada una puede
  // ser una función (p. ej. una promesa retenida). Como el servidor, el radar lleva siempre `checked` (su hora).
  // leg: otro tramo de Aena; photos: respuesta de las fotos de aerolínea a partir de la 2.ª (para retener «Actualizar»).
  async function load({ radar, tracks = [track()], openMeteo = () => tooMany, leg: legOver = null, photos = null }) {
    const { L, log } = trackLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = legOver ?? flyingLeg();
    const base = network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo });
    let i = 0, j = 0, p = 0;
    const answer = async a => { const r = typeof a === 'function' ? await a() : a; return r ? json(r.checked ? r : { ...r, checked: new Date().toISOString() }) : notFound; };
    await openApp(vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); return answer(radar[Math.min(i++, radar.length - 1)]); }
      if (u.startsWith(`${LIVE_BASE}/track/`)) { calls.push(u); return answer(tracks[Math.min(j++, tracks.length - 1)]); }
      // Las fotos fallan en la primera carga (no se guardan) y en la segunda responden con photos() (p. ej. retenidas).
      if (photos && u === 'data/airline-photos.json') { calls.push(u); return p++ === 0 ? Promise.reject(new TypeError('fallo')) : photos(); }
      return base(url, o);
    }));
    await search('IB715', d);
    await until(() => $('#result .flight') && log.maps === 1, 'ficha con mapa');
    await networkIdle();
    return { log, leg };
  }
  const held = () => { let release; const promise = new Promise(r => { release = r; }); return { get: () => promise, release: v => release(v) }; };
  const refresh = async log => { const n = radarCalls().length; $('#refresh').click(); await until(() => radarCalls().length === n + 1, 'radar de nuevo'); await networkIdle(); return log; };

  it('1) fr24Id + estela → pide /track UNA vez con el ?leg= del vuelo físico y dibuja la estela real, que acaba en el avión', async () => {
    const { log, leg } = await load({ radar: [FA] });
    expect(trackCalls()).toEqual([`${LIVE_BASE}/track/IB/715.json?leg=${encodeURIComponent(physicalFlightKey(leg))}`]);
    const [l] = trails(log);
    expect(l.o.color).toBe('#1A6FE0');
    // Los puntos reales hasta la posición del avión (el de «ahora» es posterior: fuera) y el avión como último vértice.
    expect(l.coords).toEqual([[40.47, -3.56], [45, -2], [50.9, -1.1], [51, -1]]);
    expect(log.lines.filter(x => x.live && x.o.dashArray).length).toBeGreaterThan(0); // la ruta prevista sigue (discontinua)
  });

  it('2) sin fr24Id (lectura de adsb.lol) → ninguna petición a Flight Tracks ni estela', async () => {
    const { log } = await load({ radar: [{ ...RADAR_FLYING, hex: 'abc123', posAgeS: 2, lat: 51, lon: -1 }] });
    expect(trackCalls()).toEqual([]);
    expect(trails(log)).toEqual([]);
  });

  it('4) 9) dos «Actualizar» seguidos: ni otro /track ni otro mapa; 6) la nueva posición real prolonga la estela hasta B', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
    try {
      const { log } = await load({ radar: [FA, FB, FB] });
      await refresh(log);
      const atB = () => trails(log)[0]?.coords.at(-1)?.[0] === 51.4 && log.markers[0]?.ll[0] === 51.4;
      await until(atB, 'la animación A → B termina'); // requestAnimationFrame de jsdom: tiempo real
      await refresh(log);
      expect(trackCalls()).toHaveLength(1);
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
      expect(log.view.filter(v => v !== 'fitBounds')).toEqual([]);
      expect(log.view).toHaveLength(1); // solo el encuadre inicial
      const [l] = trails(log);
      expect(trails(log)).toHaveLength(1);
      expect(l.coords.at(-1)).toEqual([51.4, -0.6]);
      expect(l.coords.at(-2)).toEqual([51, -1]); // A quedó como vértice real
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('5) cambio de fr24Id: la estela anterior se borra y se pide la del nuevo avión', async () => {
    const other = { ...FB, fr24Id: '7a8b9c0d', fr24IdChanged: true };
    const { log } = await load({ radar: [FA, other], tracks: [track(), track('7a8b9c0d', { points: [[48, -2], [51.3, -0.7], [51.35, -0.65], [51.4, -0.6]] })] });
    const first = trails(log)[0];
    await refresh(log);
    await until(() => trackCalls().length === 2 && trails(log)[0] !== first, 'estela nueva');
    expect(first.live).toBe(false);
    expect(trails(log)).toHaveLength(1);
    expect(trails(log)[0].coords[0]).toEqual([48, -2]);
  });

  it('una estela de OTRO fr24Id que el de la lectura (respuesta cruzada) no se dibuja', async () => {
    const { log } = await load({ radar: [FA], tracks: [track('ffff0000')] });
    expect(trackCalls()).toHaveLength(1);
    expect(trails(log)).toEqual([]);
  });

  it('8) aterrizado según FR24 con fr24Id: «Ruta realizada» con la trayectoria entera, sin avión', async () => {
    const { log } = await load({ radar: [{ state: 'aterrizado', callsign: 'IBE715', seenS: 30, distanceKm: 2, source: 'fr24', fr24Id: '3c4d5e6f' }] });
    await until(() => trails(log).length === 1, 'estela');
    expect($('#map-card .card-title').textContent).toBe('Ruta realizada');
    expect(trails(log)[0].coords).toEqual(track().points);
    expect(planeOnScreen(log)).toBe(false);
  });

  it('18) /track no disponible (o 404): sin estela y la ficha y la ruta prevista siguen igual; «Actualizar» lo reintenta una vez', async () => {
    const { log } = await load({ radar: [FA, FB], tracks: [{ state: 'unavailable', source: 'fr24' }, null] });
    expect(trails(log)).toEqual([]);
    expect($('#error').hidden).toBe(true);
    expect($('.telemetry')).not.toBeNull();
    expect(log.lines.some(l => l.live && l.o.dashArray)).toBe(true);
    await refresh(log);
    expect(trackCalls()).toHaveLength(2);
    expect(trails(log)).toEqual([]);
  });

  it('AeroDataBox: /track-adb con el mismo ?leg= que /radar-adb', async () => {
    const fmt = (ms, offH) => { const t = new Date(ms + offH * 3600000).toISOString(); return `${t.slice(0, 10)} ${t.slice(11, 16)}${offH >= 0 ? '+' : '-'}${String(Math.abs(offH)).padStart(2, '0')}:00`; };
    const utc = ms => `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)}Z`;
    const dep = Math.floor((Date.now() - 2 * 3600000) / 60000) * 60000, arr = dep + 12 * 3600000;
    const d = fmt(dep, 2).slice(0, 10);
    const raw = { number: 'GA 89', callSign: 'GIA89', status: 'EnRoute', codeshareStatus: 'IsOperator', airline: { name: 'Garuda Indonesia' },
      departure: { airport: { iata: 'AMS' }, scheduledTime: { utc: utc(dep), local: fmt(dep, 2) } },
      arrival: { airport: { iata: 'CGK' }, scheduledTime: { utc: utc(arr), local: fmt(arr, 7) } }, aircraft: { model: 'Boeing 777' } };
    const entry = { status: 'found', source: 'aerodatabox', number: 'GA89', date: d, fetchedAt: new Date().toISOString(), legs: normalizeFlights([raw]) };
    const { L, log } = trackLeaflet();
    vi.stubGlobal('L', L);
    const base = network({ flights: {}, schedule: { [`GA89|${d}`]: entry }, openMeteo: () => tooMany,
      radarAdb: () => ({ ...FA, callsign: 'GIA89', fr24Id: '4a4a4a4a', lat: 45.1, lon: 40.2, checked: new Date().toISOString() }) });
    await openApp(vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/track-adb/`)) { calls.push(u); return Promise.resolve(json(track('4a4a4a4a', { points: [[52.3, 4.76], [45, 39], [45.05, 40.1], [45.1, 40.2]] }))); }
      return base(url, o);
    }));
    await search('GA89', d);
    await until(() => trails(log).length === 1, 'estela de AeroDataBox');
    const legKey = new URL(calls.find(u => u.includes('/radar-adb/'))).searchParams.get('leg');
    expect(trackCalls()).toEqual([`${LIVE_BASE}/track-adb/GA89/${d}.json?leg=${encodeURIComponent(legKey)}`]);
    expect(calls.some(u => u.includes('/track/'))).toBe(false);
  });
  // Ronda de corrección 1: «Actualizar» con /track en curso, reloj del móvil desfasado, estela durante A → B, ruta
  // realizada de un vuelo aterrizado hace horas y lecturas que no deben tocar la estela.
  const S = () => Math.floor(Date.now() / 1000) * 1000; // hora del «servidor», en segundos enteros
  it('«Actualizar» con /track retenida y liberada tras clearFicha (ficha nula, mapa en traspaso) → la estela se pinta, 1 sola petición', async () => {
    const t = held(), photosHeld = held();
    const s0 = S();
    const fa = { ...FA, checked: new Date(s0).toISOString() };
    const { log } = await load({ radar: [fa, fa], tracks: [t.get], photos: photosHeld.get });
    expect(trackCalls()).toHaveLength(1);
    $('#refresh').click();
    await until(() => calls.filter(u => u === 'data/airline-photos.json').length === 2, '«Actualizar» retenida en buildFlight');
    t.release(track('3c4d5e6f', { times: [s0 / 1000 - 3000, s0 / 1000 - 1500, s0 / 1000 - 60, s0 / 1000 + 25] }));
    await new Promise(r => setTimeout(r, 50));
    expect(trails(log)).toHaveLength(1); // pintada en el mapa conservado, con la ficha aún en traspaso
    photosHeld.release(json({}));
    await until(() => trails(log).length === 1 && radarCalls().length === 2, 'estela pintada tras «Actualizar»');
    await networkIdle();
    expect(trackCalls()).toHaveLength(1);
    expect(log.maps).toBe(1);
    expect(trails(log)[0].coords).toEqual([[40.47, -3.56], [45, -2], [50.9, -1.1], [51, -1]]);
  });

  it.each([['+5 min', 5], ['−5 min', -5]])('reloj del móvil desfasado %s: el corte de la estela usa solo horas del servidor', async (_label, offMin) => {
    const s0 = S();
    const fa = { ...FA, checked: new Date(s0).toISOString() }; // posición de s0 − 2 s
    // Un punto 1 s DESPUÉS de la posición del avión (fuera) y otro 60 s antes (dentro).
    const tr = track('3c4d5e6f', { times: [s0 / 1000 - 3000, s0 / 1000 - 1500, s0 / 1000 - 60, s0 / 1000 - 1] });
    vi.useFakeTimers({ toFake: ['Date'], now: s0 + offMin * 60000, shouldAdvanceTime: true });
    try {
      const { log } = await load({ radar: [fa], tracks: [tr] });
      await until(() => trails(log).length === 1, 'estela');
      // RELOJ 27–28 (antes, +5 min envejecía la posición para el móvil y quitaba el avión): la antigüedad es la del
      // servidor más el reloj monotónico, así que el avión está en los dos casos, fresco, y la estela acaba en él y deja
      // fuera el punto posterior a su posición (horas del servidor).
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
      expect(trails(log)[0].coords).toEqual([[40.47, -3.56], [45, -2], [50.9, -1.1], [51, -1]]);
    } finally { vi.useRealTimers(); }
  });

  it('10) la estela llega mientras el avión se desplaza de A a B: nada por delante del avión (límite = hora de A) y acaba en B', async () => {
    const t = held();
    const s0 = S();
    const fa = { ...FA, checked: new Date(s0).toISOString() }; // A: s0 − 2 s
    const fb = { ...FB, checked: new Date(s0 + 30000).toISOString() }; // B: s0 + 28 s (hora del servidor)
    const { log } = await load({ radar: [fa, fb], tracks: [t.get] });
    $('#refresh').click();
    await until(() => radarCalls().length === 2 && log.markers[0].path.length > 2 && log.markers[0].ll[0] < FB.lat, 'avión desplazándose');
    const between = [51.2, -0.8];
    t.release(track('3c4d5e6f', { points: [[40.47, -3.56], [45, -2], [50.9, -1.1], between, [51.6, -0.4]],
      times: [s0 / 1000 - 3000, s0 / 1000 - 1500, s0 / 1000 - 60, s0 / 1000 + 10, s0 / 1000 + 40] }));
    await until(() => trails(log).length === 1, 'estela');
    const [l] = trails(log);
    const mid = l.coords;
    expect(mid.slice(0, 3)).toEqual([[40.47, -3.56], [45, -2], [50.9, -1.1]]);
    expect(mid.some(c => c[0] === between[0] || c[0] === 51.6)).toBe(false);
    expect(mid.at(-1)).toEqual(log.markers[0].ll); // la cabeza es el avión que se ve
    await until(() => log.markers[0].ll[0] === FB.lat, 'avión en B');
    expect(l.coords.at(-1)).toEqual([51.4, -0.6]);
    expect(l.coords.some(c => c[0] === 51.6)).toBe(false);
    expect(trackCalls()).toHaveLength(1);
  });

  it('«Actualizar» sin lectura nueva aún (avión retenido): la estela se corta en la lectura que lo puso, no se pinta entera', async () => {
    const t = held(), r2 = held();
    const s0 = S();
    const fa = { ...FA, checked: new Date(s0).toISOString() };
    const { log } = await load({ radar: [fa, r2.get], tracks: [t.get] });
    $('#refresh').click();
    await until(() => radarCalls().length === 2, 'radar retenido');
    await networkIdle();
    t.release(track('3c4d5e6f', { times: [s0 / 1000 - 3000, s0 / 1000 - 1500, s0 / 1000 - 60, s0 / 1000 + 5] }));
    await until(() => trails(log).length === 1, 'estela');
    expect(trails(log)[0].coords).toEqual([[40.47, -3.56], [45, -2], [50.9, -1.1], [51, -1]]);
    r2.release(fa);
    await networkIdle();
  });

  it('una lectura estimada o «reciente» (sin posición) no prolonga ni borra la estela', async () => {
    const est = { state: 'sin-datos', fr24Estimated: true, fr24Id: '3c4d5e6f', source: 'fr24' };
    const { log } = await load({ radar: [FA, est, { state: 'sin-datos', source: 'fr24' }] });
    await until(() => trails(log).length === 1, 'estela');
    const [l] = trails(log);
    const before = JSON.stringify(l.coords);
    await refresh(log);
    await refresh(log);
    expect(trails(log)).toEqual([l]);
    expect(JSON.stringify(l.coords)).toBe(before); // la misma trayectoria real, sin puntos nuevos ni borrada
    expect(trackCalls()).toHaveLength(1);
  });

  it('aterrizado hace 3 h (Aena), sin fr24Id en la ficha: pide /track UNA vez y pinta la ruta realizada con el fr24Id de la respuesta', async () => {
    const dep = Date.now() - 5 * 3600000, arr = dep + 2 * 3600000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD), sa = formatLocal(arr, 'Europe/London');
    const leg = { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, sa, ea: `${dayOf(arr)}T${sa}`, st: 'LND', std: 'BOR', sta: 'LND', ac: 'A21N' };
    const { log } = await load({ leg: { d, leg }, radar: [null], tracks: [track('9f9f9f9f')] });
    await until(() => trails(log).length === 1, 'ruta realizada');
    expect(radarCalls()).toEqual([]);
    expect(trackCalls()).toEqual([`${LIVE_BASE}/track/IB/715.json?leg=${encodeURIComponent(physicalFlightKey(leg))}`]);
    expect(trails(log)[0].coords).toEqual(track().points);
    expect($('#map-card .card-title').textContent).toBe('Ruta realizada');
    expect(planeOnScreen(log)).toBe(false);
    await networkIdle();
    expect(trackCalls()).toHaveLength(1);
  });

  it('aterrizado sin asociación en el servidor (no-aplica): sin estela y una sola petición', async () => {
    const dep = Date.now() - 5 * 3600000, arr = dep + 2 * 3600000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD), sa = formatLocal(arr, 'Europe/London');
    const leg = { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, sa, ea: `${dayOf(arr)}T${sa}`, st: 'LND', std: 'BOR', sta: 'LND', ac: 'A21N' };
    const { log } = await load({ leg: { d, leg }, radar: [null], tracks: [{ state: 'no-aplica', source: 'fr24' }] });
    await networkIdle();
    expect(trackCalls()).toHaveLength(1);
    expect(trails(log)).toEqual([]);
  });

  it.each([['cancelado', { st: 'CAN', std: 'CAN' }], ['desviado', { sta: 'DES', st: 'DES', std: 'BOR' }]])('%s: ninguna petición de estela', async (_n, flags) => {
    const dep = Date.now() - 5 * 3600000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    const leg = { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, ac: 'A21N', ...flags };
    const { log } = await load({ leg: { d, leg }, radar: [null] });
    await networkIdle();
    expect(log.maps).toBe(1);
    expect(trackCalls()).toEqual([]);
  });
});


// Seguimiento en vivo con Flightradar24 (js/live-tracker.js; decisión del controlador, 21/10/2026): con la ficha de un
// vuelo «volando» según FR24, la app vuelve a pedir EL MISMO /radar cada 45 s y lo pinta por el camino de siempre. Un solo
// seguidor por ficha; se para con otra búsqueda, «Nueva consulta», aterrizado, Aena final, 401/403; pestaña oculta → cero
// peticiones; un fallo no se pinta (la última posición real se queda quieta y caduca a los 180 s). Reloj y temporizadores
// simulados (performance incluido: la antigüedad usa el reloj monotónico).
describe('seguimiento en vivo con Flightradar24', () => {
  function liveLeaflet() {
    const log = { maps: 0, mapsRemoved: 0, markers: [], view: [], lines: [] };
    const layer = () => ({ addTo() { return this; }, bindTooltip() { return this; }, remove() {} });
    const L = {
      map: () => { log.maps++; return { fitBounds() { log.view.push('fitBounds'); }, setView() { log.view.push('setView'); }, setZoom() { log.view.push('setZoom'); },
        invalidateSize() {}, remove() { log.mapsRemoved++; } }; },
      tileLayer: layer, polygon: layer, circleMarker: layer,
      polyline: (coords, o = {}) => ({ coords, o, live: false, addTo() { this.live = true; log.lines.push(this); return this; }, bindTooltip() { return this; },
        remove() { this.live = false; }, setLatLngs(c) { this.coords = c; return this; }, bringToFront() { return this; } }),
      latLngBounds: () => ({ pad() { return this; } }),
      divIcon: o => o,
      marker: ll => {
        const cls = new Set();
        const rot = { style: {}, classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) } };
        const m = { ...layer(), ll, path: [ll], removed: false, rot, cls, setLatLng(p) { this.ll = p; this.path.push(p); return this; }, remove() { this.removed = true; },
          getElement() { return { querySelector: () => rot }; } };
        log.markers.push(m);
        return m;
      },
    };
    return { L, log };
  }
  const trails = log => log.lines.filter(l => l.live && !l.o.dashArray);
  const trackCalls = () => calls.filter(u => u.includes('/track/'));
  const deg = m => { const tr = m.rot.style.transform; return tr ? Number(tr.match(/rotate\((-?[\d.]+)deg\)/)[1]) : null; };
  const flyingLeg = () => {
    const dep = Date.now() - 60 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD);
    return { d, leg: { d, o: 'MAD', a: 'LHR', sd, ed: `${d}T${sd}`, st: 'BOR', std: 'BOR', ac: 'A21N' } };
  };
  // Lectura de FR24 tal como la sirve el servidor en el instante de la petición k: posición de hace 2 s y `checked` con
  // la hora DEL SERVIDOR (skewMs: cuánto adelanta el reloj del móvil al del servidor).
  let skewMs = 0;
  const reading = (k, over = {}) => ({ state: 'volando', source: 'fr24', match: 'fr24', fr24Id: '3c4d5e6f', hex: '3423C1', callsign: 'IBE715',
    altM: 10668, altFt: 35000, kmh: 830, vRateFpm: 0, seenS: 2, posAgeS: 2, lat: 51 + 0.1 * k, lon: -1 + 0.1 * k, track: 45, remainingKm: 300 - 10 * k,
    checked: new Date(Date.now() - skewMs).toISOString(), ...over });
  const track = () => {
    const s = Math.floor((Date.now() - skewMs) / 1000);
    return { state: 'found', fr24Id: '3c4d5e6f', source: 'fr24', points: [[40.47, -3.56], [45, -2], [50.9, -1.1]], times: [s - 3000, s - 1500, s - 60],
      lastAt: new Date((s - 60) * 1000).toISOString() };
  };
  // radar(k): la respuesta a la k-ésima petición a /radar (null = 404, sin respuesta). render: refresco de Aena opcional.
  async function load({ radar = k => reading(k), render = null, extraFlights = {}, openMeteo = () => tooMany } = {}) {
    const { L, log } = liveLeaflet();
    vi.stubGlobal('L', L);
    const { d, leg } = flyingLeg();
    const base = network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] }, ...extraFlights }, openMeteo });
    let k = 0;
    await openApp(vi.fn((url, o) => {
      const u = String(url);
      if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); const r = radar(k++); return Promise.resolve(r ? json(r) : notFound); }
      if (u.startsWith(`${LIVE_BASE}/track/`)) { calls.push(u); return Promise.resolve(json(track())); }
      if (render && u.startsWith(`${LIVE_BASE}/flights/`)) { calls.push(u); return Promise.resolve(json({ name: 'Iberia', updated: render.updated, legs: render.legs })); }
      return base(url, o);
    }));
    await search('IB715', d);
    await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión');
    await networkIdle();
    return { log, leg, d };
  }
  const radarCalls = () => calls.filter(u => u.includes('/radar/'));
  const fakeAll = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], shouldAdvanceTime: true });
  // Avanza el reloj simulado justo hasta `ms` después de la PRIMERA respuesta del radar (t0).
  let t0 = 0;
  const mark = () => { t0 = performance.now(); };
  const to = async s => { const ms = t0 + s * 1000 - performance.now(); if (ms > 0) await vi.advanceTimersByTimeAsync(ms); await networkIdle(); };
  beforeEach(() => { skewMs = 0; });

  it('LIVE 8) 30) volando con FR24 → el MISMO /radar (mismo ?leg=, sin ?poll) cada 45 s; Flight Tracks una sola vez', async () => {
    fakeAll();
    try {
      const { log } = await load();
      mark();
      const meteo = calls.filter(u => u.includes('open-meteo')).length;
      expect(radarCalls()).toHaveLength(1);
      await to(44);
      expect(radarCalls()).toHaveLength(1);
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      expect(radarCalls()[1]).toBe(radarCalls()[0]); // exactamente la misma consulta
      expect(new URL(radarCalls()[1]).searchParams.get('poll')).toBeNull();
      await to(137);
      expect(radarCalls()).toHaveLength(4);
      expect(trackCalls()).toHaveLength(1); // CRÉDITOS 30: la estela no se vuelve a pedir
      expect(calls.filter(u => u.includes('open-meteo'))).toHaveLength(meteo); // sin meteorología en el seguimiento
      expect(log.maps).toBe(1);
      expect(log.mapsRemoved).toBe(0);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('«Ahora» en Turbulencias: aparece con la posición real, la sigue con cada lectura de 45 s sin pedir nada y se quita cuando la posición caduca', async () => {
    fakeAll();
    try {
      // Lecturas 0 y 1 con posición; desde la 2, «volando» sin posición ni distancia (FR24 la pierde).
      const { log } = await load({ openMeteo: openMeteoOk, radar: k => (k < 2 ? reading(k) : reading(k, { lat: undefined, lon: undefined, posAgeS: undefined, remainingKm: undefined })) });
      mark();
      await until(() => $('#turb-now') && !$('#turb-now').hidden, '«Ahora»');
      await networkIdle();
      const now = () => [...document.querySelectorAll('#turb-now .k, #turb-now .v, #turb-now .turb-now-next')].map(e => e.textContent).join(' | ');
      const x = () => parseFloat($('#timeline').style.getPropertyValue('--now-x'));
      expect(now()).toContain('Ahora | Tranquilo'); // pronóstico en calma: nivel 0 del tramo, y en texto
      expect(now()).toContain('Resto del vuelo: Sin cambios relevantes previstos');
      expect($('#timeline .tchart .tnow').getAttribute('aria-hidden')).toBe('true'); // el marcador es decorativo
      const mark0 = $('#timeline .tnow'), x0 = x();
      expect(x0).toBeGreaterThan(50); // (51, −1): casi en Londres, en la segunda mitad del vuelo
      expect(x0).toBeLessThan(100);
      const meteo = calls.filter(u => u.includes('open-meteo')).length, radar = radarCalls().length;
      await to(46); // la lectura del ciclo siguiente (B), sin ninguna petición más
      await until(() => x() > x0, 'el marcador avanza');
      expect($('#timeline .tnow')).toBe(mark0); // el mismo nodo: se desplaza (transición CSS), no se recrea
      expect(radarCalls()).toHaveLength(radar + 1); // solo la lectura de siempre de los 45 s
      expect(calls.filter(u => u.includes('open-meteo'))).toHaveLength(meteo);
      const x1 = x();
      await to(46 + 120); // lecturas sin posición: se queda la última real (≤ 180 s), quieta
      expect($('#turb-now').hidden).toBe(false);
      expect(x()).toBe(x1);
      await to(46 + 185); // la posición de B ya no vale: fuera «Ahora» (la tarjeta sigue igual)
      expect($('#turb-now').hidden).toBe(true);
      expect($('#timeline .tnow')).toBeNull();
      expect($('#forecast-area [data-card="turbulence"] .tchart')).not.toBeNull();
      expect(calls.filter(u => u.includes('open-meteo'))).toHaveLength(meteo);
      expect(log.maps).toBe(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('Calm Score: aparece con el pronóstico, sigue igual (y abierto) con cada lectura del radar y no pide nada', async () => {
    fakeAll();
    try {
      await load({ openMeteo: openMeteoOk });
      mark();
      await until(() => $('.hero-status .calm'), 'Calm Score');
      await networkIdle();
      const calm = () => [...document.querySelectorAll('.hero-status .calm-num, .hero-status .calm-label')].map(e => e.textContent).join(' ');
      expect(calm()).toBe('100 Calm Score'); // pronóstico en calma (titular «Tranquilo»)
      expect($('.hero-status .calm .sr-only').textContent).toContain('de 100');
      expect($('.hero-status .calm-info').textContent).toContain('No es una probabilidad');
      $('.hero-status details.calm').open = true;
      const meteo = calls.filter(u => u.includes('open-meteo')).length, radar = radarCalls().length, before = $('.flight');
      await to(46); // lectura nueva: la ficha se repinta entera
      await until(() => $('.flight') !== before, 'ficha repintada');
      expect(calm()).toBe('100 Calm Score');
      expect($('.hero-status details.calm').open).toBe(true); // el desplegable sigue como estaba
      expect(radarCalls()).toHaveLength(radar + 1);
      expect(calls.filter(u => u.includes('open-meteo'))).toHaveLength(meteo); // ni el número ni el repintado piden nada
      expect($('#turb-now').hidden).toBe(false); // «Ahora» sigue ahí
      // «Actualizar» del mismo vuelo: el número no desaparece ni un instante mientras llega el pronóstico nuevo.
      let missing = 0;
      const mo = new MutationObserver(() => { if ($('.flight .hero-status') && !$('.flight .hero-status .calm')) missing++; });
      mo.observe($('#result'), { childList: true, subtree: true });
      const oldArea = $('#forecast-area');
      $('#refresh').click();
      await until(() => $('#forecast-area') !== oldArea && $('#forecast-area [data-card="turbulence"]'), 'pronóstico repintado');
      await networkIdle();
      mo.disconnect();
      expect(missing).toBe(0);
      expect(calm()).toBe('100 Calm Score');
      expect($('.hero-status details.calm').open).toBe(true); // y abierto, como estaba
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('LIVE 9) 10) 11) cada lectura nueva antes de caducar: el avión sigue fresco más allá de 60 s, va de A a B y la estela llega hasta B', async () => {
    fakeAll();
    try {
      const { log } = await load();
      mark();
      await until(() => trails(log).length === 1, 'estela');
      await to(46);
      const B = reading(1);
      await until(() => log.markers[0].ll[0] === B.lat && log.markers[0].ll[1] === B.lon, 'el avión en B');
      const { path } = log.markers[0];
      expect(log.markers).toHaveLength(1); // el mismo marcador, sin recrearlo
      expect(path.some(p => p[0] > 51 && p[0] < B.lat)).toBe(true); // pasa por posiciones intermedias (A → B animado)
      expect(trails(log)[0].coords.at(-1)).toEqual([B.lat, B.lon]); // la estela, prolongada hasta B
      await to(140); // 3 ciclos: más de 60 s desde la primera lectura
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false); // siempre una lectura fresca: nunca atenuado
      expect($('[data-signal-level="live"]')).not.toBeNull();
      expect(trackCalls()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('ORIENTACIÓN: el icono sigue el track real de FR24 desde la primera posición y en cada lectura', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => reading(k, { track: k === 0 ? 270 : 300 }) });
      mark();
      expect(Math.abs(deg(log.markers[0]))).toBe(180); // oeste, ya al colocarlo
      await to(46);
      await until(() => ((deg(log.markers[0]) % 360) + 360) % 360 === 210, 'rumbo 300');
      expect(deg(log.markers[0])).toBe(-150); // de −180 a −150: 30° por el camino corto
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('LIVE 12) 13) los repintados y «Actualizar» no crean otro seguidor: una sola cadencia, reprogramada tras «Actualizar»', async () => {
    fakeAll();
    try {
      await load();
      mark();
      await to(20);
      $('#refresh').click();
      await until(() => radarCalls().length === 2, '«Actualizar»');
      await networkIdle();
      const at = performance.now() - t0; // ~20 s y pico
      await to(at / 1000 + 44);
      expect(radarCalls()).toHaveLength(2); // nada a los 45 s del principio: el seguidor se reprogramó
      await to(at / 1000 + 46);
      expect(radarCalls()).toHaveLength(3);
      await to(at / 1000 + 91);
      expect(radarCalls()).toHaveLength(4);
      // Repintados (cada lectura repinta la tarjeta, Detalles avanzados, el avión y la señal): siguen siendo 45 s.
      await to(at / 1000 + 89 + 45);
      expect(radarCalls()).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('LIVE 14) 32) otra búsqueda o «Nueva consulta» (ficha cerrada) → ninguna petición más del radar', async () => {
    fakeAll();
    try {
      const tomorrow = dayOf(Date.now() + 24 * 3600000);
      const other = { IB1668: { name: 'Iberia', updated: new Date().toISOString(), legs: [{ d: tomorrow, o: 'PMI', a: 'MAD', sd: '17:55', ed: `${tomorrow}T17:55`, st: 'SCH' }] } };
      await load({ extraFlights: other });
      mark();
      await to(46);
      expect(radarCalls()).toHaveLength(2); // el seguidor estaba activo
      await search('IB1668', tomorrow);
      await until(() => $('#result .flight')?.textContent.includes('IB 1668'), 'otra ficha');
      await to(400);
      expect(radarCalls()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
    fakeAll();
    try {
      await load();
      mark();
      await to(46);
      expect(radarCalls()).toHaveLength(2); // el seguidor estaba activo
      $('#back').click();
      await to(400);
      expect(radarCalls()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('LIVE 15) aterrizado según FR24 → «Aterrizado» y se para', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => (k === 0 ? reading(0) : { state: 'aterrizado', source: 'fr24', fr24Id: '3c4d5e6f', callsign: 'IBE715', seenS: 20, distanceKm: 2 }) });
      mark();
      await to(46);
      await until(() => $('#result .flight .status')?.textContent.includes('Aterrizado'), 'aterrizado');
      await to(600);
      expect(radarCalls()).toHaveLength(2);
      expect(planeOnScreen(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('LIVE 16) Aena da la llegada final (LND) o desviado → se para el seguimiento', async () => {
    for (const flags of [{ st: 'LND', sta: 'LND' }, { sta: 'DES', st: 'DES' }]) {
      fakeAll();
      try {
        const render = { updated: new Date().toISOString(), legs: null };
        const { leg } = await load({ render });
        render.legs = [{ ...leg, ...flags }];
        render.updated = new Date(Date.now() + 600000).toISOString();
        mark();
        await to(46);
        expect(radarCalls().length, 'seguidor activo antes de Aena').toBeGreaterThanOrEqual(2);
        await to(640);
        await until(() => !$('.telemetry'), `Aena ${flags.sta}`);
        const n = radarCalls().length;
        await to(1000);
        expect(radarCalls(), flags.sta).toHaveLength(n);
      } finally { vi.useRealTimers(); }
    }
  }, 30000);

  it('LIVE 17) 18) pestaña oculta → cero peticiones; al volver a visible con la lectura vieja, pide en el acto y sigue a 45 s', async () => {
    fakeAll();
    const setVisibility = v => { Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
    try {
      await load();
      mark();
      await to(10);
      setVisibility('hidden');
      await to(600);
      expect(radarCalls()).toHaveLength(1);
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(10);
      await networkIdle();
      expect(radarCalls()).toHaveLength(2); // en el acto
      const at = performance.now() - t0;
      await to(at / 1000 + 44);
      expect(radarCalls()).toHaveLength(2);
      await to(at / 1000 + 46);
      expect(radarCalls()).toHaveLength(3);
    } finally { delete document.visibilityState; vi.useRealTimers(); }
  }, 30000);

  it('FALLOS 21) 22) 23) un fallo (timeout/red) no quita ni mueve la última posición real ni prolonga la estela; atenuada a los 60 s y fuera a los 180 s', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => (k === 0 ? reading(0) : k === 1 ? null : { state: 'no-disponible', source: 'fr24', reason: 'timeout' }) });
      mark();
      await until(() => trails(log).length === 1, 'estela');
      const trail = JSON.stringify(trails(log)[0].coords);
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      expect(log.markers[0].path).toEqual([[51, -1]]); // quieta: ningún movimiento
      expect(planeDimmed(log)).toBe(false);
      expect($('.telemetry')).not.toBeNull(); // la telemetría de la última lectura real se queda
      expect(JSON.stringify(trails(log)[0].coords)).toBe(trail);
      await to(63);
      expect(planeDimmed(log)).toBe(true); // última posición conocida
      await to(134);
      expect(radarCalls()).toHaveLength(2); // espera conservadora de 90 s tras el fallo
      await to(137);
      expect(radarCalls()).toHaveLength(3);
      expect(log.markers[0].path).toEqual([[51, -1]]);
      await to(176); // posición de 2 s al recibirla: 178 s
      expect(planeOnScreen(log)).toBe(true);
      await to(180); // 182 s
      expect(planeOnScreen(log)).toBe(false); // > 180 s: solo ruta, estela real pasada y aeropuertos
      expect(JSON.stringify(trails(log)[0].coords)).toBe(trail);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('FALLOS 24) 429 con Retry-After 200 s: la siguiente petición, no antes', async () => {
    fakeAll();
    try {
      await load({ radar: k => (k === 1 ? { state: 'no-disponible', source: 'fr24', reason: 'limite', retryAfterSec: 200 } : reading(k)) });
      mark();
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      await to(244);
      expect(radarCalls()).toHaveLength(2);
      await to(247);
      expect(radarCalls()).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('FALLOS 25) 401/403 → se para sin bucle (la ficha se queda con la última lectura real)', async () => {
    fakeAll();
    try {
      await load({ radar: k => (k === 0 ? reading(0) : { state: 'no-disponible', source: 'fr24', reason: 'autorizacion' }) });
      mark();
      await to(46);
      await to(3600);
      expect(radarCalls()).toHaveLength(2);
      expect($('.telemetry')).not.toBeNull();
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('FALLOS 26) 5xx seguidos: espera 90, 180 y 300 s; tras un éxito, otra vez 45 s', async () => {
    fakeAll();
    try {
      const fail = { state: 'no-disponible', source: 'fr24', reason: 'servidor' };
      await load({ radar: k => (k >= 1 && k <= 3 ? fail : reading(k)) });
      mark();
      // Peticiones a los 45, 135 (45 + 90), 315 (+180), 615 (+300) y 660 (+45, tras el éxito).
      for (const [s, n] of [[46, 2], [134, 2], [137, 3], [314, 3], [317, 4], [614, 4], [617, 5], [659, 5], [662, 6]]) {
        await to(s);
        expect(radarCalls(), `${s} s`).toHaveLength(n);
      }
    } finally { vi.useRealTimers(); }
  }, 30000);

  it.each([['+5 min', 5], ['−5 min', -5]])('RELOJ 27–28) reloj del móvil %s respecto al servidor: el avión no caduca ni rejuvenece en falso', async (_l, off) => {
    skewMs = off * 60000;
    fakeAll();
    try {
      const { log } = await load();
      mark();
      expect(planeDimmed(log)).toBe(false);
      expect($('.flight .tm-signal .tm-value').textContent).toBe('2 s'); // la antigüedad del servidor, no ±5 min
      await to(30);
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
      await to(46);
      expect(planeDimmed(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);

  // ---- Ronda de corrección 1 ----
  const refreshNow = async () => { const n = radarCalls().length; $('#refresh').click(); await until(() => radarCalls().length === n + 1, '«Actualizar»'); await networkIdle(); };
  it('Importante 1) un seguidor parado (401/403) no impide otro: «Actualizar» con «volando» → a los +45 s, petición nueva', async () => {
    fakeAll();
    try {
      await load({ radar: k => (k === 1 ? { state: 'no-disponible', source: 'fr24', reason: 'autorizacion' } : reading(k)) });
      mark();
      await to(46);
      await to(200);
      expect(radarCalls()).toHaveLength(2); // parado
      await refreshNow();
      const at = performance.now() - t0;
      await to(at / 1000 + 44);
      expect(radarCalls()).toHaveLength(3);
      await to(at / 1000 + 46);
      expect(radarCalls()).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  }, 30000);

  // Una sola autoridad (22/10/2026): la consulta de «Actualizar» la hace el MISMO seguidor; sin pollRadar paralelo.
  it('Importante 2) «Actualizar» sin respuesta persistente: un solo camino — ningún ?poll=1; el seguidor reintenta a 90, 180… s', async () => {
    fakeAll();
    try {
      await load({ radar: k => (k === 0 ? reading(0) : null) });
      mark();
      await to(20);
      await refreshNow(); // t ≈ 20 s: la consulta de «Actualizar» (sin respuesta)
      const at = (performance.now() - t0) / 1000;
      await to(at + 89);
      expect(radarCalls()).toHaveLength(2);
      await to(at + 92);
      expect(radarCalls()).toHaveLength(3); // espera de fallo de 90 s
      await to(at + 90 + 179);
      expect(radarCalls()).toHaveLength(3);
      await to(at + 90 + 182);
      expect(radarCalls()).toHaveLength(4); // 180 s
      expect(radarCalls().filter(u => new URL(u).searchParams.get('poll') !== null)).toEqual([]); // ningún sondeo paralelo
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('una sola autoridad (reproducción exacta): «Actualizar» y el radar sin responder más de 3 min (timeouts de 20 s) → al recuperarse, un solo ciclo y una sola secuencia', async () => {
    fakeAll();
    try {
      const { L, log } = liveLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      const base = network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany });
      let k = 0, open = 0, maxOpen = 0, down = false;
      const log2 = []; // [segundos desde t0, ?poll]
      await openApp(vi.fn((url, o) => {
        const u = String(url);
        if (u.startsWith(`${LIVE_BASE}/radar/`)) {
          calls.push(u);
          log2.push([Math.round((performance.now() - t0) / 1000), new URL(u).searchParams.get('poll')]);
          const n = k++;
          open++; maxOpen = Math.max(maxOpen, open);
          const done = r => { open--; return r ? json(r) : notFound; };
          // Sin conexión: cada petición agota el timeout de 20 s del navegador (fetchRadar → null).
          if (down) return new Promise(r => setTimeout(() => r(done(null)), 20000));
          return Promise.resolve(done(reading(n)));
        }
        if (u.startsWith(`${LIVE_BASE}/track/`)) { calls.push(u); return Promise.resolve(json(track())); }
        return base(url, o);
      }));
      t0 = performance.now();
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión');
      await networkIdle();
      mark();
      // 1) vuelo FR24 en seguimiento
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      // 2) «Actualizar» (t ≈ 60 s); 3) su petición no responde durante más de 3 minutos
      // 2) «Actualizar» (t ≈ 60 s); 3) el radar no responde durante más de 3 minutos (hasta t ≈ 400 s)
      await to(60);
      down = true;
      $('#refresh').click();
      await until(() => radarCalls().length === 3, 'consulta de «Actualizar»');
      await to(400);
      // Solo el seguidor reintenta, con su espera creciente (90, 180 s…): la de «Actualizar» a ~60 s (→ null a ~80),
      // ~170 (→ ~190) y ~370. Ningún sondeo de «Actualizar» en paralelo.
      expect(radarCalls().length).toBeLessThanOrEqual(5);
      // 4) se recupera la conexión
      down = false;
      const before = radarCalls().length;
      await to(800);
      // 5) un solo ciclo de consulta y una sola secuencia de peticiones.
      expect(maxOpen).toBe(1); // nunca dos peticiones a la vez
      expect(log2.every(([, poll]) => poll === null)).toBe(true); // ni un ?poll=1: ningún pollRadar paralelo
      const gaps = log2.slice(1).map(([s1], i) => s1 - log2[i][0]);
      expect(gaps.filter((g, i) => i !== 1 && g < 44)).toEqual([]); // nunca menos de 45 s entre dos (salvo «Actualizar», manual)
      expect(radarCalls().length).toBeGreaterThan(before); // tras recuperarse, sigue la misma secuencia…
      const tail = log2.slice(-3).map(([t]) => t);
      expect(tail[2] - tail[1]).toBeGreaterThanOrEqual(44); // …a 45 s
      expect(tail[2] - tail[1]).toBeLessThanOrEqual(46);
      expect(planeOnScreen(log)).toBe(true);
      expect(log.maps).toBe(1);
      expect(trackCalls()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('una sola autoridad: «Actualizar» con la petición del radar colgada 5 min (> 3) y luego recuperada → un solo ciclo y una sola secuencia', async () => {
    fakeAll();
    try {
      const { L, log } = liveLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      const base = network({ flights: { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany });
      let k = 0, open = 0, maxOpen = 0, release = null;
      const log2 = []; // [segundos desde t0, ?poll]
      await openApp(vi.fn((url, o) => {
        const u = String(url);
        if (u.startsWith(`${LIVE_BASE}/radar/`)) {
          calls.push(u);
          log2.push([Math.round((performance.now() - t0) / 1000), new URL(u).searchParams.get('poll')]);
          const n = k++;
          open++; maxOpen = Math.max(maxOpen, open);
          const done = r => { open--; return r ? json(r) : notFound; };
          // 3.ª petición (la de «Actualizar»): se cuelga hasta release() (conexión recuperada).
          if (n === 2) return new Promise(r => { release = () => r(done(reading(n))); });
          return Promise.resolve(done(reading(n)));
        }
        if (u.startsWith(`${LIVE_BASE}/track/`)) { calls.push(u); return Promise.resolve(json(track())); }
        return base(url, o);
      }));
      t0 = performance.now();
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión');
      await networkIdle();
      mark();
      // 1) vuelo FR24 en seguimiento
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      // 2) «Actualizar» (t ≈ 60 s); 3) su petición no responde durante más de 3 minutos
      await to(60);
      $('#refresh').click();
      await until(() => radarCalls().length === 3, 'consulta de «Actualizar»');
      // 5 min colgada: más que el tope de espera (3 min) + la espera de fallo (90 s), que antes abría un segundo camino.
      await to(60 + 300);
      expect(radarCalls()).toHaveLength(3); // nada nuevo mientras está colgada: ni ciclo, ni sondeo, ni tope de espera
      expect(open).toBe(1);
      // 4) se recupera la conexión
      release();
      await networkIdle();
      const back = (performance.now() - t0) / 1000;
      expect(log.markers[0].ll).not.toBeNull();
      // 5) un solo ciclo: la siguiente a los +45 s, después cada 45 s; nunca dos a la vez ni ?poll=1
      await to(back + 44);
      expect(radarCalls()).toHaveLength(3);
      await to(back + 46);
      expect(radarCalls()).toHaveLength(4);
      await to(back + 91);
      expect(radarCalls()).toHaveLength(5);
      await to(back + 134);
      expect(radarCalls()).toHaveLength(5);
      await to(back + 136);
      expect(radarCalls()).toHaveLength(6);
      expect(maxOpen).toBe(1);
      expect(log2.every(([, poll]) => poll === null)).toBe(true);
      // Una sola secuencia: entre dos peticiones seguidas, nunca menos de 45 s (salvo la de «Actualizar», manual).
      const gaps = log2.slice(1).map(([s1], i) => s1 - log2[i][0]);
      expect(gaps.filter((g, i) => i !== 1 && g < 44)).toEqual([]);
      expect(log.maps).toBe(1);
      expect(trackCalls()).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('Importante 3) seguimiento al día con caché de 35 s (posición de 37 s al llegar): entre ciclos, quieto y SIN atenuar; fuera a los 180 s', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => reading(k, { posAgeS: 37, seenS: 37 }) });
      mark();
      expect(planeDimmed(log)).toBe(false);
      await to(30); // 67 s: ya no es fresca, pero la lectura siguiente está al llegar
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
      const path = log.markers[0].path.length;
      await to(44);
      expect(planeDimmed(log)).toBe(false);
      expect(log.markers[0].path).toHaveLength(path); // quieta: nada se mueve con una lectura vieja
      await to(46);
      expect(radarCalls()).toHaveLength(2);
      await to(80); // el ciclo siguiente, otra vez sin atenuar
      expect(planeDimmed(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('Importante 3) con un fallo, la última posición (vieja) sí se atenúa; y pasados 180 s desaparece', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => (k === 0 ? reading(0, { posAgeS: 37, seenS: 37 }) : null) });
      mark();
      await to(30);
      expect(planeDimmed(log)).toBe(false);
      await to(46); // el ciclo falla: falta la lectura esperada
      expect(planeDimmed(log)).toBe(true);
      await to(140); // 177 s
      expect(planeOnScreen(log)).toBe(true);
      await to(145); // 182 s
      expect(planeOnScreen(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('menor) «Actualizar» con «no disponible»: no se pinta encima (telemetría y avión de la última lectura real se quedan)', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => (k === 0 ? reading(0) : { state: 'no-disponible', source: 'fr24', reason: 'servidor' }) });
      mark();
      await to(10);
      await refreshNow();
      expect($('.telemetry')).not.toBeNull();
      expect($('#result .flight').textContent).not.toContain('Sin señal');
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('menor) lectura «sin datos» con la última posición real de 10 s: el avión sigue con su frescura real (sin atenuar)', async () => {
    fakeAll();
    try {
      const { log } = await load({ radar: k => (k === 0 ? reading(0) : { state: 'sin-datos', source: 'fr24' }) });
      mark();
      await to(8);
      await refreshNow();
      expect(planeOnScreen(log)).toBe(true);
      expect(planeDimmed(log)).toBe(false);
      expect(log.markers[0].path).toEqual([[51, -1]]);
    } finally { vi.useRealTimers(); }
  }, 30000);

  it('ronda 2) «Actualizar» con un cambio de Aena + «no disponible»: horas NUEVAS de Aena con la telemetría anterior y el avión quieto', async () => {
    fakeAll();
    try {
      const { L, log } = liveLeaflet();
      vi.stubGlobal('L', L);
      const { d, leg } = flyingLeg();
      const data = { IB715: { name: 'Iberia', updated: new Date().toISOString(), legs: [leg] } };
      const base = network({ flights: data, openMeteo: () => tooMany });
      let k = 0;
      await openApp(vi.fn((url, o) => {
        const u = String(url);
        if (u.startsWith(`${LIVE_BASE}/radar/`)) { calls.push(u); return Promise.resolve(json(k++ === 0 ? reading(0) : { state: 'no-disponible', source: 'fr24', reason: 'servidor' })); }
        if (u.startsWith(`${LIVE_BASE}/track/`)) { calls.push(u); return Promise.resolve(json(track())); }
        return base(url, o);
      }));
      await search('IB715', d);
      await until(() => $('.telemetry') && log.maps === 1 && planeOnScreen(log), 'ficha con el avión');
      await networkIdle();
      mark();
      const newEd = formatLocal(Date.now() - 53 * 60000, MAD); // salida estimada nueva (antes: la programada, hace 60 min)
      expect($('#result .flight .milestones').textContent).not.toContain(newEd);
      data.IB715 = { ...data.IB715, updated: new Date().toISOString(), legs: [{ ...leg, ed: `${d}T${newEd}` }] };
      await to(10);
      await refreshNow();
      // Los hitos del Horario son los de la consulta nueva (no los de la tarjeta de antes de «Actualizar»).
      expect($('#result .flight .milestones').textContent).toContain(newEd);
      expect($('.telemetry')).not.toBeNull(); // con la telemetría de la última lectura real
      expect($('.flight .tm-signal .tm-value').textContent).not.toBe('2 s'); // que sigue envejeciendo, no se reinicia
      expect(log.markers).toHaveLength(1);
      expect(log.markers[0].path).toEqual([[51, -1]]); // el avión, quieto
      expect(planeDimmed(log)).toBe(false);
    } finally { vi.useRealTimers(); }
  }, 30000);
});
