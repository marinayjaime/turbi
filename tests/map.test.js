// Tarjeta del mapa (js/map.js): título por fase, marcador del avión solo con posición real y Leaflet prescindible.
// Leaflet se simula con un `L` falso en globalThis: se cuentan marcadores creados, movidos y quitados.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { routeLines, mapCardHtml, mapFactsHtml, createRouteMap } from '../js/map.js';

function fakeLeaflet() {
  const log = { markers: [], moved: [], removed: 0, invalidated: 0, tileOpts: null, mapRemoved: 0 };
  const layer = () => ({ addTo() { return this; }, bindTooltip() { return this; }, remove() { log.removed++; } });
  const L = {
    map: () => ({
      fitBounds() {}, invalidateSize() { log.invalidated++; }, remove() { log.mapRemoved++; },
    }),
    tileLayer: (_url, opts) => { log.tileOpts = opts; return layer(); },
    polyline: layer, polygon: layer, circleMarker: layer,
    latLngBounds: () => ({ pad() { return this; } }),
    divIcon: o => o,
    marker: (ll, o) => {
      const rot = { style: {} };
      const m = { ...layer(), ll, o, rot, setLatLng(p) { log.moved.push(p); this.ll = p; return this; },
        getElement() { return { querySelector: () => rot }; } };
      log.markers.push(m);
      return m;
    },
  };
  return { L, log };
}

const OPTS = {
  origin: { iata: 'AAA', lat: 39, lon: 3 }, destination: { iata: 'BBB', lat: 41, lon: 2 },
  route: [{ lat: 39, lon: 3 }, { lat: 41, lon: 2 }],
};

describe('mapCardHtml', () => {
  it.each([['programado', 'Ruta prevista'], ['en-curso', 'Radar'], ['finalizado', 'Ruta realizada'], ['cancelado', 'Ruta prevista']])(
    '%s -> %s', (fase, titulo) => {
      const html = mapCardHtml(fase);
      expect(html).toContain(titulo);
      expect(html).toContain('<section class="card map-card" id="map-card">');
      expect(html).toContain('<div id="map" class="map">');
      expect(html).toContain('id="map-facts"');
      expect(html).toContain('data-map="expand"');
      expect(html).toContain('<svg');
    });
});

describe('mapFactsHtml (§5.8, datos bajo el mapa)', () => {
  const flying = over => ({ phase: 'en-curso', status: { text: 'En vuelo', tone: 'ok' }, aircraft: 'Airbus A320',
    radar: { state: 'volando', callsign: 'IBE123', match: 'indicativo', ...over } });
  const facts = html => [...html.matchAll(/<span class="k">([^<]+)<\/span><span class="v">([^<]+)<\/span>/g)].map(m => [m[1], m[2]]);
  it('en el aire con el radar volando: Indicativo, Avión e Identificación «Directa» (por indicativo)', () => {
    expect(facts(mapFactsHtml(flying()))).toEqual([['Indicativo', 'IBE123'], ['Avión', 'Airbus A320'], ['Identificación', 'Directa']]);
  });
  it('por ruta → «Por ruta»; por transpondedor → el texto de Detalles avanzados', () => {
    expect(facts(mapFactsHtml(flying({ match: 'ruta' }))).at(-1)).toEqual(['Identificación', 'Por ruta']);
    expect(facts(mapFactsHtml(flying({ match: 'transpondedor' }))).at(-1)).toEqual(['Identificación', 'Por transpondedor']);
  });
  it('solo los datos que existen (sin «—» ni valores por defecto) y escapados', () => {
    expect(facts(mapFactsHtml({ ...flying({ callsign: null, match: undefined }), aircraft: null }))).toEqual([]);
    expect(mapFactsHtml({ ...flying(), aircraft: '<b>' })).toContain('&lt;b&gt;');
  });
  it('vacío fuera del aire o sin radar «volando»', () => {
    expect(mapFactsHtml(null)).toBe('');
    expect(mapFactsHtml({ ...flying(), radar: { state: 'reciente', callsign: 'IBE123' } })).toBe('');
    expect(mapFactsHtml({ ...flying(), radar: { state: 'localizando' } })).toBe('');
    expect(mapFactsHtml({ phase: 'pendiente', status: { text: 'Programado' }, aircraft: 'Airbus A320' })).toBe('');
    // Aterrizado (finalizado) aunque la última lectura fuera «volando»: sin datos bajo el mapa.
    expect(mapFactsHtml({ ...flying(), status: { text: 'Aterrizado', landing: 'confirmed-landed' } })).toBe('');
  });
});

