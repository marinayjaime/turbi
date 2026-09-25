import { describe, it, expect, vi } from 'vitest';
import { MODELS, CENTER_VARS, CROSS_VARS, planRoute, analyzeModel, combineModels, agreement, forecastRoute } from '../js/models.js';
import { buildProfile } from '../js/altitude.js';
import { distanceKm } from '../js/route.js';

const PMI = { lat: 39.5517, lon: 2.7388 };
const MAD = { lat: 40.4719, lon: -3.5626 };
const DEP = Date.parse('2026-09-25T10:00:00Z');
const profile = buildProfile(PMI, MAD, DEP, 90);

// Open-Meteo simulado: devuelve una ubicación por coordenada; valores = field(varName, lat, lon, hourIndex)
function fakeOpenMeteo(field, { fail = {} } = {}) {
  return vi.fn(async url => {
    const u = new URL(url);
    const model = u.searchParams.get('models');
    if (fail[model]) return { ok: false, status: fail[model] };
    const lats = u.searchParams.get('latitude').split(',').map(Number);
    const lons = u.searchParams.get('longitude').split(',').map(Number);
    const vars = u.searchParams.get('hourly').split(',');
    const start = Date.parse(u.searchParams.get('start_hour') + ':00Z');
    const end = Date.parse(u.searchParams.get('end_hour') + ':00Z');
    const times = [];
    for (let t = start; t <= end; t += 3600000) times.push(new Date(t).toISOString().slice(0, 16));
    const body = lats.map((lat, i) => {
      const hourly = { time: times };
      for (const v of vars) hourly[v] = times.map((_, h) => field(v, lat, lons[i], h, model));
      return { latitude: lat, longitude: lons[i], elevation: 100, hourly };
    });
    return { ok: true, status: 200, json: async () => (body.length === 1 ? body[0] : body) };
  });
}
const calm = v => (v.startsWith('wind_speed') ? 15 : v.startsWith('wind_direction') ? 270
  : v.startsWith('temperature_') ? { 400: -25, 300: -40, 250: -50, 200: -55, 150: -58 }[v.match(/_(\d+)hPa/)[1]]
  : v.startsWith('vertical_velocity') ? 0 : v === 'cape' ? 0 : v === 'weather_code' ? 1 : 0);
// Chorro con cizalladura fuerte en 300–250 hPa
const jet = v => (v === 'wind_speed_250hPa' ? 60 : v === 'wind_speed_300hPa' ? 35 : calm(v));

describe('planRoute', () => {
  it('2 vecinos transversales a ~50 km solo en puntos a FL200 o más', () => {
    const plan = planRoute(profile);
    const high = profile.points.filter(p => p.fl >= 200).length;
    expect(plan.cross).toHaveLength(high * 2);
    for (const c of plan.cross) expect(distanceKm(profile.points[c.i], c)).toBeCloseTo(50, 0);
  });
});

describe('variables', () => {
  it('centro 22 variables; vecinos 10 (solo viento)', () => {
    expect(CENTER_VARS).toHaveLength(22);
    expect(CROSS_VARS).toHaveLength(10);
    expect(CROSS_VARS.every(v => v.startsWith('wind_'))).toBe(true);
  });
});

