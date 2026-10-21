// Seguimiento en vivo de la ficha (js/live-tracker.js): mientras se mira un vuelo en curso con Flightradar24, la app vuelve
// a pedir EL MISMO /radar cada 45 s (setTimeout encadenado, uno solo), con espera creciente ante fallos, respetando un 429,
// parando con 401/403 o un final definitivo, y sin pedir nada con la pestaña oculta. Reloj y temporizadores simulados.
import { describe, it, expect, vi } from 'vitest';
import { startLiveTracker, liveDecision, LIVE_INTERVAL_MS, LIVE_BACKOFF_MS } from '../js/live-tracker.js';

const flying = (over = {}) => ({ state: 'volando', source: 'fr24', fr24Id: '3c4d5e6f', lat: 40, lon: -3, posAgeS: 3, seenS: 3, ...over });
const unavailable = (reason, over = {}) => ({ state: 'no-disponible', source: 'fr24', reason, ...over });

// Temporizadores y reloj monotónico simulados: run(ms) avanza y ejecuta lo vencido (y las promesas).
function harness({ answers = [flying()], visible = true, active = true, over = false } = {}) {
  let t = 0, seq = 0;
  const timers = new Map();
  const env = { visible, active, over };
  const fetchOnce = vi.fn(async () => { const a = answers.length > 1 ? answers.shift() : answers[0]; return typeof a === 'function' ? a() : a; });
  const onReading = vi.fn();
  const tracker = startLiveTracker({
    key: 'k1', fetchOnce, onReading, isActive: () => env.active, isOver: () => env.over, visible: () => env.visible,
    now: () => t, setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; }, clearTimer: id => timers.delete(id),
  });
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  async function run(ms) {
    const end = t + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      t = next[1].at;
      next[1].fn();
      await flush();
    }
    t = end;
    await flush();
  }
  const pendingIn = () => { const n = [...timers.values()]; return n.length ? n.map(x => x.at - t) : []; };
  return { tracker, fetchOnce, onReading, run, env, timers, pendingIn, flush, at: () => t };
}

describe('liveDecision: qué hacer con cada respuesta', () => {
  it('volando con FR24 → se pinta y siguiente ciclo a los 45 s (la espera vuelve a 45 s)', () => {
    expect(liveDecision(flying(), 2)).toEqual({ paint: true, stop: false, delayMs: LIVE_INTERVAL_MS, failures: 0 });
  });
  it('sin datos / estimada (respuesta real de FR24 sin posición) → se pinta y se sigue a 45 s', () => {
    expect(liveDecision({ state: 'sin-datos', source: 'fr24', fr24Estimated: true }, 0)).toMatchObject({ paint: true, stop: false, delayMs: LIVE_INTERVAL_MS });
  });
  it('FALLOS 26) sin respuesta (red, timeout, 5xx) → nada se pinta; espera 90, 180 y 300 s (máximo)', () => {
    expect(LIVE_BACKOFF_MS).toEqual([90000, 180000, 300000]);
    expect(liveDecision(null, 0)).toEqual({ paint: false, stop: false, delayMs: 90000, failures: 1 });
    expect(liveDecision(unavailable('servidor'), 1)).toMatchObject({ paint: false, delayMs: 180000, failures: 2 });
    expect(liveDecision(unavailable('timeout'), 2)).toMatchObject({ paint: false, delayMs: 300000 });
    expect(liveDecision(unavailable('red'), 9)).toMatchObject({ paint: false, delayMs: 300000 });
  });
  it('FALLOS 24) 429 → no antes de Retry-After (y nunca antes del intervalo)', () => {
    expect(liveDecision(unavailable('limite', { retryAfterSec: 120 }), 0)).toMatchObject({ paint: false, stop: false, delayMs: 120000 });
    expect(liveDecision(unavailable('limite', { retryAfterSec: 10 }), 0)).toMatchObject({ delayMs: LIVE_INTERVAL_MS });
    expect(liveDecision(unavailable('limite'), 0)).toMatchObject({ delayMs: 90000 }); // sin Retry-After: espera creciente
  });
  it('FALLOS 25) 401/403 (autorización) → se para, sin bucle', () => {
    expect(liveDecision(unavailable('autorizacion'), 0)).toMatchObject({ paint: false, stop: true });
  });
  it('final definitivo: aterrizado se pinta y para; no-aplica o una respuesta que ya no es de FR24, para', () => {
    expect(liveDecision({ state: 'aterrizado', source: 'fr24' }, 0)).toMatchObject({ paint: true, stop: true });
    expect(liveDecision({ state: 'no-aplica' }, 0)).toMatchObject({ paint: false, stop: true });
    expect(liveDecision(flying({ source: 'adsb.lol' }), 0)).toMatchObject({ paint: true, stop: true });
  });
});

