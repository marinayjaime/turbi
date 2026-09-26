// @vitest-environment jsdom
// Flujo real de la app (js/app.js sobre index.html), con la red simulada por URL: la ficha no depende de Open-Meteo
// y «Actualizar» reutiliza el pronóstico en caché.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_BASE } from '../js/config.js';
import { formatLocal } from '../js/time.js';
import { FORECAST_UNAVAILABLE } from '../js/ui-forecast.js';

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
function network({ flights, radar = null, openMeteo, adsbdb = {}, aliases = null }) {
  const radars = Array.isArray(radar) ? [...radar] : null;
  calls = [];
  return vi.fn(async url => {
    url = String(url);
    calls.push(url);
    if (url === 'data/airports.json') return json(JSON.parse(readFileSync('data/airports.json', 'utf8')));
    if (url === 'data/airline-photos.json') return json(JSON.parse(readFileSync('data/airline-photos.json', 'utf8')));
    const f = url.match(/^data\/flights\/(\w+)\/(\d+)\.json$/);
    if (f && flights[`${f[1]}${f[2]}`]) return json(flights[`${f[1]}${f[2]}`]);
    if (url.startsWith(`${LIVE_BASE}/radar/`)) return radars ? json(radars.length > 1 ? radars.shift() : radars[0]) : radar ? json(radar) : notFound;
    const cs = url.match(/^https:\/\/api\.adsbdb\.com\/v0\/callsign\/(\w+)$/);
    if (cs) return typeof adsbdb[cs[1]] === 'function' ? adsbdb[cs[1]]() : adsbdb[cs[1]] ? json(adsbdb[cs[1]]) : notFound;
    if (url === 'data/flights/_aliases.json') return aliases ? json(aliases) : notFound;
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
