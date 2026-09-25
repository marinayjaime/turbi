import { describe, it, expect, vi } from 'vitest';
import { HOURLY_VARS, hourKey, neighbours, fetchLocations, fetchRouteWeather } from '../js/weather.js';

const T0 = Date.parse('2026-09-25T22:00:00Z');
const HOURS = ['2026-09-25T21:00', '2026-09-25T22:00', '2026-09-25T23:00', '2026-09-26T00:00', '2026-09-26T01:00'];

// Ubicación falsa de Open-Meteo: cada variable vale (índice de hora) + base.
function fakeLocation(base = 0, elevation = 50) {
  const hourly = { time: HOURS };
  for (const v of HOURLY_VARS) hourly[v] = HOURS.map((_, i) => base + i);
  return { elevation, hourly };
}
// fetch falso: devuelve tantas ubicaciones como latitudes haya en la URL.
function fakeFetch({ single = false } = {}) {
  return vi.fn(async url => {
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const body = Array.from({ length: n }, (_, i) => fakeLocation(i * 100));
    return { ok: true, status: 200, json: async () => (single && n === 1 ? body[0] : body) };
  });
}

describe('hourKey', () => {
  it('redondea a la hora más cercana en UTC', () => {
    expect(hourKey(Date.parse('2026-09-25T22:20:00Z'))).toBe('2026-09-25T22:00');
    expect(hourKey(Date.parse('2026-09-25T22:30:00Z'))).toBe('2026-09-25T23:00');
  });
  it('salta de día al cruzar medianoche', () => {
    expect(hourKey(Date.parse('2026-09-25T23:40:00Z'))).toBe('2026-09-26T00:00');
  });
});

describe('neighbours', () => {
  it('coloca los vecinos a ~50 km', () => {
    const nb = neighbours({ lat: 40, lon: 3 });
    expect(nb.n.lat - 40).toBeCloseTo(50 / 111.32, 6);
    expect(nb.s.lon).toBe(3);
    expect(nb.e.lon - 3).toBeCloseTo(50 / (111.32 * Math.cos(40 * Math.PI / 180)), 6);
    expect(nb.w.lat).toBe(40);
  });
});

describe('fetchLocations', () => {
  it('pide las variables, en m/s y GMT, con una hora de margen', async () => {
    const f = fakeFetch();
    await fetchLocations([{ lat: 40, lon: 3 }], T0, T0 + 3600000, f);
    const u = new URL(f.mock.calls[0][0]);
    expect(u.origin + u.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(u.searchParams.get('hourly')).toBe(HOURLY_VARS.join(','));
    expect(u.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(u.searchParams.get('timezone')).toBe('GMT');
    expect(u.searchParams.get('start_hour')).toBe('2026-09-25T21:00');
    expect(u.searchParams.get('end_hour')).toBe('2026-09-26T00:00');
  });
  it('acepta respuesta de objeto único', async () => {
    const r = await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, fakeFetch({ single: true }));
    expect(r).toHaveLength(1);
  });
  it('trocea en peticiones de 100 ubicaciones', async () => {
    const f = fakeFetch();
    const locs = Array.from({ length: 150 }, (_, i) => ({ lat: 40, lon: i / 100 }));
    const r = await fetchLocations(locs, T0, T0, f);
    expect(f).toHaveBeenCalledTimes(2);
    expect(r).toHaveLength(150);
  });
  it('429: mensaje de esperar un minuto', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429 }));
    await expect(fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f))
      .rejects.toThrow('Demasiadas consultas seguidas: espera un minuto y vuelve a intentarlo.');
  });
  it('lanza error legible si Open-Meteo falla', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f))
      .rejects.toThrow('No se pudo obtener el pronóstico (HTTP 503)');
  });
});

describe('fetchRouteWeather', () => {
  it('añade vecinos solo en crucero y toma la hora más cercana a cada punto', async () => {
    const route = {
      departureMs: T0, arrivalMs: T0 + 2 * 3600000,
      points: [
        { lat: 40, lon: 3, time: T0, phase: 'climb' },
        { lat: 41, lon: 3, time: T0 + 100 * 60000, phase: 'cruise' }, // 23:40 → 00:00 del día siguiente
      ],
    };
    const f = fakeFetch();
    const w = await fetchRouteWeather(route, f);
    expect(w).toHaveLength(2);
    expect(w[0].n).toBeUndefined();
    // punto 0 → ubicación 0 (base 0), hora 22:00 = índice 1
    expect(w[0].center.cape).toBe(1);
    expect(w[0].center.elevation).toBe(50);
    // punto 1 → ubicación 1 (base 100), vecinos 2..5; hora 00:00 = índice 3
    expect(w[1].center.cape).toBe(103);
    expect(w[1].n.wind_speed_250hPa).toBe(203);
    expect(w[1].w.wind_speed_250hPa).toBe(503);
  });
  it('lanza error si la hora no está en los datos', async () => {
    const route = { departureMs: T0, arrivalMs: T0, points: [{ lat: 40, lon: 3, time: T0 + 10 * 3600000, phase: 'climb' }] };
    await expect(fetchRouteWeather(route, fakeFetch())).rejects.toThrow('No hay pronóstico para esa hora');
  });
});

