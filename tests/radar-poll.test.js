// Sondeo del radar mientras el servidor identifica el avión por su ruta (1–2 min con el límite de adsb.lol):
// reintentos encadenados (nunca setInterval), que paran con un resultado definitivo, al cambiar de búsqueda o al
// agotar los sondeos. La ficha solo espera la primera respuesta.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollRadar, keepPolling, RADAR_POLL_DELAYS_MS } from '../js/radar.js';

beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-09-25T16:00:00Z') }));
afterEach(() => vi.useRealTimers());

const IDENT = { state: 'sin-datos', identifying: true };
const FLYING = { state: 'volando', callsign: 'RYR12AB', hex: 'abc123', match: 'ruta' };
// Servidor simulado: devuelve en orden las respuestas dadas (la última se repite) y anota cuándo se le pregunta.
function server(responses) {
  const t0 = Date.now(), seen = [], list = [...responses];
  const fetchOnce = vi.fn(async ({ poll }) => { seen.push({ s: (Date.now() - t0) / 1000, poll }); return list.length > 1 ? list.shift() : list[0]; });
  return { fetchOnce, seen };
}

describe('calendario de sondeos', () => {
  it('cubre una identificación de 1–2 min y las pausas de adsb.lol: 20…180 s y después cada minuto hasta 8 min', () => {
    const at = RADAR_POLL_DELAYS_MS.reduce((acc, d) => [...acc, (acc.at(-1) ?? 0) + d], []).map(ms => ms / 1000);
    expect(at).toEqual([20, 40, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480]);
    expect(Math.min(...RADAR_POLL_DELAYS_MS)).toBeGreaterThanOrEqual(20000); // nunca en bucle rápido
  });
  it('keepPolling: solo mientras identifica y sin resultado definitivo', () => {
    expect(keepPolling(IDENT)).toBe(true);
    expect(keepPolling(null)).toBe(true); // sin respuesta: el trabajo del servidor sigue
    for (const r of [FLYING, { ...FLYING, identifying: true }, { state: 'aterrizado' }, { state: 'sin-datos' }, { state: 'no-disponible' }]) expect(keepPolling(r)).toBe(false);
  });
});

