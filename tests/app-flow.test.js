// @vitest-environment jsdom
// Flujo real de la app (js/app.js sobre index.html), con la red simulada por URL: la ficha no depende de Open-Meteo
// y «Actualizar» reutiliza el pronóstico en caché.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_BASE } from '../js/config.js';
import { formatLocal } from '../js/time.js';
import { FORECAST_UNAVAILABLE } from '../js/ui-forecast.js';
import { normalizeFlights } from '../server/aerodatabox.mjs';

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
    for (const txt of ['Volando', '830', '10.700', '300', 'Radar ADS-B', 'IBE715']) expect(panel).toContain(txt);
    expect(area()).toContain('Puedes reintentar en unos 30 s');
    expect($('#forecast-retry')).not.toBeNull();
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
    expect(area()).not.toContain(FORECAST_UNAVAILABLE);
  });
});

// La ficha completa: tarjeta del vuelo, título Turbulencias y su sección. Tiene que estar siempre.
const shell = () => ({ flight: Boolean($('#result .flight')), turbulencias: [...document.querySelectorAll('#result h3.section')].some(h => h.textContent === 'Turbulencias'),
  area: Boolean($('#forecast-area')), error: !$('#error').hidden });
const SHELL_OK = { flight: true, turbulencias: true, area: true, error: false };
const radarCalls = () => calls.filter(u => u.includes('/radar/'));
// Avanza el reloj simulado; entre temporizador y temporizador se resuelven las promesas (cada sondeo programa el siguiente).
async function advance(ms) { await vi.advanceTimersByTimeAsync(ms); await networkIdle(); }
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
      expect($('.telemetry').textContent).toContain('Volando'); // con el radar volando, «Volando» va en el panel
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
      expect($('.radar.muted').textContent).toBe('Localizando el avión en el radar…'); // no «Sin señal ADS-B»
      await advance(20000);
      expect(radarCalls()).toHaveLength(2); // el servidor dice: 429, reanudo en 100 s
      expect(shell()).toEqual(SHELL_OK);
      expect($('.radar.muted').textContent).toBe('Localizando el avión en el radar…');
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
      expect($('.radar.muted')?.textContent).toBe('Localizando el avión en el radar…'); // también con Aena en «Volando»
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
    await until(() => $('#forecast-area .summary'), 'previsión');
    expect(shell()).toEqual(SHELL_OK);
    expect(area()).not.toContain(FORECAST_UNAVAILABLE);
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
    await until(() => $('#forecast-area .note'), 'motivo');
    expect($('#forecast-area .note').textContent).toBe('Vuelo cancelado.');
    expect(shell()).toEqual(SHELL_OK);
  });
});

