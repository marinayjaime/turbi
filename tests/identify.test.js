// Vuelo comercial → avión físico (hex ICAO) cuando el indicativo operativo no es OACI + número (p. ej. Ryanair).
// Diseño: docs/turbi-roadmap.md (fase de identificación). FR2311 del 25/09/2026 solo como regresión, con datos
// observados ese día; nada del código conoce FR2311 ni RYR19HB.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { corridor, typeCompatible, identifyByZone, createHexRegistry, LIMITS } from '../server/identify.mjs';
import { adsbLimiter } from '../server/adsb.mjs';
// El limitador global de adsb.lol sin espera en las pruebas (su separación se prueba aparte, en tests/adsb.test.js).
beforeEach(() => { adsbLimiter.reset({ minIntervalMs: 0, identifyIntervalMs: 0 }); });

const PMI = [39.5517, 2.73881], LBA = [53.8659, -1.66057];
const MIN = 60000;
const dep = Date.parse('2026-09-25T07:27:00Z'); // salida de FR2311 según Aena (09:27 en Palma)
const now = dep + 30 * MIN;
const fr2311 = { al: 'FR', icao: 'RYR', n: '2311', d: '2026-09-25', o: 'PMI', a: 'LBA', sd: '09:25', ed: '2026-09-25T09:27', st: 'BOR', std: 'BOR', sta: null, ac: '738W', op: 'FR' };

// Aviones de Ryanair observados en adsb.lol a esa hora cerca de la ruta (posición, rumbo, tipo) y ruta en adsbdb.
const seen = [
  ['RYR19HB', '4d225e', 'B738', 40.94, 1.28, 338, 35500, 'PMI', 'LBA'],
  ['RYR393A', '4d2214', 'B738', 43.50, 2.22, 327, 23400, 'PGF', 'STN'],
  ['RYR5UM', '4ca111', 'B738', 42.30, 1.90, 350, 36000, 'ALC', 'HEL'],
  ['RYR6PG', '4ca222', 'B738', 41.40, 2.00, 343, 34000, 'AGP', 'RAK'],
  ['RYR16KD', '4cad3d', 'B38M', 40.76, 1.25, 15, 34000, 'ALC', 'BRE'],
  ['RYR18HJ', '4d2243', 'B738', 43.76, 2.82, 174, 33300, 'XXX', 'YYY'],
  ['RYR1MC', '4ca27c', 'B738', 45.32, 0.90, 355, 34000, 'REU', 'CRL'],
];
const ac = ([flight, hex, t, lat, lon, track, alt]) => ({ flight: `${flight} `, hex, t, lat, lon, track, alt_baro: alt, gs: 450, seen: 1, seen_pos: 1 });
// Falso adsb.lol + adsbdb que cuenta las llamadas.
function apis({ aircraft = seen, routes = Object.fromEntries(seen.map(s => [s[0], [s[7], s[8]]])), failRoute = [] } = {}) {
  const calls = { point: 0, hex: 0, callsign: 0, adsbdb: 0 };
  const fetchFn = vi.fn(async url => {
    let body;
    if (url.includes('/v2/point/')) { calls.point++; body = { ac: aircraft.map(ac) }; }
    else if (url.includes('/v2/hex/')) { calls.hex++; const h = url.split('/').pop(); body = { ac: aircraft.filter(a => a[1] === h).map(ac) }; }
    else if (url.includes('/v2/callsign/')) { calls.callsign++; body = { ac: [] }; }
    else if (url.includes('adsbdb')) {
      calls.adsbdb++;
      const cs = url.split('/').pop();
      if (failRoute.includes(cs)) return { ok: false, status: 500 };
      const r = routes[cs];
      body = { response: r ? { flightroute: { origin: { iata_code: r[0] }, destination: { iata_code: r[1] } } } : 'unknown callsign' };
    }
    return { ok: true, json: async () => body };
  });
  return { fetchFn, calls };
}
const ctx = over => ({ leg: fr2311, legs: [fr2311], origin: PMI, dest: LBA, nowMs: now, pauseMs: 0, ...over });