describe('createRouteMap', () => {
  let ctx;
  beforeEach(() => { ctx = fakeLeaflet(); globalThis.L = ctx.L; });
  afterEach(() => { delete globalThis.L; });
  const el = () => ({ hidden: true });

  it('setPlane(null) no crea marcador', async () => {
    const m = await createRouteMap(el(), OPTS);
    m.setPlane(null);
    expect(ctx.log.markers).toHaveLength(0);
  });

  it('crea el marcador, lo mueve sin crear otro y lo quita con null', async () => {
    // Movimiento directo (prefers-reduced-motion) para comprobar solo el ciclo de vida del marcador; la animación tiene
    // su propio bloque de tests.
    const m = await createRouteMap(el(), OPTS, { raf: () => 0, caf: () => {}, now: () => 0, reducedMotion: () => true });
    m.setPlane({ lat: 40, lon: 2.5, stale: false });
    expect(ctx.log.markers).toHaveLength(1);
    m.setPlane({ lat: 40.1, lon: 2.4 });
    expect(ctx.log.markers).toHaveLength(1);
    expect(ctx.log.moved).toEqual([[40.1, 2.4]]);
    m.setPlane(null);
    expect(ctx.log.removed).toBe(1);
    m.setPlane(null);
    expect(ctx.log.removed).toBe(1);
    m.setPlane({ lat: 40, lon: 2 });
    expect(ctx.log.markers).toHaveLength(2);
  });

  it('teselas suaves, invalidate y destroy', async () => {
    const m = await createRouteMap(el(), OPTS);
    expect(ctx.log.tileOpts.className).toBe('tiles-soft');
    m.invalidate();
    expect(ctx.log.invalidated).toBe(1);
    m.destroy();
    expect(ctx.log.mapRemoved).toBe(1);
  });

  it('setForecast acepta una vista sin aviación', async () => {
    const m = await createRouteMap(el(), OPTS);
    expect(() => m.setForecast({ route: OPTS.route })).not.toThrow();
  });

  it('clearForecast: vuelve a la ruta sin colorear, sin SIGMET ni PIREP, sin tocar la vista ni el avión', async () => {
    // Capas vivas por tipo (con sus opciones): se quitan con remove().
    const live = [];
    let views = 0;
    const track = kind => (coords, o = {}) => {
      const l = { kind, o, addTo() { live.push(this); return this; }, bindTooltip() { return this; }, remove() { live.splice(live.indexOf(this), 1); } };
      return l;
    };
    Object.assign(ctx.L, { polyline: track('line'), polygon: track('polygon'), circleMarker: track('circle'),
      map: () => ({ fitBounds() { views++; }, setView() { views++; }, setZoom() { views++; }, invalidateSize() {}, remove() {} }) });
    const m = await createRouteMap(el(), OPTS, { raf: () => 0, caf: () => {}, now: () => 0, reducedMotion: () => true });
    m.setPlane({ lat: 40, lon: 2.5 });
    const layers = () => live.map(l => `${l.kind} ${l.o.color}`).sort();
    const fresh = layers();
    m.setForecast({ route: [{ lat: 39, lon: 3, level: 3 }, { lat: 41, lon: 2, level: 3 }],
      aviation: { sigmets: [{ coords: [{ lat: 39, lon: 2 }, { lat: 40, lon: 3 }, { lat: 41, lon: 2 }], label: 'S' }],
        pireps: [{ lat: 40, lon: 2.5, label: 'P' }] } });
    expect(live.some(l => l.kind === 'polygon')).toBe(true);
    expect(live.some(l => l.o.color === '#ff3b30' && l.kind === 'line')).toBe(true);
    const before = views;
    m.clearForecast();
    expect(layers()).toEqual(fresh); // ruta gris y los dos aeropuertos, como recién creado
    expect(views).toBe(before);
    expect(ctx.log.markers).toHaveLength(1);
    expect(ctx.log.removed).toBe(0); // el avión sigue
  });

  it('rechaza la promesa si Leaflet no carga', async () => {
    delete globalThis.L;
    await expect(createRouteMap(el(), OPTS)).rejects.toBeTruthy();
  });
});

