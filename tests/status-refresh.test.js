// Refresco ligero del estado oficial de Aena (js/status-refresh.js): cadencia según `updated` (el reloj real de los
// datos de Render), siempre el mismo vuelo físico, y los fallos nunca cambian nada.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startStatusRefresh, nextRefreshDelay, refreshMode, isStale, RETRY_MS, RETRY_FIRST_MS, PREWATCH_MS, TOO_OLD_MS } from '../js/status-refresh.js';
import { physicalFlightKey } from '../js/physical-flight.js';
import { aenaFinal } from '../js/schedule.js';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const D = '2026-09-26';
const fly = { al: 'FR', n: '1526', d: D, o: 'MLA', a: 'BCN', sd: null, sa: '14:40', ea: `${D}T14:40`, st: 'FLY', std: null, sta: 'FLY' };
const KEY = physicalFlightKey(fly);
const iso = ms => new Date(ms).toISOString();
beforeEach(() => vi.useFakeTimers({ now: T0 }));
afterEach(() => vi.useRealTimers());

// Render simulado: cada consulta devuelve lo que diga `serve(n, ahora)` (n = número de consulta).
function setup(serve, extra = {}) {
  const at = [], got = [];
  const fetchLive = vi.fn(async () => { at.push((Date.now() - T0) / 1000); return serve(at.length, Date.now()); });
  const r = startStatusRefresh({ key: KEY, initialUpdated: iso(T0), fetchLive, onLeg: (leg, upd) => got.push({ sta: leg.sta, upd }), isOver: aenaFinal, ...extra });
  return { r, at, got, fetchLive };
}

describe('cadencia: ~1 petición por ciclo de Render', () => {
  it('reglas: esperar a updated + 10 min + 20 s sin tope; si no hay ciclo nuevo, 60 s y después 120 s', () => {
    expect(nextRefreshDelay({ updatedMs: T0, changed: true, unchanged: 0, nowMs: T0 })).toBe(620000);
    expect(nextRefreshDelay({ updatedMs: T0, changed: false, unchanged: 1, nowMs: T0 + 620000 })).toBe(RETRY_FIRST_MS);
    expect(nextRefreshDelay({ updatedMs: T0, changed: false, unchanged: 2, nowMs: T0 + 680000 })).toBe(RETRY_MS);
    expect(nextRefreshDelay({ updatedMs: NaN, changed: true, unchanged: 0, nowMs: T0 })).toBe(RETRY_MS); // inválido
    expect(nextRefreshDelay({ updatedMs: T0 - 40 * 60000, changed: true, unchanged: 0, nowMs: T0 })).toBe(RETRY_MS); // muy antiguo
  });
  it('Render se actualiza a su hora: una consulta por ciclo (a los 620, 1220, 1820 s)', async () => {
    // Cada 10 min justos hay datos nuevos (updated = múltiplo de 600 s desde T0).
    const { at } = setup((n, now) => ({ updated: iso(T0 + Math.floor((now - T0) / 600000) * 600000), legs: [fly] }));
    await vi.advanceTimersByTimeAsync(1900000);
    expect(at).toEqual([620, 1220, 1820]); // cada respuesta trae el ciclo de los 600 s anteriores → +620 s
  });
  it('si la descarga de Render se retrasa: 60 s y después 120 s hasta ver el ciclo nuevo; entonces, al siguiente ciclo', async () => {
    const newCycle = T0 + 800000; // Render tarda 13 min 20 s
    const { at } = setup((n, now) => ({ updated: iso(now >= newCycle ? newCycle : T0), legs: [fly] }));
    await vi.advanceTimersByTimeAsync(1450000);
    expect(at).toEqual([620, 680, 800, 1420]); // 620 (sin cambio) → +60 → +120 (ciclo nuevo) → 800 + 620
  });
});

describe('siempre el mismo vuelo físico y nada cambia por un fallo', () => {
  it('el tramo nuevo de la misma clave llega a onLeg; con llegada final se detiene', async () => {
    let sta = 'FLY';
    const { r, at, got } = setup((n, now) => { if (n === 2) sta = 'LND'; return { updated: iso(now), legs: [{ ...fly, sta, st: sta }] }; });
    await vi.advanceTimersByTimeAsync(3600000);
    expect(got.map(g => g.sta)).toEqual(['FLY', 'LND']);
    expect(at).toHaveLength(2); // llegada final: no hay más consultas
    expect(r.pending).toBe(false);
  });
  it('si la clave desaparece, nunca se usa otro tramo del mismo número', async () => {
    const other = { ...fly, o: 'MAD', a: 'BCN', sa: '18:00', ea: `${D}T18:00`, sta: 'LND', st: 'LND' };
    const { got } = setup((n, now) => ({ updated: iso(now), legs: [other] }));
    await vi.advanceTimersByTimeAsync(3000000);
    expect(got).toEqual([]);
  });
  it('fallo de red: no se llama a onLeg, se reintenta a los 120 s; Pages solo tras 3 fallos, mismo vuelo y más reciente', async () => {
    const pagesCalls = [];
    let pages = { updated: iso(T0 - 60000), legs: [{ ...fly, sta: 'LND' }] }; // más antiguo que lo que ya tenemos
    const { at, got } = setup(() => null, { fetchPages: async () => { pagesCalls.push((Date.now() - T0) / 1000); return pages; } });
    await vi.advanceTimersByTimeAsync(620000 + 120000 * 2 + 1000);
    expect(at).toEqual([620, 740, 860]);
    expect(pagesCalls).toEqual([860]); // tras el tercer fallo
    expect(got).toEqual([]); // Pages más antiguo: rechazado
    pages = { updated: iso(T0 + 900000), legs: [{ ...fly, a: 'GRO', sta: 'LND' }] }; // más reciente pero OTRO vuelo físico
    await vi.advanceTimersByTimeAsync(120000);
    expect(got).toEqual([]);
    pages = { updated: iso(T0 + 900000), legs: [{ ...fly, sta: 'LND', st: 'LND' }] }; // mismo vuelo y más reciente
    await vi.advanceTimersByTimeAsync(120000);
    expect(got.map(g => g.sta)).toEqual(['LND']);
  });
  it('stop() y dejar de estar activa cancelan el temporizador', async () => {
    const a = setup((n, now) => ({ updated: iso(now), legs: [fly] }));
    a.r.stop();
    await vi.advanceTimersByTimeAsync(3600000);
    expect(a.at).toEqual([]);
    let active = true;
    const b = setup((n, now) => ({ updated: iso(now), legs: [fly] }), { isActive: () => active, initialUpdated: iso(Date.now()) });
    await vi.advanceTimersByTimeAsync(700000);
    active = false;
    await vi.advanceTimersByTimeAsync(3600000);
    expect(b.at).toHaveLength(1); // solo la primera, antes de dejar la ficha
  });
});

