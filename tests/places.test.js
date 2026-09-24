import { describe, it, expect, vi } from 'vitest';
import { nameSegments } from '../js/places.js';

const seg = (level, lat, km) => ({ level, mid: { lat, lon: 3, kmFromOrigin: km } });
const noWait = vi.fn(async () => {});

describe('nameSegments', () => {
  it('nombra solo los tramos con turbulencia y espera 1,1 s entre peticiones', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ address: { state: 'Cataluña', country: 'España' } }) }));
    const segs = [seg(0, 40, 10), seg(1, 41, 100), seg(2, 42, 200)];
    await nameSegments(segs, 'PMI', f, noWait);
    expect(segs.map(s => s.place)).toEqual([undefined, 'sobre Cataluña', 'sobre Cataluña']);
    expect(f).toHaveBeenCalledTimes(2);
    expect(noWait).toHaveBeenCalledWith(1100);
    const u = new URL(f.mock.calls[0][0]);
    expect(u.searchParams.get('accept-language')).toBe('es');
  });
  it('sobre el mar (Unable to geocode) usa km desde el origen', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ error: 'Unable to geocode' }) }));
    const segs = [seg(1, 40, 123.4)];
    await nameSegments(segs, 'PMI', f, noWait);
    expect(segs[0].place).toBe('a 123 km de PMI');
  });
  it('error de red usa km y no lanza', async () => {
    const f = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const segs = [seg(2, 40, 50)];
    await nameSegments(segs, 'BCN', f, noWait);
    expect(segs[0].place).toBe('a 50 km de BCN');
  });
  it('como mucho 5 peticiones; el resto con km', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ address: { country: 'Francia' } }) }));
    const segs = Array.from({ length: 7 }, (_, i) => seg(1, 40 + i, i * 10));
    await nameSegments(segs, 'PMI', f, noWait);
    expect(f).toHaveBeenCalledTimes(5);
    expect(segs[4].place).toBe('sobre Francia');
    expect(segs[6].place).toBe('a 60 km de PMI');
  });
});
