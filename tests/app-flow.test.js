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
function network({ flights, radar = null, openMeteo }) {
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
      expect(radarCalls().slice(1).every(u => u.endsWith('?poll=1'))).toBe(true);
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
      expect(radarCalls()[1].endsWith('?poll=1')).toBe(true);
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
