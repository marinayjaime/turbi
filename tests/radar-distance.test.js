// Distancia restante «en vivo» entre lecturas ADS-B reales (interpolación visual; js/radar-distance.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { distanceReference, estimateRemaining, startRemainingTicker, REMAINING_FLOOR_KM, MAX_EXTRAPOLATION_S, MIN_KMH } from '../js/radar-distance.js';

const T0 = Date.parse('2026-09-26T10:00:00Z');
const reading = over => ({ state: 'volando', remainingKm: 366, kmh: 900, seenS: 0, checked: new Date(T0).toISOString(), ...over });
beforeEach(() => vi.useFakeTimers({ now: T0 }));
afterEach(() => vi.useRealTimers());

describe('estimación de la distancia visible', () => {
  it('1) 366 km a 900 km/h: baja con el tiempo (15 km por minuto)', () => {
    const ref = distanceReference(reading(), T0);
    expect(estimateRemaining(ref, T0).km).toBe(366);
    expect(estimateRemaining(ref, T0 + 60000).km).toBe(351);
    expect(estimateRemaining(ref, T0 + 120000).km).toBe(336);
  });
  it('4) señal antigua: deja de extrapolar a los 5 min de antigüedad de la posición (seenS incluido)', () => {
    const ref = distanceReference(reading(), T0);
    const at5 = estimateRemaining(ref, T0 + MAX_EXTRAPOLATION_S * 1000);
    expect(at5).toEqual({ km: 291, moving: false });
    expect(estimateRemaining(ref, T0 + 3600000).km).toBe(291); // una hora después sigue quieta
    const old = distanceReference(reading({ seenS: 240 }), T0); // llegó ya con 4 min: solo 1 min de margen
    expect(estimateRemaining(old, T0 + 600000).km).toBe(351);
    expect(estimateRemaining(distanceReference(reading({ seenS: 400 }), T0), T0 + 60000)).toEqual({ km: 366, moving: false });
  });
  it('5) nunca negativa; y cerca del destino, freno: la extrapolación no baja de 30 km', () => {
    const ref = distanceReference(reading({ remainingKm: 40, kmh: 700 }), T0);
    expect(estimateRemaining(ref, T0 + 600000)).toEqual({ km: REMAINING_FLOOR_KM, moving: false });
    const near = distanceReference(reading({ remainingKm: 12, kmh: 400 }), T0); // lectura real ya por debajo del freno
    expect(estimateRemaining(near, T0 + 120000)).toEqual({ km: 12, moving: false });
    expect(estimateRemaining(distanceReference(reading({ remainingKm: 0 }), T0), T0 + 60000).km).toBe(0);
  });
  it('sin velocidad de vuelo creíble (en tierra o rodando) o sin distancia, no se extrapola', () => {
    expect(estimateRemaining(distanceReference(reading({ kmh: MIN_KMH - 1 }), T0), T0 + 60000)).toEqual({ km: 366, moving: false });
    expect(estimateRemaining(distanceReference(reading({ kmh: null }), T0), T0 + 60000)).toEqual({ km: 366, moving: false });
    expect(distanceReference(reading({ remainingKm: null }), T0)).toBeNull();
    expect(distanceReference({ state: 'aterrizado', remainingKm: 3 }, T0)).toBeNull();
  });
});

describe('antigüedad inicial: seenS + tiempo en la caché del servidor (checked)', () => {
  const at = s => new Date(T0 + s * 1000).toISOString();
  it('seenS 0 y checked 60 s antes → solo quedan 240 s de extrapolación; la distancia inicial es la del servidor', () => {
    const ref = distanceReference(reading({ seenS: 0, checked: at(-60) }), T0);
    expect(ref.ageAtReceiptS).toBe(60);
    expect(estimateRemaining(ref, T0).km).toBe(366); // no se descuenta la antigüedad del número
    expect(estimateRemaining(ref, T0 + 239000).moving).toBe(true);
    expect(estimateRemaining(ref, T0 + 240000)).toEqual({ km: 306, moving: false }); // 366 − 900 × 240 / 3600
    expect(estimateRemaining(ref, T0 + 600000).km).toBe(306);
  });
  it('seenS 120 y checked 30 s antes → antigüedad inicial 150 s (quedan 150 s)', () => {
    const ref = distanceReference(reading({ seenS: 120, checked: at(-30) }), T0);
    expect(ref.ageAtReceiptS).toBe(150);
    expect(estimateRemaining(ref, T0 + 600000).km).toBe(329); // 366 − 900 × 150 / 3600 = 328,5
  });
  it('checked en el futuro (desfase de reloj) nunca añade antigüedad negativa', () => {
    expect(distanceReference(reading({ seenS: 10, checked: at(+45) }), T0).ageAtReceiptS).toBe(10);
  });
  it('checked inválido o ausente → solo seenS', () => {
    for (const checked of ['no es una fecha', undefined, null, 12345]) {
      expect(distanceReference(reading({ seenS: 20, checked }), T0).ageAtReceiptS).toBe(20);
    }
  });
  it('cero cambios de red: el cálculo y el temporizador no hacen ninguna petición', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const t = startRemainingTicker({ ref: distanceReference(reading({ checked: at(-60) }), T0), render: () => true });
      await vi.advanceTimersByTimeAsync(600000);
      expect(t.running).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('temporizador (1 s, encadenado)', () => {
  it('repinta cada segundo, se detiene solo al dejar de moverse y no hace nada más', async () => {
    const shown = [];
    const t = startRemainingTicker({ ref: distanceReference(reading(), T0), render: km => { shown.push(km); return true; } });
    await vi.advanceTimersByTimeAsync(10000);
    expect(shown).toHaveLength(10);
    expect(shown.at(-1)).toBe(364); // 366 − 900 × 10 / 3600 = 363,5
    expect([...shown].sort((a, b) => b - a)).toEqual(shown); // nunca sube
    await vi.advanceTimersByTimeAsync(MAX_EXTRAPOLATION_S * 1000);
    expect(t.running).toBe(false);
    const n = shown.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(shown).toHaveLength(n);
  });
  it('3) una lectura real nueva sustituye la estimación: el temporizador anterior se para y se sigue desde el nuevo valor', async () => {
    const a = [], b = [];
    const t1 = startRemainingTicker({ ref: distanceReference(reading(), T0), render: km => { a.push(km); return true; } });
    await vi.advanceTimersByTimeAsync(30000);
    t1.stop();
    const t2 = startRemainingTicker({ ref: distanceReference(reading({ remainingKm: 300, kmh: 880 }), Date.now()), render: km => { b.push(km); return true; } });
    const before = a.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(a).toHaveLength(before); // el anterior ya no pinta
    expect(b[0]).toBe(300); // 300 − 880/3600 ≈ 299,8
    expect(b.at(-1)).toBe(298);
    t2.stop();
  });
  it('7) se detiene si la ficha deja de estar activa o desaparece el elemento', async () => {
    let active = true;
    const shown = [];
    const t = startRemainingTicker({ ref: distanceReference(reading(), T0), isActive: () => active, render: km => { shown.push(km); return true; } });
    await vi.advanceTimersByTimeAsync(3000);
    active = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(shown).toHaveLength(3);
    expect(t.running).toBe(false);
    const gone = startRemainingTicker({ ref: distanceReference(reading(), T0), render: () => false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(gone.running).toBe(false);
  });
});
