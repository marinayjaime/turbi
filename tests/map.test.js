// @vitest-environment jsdom
// Mapa del vuelo (js/map.js, MapLibre): el bloque protagonista, el estilo aligerado, el avión solo con posiciones reales
// (recorrido continuo A → B durante el intervalo del seguimiento, sin pasar nunca de la última), la estela real en dos
// capas y la cámara. MapLibre se simula (tests/fixtures/fake-maplibre.js); el reloj y los fotogramas, también.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { routeLines, mapHeroHtml, mapTitle, createRouteMap, lightStyle, FALLBACK_STYLE, PLANE_GLIDE_MS } from '../js/map.js';
import { LIVE_INTERVAL_MS } from '../js/live-tracker.js';
import { fakeMapLibre } from './fixtures/fake-maplibre.js';

const OPTS = {
  origin: { iata: 'AAA', lat: 39, lon: 0 }, destination: { iata: 'BBB', lat: 42, lon: 3 },
  route: [{ lat: 39, lon: 0 }, { lat: 42, lon: 3 }],
};
let ctx, frames, t, reduced;
// Reloj y fotogramas a mano: advance(ms) mueve el reloj y ejecuta los fotogramas pendientes (como el navegador).
const clock = { raf: cb => { frames.push(cb); return frames.length; }, caf: id => { frames[id - 1] = null; }, now: () => t, reducedMotion: () => reduced };
const advance = ms => { t += ms; const run = frames.splice(0); for (const f of run) f?.(t); };
// Recorre `ms` en pasos de `step` (fotogramas sucesivos) y devuelve las posiciones mostradas.
const run = (ms, step = 1000) => { const seen = []; for (let k = 0; k < ms; k += step) { advance(step); seen.push(shown()); } return seen; };
const shown = () => ctx.log.markers.at(-1)?.ll;
const trail = () => ctx.log.lines.find(l => l.id === 'track');
const make = () => createRouteMap({ hidden: true }, OPTS, clock);
const ID = 'v1|abc';
beforeEach(() => {
  ctx = fakeMapLibre();
  vi.stubGlobal('maplibregl', ctx.L);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }))); // sin el estilo de OpenFreeMap: fondo liso
  frames = []; t = 1000; reduced = false;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('bloque del mapa', () => {
  it.each([['en-curso', 'Radar'], ['finalizado', 'Ruta realizada']])('%s → «%s», sin tarjeta, con ampliar, cerrar y créditos', (fase, titulo) => {
    const html = mapHeroHtml(fase);
    expect(html).toContain(`<span class="map-label card-title">${titulo}</span>`);
    expect(html).toContain('<section class="map-hero" id="map-card"');
    expect(html).not.toMatch(/class="card[ "]/);
    expect(html).toContain('<div id="map" class="map">');
    expect(html).toContain('data-map="expand"');
    expect(html).toContain('data-map="close"');
    for (const c of ['OpenFreeMap', 'OpenMapTiles', 'OpenStreetMap']) expect(html).toContain(c);
  });
  it('mapTitle por fase', () => {
    expect(mapTitle('en-curso')).toBe('Radar');
    expect(mapTitle('finalizado')).toBe('Ruta realizada');
  });
  it('el recorrido del avión dura lo mismo que el intervalo del seguimiento en vivo (la constante compartida)', () => {
    expect(PLANE_GLIDE_MS).toBe(LIVE_INTERVAL_MS);
  });
});

describe('lightStyle (estilo claro de OpenFreeMap, aligerado)', () => {
  const layer = (id, type = 'line', extra = {}) => ({ id, type, source: 'openmaptiles', paint: {}, ...extra });
  const style = { version: 8, sources: {}, layers: [layer('background', 'background'), layer('water', 'fill'), layer('building', 'fill'),
    layer('highway_minor'), layer('highway_path'), layer('railway'), layer('highway_major_casing'), layer('highway_motorway_bridge_casing'), layer('boundary_2'), layer('highway_motorway_subtle'),
    layer('label_village', 'symbol', { layout: { 'text-field': '{name}' } }), layer('label_city', 'symbol', { layout: { 'text-field': '{name}', 'text-size': 12 } }),
    layer('airport', 'symbol', { layout: { 'text-field': '{name}' } })] };
  it('quita lo que compite con el vuelo y deja fronteras, autopistas tenues, ciudades y aeropuertos', () => {
    expect(lightStyle(style).layers.map(l => l.id)).toEqual(['background', 'water', 'boundary_2', 'highway_motorway_subtle', 'label_city', 'airport']);
  });
  it('agua azul grisácea suave, fondo claro y nombres en español (o latinos)', () => {
    const s = lightStyle(style);
    expect(s.layers.find(l => l.id === 'water').paint['fill-color']).toBe('#cbd9e4');
    expect(s.layers.find(l => l.id === 'background').paint['background-color']).toBe('#f4f5f2');
    const city = s.layers.find(l => l.id === 'label_city');
    expect(city.layout['text-field']).toEqual(['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']]);
    expect(city.layout['text-size']).toBe(12);
  });
  it('un estilo no válido → null (se usa el fondo liso)', () => {
    expect(lightStyle(null)).toBeNull();
    expect(lightStyle({ layers: [] })).toBeNull();
    expect(FALLBACK_STYLE.layers).toHaveLength(1);
  });
});

