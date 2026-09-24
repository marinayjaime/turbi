import { describe, it, expect, vi } from 'vitest';
import { forecastView, aviationView } from '../js/forecast.js';
import { routeLines } from '../js/map.js';
import { buildProfile } from '../js/altitude.js';

const PMI = { iata: 'PMI', city: 'Palma de Mallorca', lat: 39.5517, lon: 2.7388 };
const MAD = { iata: 'MAD', city: 'Madrid', lat: 40.4719, lon: -3.5626 };
const NOW = Date.parse('2026-09-25T06:00:00Z');
const DEP = Date.parse('2026-09-25T10:00:00Z');

function fakeOpenMeteo(field) {
  return vi.fn(async url => {
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',').map(Number), lons = u.searchParams.get('longitude').split(',').map(Number);
    const vars = u.searchParams.get('hourly').split(',');
    const start = Date.parse(u.searchParams.get('start_hour') + ':00Z'), end = Date.parse(u.searchParams.get('end_hour') + ':00Z');
    const times = []; for (let t = start; t <= end; t += 3600000) times.push(new Date(t).toISOString().slice(0, 16));
    const body = lats.map((lat, i) => ({ latitude: lat, longitude: lons[i], elevation: 100, hourly: Object.fromEntries([['time', times], ...vars.map(v => [v, times.map(() => field(v))])]) }));
    return { ok: true, json: async () => body };
  });
}
const calm = v => (v.startsWith('wind_speed') ? 15 : v.startsWith('wind_direction') ? 270 : v.startsWith('temperature_') ? -40 : v === 'weather_code' ? 1 : 0);

describe('forecastView', () => {
  it('monta el modelo de vista completo y serializable', async () => {
    const profile = buildProfile(PMI, MAD, DEP, 90);
    const v = await forecastView({ q: { number: 'IB1668', airline: 'Iberia', origin: PMI, destination: MAD }, profile, flight: null, times: '12:00–13:30', nowMs: NOW, fetchFn: fakeOpenMeteo(calm) });
    expect(v).toMatchObject({ v: 2, title: 'PMI → MAD', subtitle: 'IB1668 · Iberia', fromCity: 'Palma de Mallorca', toCity: 'Madrid', originIata: 'PMI', durationMin: 90, models: ['ECMWF', 'GFS'], queriedAt: NOW });
    expect(v.summary.headline).toBe('Tranquilo');
    expect(v.confidence.level).toBe('alta');
    expect(v.altitudes).toHaveLength(6);
    expect(v.route).toHaveLength(profile.points.length);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
  });
});

describe('aviationView', () => {
  const av = {
    metar: { updated: '2026-09-24T10:00:00Z', items: { LEPA: { raw: 'METAR LEPA', wdir: 230, wspd: 8, visib: '6+', clouds: [{ cover: 'FEW', base: 1800 }], wx: '', temp: 27 } } },
    taf: { items: { LEMD: { raw: 'TAF LEMD', fcsts: [] } } },
    sigmet: { items: [] }, pirep: { items: [] }, icao: { PMI: 'LEPA', MAD: 'LEMD' },
  };
  it('resume origen y destino y filtra SIGMET/PIREP por la ruta', () => {
    const r = aviationView(av, { originIata: 'PMI', destinationIata: 'MAD', route: [{ lat: 39.5, lon: 2.7 }, { lat: 40.4, lon: -3.5 }], depMs: DEP, arrMs: DEP + 5400000 }, NOW);
    expect(r.origin).toMatchObject({ icao: 'LEPA', metarRaw: 'METAR LEPA', metarText: 'Viento del suroeste a 15 km/h · buena visibilidad · algunas nubes · 27 °C', tafText: null });
    expect(r.destination).toMatchObject({ icao: 'LEMD', metarText: null, tafRaw: 'TAF LEMD', tafText: ['Sin fenómenos significativos previstos'] });
    expect(r.sigmets).toEqual([]);
    expect(r.pireps).toEqual([]);
    expect(r.updated).toBe('2026-09-24T10:00:00Z');
  });
  it('sin ningún dato → null', () => {
    expect(aviationView({ metar: null, taf: null, sigmet: null, pirep: null, icao: null }, { originIata: 'PMI', destinationIata: 'MAD', route: [] }, NOW)).toBeNull();
  });
});

describe('routeLines (mapa)', () => {
  it('agrupa puntos consecutivos del mismo nivel, uniendo los tramos', () => {
    const r = [{ lat: 0, lon: 0, level: 0 }, { lat: 0, lon: 1, level: 0 }, { lat: 0, lon: 2, level: 2 }, { lat: 0, lon: 3, level: null }];
    expect(routeLines(r)).toEqual([
      { level: 0, coords: [[0, 0], [0, 1], [0, 2]] },
      { level: 2, coords: [[0, 2], [0, 3]] },
    ]);
  });
});

describe('aviationView: frescura y datos que faltan', () => {
  const route = [{ lat: 39.5, lon: 2.7 }, { lat: 40.4, lon: -3.5 }];
  const v = { originIata: 'PMI', destinationIata: 'MAD', route, depMs: DEP, arrMs: DEP + 5400000 };
  const metar = t => ({ raw: 'METAR LEPA', t, wdir: 230, wspd: 8, visib: '6+', clouds: [], wx: '', temp: 27 });
  it('METAR reciente: con su antigüedad; de más de 3 h: no se muestra como actual', () => {
    const fresh = aviationView({ metar: { items: { LEPA: metar(NOW - 40 * 60000) } }, icao: { PMI: 'LEPA' } }, v, NOW);
    expect(fresh.origin).toMatchObject({ metarAge: 'hace 40 min', metarStale: false });
    const old = aviationView({ metar: { items: { LEPA: metar(NOW - 5 * 3600000) } }, icao: { PMI: 'LEPA' } }, v, NOW);
    expect(old.origin).toMatchObject({ metarText: null, metarStale: true });
  });
  it('archivo de SIGMET o PIREP ausente → null (no «ninguno»)', () => {
    const r = aviationView({ metar: { items: {} }, icao: {} }, v, NOW);
    expect(r.sigmets).toBeNull();
    expect(r.pireps).toBeNull();
  });
});