describe('qué vuelos se refrescan (refreshMode) y datos stale', () => {
  const H = 3600000;
  it('en curso → continuo (como hasta ahora)', () => {
    expect(refreshMode({ phase: 'en-curso', depMs: T0 - H, updatedMs: T0, nowMs: T0 })).toBe('continuous');
  });
  it('programado a 2 h de la salida → continuo (con datos viejos o al día)', () => {
    expect(refreshMode({ phase: 'pendiente', depMs: T0 + 2 * H, updatedMs: T0 - 4 * H, nowMs: T0 })).toBe('continuous');
    expect(refreshMode({ phase: 'pendiente', depMs: T0 + 2 * H, updatedMs: T0, nowMs: T0 })).toBe('continuous');
    expect(PREWATCH_MS).toBe(6 * H);
    expect(refreshMode({ phase: 'pendiente', depMs: T0 + 6 * H, updatedMs: T0, nowMs: T0 })).toBe('continuous'); // borde
  });
  it('programado a 8 h → sin refresco continuo: nada con datos al día, un solo intento con datos stale', () => {
    expect(refreshMode({ phase: 'pendiente', depMs: T0 + 8 * H, updatedMs: T0 - 5 * 60000, nowMs: T0 })).toBe('none');
    expect(refreshMode({ phase: 'pendiente', depMs: T0 + 8 * H, updatedMs: T0 - 4 * H, nowMs: T0 })).toBe('once');
  });
  it('terminado o cancelado → nunca (Aena ya dio su estado final)', () => {
    for (const phase of ['terminado', 'cancelado']) expect(refreshMode({ phase, depMs: T0 + H, updatedMs: T0 - 4 * H, nowMs: T0 })).toBe('none');
  });
  it('datos de más de 30 min (o sin fecha) → stale', () => {
    expect(TOO_OLD_MS).toBe(30 * 60000);
    expect(isStale(T0 - 31 * 60000, T0)).toBe(true);
    expect(isStale(T0 - 29 * 60000, T0)).toBe(false);
    expect(isStale(NaN, T0)).toBe(true);
  });
});

describe('datos stale: primer intento enseguida y GitHub Pages si Render no responde', () => {
  const OLD = T0 - 4 * 3600000;
  it('primer intento a los 5 s (no a los 120 s) y aplica lo nuevo de Render', async () => {
    const { at, got } = setup(() => ({ updated: iso(T0 - 60000), legs: [{ ...fly, sta: 'FNL' }] }), { initialUpdated: iso(OLD) });
    await vi.advanceTimersByTimeAsync(6000);
    expect(at).toEqual([5]);
    expect(got).toEqual([{ sta: 'FNL', upd: iso(T0 - 60000) }]);
  });
  it('Render no responde (dormido) → GitHub Pages en el mismo intento, si es más reciente y trae el mismo vuelo', async () => {
    const fetchPages = vi.fn(async () => ({ updated: iso(T0 - 20 * 60000), legs: [{ ...fly, sta: 'FNL' }] }));
    const { at, got } = setup(() => null, { initialUpdated: iso(OLD), fetchPages });
    await vi.advanceTimersByTimeAsync(6000);
    expect(at).toEqual([5]);
    expect(fetchPages).toHaveBeenCalledTimes(1);
    expect(got).toEqual([{ sta: 'FNL', upd: iso(T0 - 20 * 60000) }]);
  });
  it('con datos al día, Render sin responder: GitHub Pages solo tras 3 fallos (como antes)', async () => {
    const fetchPages = vi.fn(async () => null);
    setup(() => null, { initialUpdated: iso(T0), fetchPages });
    await vi.advanceTimersByTimeAsync(620000 + 2 * RETRY_MS - 1000);
    expect(fetchPages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchPages).toHaveBeenCalledTimes(1);
  });
  it('modo «una vez»: un solo intento y nada más (ni reintentos ni ciclos)', async () => {
    const { at, r } = setup(() => ({ updated: iso(T0 - 60000), legs: [fly] }), { initialUpdated: iso(OLD), once: true });
    await vi.advanceTimersByTimeAsync(3 * 3600000);
    expect(at).toEqual([5]);
    expect(r.pending).toBe(false);
    const failing = setup(() => null, { initialUpdated: iso(OLD), once: true });
    await vi.advanceTimersByTimeAsync(3 * 3600000);
    expect(failing.at).toHaveLength(1);
  });
});
