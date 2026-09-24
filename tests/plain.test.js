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
    expect(aircraftName('XYZ9')).toBe('XYZ9');
    expect(aircraftName(null)).toBeNull();
  });
});