describe('routeLines', () => {
  it('agrupa tramos consecutivos del mismo nivel', () => {
    const r = [{ lat: 1, lon: 1, level: 0 }, { lat: 2, lon: 2, level: 0 }, { lat: 3, lon: 3, level: 2 }];
    expect(routeLines(r).map(l => l.level)).toEqual([0, 2]);
  });
});

// Movimiento suave ENTRE POSICIONES REALES: de la que se ve a la nueva en ~2,5 s (requestAnimationFrame + setLatLng),
// sin extrapolar más allá de la última, sin animar desde una posición perdida ni entre dos aviones distintos.
describe('createRouteMap: movimiento suave del avión', () => {
  let ctx, frames, t, reduced;
  const clock = { raf: cb => { frames.push(cb); return frames.length; }, caf: id => { frames[id - 1] = null; }, now: () => t, reducedMotion: () => reduced };
  // Avanza el reloj y ejecuta los fotogramas pendientes (como hace el navegador).
  const advance = ms => { t += ms; const run = frames.splice(0); for (const f of run) f?.(t); };
  const A = { lat: 40, lon: 0 }, B = { lat: 40, lon: 1 }, C = { lat: 41, lon: 1 };
  const shown = () => ctx.log.markers.at(-1)?.ll;
  beforeEach(() => { ctx = fakeLeaflet(); globalThis.L = ctx.L; frames = []; t = 1000; reduced = false; });
  afterEach(() => { delete globalThis.L; });
  const make = () => createRouteMap({ hidden: true }, OPTS, clock);

  it('primera posición: el avión se coloca directamente, sin animación', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    expect(ctx.log.markers).toHaveLength(1);
    expect(shown()).toEqual([40, 0]);
    expect(frames).toHaveLength(0);
  });

  it('A → B: se desplaza en ~2,5 s por puntos intermedios y termina exactamente en B (nunca más allá)', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' });
    expect(ctx.log.markers).toHaveLength(1); // el mismo marcador, sin recrearlo
    advance(1250);
    const [lat, lon] = shown();
    expect(lat).toBeCloseTo(40);
    expect(lon).toBeGreaterThan(0);
    expect(lon).toBeLessThan(1);
    advance(1250);
    expect(shown()).toEqual([40, 1]);
    const moves = ctx.log.moved.length;
    advance(5000); // sin lectura nueva: el avión se queda en B, no sigue avanzando
    expect(shown()).toEqual([40, 1]);
    expect(ctx.log.moved.length).toBe(moves);
    expect(frames).toHaveLength(0);
  });

  it('el icono se orienta hacia la nueva posición (rumbo entre los dos puntos)', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' }); // hacia el este: rumbo ≈ 90°, el icono ya apunta al este → ≈ 0°
    const deg = Number(ctx.log.markers[0].rot.style.transform.match(/rotate\((-?[\d.]+)deg\)/)[1]);
    expect(Math.abs(deg)).toBeLessThan(1);
    advance(2500); // llega a B
    m.setPlane(C, { identity: 'v1|abc' }); // de B hacia el norte: ≈ −90°
    expect(Number(ctx.log.markers[0].rot.style.transform.match(/rotate\((-?[\d.]+)deg\)/)[1])).toBeCloseTo(-90, 0);
  });

  it('una nueva lectura a mitad de animación parte de la posición que se está mostrando (sin saltos)', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' });
    advance(1250);
    const mid = shown();
    m.setPlane(C, { identity: 'v1|abc' });
    advance(16);
    const next = shown();
    expect(Math.abs(next[0] - mid[0]) + Math.abs(next[1] - mid[1])).toBeLessThan(0.05);
    advance(2500);
    expect(shown()).toEqual([41, 1]);
  });

  it('la misma posición otra vez (repintado de la ficha) no reinicia nada', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(A, { identity: 'v1|abc' });
    expect(frames).toHaveLength(0);
    expect(ctx.log.moved).toHaveLength(0);
  });

  it('posición de más de 60 s (null) durante la animación: se cancela y el avión desaparece', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' });
    advance(500);
    m.setPlane(null);
    expect(ctx.log.removed).toBeGreaterThan(0);
    const moves = ctx.log.moved.length;
    advance(3000);
    expect(ctx.log.moved.length).toBe(moves); // ningún fotograma más
  });

  it('pérdida y recuperación: la nueva posición se coloca directamente (nunca animada desde la antigua)', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(null);
    m.setPlane(C, { identity: 'v1|abc' });
    expect(ctx.log.markers).toHaveLength(2);
    expect(shown()).toEqual([41, 1]);
    expect(frames).toHaveLength(0);
  });

  it('cambio de avión identificado o de vuelo físico: salto directo, sin animación entre ambos', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|def' });
    expect(shown()).toEqual([40, 1]);
    expect(frames).toHaveLength(0);
    m.setPlane(C, { identity: 'v2|def' });
    expect(shown()).toEqual([41, 1]);
    expect(frames).toHaveLength(0);
  });

  it('prefers-reduced-motion: reduce → sin animación, el marcador va directo a la nueva posición', async () => {
    reduced = true;
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' });
    expect(shown()).toEqual([40, 1]);
    expect(frames).toHaveLength(0);
  });

  it('destroy cancela la animación en curso', async () => {
    const m = await make();
    m.setPlane(A, { identity: 'v1|abc' });
    m.setPlane(B, { identity: 'v1|abc' });
    m.destroy();
    const moves = ctx.log.moved.length;
    advance(3000);
    expect(ctx.log.moved.length).toBe(moves);
  });
});

