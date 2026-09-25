import { describe, it, expect, vi } from 'vitest';
import { needsRadar, findOnRadar } from '../server/radar.mjs';

const leg = over => ({ al: 'EI', icao: 'EIN', n: '737', d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
const now = Date.parse('2026-09-24T21:00:00Z'); // 23:00 en Palma
const plane = over => ({ hex: 'abc', flight: 'EIN737  ', alt_baro: 15775, gs: 361.4, lat: 52.95, lon: -6.66, seen: 1, ...over });
const radar = ac => vi.fn(async () => ({ ok: true, json: async () => ({ ac }) }));
const find = (f, over) => findOnRadar({ leg: leg(over), fetchFn: f, pauseMs: 0 });

describe('cuándo se mira el radar', () => {
  it('solo si Aena dice que ha salido y no informa de la llegada', () => {
    expect(needsRadar(leg(), now)).toBe(true);
    expect(needsRadar(leg({ sta: 'FLY' }), now)).toBe(false); // destino español: lo dice Aena
    expect(needsRadar(leg({ std: 'EMB', st: 'EMB' }), now)).toBe(false);
    expect(needsRadar(leg({ d: '2026-09-23', ed: '2026-09-23T08:00' }), now)).toBe(false); // hace más de 20 h
    expect(needsRadar(leg({ icao: null }), now)).toBe(false);
  });
});

describe('buscar el vuelo en el radar (solo su indicativo exacto)', () => {
  it('una sola consulta, por el indicativo del vuelo buscado (EIN737)', async () => {
    const f = radar([plane()]);
    expect(await find(f)).toMatchObject({ state: 'volando', callsign: 'EIN737', altM: 4808, altFt: 15775, kmh: 669, seenS: 1 });
    expect(f.mock.calls.map(c => c[0])).toEqual(['https://api.adsb.lol/v2/callsign/EIN737']);
  });
  it('no está en el radar (o emite con otro indicativo): sin datos, no se deduce nada', async () => {
    expect(await find(radar([]))).toEqual({ state: 'sin-datos', callsign: 'EIN737' });
  });
  it('en tierra: no se dice que vuela', async () => {
    expect((await find(radar([plane({ alt_baro: 'ground' })]))).state).toBe('sin-datos');
  });
  it('señal de hace más de 3 min: no cuenta', async () => {
    expect((await find(radar([plane({ seen: 200 })]))).state).toBe('sin-datos');
  });
  it('ante un 429 reintenta; si sigue fallando: no disponible (nunca un error hacia la app)', async () => {
    let n = 0;
    const ok = radar([plane()]);
    expect((await find(vi.fn(async (u, o) => (++n === 1 ? { ok: false, status: 429 } : ok(u, o))))).state).toBe('volando');
    expect((await find(vi.fn(async () => { throw new TypeError('fetch failed'); }))).state).toBe('no-disponible');
  });
  it('código compartido: prueba también los números del mismo vuelo (el avión emite con el de la operadora)', async () => {
    const f = vi.fn(async url => ({ ok: true, json: async () => ({ ac: url.endsWith('IBE5810') ? [plane({ flight: 'IBE5810' })] : [] }) }));
    const la = leg({ al: 'LA', icao: 'LAN', n: '1664', a: 'LYS' });
    const r = await findOnRadar({ leg: la, siblings: [la, leg({ al: 'IB', icao: 'IBE', n: '5810', a: 'LYS' }), la], fetchFn: f, pauseMs: 0 });
    expect(r).toMatchObject({ state: 'volando', callsign: 'IBE5810' });
    expect(f.mock.calls.map(c => c[0].split('/').pop())).toEqual(['LAN1664', 'IBE5810']);
  });
  it('datos ADS-B directos: distancia que queda, velocidad vertical (baro_rate) y hora de la señal; sin ETA propia', async () => {
    // Avión a 52.95, -6.66; Dublín en 53.4213, -6.27007 → 58 km
    const r = await findOnRadar({ leg: leg(), fetchFn: radar([plane({ baro_rate: -1216 })]), pauseMs: 0, dest: [53.4213, -6.27007] });
    expect(r).toMatchObject({ remainingKm: 58, vRateFpm: -1216 });
    expect(r.etaMin).toBeUndefined(); // la llegada estimada la calcula la app (js/eta.js), con suavizado
  });
  it('sin baro_rate usa geom_rate; sin ninguno, null; sin destino, sin distancia', async () => {
    expect((await findOnRadar({ leg: leg(), fetchFn: radar([plane({ geom_rate: 832 })]), pauseMs: 0 })).vRateFpm).toBe(832);
    const r = await findOnRadar({ leg: leg(), fetchFn: radar([plane()]), pauseMs: 0 });
    expect(r.vRateFpm).toBeNull();
    expect(r.remainingKm).toBeUndefined();
  });
  it('lleva un User-Agent con contacto (adsb.lol rechaza los genéricos con 403)', async () => {
    const f = radar([plane()]);
    await find(f);
    expect(f.mock.calls[0][1].headers['User-Agent']).toMatch(/^Turbi\/.+github\.com\/marinayjaime\/turbi/);
  });
});
