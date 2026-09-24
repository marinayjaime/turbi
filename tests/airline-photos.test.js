import { describe, it, expect, vi } from 'vitest';
import { photoFor, operatorName, loadAirlinePhotos } from '../js/airline-photos.js';

const db = {
  airlines: { YW: 'Air Nostrum', FR: 'Ryanair' },
  photos: { 'FR|Boeing 737-800': { thumb: 't', artist: 'a', license: 'l', page: 'p' }, 'FR|Boeing 737 MAX 8': null },
};

describe('foto real de la operadora y el modelo', () => {
  it('solo si Aena dice quién opera y hay foto de esa aerolínea con ese modelo', () => {
    expect(photoFor(db, { op: 'FR', ac: '73H' })).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p' });
    expect(photoFor(db, { op: 'FR', ac: '7M8' })).toBeNull(); // sin foto de Ryanair con ese modelo: nada
    expect(photoFor(db, { ac: '73H' })).toBeNull(); // operadora dudosa y sin número buscado: nada
    expect(photoFor(db, { op: 'FR', ac: 'XYZ' })).toBeNull();
    expect(photoFor(null, { op: 'FR', ac: '73H' })).toBeNull();
  });
  it('código compartido (Aena no dice quién opera): foto de la aerolínea del número buscado, marcada como tal', () => {
    expect(photoFor(db, { ac: '73H' }, 'FR')).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p', shared: true });
    expect(photoFor(db, { ac: '7M8' }, 'FR')).toBeNull(); // esa aerolínea no tiene foto de ese modelo
    expect(photoFor(db, { op: 'FR', ac: '73H' }, 'IB')).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p' }); // si Aena dice quién opera, manda Aena
  });
  it('«Operado por» solo si opera otra aerolínea', () => {
    expect(operatorName(db, { al: 'IB', op: 'YW' })).toBe('Air Nostrum');
    expect(operatorName(db, { al: 'FR', op: 'FR' })).toBeNull();
    expect(operatorName(db, { al: 'IB' })).toBeNull();
    expect(operatorName(db, { al: 'IB', op: 'ZZ' })).toBe('ZZ');
  });
  it('si no se puede cargar el archivo: null (la ficha sale sin foto)', async () => {
    expect(await loadAirlinePhotos(vi.fn(async () => { throw new TypeError('x'); }))).toBeNull();
  });
});
