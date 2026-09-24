import { describe, it, expect, vi } from 'vitest';
import { summarizeMetar, summarizeTaf, sigmetsNearRoute, pirepsNearRoute, loadAviation, NO_PIREPS } from '../js/aviation-weather.js';

describe('summarizeMetar', () => {
  it('LEPA real simplificado', () => {
    const m = { raw: 'METAR LEPA 241100Z 23008KT 210V270 9999 FEW018 27/20 Q1023 NOSIG', wdir: 230, wspd: 8, wgst: null, visib: '6+', clouds: [{ cover: 'FEW', base: 1800 }], wx: '', temp: 27 };
    expect(summarizeMetar(m)).toBe('Viento del suroeste a 15 km/h · buena visibilidad · algunas nubes · 27 °C');
  });
  it('rachas, tormenta, nubes bajas, visibilidad reducida, viento variable y calma', () => {
    expect(summarizeMetar({ wdir: 'VRB', wspd: 4, visib: 2, clouds: [{ cover: 'BKN', base: 800 }], wx: 'TSRA', temp: 18 }))
      .toBe('Viento de dirección variable a 5 km/h · visibilidad reducida · tormenta con lluvia · nubes bajas (a 250 m) · 18 °C');
    expect(summarizeMetar({ wdir: 0, wspd: 0, visib: '6+', clouds: [{ cover: 'CAVOK' }] })).toBe('Viento en calma · buena visibilidad · sin nubes significativas');
    expect(summarizeMetar({ wdir: 200, wspd: 20, wgst: 35, visib: '6+', clouds: [{ cover: 'OVC', base: 3000 }] }))
      .toBe('Viento del sur a 35 km/h con rachas de 65 km/h · buena visibilidad · cielo cubierto (nubes a 900 m)');
  });
  it('sin METAR → null', () => {
    expect(summarizeMetar(null)).toBeNull();
  });
});

describe('summarizeTaf', () => {
  const H = h => Date.parse(`2026-09-24T${String(h).padStart(2, '0')}:00:00Z`) / 1000;
  it('sin fenómenos', () => {
    expect(summarizeTaf({ fcsts: [{ from: H(12), to: H(18), wspd: 4 }] })).toEqual(['Sin fenómenos significativos previstos']);
  });
  it('tormentas temporales, rachas y visibilidad, sin repetir', () => {
    const taf = { fcsts: [
      { from: H(12), to: H(23), wspd: 4 },
      { from: H(13), to: H(16), change: 'TEMPO', prob: 40, wspd: 8, wgst: 28, wx: 'TSRA' },
      { from: H(18), to: H(20), change: 'BECMG', visib: 1.5, wx: 'BR' },
    ] };
    expect(summarizeTaf(taf)).toEqual([
      'Posibles tormentas a ratos de 13:00 a 16:00 (probabilidad 40 %)',
      'Rachas de hasta 50 km/h a ratos de 13:00 a 16:00 (probabilidad 40 %)',
      'Visibilidad reducida cambiando de 18:00 a 20:00',
    ]);
  });
  it('periodo «a partir de» (FM) bien redactado', () => {
    const taf = { fcsts: [{ from: H(14), to: H(18), change: 'FM', wx: 'SHRA' }] };
    expect(summarizeTaf(taf)).toEqual(['Chubascos a partir de las 14:00']);
  });
  it('sin TAF → null', () => {
    expect(summarizeTaf(null)).toBeNull();
  });
});

const route = [{ lat: 39.55, lon: 2.74 }, { lat: 40.0, lon: 0.5 }, { lat: 40.49, lon: -3.57 }];
const DEP = Date.parse('2026-09-24T16:00:00Z'), ARR = Date.parse('2026-09-24T17:30:00Z');
const sq = (lat, lon, d) => [[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]].map(([la, lo]) => ({ lat: la, lon: lo }));

