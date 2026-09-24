import { describe, it, expect } from 'vitest';
import { localToUtcMs, formatLocal } from '../js/time.js';

describe('time', () => {
  it('convierte hora local de Madrid en verano (UTC+2) a UTC', () => {
    expect(localToUtcMs('2026-09-25', '07:15', 7200)).toBe(Date.parse('2026-09-25T05:15:00Z'));
  });
  it('cruza el día hacia atrás', () => {
    expect(localToUtcMs('2026-09-25', '01:00', 7200)).toBe(Date.parse('2026-09-24T23:00:00Z'));
  });
  it('formatea en hora local', () => {
    expect(formatLocal(Date.parse('2026-09-25T05:15:00Z'), 7200)).toBe('07:15');
    expect(formatLocal(Date.parse('2026-09-25T23:30:00Z'), 3600)).toBe('00:30');
  });
});