describe('forecastRoute', () => {
  it('pide cada modelo por separado, con sus variables, y combina', async () => {
    const f = fakeOpenMeteo(calm);
    const r = await forecastRoute(profile, f);
    const urls = f.mock.calls.map(c => new URL(c[0]));
    expect(new Set(urls.map(u => u.searchParams.get('models')))).toEqual(new Set(MODELS.map(m => m.id)));
    expect(urls.some(u => u.searchParams.get('hourly') === CROSS_VARS.join(','))).toBe(true);
    expect(r.models).toEqual(['ECMWF', 'GFS']);
    expect(r.points).toHaveLength(profile.points.length);
    expect(r.points.every(p => p.level === 0)).toBe(true);
    expect(r.coverage).toBe(1);
    expect(r.agreement.level).toBe('alta');
  });
  it('detecta turbulencia en crucero con un chorro cizallado', async () => {
    const r = await forecastRoute(profile, fakeOpenMeteo(jet));
    const cruise = r.points.filter((p, i) => profile.points[i].phase === 'cruise');
    expect(cruise.some(p => p.level >= 1)).toBe(true);
    expect(cruise.flatMap(p => p.causes)).toContain('vertical_shear');
  });
  it('si un modelo falla, sigue con el otro y lo indica', async () => {
    const r = await forecastRoute(profile, fakeOpenMeteo(calm, { fail: { ecmwf_ifs025: 500 } }));
    expect(r.models).toEqual(['GFS']);
    expect(r.agreement.level).toBe('no disponible');
  });
  it('un modelo con casi todo nulo se descarta', async () => {
    const f = fakeOpenMeteo((v, lat, lon, h, model) => (model === 'ecmwf_ifs025' ? null : calm(v)));
    const r = await forecastRoute(profile, f);
    expect(r.models).toEqual(['GFS']);
  });
  it('si fallan los dos, lanza error', async () => {
    await expect(forecastRoute(profile, fakeOpenMeteo(calm, { fail: { ecmwf_ifs025: 500, gfs_seamless: 500 } })))
      .rejects.toThrow();
  });
  it('429: se propaga el aviso de cupo, sin insistir', async () => {
    const f = fakeOpenMeteo(calm, { fail: { ecmwf_ifs025: 429, gfs_seamless: 429 } });
    await expect(forecastRoute(profile, f)).rejects.toThrow('Demasiadas consultas seguidas');
  });
  it('cobertura parcial: puntos sin datos cuentan como no válidos', async () => {
    const f = fakeOpenMeteo((v, lat) => (lat > 40.2 ? null : calm(v)));
    const r = await forecastRoute(profile, f);
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.coverage).toBeLessThan(1);
  });
});

describe('combineModels y agreement', () => {
  const pt = (score, causes = []) => ({ score, level: score >= 75 ? 3 : score >= 50 ? 2 : score >= 25 ? 1 : 0, causes, layers: [], valid: true });
  it('media del índice por punto; causas del modelo con más puntuación', () => {
    const c = combineModels([{ model: 'ECMWF', points: [pt(60, ['vertical_shear'])] }, { model: 'GFS', points: [pt(30, ['convection'])] }]);
    expect(c[0]).toMatchObject({ score: 45, level: 1, causes: ['vertical_shear', 'convection'] });
  });
  it('como mucho 3 causas al combinar', () => {
    const c = combineModels([{ model: 'ECMWF', points: [pt(60, ['vertical_shear', 'jet_stream', 'instability'])] }, { model: 'GFS', points: [pt(50, ['convection', 'clear_air'])] }]);
    expect(c[0].causes).toHaveLength(3);
  });
  it('un punto válido solo en un modelo usa ese modelo', () => {
    const c = combineModels([{ model: 'ECMWF', points: [{ score: null, level: null, causes: [], layers: [], valid: false }] }, { model: 'GFS', points: [pt(30)] }]);
    expect(c[0].score).toBe(30);
  });
  it('ejemplos del documento: ligera/ligera alto · moderada/ligera medio · moderada/nula bajo', () => {
    const run = scores => scores.map(s => pt(s));
    expect(agreement(run([30, 30, 10]), run([35, 30, 5])).level).toBe('alta');
    expect(agreement(run([55, 30, 10]), run([35, 30, 10])).level).toBe('media');
    expect(agreement(run([55, 30, 10]), run([10, 10, 10])).level).toBe('baja');
  });
});