describe('sigmetsNearRoute', () => {
  const base = { hazard: 'TURB', qualifier: 'SEV', base: 30000, top: 40000, validFrom: DEP / 1000 - 3600, validTo: ARR / 1000 + 3600, raw: 'x' };
  it('cruza la ruta, o a menos de 100 km, y vigente durante el vuelo', () => {
    const crossing = { ...base, coords: sq(40.0, 0.5, 0.5) };
    const near = { ...base, coords: sq(41.0, 0.5, 0.2) }; // borde sur a ~88 km de la ruta
    const far = { ...base, coords: sq(46, 10, 0.5) };
    const expired = { ...crossing, validTo: DEP / 1000 - 60 };
    const icing = { ...crossing, hazard: 'ICE' };
    const r = sigmetsNearRoute([crossing, near, far, expired, icing], route, DEP, ARR);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ label: 'Turbulencia fuerte', levels: 'entre 9,1 y 12,2 km de altura', crosses: true });
    expect(r[1].crosses).toBe(false);
  });
  it('etiquetas en lenguaje llano', () => {
    const mtw = { ...base, hazard: 'MTW', qualifier: 'SEV', coords: sq(40.0, 0.5, 0.5) };
    expect(sigmetsNearRoute([mtw], route, DEP, ARR)[0].label).toBe('Viento fuerte sobre montañas');
  });
  it('sin coordenadas o lista vacía → []', () => {
    expect(sigmetsNearRoute([{ ...base, coords: [] }], route, DEP, ARR)).toEqual([]);
    expect(sigmetsNearRoute(null, route, DEP, ARR)).toEqual([]);
  });
});

describe('pirepsNearRoute', () => {
  const now = DEP;
  it('solo informes con turbulencia, cercanos y recientes', () => {
    const pireps = [
      { lat: 40.1, lon: 0.6, fl: 360, t: now - 3600000, int: 'MOD', raw: 'a' },
      { lat: 40.1, lon: 0.6, fl: 360, t: now - 5 * 3600000, int: 'MOD', raw: 'viejo' },
      { lat: 55, lon: -20, fl: 380, t: now - 600000, int: 'LGT', raw: 'lejos' },
      { lat: 39.6, lon: 2.6, fl: 120, t: now - 600000, int: 'NEG', raw: 'neg' },
    ];
    const r = pirepsNearRoute(pireps, route, now);
    expect(r.map(p => p.raw)).toEqual(['a', 'neg']);
    expect(r[0].label).toBe('moderada');
    expect(r[1].label).toBe('sin turbulencia');
  });
  it('mensaje cuando no hay: nunca «no hay turbulencia»', () => {
    expect(NO_PIREPS).toBe('No hay informes recientes disponibles en esta zona.');
    expect(pirepsNearRoute([], route, now)).toEqual([]);
  });
});

describe('loadAviation', () => {
  it('un archivo que falla no rompe los demás', async () => {
    const f = vi.fn(async url => (url.includes('sigmet') ? { ok: false, status: 404 } : { ok: true, json: async () => ({ updated: 'x', items: [] }) }));
    const r = await loadAviation(f);
    expect(r.sigmet).toBeNull();
    expect(r.metar).toEqual({ updated: 'x', items: [] });
  });
  it('sin red: todo null, sin excepción', async () => {
    const r = await loadAviation(vi.fn(async () => { throw new TypeError('Load failed'); }));
    expect(r).toEqual({ metar: null, taf: null, sigmet: null, pirep: null, icao: null });
  });
});

describe('SIGMET que cruza la ruta entre dos puntos', () => {
  it('un polígono pequeño entre dos puntos de la ruta cuenta como «cruza»', () => {
    const r2 = [{ lat: 40, lon: 0 }, { lat: 40, lon: 1 }];
    const small = { hazard: 'TURB', qualifier: 'SEV', validFrom: 0, validTo: 4e9, coords: sq(40, 0.5, 0.05), raw: 'x' };
    expect(sigmetsNearRoute([small], r2, 0, 1)[0]).toMatchObject({ crosses: true, distanceKm: 0 });
  });
});