describe('createRouteMap', () => {
  it('ruta prevista y aeropuertos; sin el estilo de OpenFreeMap, sobre el fondo liso', async () => {
    await make();
    expect(ctx.log.map.opts.style).toBe(FALLBACK_STYLE);
    expect(ctx.log.map.opts.cooperativeGestures).toBe(true); // en la ficha, el mapa no captura el desplazamiento de la página
    expect(ctx.log.lines.find(l => l.id === 'route').live).toBe(true);
    expect(ctx.log.airports.map(m => m.el.textContent)).toEqual(['AAA', 'BBB']);
    expect(ctx.log.markers).toHaveLength(0);
  });
  it('sin MapLibre (sin WebGL): rechaza; quien llama sigue sin mapa', async () => {
    vi.stubGlobal('maplibregl', fakeMapLibre({ fail: true }).L);
    await expect(make()).rejects.toBeTruthy();
  });
  it('setForecast y clearForecast: ruta coloreada, SIGMET y PIREP; clearForecast vuelve a la ruta sin colorear sin tocar la vista ni el avión', async () => {
    reduced = true;
    const m = await make();
    m.setPlane({ lat: 40, lon: 1 }, { identity: ID });
    const views = ctx.log.view.length;
    m.setForecast({ route: [{ lat: 39, lon: 0, level: 3 }, { lat: 42, lon: 3, level: 3 }],
      aviation: { sigmets: [{ coords: [{ lat: 39, lon: 0 }, { lat: 40, lon: 1 }, { lat: 41, lon: 0 }], label: 'S' }], pireps: [{ lat: 40, lon: 1, label: 'P' }] } });
    expect(ctx.log.map.data.route.features[0].properties.level).toBe(3);
    expect(ctx.log.map.data.sigmets.features).toHaveLength(1);
    expect(ctx.log.map.data.pireps.features).toHaveLength(1);
    m.clearForecast();
    expect(ctx.log.map.data.route.features[0].properties.level).toBe(0);
    expect(ctx.log.map.data.sigmets.features).toHaveLength(0);
    expect(ctx.log.map.data.pireps.features).toHaveLength(0);
    expect(ctx.log.view.length).toBe(views);
    expect(ctx.log.markers[0].removed).toBe(false);
  });
  it('destroy quita el mapa', async () => {
    const m = await make();
    m.destroy();
    expect(ctx.log.mapsRemoved).toBe(1);
  });
});