// Estela real (FR24 Flight Tracks): una polilínea sólida y marcada (acento) encima de la ruta prevista, que pasa a ser
// tenue y discontinua. Termina en el avión: mientras se anima A → B su último vértice sigue al avión (la MISMA polilínea,
// setLatLngs), nunca más allá de B. Sin avión, se queda tal cual. Otra identidad: nunca se mezcla.
describe('createRouteMap: estela real del vuelo', () => {
  let lines, frames, t;
  const clock = { raf: cb => { frames.push(cb); return frames.length; }, caf: id => { frames[id - 1] = null; }, now: () => t, reducedMotion: () => false };
  const advance = ms => { t += ms; const run = frames.splice(0); for (const f of run) f?.(t); };
  beforeEach(() => {
    const ctx = fakeLeaflet();
    lines = [];
    ctx.L.polyline = (coords, o = {}) => {
      const l = { coords, o, live: false, fronts: 0, sets: 0, addTo() { this.live = true; lines.push(this); return this; }, bindTooltip() { return this; },
        remove() { this.live = false; }, setLatLngs(c) { this.coords = c; this.sets++; return this; }, bringToFront() { this.fronts++; return this; } };
      return l;
    };
    globalThis.L = ctx.L;
    frames = [];
    t = 1000;
  });
  afterEach(() => { delete globalThis.L; });
  const make = () => createRouteMap({ hidden: true }, OPTS, clock);
  const live = () => lines.filter(l => l.live);
  const trail = () => live().filter(l => !l.o.dashArray);
  const route = () => live().filter(l => l.o.dashArray);
  const ID = 'v1|3c4d5e6f';
  const P = [[39, 3], [39.5, 2.8], [40, 2.5]];

  it('la ruta prevista es siempre tenue y discontinua (también coloreada por setForecast)', async () => {
    const m = await make();
    expect(route()).toHaveLength(1);
    expect(route()[0].o.opacity).toBeLessThanOrEqual(0.6);
    m.setForecast({ route: [{ lat: 39, lon: 3, level: 0 }, { lat: 40, lon: 2.5, level: 2 }, { lat: 41, lon: 2, level: 2 }] });
    expect(live().every(l => l.o.dashArray && l.o.opacity <= 0.6)).toBe(true);
  });

  it('1) setTrack dibuja una polilínea sólida, de acento y más gruesa, encima de la ruta (también tras setForecast)', async () => {
    const m = await make();
    m.setTrack(P, { identity: ID });
    expect(trail()).toHaveLength(1);
    const [l] = trail();
    expect(l.coords).toEqual(P);
    expect(l.o).toMatchObject({ color: '#1A6FE0', weight: 4 });
    expect(l.o.opacity).toBeGreaterThan(0.8);
    expect(m.trackIdentity()).toBe(ID);
    const fronts = l.fronts;
    m.setForecast({ route: OPTS.route });
    expect(l.fronts).toBeGreaterThan(fronts); // la ruta redibujada no la tapa
    m.clearForecast();
    expect(trail()).toEqual([l]); // clearForecast no toca la estela
  });

  it('termina en el avión de la misma identidad; la de otra identidad no se une', async () => {
    const m = await make();
    m.setPlane({ lat: 40.2, lon: 2.4 }, { identity: ID });
    m.setTrack(P, { identity: ID });
    expect(trail()[0].coords).toEqual([...P, [40.2, 2.4]]);
    const other = await make();
    other.setPlane({ lat: 40.2, lon: 2.4 }, { identity: 'v1|otro' });
    other.setTrack(P, { identity: ID });
    expect(trail().at(-1).coords).toEqual(P);
  });

  it('6) extendTrack añade un punto real (sin duplicar el último); con otra identidad, nada', async () => {
    const m = await make();
    m.setTrack(P, { identity: ID });
    m.extendTrack([40.3, 2.3], { identity: ID });
    m.extendTrack([40.3, 2.3], { identity: ID });
    m.extendTrack([41, 1], { identity: 'v1|otro' });
    expect(trail()).toHaveLength(1);
    expect(trail()[0].coords).toEqual([...P, [40.3, 2.3]]);
  });

  it('10) A → B: la cabeza sigue al avión en cada fotograma (la MISMA polilínea) y termina exactamente en B', async () => {
    const m = await make();
    const A = { lat: 40, lon: 2.5 }, B = { lat: 40.4, lon: 2.1 };
    m.setPlane(A, { identity: ID });
    m.setTrack(P, { identity: ID });
    m.setPlane(B, { identity: ID });
    m.extendTrack([B.lat, B.lon], { identity: ID }); // la lectura real B, recibida a la vez que empieza la animación
    const [l] = trail();
    expect(l.coords.at(-1)).toEqual([40, 2.5]); // aún en A: la estela no se adelanta al avión
    advance(1250);
    const head = l.coords.at(-1);
    expect(head[0]).toBeGreaterThan(40);
    expect(head[0]).toBeLessThan(40.4);
    expect(l.coords.filter(c => c[0] === 40.4)).toHaveLength(0); // B todavía no es vértice
    advance(1250);
    expect(l.coords.at(-1)).toEqual([40.4, 2.1]);
    expect(l.coords.filter(c => c[0] === 40.4 && c[1] === 2.1)).toHaveLength(1);
    advance(5000);
    expect(l.coords.at(-1)).toEqual([40.4, 2.1]); // nunca más allá de B
    expect(trail()).toEqual([l]);
    expect(lines.filter(x => !x.o.dashArray)).toHaveLength(1); // ninguna capa nueva: sin parpadeos
  });

  it('el avión desaparece (posición > 60 s): la estela se queda tal cual, sin cabeza', async () => {
    const m = await make();
    m.setPlane({ lat: 40.2, lon: 2.4 }, { identity: ID });
    m.setTrack(P, { identity: ID });
    m.extendTrack([40.2, 2.4], { identity: ID });
    m.setPlane(null);
    expect(trail()[0].coords).toEqual([...P, [40.2, 2.4]]);
  });

  it('5) setTrack de otra identidad sustituye la anterior; clearTrack la quita', async () => {
    const m = await make();
    m.setTrack(P, { identity: ID });
    const first = trail()[0];
    m.setTrack([[41, 1], [41.1, 1.1]], { identity: 'v1|7a8b9c0d' });
    expect(first.live).toBe(false);
    expect(trail()).toHaveLength(1);
    expect(trail()[0].coords).toEqual([[41, 1], [41.1, 1.1]]);
    m.clearTrack();
    expect(trail()).toHaveLength(0);
    expect(m.trackIdentity()).toBeNull();
    m.extendTrack([41, 1], { identity: 'v1|7a8b9c0d' });
    expect(trail()).toHaveLength(0);
  });
});