describe('analyzeModel', () => {
  it('cada punto trae su pronóstico por capas para el comparador de altitudes', async () => {
    const r = await forecastRoute(profile, fakeOpenMeteo(calm));
    const p = r.points.find(x => x.layers.length);
    expect(p.layers).toHaveLength(4);
    expect(typeof analyzeModel).toBe('function');
  });
});

import { fetchModelRuns } from '../js/models.js';

describe('fetchModelRuns', () => {
  it('hora de inicialización de cada modelo desde meta.json', async () => {
    const f = vi.fn(async url => ({ ok: true, json: async () => ({ last_run_initialisation_time: url.includes('ecmwf') ? 1790208000 : 1790229600 }) }));
    const r = await fetchModelRuns(['ECMWF', 'GFS'], f);
    expect(f.mock.calls.map(c => c[0])).toEqual([
      'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json',
      'https://api.open-meteo.com/data/ncep_gfs025/static/meta.json',
    ]);
    expect(r).toEqual({ ECMWF: 1790208000000, GFS: 1790229600000 });
  });
  it('si falla, ese modelo no aparece (nunca se inventa la hora)', async () => {
    const f = vi.fn(async url => (url.includes('ecmwf') ? { ok: false, status: 500 } : { ok: true, json: async () => ({ last_run_initialisation_time: 1790229600 }) }));
    expect(await fetchModelRuns(['ECMWF', 'GFS'], f)).toEqual({ GFS: 1790229600000 });
    expect(await fetchModelRuns(['GFS'], vi.fn(async () => { throw new TypeError('x'); }))).toEqual({});
  });
});

describe('fetchModelRuns: caché (Actualizar no vuelve a pedir meta.json a Open-Meteo)', () => {
  const meta = t => ({ ok: true, json: async () => ({ last_run_initialisation_time: t }) });
  it('dentro de 45 min reutiliza la hora ya obtenida; después la vuelve a pedir', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00Z') });
    try {
      const f = vi.fn(async () => meta(1790208000));
      await fetchModelRuns(['ECMWF', 'GFS'], f);
      vi.setSystemTime(Date.parse('2026-09-25T10:44:00Z'));
      expect(await fetchModelRuns(['ECMWF', 'GFS'], f)).toEqual({ ECMWF: 1790208000000, GFS: 1790208000000 });
      expect(f).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.parse('2026-09-25T10:46:00Z'));
      await fetchModelRuns(['ECMWF'], f);
      expect(f).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it('un fallo no se guarda: la siguiente vez se vuelve a intentar', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? { ok: false, status: 500 } : meta(1790208000)));
    expect(await fetchModelRuns(['GFS'], f)).toEqual({});
    expect(await fetchModelRuns(['GFS'], f)).toEqual({ GFS: 1790208000000 });
  });
});

describe('rejilla real de GFS', () => {
  it('las coordenadas de GFS se ajustan a 0,25° (sus datos en altura vienen de esa rejilla)', async () => {
    const seen = [];
    const base = fakeOpenMeteo(calm);
    const f = vi.fn(async url => {
      const res = await base(url);
      const body = await res.json();
      const model = new URL(url).searchParams.get('models');
      // GFS devuelve coordenadas de su rejilla fina (0,11°), no las de 0,25° de sus datos en altura
      for (const loc of body) { if (model === 'gfs_seamless') { loc.latitude += 0.041; loc.longitude -= 0.03; } seen.push(loc); }
      return { ok: true, status: 200, json: async () => body };
    });
    const { snapToGrid } = await import('../js/models.js');
    expect(snapToGrid({ lat: 40.709, lon: -3.47 }, 0.25)).toEqual({ lat: 40.75, lon: -3.5 });
    expect(snapToGrid({ lat: 40.709, lon: -3.47 }, null)).toEqual({ lat: 40.709, lon: -3.47 });
    const gfs = (await import('../js/models.js')).MODELS.find(m => m.label === 'GFS');
    expect(gfs.grid).toBe(0.25);
    await forecastRoute(profile, f);
  });
});