// Movimiento continuo ENTRE POSICIONES REALES: A → B durante el intervalo del seguimiento, nunca más allá de la última
// recibida; con la siguiente, sigue desde ahí (pasando por B, sin recortar).
describe('createRouteMap: movimiento del avión', () => {
  const A = { lat: 40, lon: 0 }, B = { lat: 40, lon: 1 }, C = { lat: 41, lon: 1 };

  it('primera posición: directa, sin animación', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    expect(shown()).toEqual([40, 0]);
    expect(frames).toHaveLength(0);
  });

  it('E) A → B: avanza poco a poco durante todo el intervalo y nunca pasa de B', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    const seen = run(PLANE_GLIDE_MS);
    expect(ctx.log.markers).toHaveLength(1); // el mismo marcador
    const lons = seen.map(p => p[1]);
    for (let i = 1; i < lons.length; i++) expect(lons[i]).toBeGreaterThanOrEqual(lons[i - 1]); // siempre hacia delante
    expect(lons.every(x => x <= 1)).toBe(true); // nunca más allá de B
    const half = lons[Math.floor(lons.length / 2) - 1];
    expect(half).toBeGreaterThan(0.35); // a mitad del intervalo, a medio camino (velocidad casi constante)
    expect(half).toBeLessThan(0.65);
    expect(lons.filter(x => x > 0 && x < 1).length).toBeGreaterThan(30); // continuo: decenas de posiciones intermedias
    expect(shown()).toEqual([40, 1]); // termina exactamente en B
  });

  it('F) la lectura siguiente tarda: se queda en B (sin extrapolar) y sin más fotogramas', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    run(PLANE_GLIDE_MS + 1000);
    const moves = ctx.log.markers[0].path.length;
    advance(60000);
    expect(shown()).toEqual([40, 1]);
    expect(ctx.log.markers[0].path.length).toBe(moves);
    expect(frames).toHaveLength(0);
    expect(m.planeState().moving).toBe(false);
  });

  it('G) llega C: continúa B → C; si llega antes de acabar A → B, pasa por B (sin recortar) y no pasa de C', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    run(PLANE_GLIDE_MS / 2);
    const mid = shown();
    m.setPlane(C, { identity: ID });
    advance(16);
    expect(Math.abs(shown()[1] - mid[1])).toBeLessThan(0.05); // sin salto: parte de lo que se ve
    const seen = run(PLANE_GLIDE_MS);
    // Primero hacia el este hasta B (lat 40) y solo después hacia el norte: nunca en diagonal hacia C.
    for (const [lat, lon] of seen) if (lat > 40) expect(lon).toBe(1);
    expect(seen.every(([lat]) => lat <= 41)).toBe(true);
    expect(shown()).toEqual([41, 1]);
  });

  it('H) prefers-reduced-motion: cada posición se coloca directamente, sin animación continua', async () => {
    reduced = true;
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    expect(shown()).toEqual([40, 1]);
    expect(frames).toHaveLength(0);
    expect(m.planeState().moving).toBe(false);
  });

  it('la misma lectura otra vez (repintado) no reinicia nada; null quita el avión y para el recorrido', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(A, { identity: ID });
    expect(frames).toHaveLength(0);
    m.setPlane(B, { identity: ID });
    run(5000);
    m.setPlane(null);
    expect(ctx.log.markers[0].removed).toBe(true);
    const moves = ctx.log.markers[0].path.length;
    advance(5000);
    expect(ctx.log.markers[0].path.length).toBe(moves);
  });

  it('otro avión u otro vuelo físico, o una posición que no es fresca: directa, nunca animada desde la anterior', async () => {
    const m = await make();
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: 'v1|otro' });
    expect(shown()).toEqual([40, 1]);
    expect(frames).toHaveLength(0);
    m.setPlane({ ...C, fresh: false }, { identity: 'v1|otro' });
    expect(shown()).toEqual([41, 1]);
    expect(frames).toHaveLength(0);
    expect(ctx.log.markers[0].cls.has('plane-old')).toBe(true); // última posición conocida: atenuada
  });
});

describe('createRouteMap: orientación', () => {
  const deg = () => Number(ctx.log.markers[0].rot.style.transform.match(/rotate\((-?[\d.]+)deg\)/)?.[1]);
  it('el track real de FR24 manda (el icono apunta al este: rumbo − 90)', async () => {
    const m = await make();
    m.setPlane({ lat: 40, lon: 0, heading: 270 }, { identity: ID });
    expect(Math.abs(deg())).toBe(180);
  });
  it('sin track, el rumbo entre dos posiciones reales; con una sola, sin rotación inventada', async () => {
    const m = await make();
    m.setPlane({ lat: 40, lon: 0 }, { identity: ID });
    expect(ctx.log.markers[0].rot.style.transform).toBe('');
    m.setPlane({ lat: 41, lon: 0 }, { identity: ID }); // hacia el norte → −90
    expect(deg()).toBeCloseTo(-90, 0);
  });
  it('el giro va por el camino corto (260 → 280: 20°, no 340°)', async () => {
    const m = await make();
    m.setPlane({ lat: 40, lon: 0, heading: 260 }, { identity: ID });
    m.setPlane({ lat: 40, lon: -0.1, heading: 280 }, { identity: ID });
    expect(deg()).toBeCloseTo(190, 0);
  });
});