describe('startLiveTracker', () => {
  it('cadencia: un solo temporizador encadenado, una petición cada 45 s, nunca dos a la vez', async () => {
    const h = harness();
    expect(h.timers.size).toBe(1);
    expect(h.pendingIn()).toEqual([45000]); // la primera lectura ya está pintada: el siguiente ciclo, a los 45 s
    await h.run(44999);
    expect(h.fetchOnce).not.toHaveBeenCalled();
    await h.run(1);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1);
    expect(h.onReading).toHaveBeenCalledTimes(1);
    expect(h.timers.size).toBe(1);
    await h.run(45000 * 3);
    expect(h.fetchOnce).toHaveBeenCalledTimes(4);
    expect(h.timers.size).toBe(1);
  });
  it('FALLOS 21–22) un fallo NO se pinta (la última posición real se queda); espera 90 → 180 → 300 → 300 s; un éxito vuelve a 45 s', async () => {
    const h = harness({ answers: [null, unavailable('servidor'), unavailable('timeout'), null, flying(), flying()] });
    await h.run(45000);
    expect(h.onReading).not.toHaveBeenCalled();
    expect(h.pendingIn()).toEqual([90000]);
    await h.run(90000);
    expect(h.pendingIn()).toEqual([180000]);
    await h.run(180000);
    expect(h.pendingIn()).toEqual([300000]);
    await h.run(300000);
    expect(h.pendingIn()).toEqual([300000]);
    expect(h.onReading).not.toHaveBeenCalled();
    await h.run(300000);
    expect(h.onReading).toHaveBeenCalledTimes(1);
    expect(h.pendingIn()).toEqual([45000]);
    expect(h.fetchOnce).toHaveBeenCalledTimes(5);
  });
  it('FALLOS 24) 429 con Retry-After 200 s: la siguiente petición, no antes de 200 s', async () => {
    const h = harness({ answers: [unavailable('limite', { retryAfterSec: 200 }), flying()] });
    await h.run(45000);
    await h.run(199999);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1);
    await h.run(1);
    expect(h.fetchOnce).toHaveBeenCalledTimes(2);
  });
  it('FALLOS 25) 401/403: se para y no vuelve a pedir nunca', async () => {
    const h = harness({ answers: [unavailable('autorizacion')] });
    await h.run(45000);
    expect(h.tracker.stopped).toBe(true);
    expect(h.timers.size).toBe(0);
    await h.run(3600000);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1);
  });
  it('LIVE 15) aterrizado: se pinta (la ficha pasa a «Aterrizado») y se para', async () => {
    const h = harness({ answers: [{ state: 'aterrizado', source: 'fr24' }] });
    await h.run(45000);
    expect(h.onReading).toHaveBeenCalledTimes(1);
    expect(h.tracker.stopped).toBe(true);
    await h.run(600000);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1);
  });
  it('LIVE 16) final de Aena / cancelado / desviado (isOver) o ficha que ya no está (isActive): se para sin pedir', async () => {
    const a = harness();
    a.env.over = true;
    await a.run(45000);
    expect(a.fetchOnce).not.toHaveBeenCalled();
    expect(a.tracker.stopped).toBe(true);
    const b = harness();
    b.env.active = false;
    await b.run(45000);
    expect(b.fetchOnce).not.toHaveBeenCalled();
    expect(b.tracker.stopped).toBe(true);
    // Y si pasa a final con la respuesta (p. ej. withLanding la da por aterrizada al pintarla): tampoco sigue.
    const c = harness();
    c.onReading.mockImplementation(() => { c.env.over = true; });
    await c.run(45000);
    expect(c.tracker.stopped).toBe(true);
    expect(c.timers.size).toBe(0);
  });
  it('una respuesta que llega con la ficha ya cerrada no se pinta', async () => {
    let release;
    const h = harness({ answers: [() => new Promise(r => { release = r; })] });
    await h.run(45000);
    h.env.active = false;
    release(flying());
    await h.flush();
    expect(h.onReading).not.toHaveBeenCalled();
    expect(h.tracker.stopped).toBe(true);
  });
  it('LIVE 17) pestaña oculta: cero peticiones (el temporizador se cancela)', async () => {
    const h = harness();
    await h.run(10000);
    h.env.visible = false;
    h.tracker.onVisibility();
    expect(h.timers.size).toBe(0);
    await h.run(3600000);
    expect(h.fetchOnce).not.toHaveBeenCalled();
  });
  it('LIVE 17b) si el ciclo vence con la pestaña oculta (sin evento), tampoco pide: se queda en pausa', async () => {
    const h = harness();
    h.env.visible = false;
    await h.run(45000);
    expect(h.fetchOnce).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
  });
  it('LIVE 18) al volver a visible: con la última lectura de ≥ 45 s pide en el acto; si aún no tocaba, espera lo que falta', async () => {
    const h = harness();
    await h.run(10000);
    h.env.visible = false;
    h.tracker.onVisibility();
    await h.run(120000);
    h.env.visible = true;
    h.tracker.onVisibility();
    await h.run(0);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1); // en el acto
    expect(h.pendingIn()).toEqual([45000]);
    const g = harness();
    await g.run(10000);
    g.env.visible = false;
    g.tracker.onVisibility();
    await g.run(5000);
    g.env.visible = true;
    g.tracker.onVisibility();
    expect(g.pendingIn()).toEqual([30000]); // 45 − 15 s
    expect(g.fetchOnce).not.toHaveBeenCalled();
    g.tracker.onVisibility(); // otro evento «visible»: no crea un segundo temporizador
    expect(g.timers.size).toBe(1);
  });
  it('hold (p. ej. «Actualizar» en curso) cancela el ciclo sin parar; feed(lectura ya pintada) reprograma sin volver a pintar', async () => {
    const h = harness();
    await h.run(20000);
    h.tracker.hold();
    expect(h.pendingIn()).toEqual([180000]); // solo el tope de la espera
    expect(h.tracker.onTime).toBe(false);
    await h.run(179999);
    expect(h.fetchOnce).not.toHaveBeenCalled();
    h.tracker.feed(flying());
    expect(h.onReading).not.toHaveBeenCalled();
    expect(h.pendingIn()).toEqual([45000]);
    h.tracker.feed(null); // la respuesta de «Actualizar» falló: espera creciente, sin pintar
    expect(h.pendingIn()).toEqual([90000]);
    h.tracker.onVisibility(); // con un temporizador ya en marcha no se duplica
    expect(h.timers.size).toBe(1);
  });
  it('una respuesta del ciclo que llega estando en hold se descarta (la consulta nueva trae la suya)', async () => {
    let release;
    const h = harness({ answers: [() => new Promise(r => { release = r; })] });
    await h.run(45000);
    h.tracker.hold();
    release(flying());
    await h.flush();
    expect(h.onReading).not.toHaveBeenCalled();
    expect(h.pendingIn()).toEqual([180000]); // solo el tope de la espera
  });
  it('Importante 2) una espera sin feed (el sondeo de «Actualizar» no llega a dar nada) sale sola a los 3 min como un fallo', async () => {
    const h = harness();
    h.tracker.hold();
    await h.run(180000);
    expect(h.fetchOnce).not.toHaveBeenCalled();
    expect(h.pendingIn()).toEqual([90000]); // espera de fallo
    await h.run(90000);
    expect(h.fetchOnce).toHaveBeenCalledTimes(1);
    expect(h.pendingIn()).toEqual([45000]);
  });
  it('onTime: al día con el ciclo programado; no tras un fallo, en espera, con la pestaña oculta ni parado; onChange avisa', async () => {
    const onChange = vi.fn();
    let t = 0;
    const timers = new Map(); let seq = 0;
    const env = { visible: true };
    const answers = [null, flying()];
    const tr = startLiveTracker({ key: 'k', fetchOnce: async () => answers.shift(), onReading: () => {}, onChange, visible: () => env.visible,
      now: () => t, setTimer: (fn, ms) => { timers.set(++seq, { at: t + ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
    expect(tr.onTime).toBe(true);
    const fire = async () => { const [id, x] = [...timers.entries()][0]; timers.delete(id); t = x.at; x.fn(); for (let i = 0; i < 10; i++) await Promise.resolve(); };
    await fire(); // null → fallo
    expect(tr.onTime).toBe(false);
    expect(onChange).toHaveBeenCalled();
    await fire(); // lectura buena
    expect(tr.onTime).toBe(true);
    env.visible = false;
    tr.onVisibility();
    expect(tr.onTime).toBe(false);
    env.visible = true;
    tr.onVisibility();
    expect(tr.onTime).toBe(true);
    tr.stop();
    expect(tr.onTime).toBe(false);
  });
  it('visibilidad: solo «visible» cuenta como visible (prerender, hidden o desconocido no piden)', async () => {
    const doc = globalThis.document;
    globalThis.document = { visibilityState: 'prerender' };
    try {
      let n = 0;
      const timers = [];
      startLiveTracker({ key: 'k', fetchOnce: async () => { n++; return flying(); }, onReading: () => {}, now: () => 0,
        setTimer: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
      expect(timers).toHaveLength(0); // ni siquiera programa el ciclo
      expect(n).toBe(0);
    } finally { globalThis.document = doc; }
  });
  it('stop: sin temporizadores y sin peticiones después', async () => {
    const h = harness();
    h.tracker.stop();
    h.tracker.onVisibility();
    h.tracker.feed(flying());
    expect(h.timers.size).toBe(0);
    await h.run(600000);
    expect(h.fetchOnce).not.toHaveBeenCalled();
  });
});