describe('errores reintentables', () => {
  it('los fallos de Open-Meteo se marcan como reintentables', async () => {
    for (const status of [429, 503]) {
      const err = await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, vi.fn(async () => ({ ok: false, status }))).catch(e => e);
      expect(err.retryable).toBe(true);
    }
    const e500 = await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, vi.fn(async () => ({ ok: false, status: 500 }))).catch(e => e);
    expect(e500.retryable).toBe(true);
  });
});

describe('fallos momentáneos de Open-Meteo', () => {
  const okBody = { ok: true, status: 200, json: async () => [fakeLocation()] };
  it('un corte de red se reintenta y la consulta sale bien', async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(okBody);
    await expect(fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f)).resolves.toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('un 503 se reintenta', async () => {
    const f = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(okBody);
    await expect(fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f)).resolves.toHaveLength(1);
  });
  it('si sigue fallando, el mensaje dice qué servicio falla', async () => {
    const f = vi.fn(async () => { throw new TypeError('Load failed'); });
    const err = await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f).catch(e => e);
    expect(err.message).toBe('No se pudo conectar con el servicio del tiempo (Open-Meteo). Revisa la conexión e inténtalo de nuevo.');
    expect(err.retryable).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('429 no se reintenta al momento (es el cupo)', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429 }));
    await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f).catch(() => {});
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('cada petición lleva tiempo límite', async () => {
    const f = vi.fn(async () => okBody);
    await fetchLocations([{ lat: 40, lon: 3 }], T0, T0, f);
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('caché de Open-Meteo y Retry-After', () => {
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  it('la misma consulta (misma URL: ruta, horario y modelo) no se repite: Actualizar reutiliza el pronóstico', async () => {
    const f = vi.fn(async () => ok([fakeLocation()]));
    await fetchLocations([{ lat: 39.55, lon: 2.73 }], T0, T0, f);
    await fetchLocations([{ lat: 39.55, lon: 2.73 }], T0, T0, f);
    expect(f).toHaveBeenCalledTimes(1);
    await fetchLocations([{ lat: 53.42, lon: -6.27 }], T0, T0, f); // otra consulta: sí se pide
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('la caché caduca a los 45 min (los modelos se actualizan)', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00Z') });
    try {
      const f = vi.fn(async () => ok([fakeLocation()]));
      await fetchLocations([{ lat: 39.55, lon: 2.73 }], T0, T0, f);
      vi.setSystemTime(Date.parse('2026-09-25T10:44:00Z'));
      await fetchLocations([{ lat: 39.55, lon: 2.73 }], T0, T0, f);
      expect(f).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.parse('2026-09-25T10:46:00Z'));
      await fetchLocations([{ lat: 39.55, lon: 2.73 }], T0, T0, f);
      expect(f).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('los errores no se guardan en la caché', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1 ? { ok: false, status: 500 } : ok([fakeLocation()])));
    await expect(fetchLocations([{ lat: 1, lon: 1 }], T0, T0, f)).resolves.toHaveLength(1); // 500 → reintento → bien
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('429 con Retry-After: no se vuelve a llamar a Open-Meteo hasta que pase ese tiempo', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00Z') });
    try {
      let status = 429;
      const f = vi.fn(async () => (status === 429 ? { ok: false, status: 429, headers: { get: k => (k.toLowerCase() === 'retry-after' ? '30' : null) } } : ok([fakeLocation()])));
      const err = await fetchLocations([{ lat: 2, lon: 2 }], T0, T0, f).catch(e => e);
      expect(err.message).toMatch(/Demasiadas consultas/);
      expect(err.retryAfterMs).toBe(30000);
      status = 200;
      vi.setSystemTime(Date.parse('2026-09-25T10:00:20Z'));
      await expect(fetchLocations([{ lat: 3, lon: 3 }], T0, T0, f)).rejects.toThrow(/Demasiadas consultas/); // en pausa: ni se pide
      expect(f).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.parse('2026-09-25T10:00:31Z'));
      await expect(fetchLocations([{ lat: 3, lon: 3 }], T0, T0, f)).resolves.toHaveLength(1);
      expect(f).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('429 sin Retry-After: pausa de 60 s', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-25T10:00:00Z') });
    try {
      const f = vi.fn(async () => ({ ok: false, status: 429 }));
      expect((await fetchLocations([{ lat: 4, lon: 4 }], T0, T0, f).catch(e => e)).retryAfterMs).toBe(60000);
    } finally { vi.useRealTimers(); }
  });
});