describe('createRouteMap: estela real', () => {
  const A = { lat: 40, lon: 0 }, B = { lat: 40, lon: 1 };
  const PAST = [[39, -1], [39.5, -0.5], [40, 0]];

  it('I) dos capas (halo ancho y semitransparente; línea de acento sólida) y la ruta prevista por debajo: fina, tenue y discontinua', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    const [halo, core] = trail().o.layers;
    expect(halo.width).toBeGreaterThan(core.width);
    expect(halo.opacity).toBeLessThan(0.5);
    expect(core).toMatchObject({ color: '#1A6FE0', opacity: 1 });
    const route = ctx.log.lines.find(l => l.id === 'route');
    expect(route.o.dashArray).toBeTruthy();
    expect(route.o.layers[0].width).toBeLessThan(core.width);
    expect(route.o.layers[0].opacity).toBeLessThan(1);
    expect(trail().coords).toEqual(PAST);
  });

  it('I) una posición real nueva la prolonga y la línea crece DETRÁS del avión: B no se dibuja hasta que llega', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    m.extendTrack([B.lat, B.lon], { identity: ID }); // lo que hace la app con cada posición fresca
    run(PLANE_GLIDE_MS / 2);
    const head = trail().coords.at(-1);
    expect(head).toEqual(shown()); // la estela acaba en el avión que se ve
    expect(trail().coords.some(c => c[0] === 40 && c[1] === 1)).toBe(false); // B aún no
    run(PLANE_GLIDE_MS / 2 + 1000);
    expect(trail().coords.at(-1)).toEqual([40, 1]);
    expect(trail().coords.at(-2)).toEqual([40, 0]); // A, vértice real
  });

  it('J) una posición vieja (fresh: false) no la prolonga; tampoco repetir el último punto', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.extendTrack([40.5, 0.5], { identity: ID, fresh: false });
    m.extendTrack([40, 0], { identity: ID });
    expect(trail().coords).toEqual(PAST);
  });

  it('K) otra identidad (otro fr24Id): no se mezcla; setTrack de otra identidad sustituye la estela; clearTrack la quita', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.extendTrack([40.5, 0.5], { identity: 'v1|otro' });
    expect(trail().coords).toEqual(PAST);
    m.setTrack([[45, 5], [46, 6]], { identity: 'v1|otro' });
    expect(trail().coords).toEqual([[45, 5], [46, 6]]);
    expect(m.trackIdentity()).toBe('v1|otro');
    m.clearTrack();
    expect(trail().live).toBe(false);
    expect(m.trackIdentity()).toBeNull();
  });
});

describe('createRouteMap: cámara', () => {
  it('en vuelo: la primera posición encuadra una vez; las lecturas siguientes no mueven la vista', async () => {
    reduced = true;
    const m = await make();
    m.setPlane({ lat: 40, lon: 1 }, { identity: ID });
    expect(ctx.log.view).toEqual(['fitBounds']);
    m.setPlane({ lat: 40.2, lon: 1.2 }, { identity: ID });
    m.setPlane({ lat: 40.4, lon: 1.4 }, { identity: ID });
    expect(ctx.log.view).toEqual(['fitBounds']);
  });
  it('si el usuario ya ha movido el mapa, no se encuadra nada', async () => {
    const m = await make();
    ctx.log.map.fire('dragstart', { originalEvent: {} });
    m.setPlane({ lat: 40, lon: 1 }, { identity: ID });
    expect(ctx.log.view).toEqual([]);
  });
  it('aterrizado (sin avión): la estela encuadra la ruta realizada entera, una vez', async () => {
    const m = await make();
    m.setTrack([[39, 0], [41, 2], [42, 3]], { identity: ID });
    m.setTrack([[39, 0], [41, 2], [42, 3]], { identity: ID });
    expect(ctx.log.view).toEqual(['fitBounds']);
  });
  it('ampliado: la ruta entera y gestos normales; al cerrar, la vista y los gestos de antes', async () => {
    const m = await make();
    m.expanded(true);
    expect(ctx.log.view).toEqual(['fitBounds']);
    expect(ctx.log.map.cooperativeGestures.enabled).toBe(false);
    m.expanded(false);
    expect(ctx.log.view).toEqual(['fitBounds', 'jumpTo']);
    expect(ctx.log.map.cooperativeGestures.enabled).toBe(true);
  });
});

describe('routeLines', () => {
  it('agrupa tramos consecutivos del mismo nivel', () => {
    const r = [{ lat: 1, lon: 1, level: 0 }, { lat: 2, lon: 2, level: 0 }, { lat: 3, lon: 3, level: 2 }];
    expect(routeLines(r).map(l => l.level)).toEqual([0, 2]);
  });
});