describe('pasillo de la ruta y coherencia física', () => {
  it('FR2311 (observado): a 93 km de la línea recta y 175 km recorridos en 30 min → dentro', () => {
    const c = corridor({ origin: PMI, dest: LBA, lat: 40.94, lon: 1.28, track: 338, elapsedMin: 30 });
    expect(c.ok).toBe(true);
    expect(Math.round(c.crossKm)).toBe(-93);
  });
  it('fuera del pasillo lateral (> 120 km) → fuera', () => {
    expect(corridor({ origin: PMI, dest: LBA, lat: 41.0, lon: 4.9, track: 340, elapsedMin: 30 }).reason).toBe('lateral');
  });
  it('más lejos de lo que permite volar en ese tiempo (> 1.100 km/h + 50 km) → imposible', () => {
    expect(corridor({ origin: PMI, dest: LBA, lat: 47.5, lon: 0.9, track: 340, elapsedMin: 30 }).reason).toBe('demasiado-lejos');
  });
  it('detrás del origen o pasado el destino → fuera', () => {
    expect(corridor({ origin: PMI, dest: LBA, lat: 38.8, lon: 3.1, track: 340, elapsedMin: 30 }).reason).toBe('fuera-de-tramo');
    expect(corridor({ origin: PMI, dest: LBA, lat: 54.6, lon: -1.9, track: 340, elapsedMin: 400 }).reason).toBe('fuera-de-tramo');
  });
  it('rumbo que no va hacia el destino (> 60°) → fuera', () => {
    expect(corridor({ origin: PMI, dest: LBA, lat: 41.4, lon: 2.0, track: 170, elapsedMin: 30 }).reason).toBe('rumbo');
  });
});

describe('tipo de avión compatible con el de Aena', () => {
  it('738W (Aena) ↔ B738 (ADS-B) sí; B38M (MAX 8) no; tipo desconocido no', () => {
    expect(typeCompatible('738W', 'B738')).toBe(true);
    expect(typeCompatible('73H', 'B738')).toBe(true);
    expect(typeCompatible('738W', 'B38M')).toBe(false);
    expect(typeCompatible(null, 'B738')).toBe(false);
    expect(typeCompatible('738W', undefined)).toBe(false);
  });
});

