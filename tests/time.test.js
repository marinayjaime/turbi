import { describe, it, expect } from 'vitest';
import { localToUtcMs, formatLocal, offsetSecAt } from '../js/time.js';

const MAD = 'Europe/Madrid';

describe('time', () => {
  it('convierte hora local de Madrid en verano (UTC+2) a UTC', () => {
    expect(localToUtcMs('2026-09-25', '07:15', MAD)).toBe(Date.parse('2026-09-25T05:15:00Z'));
  });
  it('cruza el día hacia atrás', () => {
    expect(localToUtcMs('2026-09-25', '01:00', MAD)).toBe(Date.parse('2026-09-24T23:00:00Z'));
  });
  it('usa el desfase de la fecha del vuelo, no el de hoy (cambio de hora de octubre)', () => {
    expect(localToUtcMs('2026-10-26', '10:00', MAD)).toBe(Date.parse('2026-10-26T09:00:00Z'));
  });
  it('cambio de hora de marzo', () => {
    expect(localToUtcMs('2026-03-28', '10:00', MAD)).toBe(Date.parse('2026-03-28T09:00:00Z'));
    expect(localToUtcMs('2026-03-29', '10:00', MAD)).toBe(Date.parse('2026-03-29T08:00:00Z'));
  });
  it('offsetSecAt da el desfase en ese instante', () => {
    expect(offsetSecAt(MAD, Date.parse('2026-09-25T05:15:00Z'))).toBe(7200);
    expect(offsetSecAt(MAD, Date.parse('2026-12-01T12:00:00Z'))).toBe(3600);
    expect(offsetSecAt('America/New_York', Date.parse('2026-12-01T12:00:00Z'))).toBe(-18000);
    expect(offsetSecAt('UTC', Date.parse('2026-12-01T12:00:00Z'))).toBe(0);
  });
  it('formatea en hora local de la zona', () => {
    expect(formatLocal(Date.parse('2026-09-25T05:15:00Z'), MAD)).toBe('07:15');
    expect(formatLocal(Date.parse('2026-09-25T23:30:00Z'), 'Europe/London')).toBe('00:30');
    expect(formatLocal(Date.parse('2026-10-26T09:00:00Z'), MAD)).toBe('10:00');
  });
});
