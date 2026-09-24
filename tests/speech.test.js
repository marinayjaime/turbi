import { describe, it, expect } from 'vitest';
import { buildSpeech } from '../js/speech.js';

describe('buildSpeech', () => {
  it('ejemplo del documento', () => {
    const text = buildSpeech({ from: 'Palma', to: 'Madrid', summary: { headline: 'Mayormente tranquilo', maxLevel: 1, maxDurationMin: 5, moments: [{ startMin: 40, endMin: 45 }] }, confidence: 'alta' });
    expect(text).toBe('Tu vuelo entre Palma y Madrid se espera mayoritariamente tranquilo. Se prevé un tramo corto de turbulencia ligera aproximadamente 40 minutos después del despegue. Confianza alta.');
  });
  it('tranquilo, sin tramos', () => {
    expect(buildSpeech({ from: 'Palma', to: 'Barcelona', summary: { headline: 'Tranquilo', maxLevel: 0, moments: [] }, confidence: 'media' }))
      .toBe('Tu vuelo entre Palma y Barcelona se espera tranquilo. Confianza media.');
  });
  it('turbulento y tramo largo', () => {
    expect(buildSpeech({ from: 'Palma', to: 'Madrid', summary: { headline: 'Turbulento', maxLevel: 2, maxDurationMin: 25, moments: [{ startMin: 30, endMin: 55 }] }, confidence: null }))
      .toBe('Tu vuelo entre Palma y Madrid puede tener tramos de turbulencia. Se prevé turbulencia moderada durante unos 25 minutos, aproximadamente 30 minutos después del despegue.');
  });
});