describe('identificación por zona (excepcional y conservadora)', () => {
  it('FR2311 (regresión): un único candidato cumple ruta adsbdb + tipo + pasillo + física → su hex', async () => {
    const { fetchFn, calls } = apis();
    const r = await identifyByZone({ ...ctx(), fetchFn });
    expect(r).toEqual({ state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' });
    expect(calls.point).toBeLessThanOrEqual(LIMITS.maxZoneCalls);
    expect(calls.adsbdb).toBeLessThanOrEqual(LIMITS.maxCandidates);
  });
  it('dos candidatos plausibles con la misma ruta → no se elige ninguno', async () => {
    const { fetchFn } = apis({ routes: { RYR19HB: ['PMI', 'LBA'], RYR6PG: ['PMI', 'LBA'] } });
    expect((await identifyByZone({ ...ctx(), fetchFn })).state).toBe('ambiguo');
  });
  it('ruta correcta pero tipo incompatible (MAX 8 frente al 737-800 de Aena) → sin-datos', async () => {
    const { fetchFn } = apis({ aircraft: seen.map(s => (s[0] === 'RYR19HB' ? [...s.slice(0, 2), 'B38M', ...s.slice(3)] : s)) });
    expect((await identifyByZone({ ...ctx(), fetchFn })).state).toBe('sin-datos');
  });
  it('adsbdb no confirma la ruta exacta (o no responde) → sin-datos / no-disponible', async () => {
    expect((await identifyByZone({ ...ctx(), fetchFn: apis({ routes: { RYR19HB: ['PMI', 'EMA'] } }).fetchFn })).state).toBe('sin-datos');
    expect((await identifyByZone({ ...ctx(), fetchFn: apis({ failRoute: ['RYR19HB'] }).fetchFn })).state).toBe('no-disponible');
  });
  it('Aena tiene otro vuelo de la misma aerolínea y ruta en la franja → no se intenta', async () => {
    const other = { ...fr2311, n: '2313', sd: '10:10', ed: '2026-09-25T10:12' };
    const { fetchFn, calls } = apis();
    expect((await identifyByZone({ ...ctx({ legs: [fr2311, other] }), fetchFn })).state).toBe('ambiguo');
    expect(calls.point).toBe(0);
  });
  it('sin salida confirmada (antes de salida + 15 min), sin operadora o sin tipo de Aena → no se intenta', async () => {
    // Regla de radarGate (25/09/2026): sin confirmación de Aena, la identificación solo desde la salida más reciente + 15 min.
    const cases = [[{ ...fr2311, st: 'EMB', std: 'EMB' }, dep + 10 * MIN], [{ ...fr2311, op: undefined }, now], [{ ...fr2311, ac: null }, now]];
    for (const [leg, nowMs] of cases) {
      const { fetchFn, calls } = apis();
      expect((await identifyByZone({ ...ctx({ leg, legs: [leg], nowMs }), fetchFn })).state).toBe('no-aplica');
      expect(calls.point).toBe(0);
    }
  });
  it('demasiados candidatos locales (> máximo) → ambiguo sin inundar adsbdb', async () => {
    const many = Array.from({ length: LIMITS.maxCandidates + 3 }, (_, i) => [`RYR9${i}X`, `4f00${i}`, 'B738', 41 + i * 0.05, 1.5, 340, 35000, 'PMI', 'LBA']);
    const { fetchFn, calls } = apis({ aircraft: many });
    expect((await identifyByZone({ ...ctx(), fetchFn })).state).toBe('ambiguo');
    expect(calls.adsbdb).toBe(0);
  });
  it('nunca más consultas por zona que el máximo, aunque la ruta sea larga', async () => {
    const { fetchFn, calls } = apis({ aircraft: [] });
    await identifyByZone({ ...ctx({ nowMs: dep + 300 * MIN }), fetchFn });
    expect(calls.point).toBeLessThanOrEqual(LIMITS.maxZoneCalls);
  });
});

describe('registro vuelo → hex: seguimiento, reutilización, invalidación y enfriamiento', () => {
  const phys = 'PMI|LBA|2026-09-25|09:25';
  it('una vez identificado, se sigue solo por /hex/ (y lo comparten los códigos compartidos)', async () => {
    const reg = createHexRegistry();
    const { fetchFn, calls } = apis();
    const first = await reg.resolve(phys, () => identifyByZone({ ...ctx(), fetchFn }), now);
    expect(first).toMatchObject({ hex: '4d225e' });
    const pointsAfterId = calls.point;
    expect((await reg.resolve(phys, () => { throw new Error('no debe repetirse'); }, now + 5 * MIN)).hex).toBe('4d225e');
    expect(calls.point).toBe(pointsAfterId);
  });
  it('si falla: 10 min sin reintentar; después, un solo reintento', async () => {
    const reg = createHexRegistry();
    const attempt = vi.fn(async () => ({ state: 'sin-datos' }));
    expect(await reg.resolve(phys, attempt, now)).toBeNull();
    expect(await reg.resolve(phys, attempt, now + 9 * MIN)).toBeNull();
    expect(attempt).toHaveBeenCalledTimes(1);
    await reg.resolve(phys, attempt, now + LIMITS.cooldownMin * MIN + 1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
  it('dos usuarios a la vez → una sola identificación', async () => {
    const reg = createHexRegistry();
    let release;
    const attempt = vi.fn(() => new Promise(r => { release = () => r({ state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' }); }));
    const a = reg.resolve(phys, attempt, now), b = reg.resolve(phys, attempt, now);
    release();
    expect((await a).hex).toBe('4d225e');
    expect((await b).hex).toBe('4d225e');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
  it('búsquedas por zona de vuelos distintos nunca a la vez (una detrás de otra)', async () => {
    const reg = createHexRegistry();
    let running = 0, max = 0;
    const slow = () => new Promise(r => { running++; max = Math.max(max, running); setTimeout(() => { running--; r({ state: 'sin-datos' }); }, 5); });
    await Promise.all(['A', 'B', 'C'].map(k => reg.resolve(k, slow, now)));
    expect(max).toBe(1);
  });
  it('si el hex deja de ser coherente, se invalida y no se reasigna otro enseguida', async () => {
    const reg = createHexRegistry();
    await reg.resolve(phys, async () => ({ state: 'identificado', hex: '4d225e', callsign: 'RYR19HB' }), now);
    reg.invalidate(phys, now + 20 * MIN);
    const attempt = vi.fn(async () => ({ state: 'identificado', hex: '4d9999', callsign: 'RYR77ZZ' }));
    expect(await reg.resolve(phys, attempt, now + 21 * MIN)).toBeNull();
    expect(attempt).not.toHaveBeenCalled();
  });
});