describe('pollRadar', () => {
  it('1-3) identificando a los 0 s y a los 20 s; termina a los 90 s → se pinta «volando» sin recargar', async () => {
    const { fetchOnce, seen } = server([IDENT, IDENT, IDENT, IDENT, FLYING]);
    const painted = [];
    const p = pollRadar({ fetchOnce, onResult: r => painted.push(r.state) });
    await p.first;
    expect(seen).toEqual([{ s: 0, poll: false }]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(seen.at(-1)).toEqual({ s: 20, poll: true });
    await vi.advanceTimersByTimeAsync(400000);
    expect(seen.map(x => x.s)).toEqual([0, 20, 40, 60, 90]);
    expect(seen.slice(1).every(x => x.poll)).toBe(true); // los sondeos solo leen el estado del servidor
    expect(painted.at(-1)).toBe('volando');
    expect(p.pending).toBe(false);
  });
  it('identificación que termina a los 120 s (más de 60 s) también llega', async () => {
    const { fetchOnce, seen } = server([IDENT, IDENT, IDENT, IDENT, IDENT, FLYING]);
    const painted = [];
    pollRadar({ fetchOnce, onResult: r => painted.push(r.state) });
    await vi.advanceTimersByTimeAsync(400000);
    expect(seen.map(x => x.s)).toEqual([0, 20, 40, 60, 90, 120]);
    expect(painted.at(-1)).toBe('volando');
  });
  it('5) con un resultado definitivo (ambiguo o fallido: sin-datos / no-disponible sin identificar) no hay más consultas', async () => {
    for (const final of [{ state: 'sin-datos' }, { state: 'no-disponible' }, { state: 'aterrizado' }]) {
      const { fetchOnce, seen } = server([IDENT, final]);
      pollRadar({ fetchOnce, onResult: () => {} });
      await vi.advanceTimersByTimeAsync(400000);
      expect(seen.map(x => x.s), final.state).toEqual([0, 20]);
    }
  });
  it('si nunca termina, se detiene al agotar los sondeos (8 min)', async () => {
    const { fetchOnce, seen } = server([IDENT]);
    const p = pollRadar({ fetchOnce, onResult: () => {} });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(seen.map(x => x.s)).toEqual([0, 20, 40, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480]);
    expect(p.pending).toBe(false);
  });
  it('un sondeo sin respuesta (red) no pinta ni detiene: se vuelve a mirar en el siguiente turno', async () => {
    const { fetchOnce, seen } = server([IDENT, null, FLYING]);
    const painted = [];
    pollRadar({ fetchOnce, onResult: r => painted.push(r?.state ?? null) });
    await vi.advanceTimersByTimeAsync(400000);
    expect(seen.map(x => x.s)).toEqual([0, 20, 40]);
    expect(painted).toEqual(['sin-datos', 'volando']);
  });
  it('4) una búsqueda nueva (cancel o isActive falso) detiene el sondeo anterior', async () => {
    const a = server([IDENT]);
    const p = pollRadar({ fetchOnce: a.fetchOnce, onResult: () => {} });
    await vi.advanceTimersByTimeAsync(20000);
    p.cancel();
    await vi.advanceTimersByTimeAsync(400000);
    expect(a.seen).toHaveLength(2);
    let active = true;
    const b = server([IDENT]);
    pollRadar({ fetchOnce: b.fetchOnce, onResult: () => {}, isActive: () => active });
    await vi.advanceTimersByTimeAsync(20000);
    active = false; // la ficha ya no está (otra búsqueda, «Nueva consulta»)
    await vi.advanceTimersByTimeAsync(400000);
    expect(b.seen).toHaveLength(2);
  });
  it('una respuesta que llega cuando la ficha ya no está no se pinta', async () => {
    let active = true;
    let release;
    const fetchOnce = vi.fn(() => new Promise(r => { release = r; }));
    const onResult = vi.fn();
    const p = pollRadar({ fetchOnce, onResult, isActive: () => active });
    active = false;
    release(FLYING);
    await p.first;
    expect(onResult).not.toHaveBeenCalled();
  });
  it('7) first se resuelve con la primera respuesta: nadie espera a los sondeos siguientes', async () => {
    const { fetchOnce } = server([IDENT]);
    const p = pollRadar({ fetchOnce, onResult: () => {} });
    await expect(p.first).resolves.toEqual(IDENT);
    expect(p.pending).toBe(true); // el siguiente sondeo queda programado en segundo plano
    p.cancel();
  });
  it('vuelo que cambia de estado durante el sondeo: se pinta cada respuesta', async () => {
    const { fetchOnce } = server([IDENT, IDENT, { ...FLYING }]);
    const painted = [];
    pollRadar({ fetchOnce, onResult: r => painted.push(r.state) });
    await vi.advanceTimersByTimeAsync(400000);
    expect(painted).toEqual(['sin-datos', 'sin-datos', 'volando']);
  });
  it('429 en el servidor (temporary + retryAfterSec): sigue sondeando, sin preguntar antes de que acabe la pausa', async () => {
    const TEMP = { state: 'sin-datos', identifying: true, temporary: true, retryAfterSec: 118 };
    const { fetchOnce, seen } = server([IDENT, TEMP, IDENT, FLYING]);
    const painted = [];
    pollRadar({ fetchOnce, onResult: r => painted.push(r.state) });
    await vi.advanceTimersByTimeAsync(600000);
    // 0 s identificando; 20 s: el servidor reanudará en 118 s → el siguiente sondeo no llega antes (20 + 120 s, el
    // máximo de una espera); después, el calendario normal (20 s).
    expect(seen.map(x => x.s)).toEqual([0, 20, 140, 160]);
    expect(seen[2].s - seen[1].s).toBeGreaterThanOrEqual(118);
    expect(painted.at(-1)).toBe('volando');
  });
});
