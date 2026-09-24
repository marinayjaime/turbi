import { describe, it, expect } from 'vitest';
import { altitudeText, altitudeRange, kmh, compass, metres, aircraftName, localHour } from '../js/plain.js';

describe('alturas para todos (km y pies, sin «FL»)', () => {
  it('un nivel', () => {
    expect(altitudeText(350)).toBe('10,7 km (35.000 pies)');
    expect(altitudeText(300)).toBe('9,1 km (30.000 pies)');
    expect(altitudeText(0)).toBe('el suelo');
  });
  it('rangos', () => {
    expect(altitudeRange(350, 350)).toBe('a unos 10,7 km (35.000 pies)');
    expect(altitudeRange(0, 360)).toBe('del suelo a unos 11 km');
    expect(altitudeRange(300, 360)).toBe('entre 9,1 y 11 km');
    expect(altitudeRange(0, 0)).toBe('cerca del suelo');
  });
});

describe('viento, nubes y horas', () => {
  it('nudos → km/h (de 5 en 5) y grados → punto cardinal', () => {
    expect(kmh(8)).toBe(15);
    expect(kmh(28)).toBe(50);
    expect(compass(230)).toBe('del suroeste');
    expect(compass(0)).toBe('del norte');
    expect(compass(350)).toBe('del norte');
    expect(compass(95)).toBe('del este');
  });
  it('pies → metros (de 50 en 50)', () => {
    expect(metres(1800)).toBe(550);
    expect(metres(800)).toBe(250);
  });
  it('hora local de una zona horaria', () => {
    expect(localHour(Date.parse('2026-09-24T13:00:00Z'), 'Europe/Madrid')).toBe('15:00');
  });
});

describe('aircraftName', () => {
  it('códigos habituales a nombres; desconocido tal cual', () => {
    expect(aircraftName('A21N')).toBe('Airbus A321neo');
    expect(aircraftName('B738')).toBe('Boeing 737-800');
    expect(aircraftName('321')).toBe('Airbus A321');
    expect(aircraftName('73H')).toBe('Boeing 737-800');
    expect(aircraftName('XYZ9')).toBe('modelo XYZ9');
    expect(aircraftName(null)).toBeNull();
  });
});

describe('modelos que publica Aena (todos los códigos vistos el 24/09/2026)', () => {
  const seen = ['320', '73H', '321', '32N', '7M8', '32Q', 'AT7', 'CRK', '32A', '319', '738W', 'A320', 'A20N', 'A21N', 'A321', 'CRJX', '788', 'B38M',
    'A32A', '789', '359', 'E90', '295', '332', 'AT75', '333', 'A319', '772', '7S8', '764', 'AT76', '32B', '223', 'B789', 'E95', 'B788', 'A32B', '339',
    'A359', '73J', 'E190', 'E295', 'A333', 'A332', 'B772', 'AWH', '388', '781', '73C', 'BCS3', '738', '77L', '77W', 'B764', 'E195', '73W', 'A339', '773',
    'B77W', '739W', '733W', '290', 'A139', '318', 'B738', 'B77L', 'A388', '763', 'A318', 'DH4', '736', '737W', '343', 'E70', '221', '76W', '73G', 'E7W', 'B78X', 'E290'];
  it('todos tienen nombre llano', () => {
    for (const c of seen) expect(aircraftName(c), c).not.toMatch(/^modelo /);
  });
  it('ejemplos', () => {
    expect(aircraftName('AT7')).toBe('ATR 72');
    expect(aircraftName('CRK')).toBe('Bombardier CRJ1000');
    expect(aircraftName('738W')).toBe('Boeing 737-800');
    expect(aircraftName('A139')).toBe('Helicóptero AW139');
  });
});
