import { describe, it, expect, vi } from 'vitest';
import { needsRadar, findOnRadar } from '../server/radar.mjs';

const leg = over => ({ al: 'EI', icao: 'EIN', n: '737', d: '2026-09-24', o: 'PMI', a: 'DUB', sd: '20:55', ed: '2026-09-24T21:10', sa: null, ea: null, st: 'BOR', std: 'BOR', sta: null, ...over });
const now = Date.parse('2026-09-24T21:00:00Z'); // 23:00 en Palma
const plane = over => ({ hex: 'abc', flight: 'EIN737  ', alt_baro: 15775, gs: 361.4, lat: 52.95, lon: -6.66, seen: 1, ...over });
const radar = ac => vi.fn(async () => ({ ok: true, json: async () => ({ ac }) }));
const find = (f, over) => findOnRadar({ leg: leg(over), fetchFn: f, pauseMs: 0 });

describe('cuándo se mira el radar', () => {
  it('también si el aeropuerto de llegada dice «en vuelo» o «aproximándose» (FLY/FNL); nunca llegado, cancelado o desviado', () => {
    expect(needsRadar(leg({ a: 'MAD', sta: 'FLY', st: 'FLY' }), now)).toBe(true);
    expect(needsRadar(leg({ a: 'MAD', sta: 'FNL', st: 'FNL' }), now)).toBe(true);
    for (const sta of ['LND', 'IBK', 'BOR', 'DES', 'CAN']) expect(needsRadar(leg({ sta }), now)).toBe(false);
  });
  it('solo si Aena dice que ha salido y no informa de la llegada', () => {
    expect(needsRadar(leg(), now)).toBe(true);
    expect(needsRadar(leg({ sta: 'LND' }), now)).toBe(false); // llegada confirmada por Aena (antes: FLY; ahora FLY sí consulta)
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
  describe('números de 1 o 2 cifras: variante con ceros (AEA015), solo como segundo intento', () => {
    const asked = f => f.mock.calls.map(c => c[0].split('/').pop());
    const only = cs => vi.fn(async url => ({ ok: true, json: async () => ({ ac: url.endsWith(`/${cs}`) ? [plane({ flight: cs })] : [] }) }));
    const ux = n => leg({ al: 'UX', icao: 'AEA', n, a: 'SCL' });
    it('UX15: primero AEA15 y después AEA015', async () => {
      const f = only('AEA015');
      expect(await findOnRadar({ leg: ux('15'), fetchFn: f, pauseMs: 0 })).toMatchObject({ state: 'volando', callsign: 'AEA015' });
      expect(asked(f)).toEqual(['AEA15', 'AEA015']);
    });
    it('UX7: también la variante a 3 cifras (AEA007)', async () => {
      const f = only('AEA007');
      expect(await findOnRadar({ leg: ux('7'), fetchFn: f, pauseMs: 0 })).toMatchObject({ callsign: 'AEA007' });
      expect(asked(f)).toEqual(['AEA7', 'AEA007']);
    });
    it('AY1676: FIN1676, sin variantes', async () => {
      const f = only('FIN1676');
      await findOnRadar({ leg: leg({ al: 'AY', icao: 'FIN', n: '1676', a: 'HEL' }), fetchFn: f, pauseMs: 0 });
      expect(asked(f)).toEqual(['FIN1676']);
    });
    it('3 cifras (UX123): sin variante innecesaria', async () => {
      const f = only('nada');
      await findOnRadar({ leg: ux('123'), fetchFn: f, pauseMs: 0 });
      expect(asked(f)).toEqual(['AEA123']);
    });
    it('si la primera variante encuentra el avión, no se consulta la segunda', async () => {
      const f = only('AEA15');
      expect(await findOnRadar({ leg: ux('15'), fetchFn: f, pauseMs: 0 })).toMatchObject({ callsign: 'AEA15' });
      expect(asked(f)).toEqual(['AEA15']);
    });
    it('si ninguna funciona: sin-datos, como antes (con el indicativo original)', async () => {
      const f = only('nada');
      expect(await findOnRadar({ leg: ux('15'), fetchFn: f, pauseMs: 0 })).toEqual({ state: 'sin-datos', callsign: 'AEA15' });
      expect(asked(f)).toEqual(['AEA15', 'AEA015']);
    });
    it('con letra final (UX15A): no se inventa ninguna variante', async () => {
      const f = only('nada');
      await findOnRadar({ leg: ux('15A'), fetchFn: f, pauseMs: 0 });
      expect(asked(f)).toEqual(['AEA15A']);
    });
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

describe('aterrizaje confirmado por ADS-B (conservador)', () => {
  // EI737 salió de Palma a las 21:10 (19:10 UTC). PMI–DUB ≈ 1.660 km → mínimo físico ≈ 105 min a 950 km/h.
  const PMI = [39.5517, 2.73881], DUB = [53.4213, -6.27007];
  const later = Date.parse('2026-09-24T22:00:00Z'); // 2 h 50 min después de la salida
  const onGround = over => plane({ flight: 'EIN737  ', alt_baro: 'ground', gs: 12, lat: 53.428, lon: -6.255, seen: 4, seen_pos: 4, ...over }); // ~1,2 km del punto de referencia
  const land = (ac, over = {}) => findOnRadar({ leg: leg(), fetchFn: radar(ac), pauseMs: 0, dest: DUB, origin: PMI, nowMs: later, ...over });
  it('«ground» cerca del destino, señal reciente, mismo indicativo → aterrizado', async () => {
    expect(await land([onGround()])).toEqual({ state: 'aterrizado', callsign: 'EIN737', seenS: 4, distanceKm: 1, source: 'adsb.lol' });
  });
  it('«ground» lejos del destino (p. ej. aún en el origen) → no', async () => {
    expect((await land([onGround({ lat: 39.55, lon: 2.73 })])).state).toBe('sin-datos');
    expect((await land([onGround({ lat: 53.52, lon: -6.27 })])).state).toBe('sin-datos'); // ~11 km: fuera de los 8 km
  });
  it('señal o posición antigua (> 120 s) → no', async () => {
    expect((await land([onGround({ seen: 150, seen_pos: 150 })])).state).toBe('sin-datos');
    expect((await land([onGround({ seen: 5, seen_pos: 170 })])).state).toBe('sin-datos');
  });
  it('poca altitud o poca velocidad pero en el aire → «volando», nunca aterrizado', async () => {
    expect((await land([onGround({ alt_baro: 800, gs: 140 })])).state).toBe('volando');
    expect((await land([onGround({ alt_baro: 3000, gs: 60 })])).state).toBe('volando');
  });
  it('desaparece del radar → sin datos, nunca aterrizado', async () => {
    expect((await land([])).state).toBe('sin-datos');
  });
  it('sin posición válida o sin coordenadas del destino → no', async () => {
    expect((await land([onGround({ lat: undefined })])).state).toBe('sin-datos');
    expect((await land([onGround()], { dest: null })).state).toBe('sin-datos');
  });
  it('otro indicativo en la respuesta → no', async () => {
    expect((await land([onGround({ flight: 'EIN7LM' })])).state).toBe('sin-datos');
  });
  it('antes del tiempo mínimo físico desde la salida (p. ej. el avión de ayer aparcado en el destino) → no', async () => {
    expect((await land([onGround()], { nowMs: Date.parse('2026-09-24T19:40:00Z') })).state).toBe('sin-datos'); // 30 min tras salir
  });
});

describe('pocas consultas a adsb.lol con códigos compartidos', () => {
  const asked = f => f.mock.calls.map(c => c[0].split('/').pop());
  const none = () => vi.fn(async () => ({ ok: true, json: async () => ({ ac: [] }) }));
  const sib = (al, icao, n, op) => leg({ al, icao, n, a: 'MAD', ...(op ? { op } : {}) });
  it('si Aena dice quién opera, solo su indicativo', async () => {
    const f = none();
    const group = ['IB|IBE|1243', 'VY|VLG|5554', 'QR|QTR|8085', 'LA|LAN|1730'].map(x => sib(...x.split('|'), 'YW'));
    group.push(sib('YW', 'ANE', '1243', 'YW'));
    await findOnRadar({ leg: group[0], siblings: group, fetchFn: f, pauseMs: 0 });
    expect(asked(f)).toEqual(['ANE1243']);
  });
  it('si no se sabe quién opera: el número buscado primero y como mucho 4 consultas en total', async () => {
    const f = none();
    const group = ['IB|IBE|1668', 'I2|IBS|1668', 'VY|VLG|5273', 'QR|QTR|5079', 'LA|LAN|1760', 'CZ|CSN|1353'].map(x => sib(...x.split('|')));
    await findOnRadar({ leg: group[0], siblings: group, fetchFn: f, pauseMs: 0 });
    expect(asked(f)).toEqual(['IBE1668', 'IBS1668', 'VLG5273', 'QTR5079']);
  });
});