describe('la sección Turbulencias aparece siempre en la ficha de un vuelo', () => {
  it('vuelo ya aterrizado (Aena) y Open-Meteo con 429: ficha, puntualidad y la sección con el motivo', async () => {
    const dep = Date.now() - 4 * 3600000, arr = dep + 75 * 60000;
    const d = dayOf(dep), sd = formatLocal(dep, MAD), sa = formatLocal(arr, MAD);
    const leg = { d, o: 'PMI', a: 'MAD', sd, ed: `${d}T${sd}`, sa, ea: `${dayOf(arr)}T${sa}`, st: 'LND', std: 'BOR', sta: 'LND', ac: '738W' };
    await openApp(network({ flights: { UX6031: { name: 'Air Europa', updated: new Date().toISOString(), legs: [leg] } }, openMeteo: () => tooMany }));
    await search('UX6031', d);
    await until(() => $('#result .flight'), 'ficha');
    await networkIdle();
    expect([...document.querySelectorAll('#result h3')].map(h => h.textContent)).toContain('Turbulencias');
    expect($('#forecast-area .note').textContent).toBe('Este vuelo ya ha aterrizado.');
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
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
      expect($('.telemetry').textContent).toContain('Volando'); // nunca pasa a «Aterrizado» por el paso del tiempo
      expect($('#result .status')?.textContent ?? '').not.toContain('Aterrizado');
      expect(calls.slice(before).filter(u => u.includes('/radar/') || u.includes('adsb.lol'))).toHaveLength(0); // 8) cero peticiones
    } finally { vi.useRealTimers(); }
  });
  it('3) una lectura real nueva (Actualizar) sustituye la estimación en el acto y sigue desde ahí', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
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
    expect($('#result .flight').textContent).toContain('Madrid a');
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
    expect($('#result .flight').textContent).toContain('Madrid a');
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse('2026-09-26T12:00:00Z'), shouldAdvanceTime: true });
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
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T, shouldAdvanceTime: true });

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
      expect($('#forecast-area .note').textContent).toBe('Este vuelo ya ha aterrizado.');
      expect(shell()).toEqual(SHELL_OK);
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
    expect($('#result .flight').textContent).toContain('Ibiza (Eivissa) a London');
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
    await until(() => $('#result .flight') && $('#forecast-area .summary'), 'ficha y pronóstico');
    await networkIdle();
    expect($('#time-field').hidden).toBe(true); // no se pidió la hora
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect($('#result .flight h2').textContent).toBe('UO 625');
    for (const t of ['Airbus A321neo', 'Hong Kong Express · Tokyo a Hong Kong', 'Programado', 'HND', 'HKG', 'Salida 10:00', 'Llegada 13:05',
      'Horario según AeroDataBox · consultado hace un momento']) expect(card).toContain(t);
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
    await until(() => $('#result .flight')?.textContent.includes('Hong Kong a Bangkok'), 'ficha del tramo escogido');
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
    expect($('#result .flight').textContent).toContain('British Airways · Ibiza (Eivissa) a London');
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
    await until(() => $('#result .flight')?.textContent.includes('London a Ingliston, Edinburgh'), 'tramo escogido');
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
    for (const t of ['Volando', '905', '11.300', '9.300', 'Radar ADS-B', 'Última señal hace 3 s', 'GIA89']) expect(panel).toContain(t);
    expect($('#result .flight h2').textContent).toBe('GA 89');
    expect($('#result .flight').textContent).not.toContain('Aena');
    const key = `adb|GA89|${d}|AMS|CGK|${new Date(dep).toISOString().slice(0, 16)}Z`;
    expect(radarCalls()[0]).toBe(`${LIVE_BASE}/radar-adb/GA89/${d}.json?leg=${encodeURIComponent(key)}`);
    expect(calls.some(u => u.includes('/radar/'))).toBe(false); // nunca el radar de Aena
    expect(calls.filter(u => u.includes('/schedule/'))).toHaveLength(1); // AeroDataBox: nada más que la consulta del horario
  });
  it('sin transpondedor ni indicativo: ficha sin radar y 0 peticiones de radar', async () => {
    await open(raw({ callSign: null, aircraft: { model: 'Boeing 777' } }), FLYING);
    await networkIdle();
    expect(radarCalls()).toEqual([]);
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
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: T, shouldAdvanceTime: true });

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
    fake();
    try {
      const render = { fail: false, updated: iso(T - 5 * 60000), legs: [leg('22:00')] };
      await openApp(app({ pagesLeg: leg('22:00'), pagesUpdated: iso(T - 5 * 60000), render }));
      await search('IB1668', D);
      await until(() => $('#result .flight'), 'ficha');
      await networkIdle();
      const before = renderCalls().length;
      await advance(3600000);
      expect(renderCalls()).toHaveLength(before);
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
  const ticks = () => [...document.querySelectorAll('#forecast-area .ticks span')].map(s => Number(s.textContent.replace('′', '')));
  const windowFor = d => {
    const dep = localToUtcMs(d, '15:45', 'Europe/Madrid'), arr = localToUtcMs(d, '17:10', 'Europe/Madrid');
    return forecastWindow({ km, blockDepartureMs: dep, blockArrivalMs: arr });
  };

  it('IB1667 MAD → PMI: la ficha sigue en 15:45 → 17:10; ECMWF/GFS reciben la ventana en el aire (≈ 55 min) y los minutos del pronóstico también', async () => {
    const d = tomorrow();
    await openApp(network({ flights: flights(d), openMeteo: openMeteoOk }));
    await search('IB1667', d);
    await until(() => $('#forecast-area .summary'), 'pronóstico');
    await networkIdle();
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect(card).toContain('Salida 15:45');
    expect(card).toContain('Llegada 17:10'); // hora oficial, no la del pronóstico
    expect(card).not.toMatch(/Salida 1[56]:(0|5)[05] .*Llegada 16:5/);
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
    await until(() => $('#forecast-area .summary'), 'pronóstico');
    await networkIdle();
    const card = $('#result .flight').textContent.replace(/\s+/g, ' ');
    expect(card).toContain('Salida 16:05 Programada 15:45');
    expect(card).toContain('Llegada 17:30 Programada 17:10');
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
    await until(() => $('#forecast-area .note'), 'nota');
    expect($('#forecast-area .note').textContent).toBe('Este vuelo ya ha aterrizado.');
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
    await until(() => $('#forecast-area .summary'), 'pronóstico');
    await networkIdle();
    const w = forecastWindow({ km, blockDepartureMs: dep, blockArrivalMs: arr });
    for (const u of modelCalls()) expect(range(u)).toEqual([hourKey(w.forecastTakeoffMs - 3600000), hourKey(w.forecastLandingMs + 3600000)]);
    expect($('#result .flight').textContent.replace(/\s+/g, ' ')).toContain('Salida 10:00'); // la ficha, con su hora
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
