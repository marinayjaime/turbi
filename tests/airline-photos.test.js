import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { photoFor, operatorName, loadAirlinePhotos, adbModel } from '../js/airline-photos.js';

const db = {
  airlines: { YW: 'Air Nostrum', FR: 'Ryanair' },
  photos: { 'FR|Boeing 737-800': { thumb: 't', artist: 'a', license: 'l', page: 'p' }, 'FR|Boeing 737 MAX 8': null,
    'EI|Airbus A320': { thumb: 'ei320', artist: 'b', license: 'l', page: 'p' }, 'EI|Airbus A330-300': { thumb: 'ei333', artist: 'c', license: 'l', page: 'p' } },
};

describe('foto real de la operadora y el modelo', () => {
  it('solo si Aena dice quién opera y hay foto de esa aerolínea con ese modelo', () => {
    expect(photoFor(db, { op: 'FR', ac: '73H' })).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p' });
    expect(photoFor(db, { op: 'FR', ac: '7M8' })).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p', representative: true }); // sin foto de ese modelo: una de la aerolínea, rotulada
    expect(photoFor(db, { ac: '73H' })).toBeNull(); // operadora dudosa y sin número buscado: nada
    expect(photoFor(db, { op: 'ZZ', ac: '73H' })).toBeNull(); // aerolínea sin ninguna foto
    expect(photoFor(null, { op: 'FR', ac: '73H' })).toBeNull();
  });
  it('código compartido (Aena no dice quién opera): foto de la aerolínea del número buscado, marcada como tal', () => {
    expect(photoFor(db, { ac: '73H' }, 'FR')).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p', shared: true });
    expect(photoFor(db, { ac: '7M8' }, 'FR')).toMatchObject({ thumb: 't', representative: true, shared: true });
    expect(photoFor(db, { op: 'FR', ac: '73H' }, 'IB')).toEqual({ thumb: 't', artist: 'a', license: 'l', page: 'p' }); // si Aena dice quién opera, manda Aena
  });
  it('modelo desconocido (p. ej. vuelo del histórico sin tipo de avión): foto genérica verificada de esa aerolínea, rotulada', () => {
    expect(photoFor(db, { ac: null }, 'EI')).toEqual({ thumb: 'ei320', artist: 'b', license: 'l', page: 'p', representative: true, shared: true });
    expect(photoFor(db, { op: 'EI', ac: null }, 'EI')).toEqual({ thumb: 'ei320', artist: 'b', license: 'l', page: 'p', representative: true });
    expect(photoFor(db, { ac: null }, 'ZZ')).toBeNull();
  });
  it('prioridad: operadora + modelo exacto > aerolínea del número + modelo > genérica de la aerolínea', () => {
    expect(photoFor(db, { op: 'EI', ac: '333' }, 'EI').thumb).toBe('ei333');
    expect(photoFor(db, { ac: '333' }, 'EI')).toMatchObject({ thumb: 'ei333', shared: true });
    expect(photoFor(db, { ac: '333' }, 'EI').representative).toBeUndefined();
  });
  it('AeroDataBox (modelo en texto): mismo resultado que con el código, sin adivinar variantes ni aerolíneas', () => {
    expect(['Airbus A320 NEO', 'Boeing 737-8AS', 'Boeing 737-800', 'AgustaWestland AW139', 'Airbus A330', 'Boeing 737-8200', null].map(adbModel))
      .toEqual(['Airbus A320neo', 'Boeing 737-800', 'Boeing 737-800', 'Helicóptero AW139', 'Airbus A330', 'Boeing 737-8200', null]);
    expect(photoFor(db, { op: 'FR', model: adbModel('Boeing 737-8AS') })).toEqual(photoFor(db, { op: 'FR', ac: '73H' })); // exacta
    expect(photoFor(db, { op: 'EI', model: adbModel('Airbus A330') })).toMatchObject({ thumb: 'ei320', representative: true }); // genérico
    expect(photoFor(db, { op: 'ZZ', model: 'Boeing 737-800' })).toBeNull(); // nunca la de otra aerolínea con ese modelo
  });
  it('«Operado por» con el código de la aerolínea buscada (los tramos publicados no lo llevan)', () => {
    expect(operatorName(db, { op: 'FR' }, 'FR')).toBeNull();
    expect(operatorName(db, { op: 'YW' }, 'IB')).toBe('Air Nostrum');
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

// Cada copia de img/fotos-verificadas es la que --publish generó de su original y lleva sus mismos créditos
// (data/airline-photos-manifest.json). Así una copia cambiada a mano, o unos créditos de otra foto, no pasan en silencio.
describe('fotos verificadas publicadas: copia y créditos de la misma fuente', () => {
  it('copia ↔ manifiesto ↔ data/airline-photos.json', () => {
    const manifest = JSON.parse(readFileSync('data/airline-photos-manifest.json', 'utf8'));
    const { photos } = JSON.parse(readFileSync('data/airline-photos.json', 'utf8'));
    const files = readdirSync('img/fotos-verificadas').filter(f => /\.jpe?g$/i.test(f)).map(f => f.normalize('NFC'));
    expect(files.sort()).toEqual(Object.keys(manifest).sort()); // ninguna copia sin fuente ni fuente sin copia
    for (const [file, m] of Object.entries(manifest)) {
      expect(createHash('sha256').update(readFileSync(`img/fotos-verificadas/${file}`)).digest('hex'), file).toBe(m.out);
      expect(photos[m.key], file).toEqual({ thumb: `img/fotos-verificadas/${encodeURIComponent(file)}`, artist: m.artist, license: m.license, page: m.page });
    }
  });
});
