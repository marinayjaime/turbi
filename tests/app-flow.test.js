// @vitest-environment jsdom
// Flujo real de la app (js/app.js sobre index.html), con la red simulada por URL: la ficha no depende de Open-Meteo
// y «Actualizar» reutiliza el pronóstico en caché.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_BASE } from '../js/config.js';
import { formatLocal } from '../js/time.js';
import { FORECAST_UNAVAILABLE } from '../js/ui-forecast.js';
import { RADAR_RECHECK_DELAYS_MS } from '../js/radar.js';

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

describe('radar: el servidor está identificando el avión por su ruta (en segundo plano)', () => {
  it('la ficha no espera; la app vuelve a mirar el radar una sola vez y entonces muestra el panel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    try {
      const dep = Date.now() - 45 * 60000;
      const d = dayOf(dep), sd = formatLocal(dep, MAD);
      const leg = { d, o: 'PMI', a: 'LBA', sd, ed: `${d}T${sd}`, st: 'BOR', ac: '738W', op: 'FR' };
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: [{ state: 'sin-datos', identifying: true }, { ...RADAR_FLYING, callsign: 'RYR12AB', hex: 'abc123', match: 'ruta' }],
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => $('#result .flight') && calls.filter(u => u.includes('/radar/')).length === 1 && area().includes(FORECAST_UNAVAILABLE), 'ficha con la primera respuesta del radar');
      expect($('.telemetry')).toBeNull();
      vi.advanceTimersByTime(RADAR_RECHECK_DELAYS_MS[0]);
      await until(() => $('.telemetry'), 'panel tras la segunda consulta');
      expect($('.telemetry').textContent).toContain('RYR12AB');
      expect($('.tm-match')).not.toBeNull();
      vi.advanceTimersByTime(RADAR_RECHECK_DELAYS_MS.reduce((a, b) => a + b, 0));
      await networkIdle();
      expect(calls.filter(u => u.includes('/radar/'))).toHaveLength(2); // una sola nueva consulta
    } finally { vi.useRealTimers(); }
  });
  it('si sigue identificando, hace tres sondeos baratos a los 10, 25 y 45 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
    try {
      const dep = Date.now() - 45 * 60000;
      const d = dayOf(dep), sd = formatLocal(dep, MAD);
      const leg = { d, o: 'PMI', a: 'LBA', sd, ed: `${d}T${sd}`, st: 'BOR', ac: '738W', op: 'FR' };
      await openApp(network({
        flights: { FR2311: { name: 'Ryanair', updated: new Date().toISOString(), legs: [leg] } },
        radar: { state: 'sin-datos', identifying: true },
        openMeteo: () => tooMany,
      }));
      await search('FR2311', d);
      await until(() => calls.filter(u => u.includes('/radar/')).length === 1, 'primera consulta del radar');
      for (const delay of RADAR_RECHECK_DELAYS_MS) { vi.advanceTimersByTime(delay); await networkIdle(); }
      const radarCalls = calls.filter(u => u.includes('/radar/'));
      expect(radarCalls).toHaveLength(4);
      expect(radarCalls.slice(1).every(u => u.endsWith('?poll=1'))).toBe(true);
    } finally { vi.useRealTimers(); }
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
