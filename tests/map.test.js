// @vitest-environment jsdom
// Mapa del vuelo (js/map.js, MapLibre): el bloque protagonista, el estilo aligerado, el avión solo con posiciones reales
// (recorrido continuo A → B durante el intervalo del seguimiento, sin pasar nunca de la última), la estela real en dos
// capas y la cámara. MapLibre se simula (tests/fixtures/fake-maplibre.js); el reloj y los fotogramas, también.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapHeroHtml, mapTitle, createRouteMap, lightStyle, FALLBACK_STYLE, PLANE_GLIDE_MS, trackSegments, altitudeColor, ALTITUDE_STOPS_M,
  NEUTRAL_TRACK, PLANE_COLOR } from '../js/map.js';
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
    expect(ctx.log.map.opts.cooperativeGestures).toBe(false); // un dedo mueve el mapa también en la ficha (la página, fuera de él)
    expect(ctx.log.lines.find(l => l.id === 'route').live).toBe(true);
    expect(ctx.log.airports.map(m => m.el.textContent)).toEqual(['AAA', 'BBB']);
    expect(ctx.log.markers).toHaveLength(0);
  });
  it('sin MapLibre (sin WebGL): rechaza; quien llama sigue sin mapa', async () => {
    vi.stubGlobal('maplibregl', fakeMapLibre({ fail: true }).L);
    await expect(make()).rejects.toBeTruthy();
  });
  it('ni turbulencias ni SIGMET en el mapa (su rojo se confundiría con el de la altitud): la ruta prevista, siempre gris', async () => {
    const m = await make();
    expect(m.setForecast).toBeUndefined();
    expect(ctx.log.map.data.sigmets).toBeUndefined();
    const route = ctx.log.lines.find(l => l.id === 'route');
    expect(route.o.color).toBe('#8a94a3');
    expect(route.coords).toEqual([[39, 0], [42, 3]]);
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

// Estela por ALTITUD (la escala oficial de Flightradar24): cada segmento, con la altitud real de su punto final.
describe('escala de altitud (Flightradar24)', () => {
  const ft = m => m / 0.3048;
  it('los valores oficiales: blanco por debajo de 100 m y, en cada altitud de la tabla, su color exacto', () => {
    expect(ALTITUDE_STOPS_M).toHaveLength(32);
    expect(altitudeColor(ft(50))).toBe('rgb(255, 255, 255)');
    for (const [m, color] of ALTITUDE_STOPS_M) expect(altitudeColor(ft(m)), `${m} m`).toBe(color);
    expect(ALTITUDE_STOPS_M.map(([m]) => m)).toEqual([...ALTITUDE_STOPS_M.map(([m]) => m)].sort((a, b) => a - b));
  });
  it('A) cotas bajas → blanco y amarillo; B) ascenso → verde, azul claro, azul, morado; C) crucero alto → rojo', () => {
    expect(altitudeColor(0)).toBe('rgb(255, 255, 255)');
    expect(altitudeColor(ft(200))).toBe('rgb(255, 234, 0)'); // amarillo
    expect(altitudeColor(700)).toBe('rgb(253, 237, 0)'); // ≈ 213 m: entre 200 y 300 m, interpolado (decisión de Turbi)
    expect(altitudeColor(ft(1200))).toBe('rgb(0, 255, 54)'); // verde
    expect(altitudeColor(ft(3500))).toBe('rgb(0, 234, 255)'); // azul claro
    expect(altitudeColor(ft(7500))).toBe('rgb(0, 0, 255)'); // azul
    expect(altitudeColor(ft(11000))).toBe('rgb(150, 0, 255)'); // morado
    expect(altitudeColor(43000)).toBe('rgb(255, 0, 0)'); // ≈ 13 100 m: rojo
  });
  it('E) sin altitud → gris azulado neutro, nunca un color de la escala', () => {
    for (const v of [null, undefined, NaN, '35000']) expect(altitudeColor(v)).toBe(NEUTRAL_TRACK);
    expect([[0, 'x'], ...ALTITUDE_STOPS_M].some(([, c]) => c === NEUTRAL_TRACK)).toBe(false);
  });
});

describe('createRouteMap: estela real por altitud', () => {
  const A = { lat: 40, lon: 0 }, B = { lat: 40, lon: 1 };
  const PAST = [[39, -1, 2000], [39.5, -0.5, 20000], [40, 0, 36000]];
  const alts = () => trail().segments.map(sg => sg.alt);

  it('una sola capa de color por segmento (expresión de MapLibre) sobre un contorno oscuro neutro; nada azul de marca', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    const [halo, core] = trail().o.layers;
    expect(trail().o.layers).toHaveLength(2);
    expect(halo.color).toMatch(/^rgba\(20, 30, 45, /);
    expect(halo.width).toBeGreaterThan(core.width);
    expect(core.color[0]).toBe('case'); // data-driven: el color sale de la altitud de cada segmento
    expect(JSON.stringify(core.color)).toContain('"interpolate"');
    expect(JSON.stringify(trail().o)).not.toContain('#1A6FE0');
    const route = ctx.log.lines.find(l => l.id === 'route');
    expect(route.o.dashArray).toBeTruthy();
    expect(route.o.layers[0].width).toBeLessThan(core.width);
    expect(route.o.layers[0].opacity).toBeLessThan(1);
  });

  it('B) C) D) cada segmento conserva la altitud de SU punto: ascenso, crucero y descenso se leen en la línea', async () => {
    const m = await make();
    const profile = [0, 2000, 12000, 25000, 38000, 41000, 41000, 30000, 15000, 3000, 200];
    m.setTrack(profile.map((alt, i) => [38 + i * 0.3, -2 + i * 0.4, alt]), { identity: ID });
    expect(alts()).toEqual(profile.slice(1)); // segmento i → altitud del punto i (el punto final)
    const colors = alts().map(altitudeColor);
    expect(colors[0]).toBe(altitudeColor(2000)); // ascenso: amarillo/verde
    expect(colors[4]).toBe('rgb(255, 0, 228)'); // 41 000 ft ≈ 12 500 m
    expect(colors.at(-1)).toBe('rgb(255, 255, 255)'); // 200 ft ≈ 61 m: blanco al llegar
    expect(new Set(colors).size).toBeGreaterThan(6); // no un solo color para toda la ruta
  });

  it('E) F) punto sin altitud → segmento neutro; estela antigua [lat, lon] (guardada sin altitud) → se pinta entera en neutro', async () => {
    const m = await make();
    m.setTrack([[39, -1, 2000], [39.5, -0.5, null], [40, 0, 36000]], { identity: ID });
    expect(alts()).toEqual([undefined, 36000]);
    m.setTrack([[39, -1], [39.5, -0.5], [40, 0]], { identity: 'v1|antigua' });
    expect(trail().live).toBe(true);
    expect(trail().coords).toEqual([[39, -1], [39.5, -0.5], [40, 0]]);
    expect(alts()).toEqual([undefined, undefined]); // sin escala: nunca presentada como coloreada por altitud
  });

  it('G) una posición nueva prolonga la estela con SU altitud; durante el recorrido, el tramo hasta el avión ya lleva la de B, y B no se dibuja antes', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.setPlane(A, { identity: ID });
    m.setPlane(B, { identity: ID });
    m.extendTrack([B.lat, B.lon, 37000], { identity: ID }); // lo que hace la app con cada posición fresca (altFt)
    run(PLANE_GLIDE_MS / 2);
    expect(trail().coords.at(-1)).toEqual(shown()); // la estela acaba en el avión que se ve…
    expect(trail().coords.some(c => c[0] === 40 && c[1] === 1)).toBe(false); // …B aún no
    expect(alts().at(-1)).toBe(37000); // el tramo hasta el avión: la altitud real de B, no una intermedia
    run(PLANE_GLIDE_MS / 2 + 1000);
    expect(trail().coords.at(-1)).toEqual([40, 1]);
    expect(alts().at(-1)).toBe(37000);
  });

  it('H) una posición nueva sin altitud prolonga en neutro, sin heredar la anterior', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.extendTrack([40.5, 0.5], { identity: ID });
    m.extendTrack([41, 1, null], { identity: ID });
    expect(alts().slice(-2)).toEqual([undefined, undefined]);
  });

  it('una posición vieja (fresh: false) no la prolonga; tampoco repetir el último punto', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.extendTrack([40.5, 0.5, 36000], { identity: ID, fresh: false });
    m.extendTrack([40, 0, 36000], { identity: ID });
    expect(trail().coords).toEqual(PAST.map(([la, lo]) => [la, lo]));
  });

  it('I) otra identidad (otro fr24Id): no se mezcla; setTrack de otra identidad sustituye la estela; clearTrack la quita', async () => {
    const m = await make();
    m.setTrack(PAST, { identity: ID });
    m.extendTrack([40.5, 0.5, 36000], { identity: 'v1|otro' });
    expect(trail().coords).toHaveLength(3);
    m.setTrack([[45, 5, 1000], [46, 6, 2000]], { identity: 'v1|otro' });
    expect(trail().coords).toEqual([[45, 5], [46, 6]]);
    expect(alts()).toEqual([2000]);
    m.clearTrack();
    expect(trail().live).toBe(false);
    expect(m.trackIdentity()).toBeNull();
  });

  it('trackSegments: un segmento por par de puntos consecutivos, con la altitud del punto final o sin ella', () => {
    expect(trackSegments([[1, 2, 100], [3, 4, 200], [5, 6, null]]).features.map(f => [f.geometry.coordinates, f.properties]))
      .toEqual([[[[2, 1], [4, 3]], { alt: 200 }], [[[4, 3], [6, 5]], {}]]);
  });
});

// El avión: la posición actual, amarillo fijo; la altitud solo la dice la estela.
describe('createRouteMap: avión amarillo', () => {
  const plane = () => ctx.log.markers[0].el;
  it('J) amarillo fijo (#FFD400) a cualquier altitud y con cualquier lectura', async () => {
    const m = await make();
    expect(PLANE_COLOR).toBe('#FFD400');
    m.setTrack([[39, -1, 1000], [40, 0, 2000]], { identity: ID });
    m.setPlane({ lat: 40, lon: 0, heading: 90 }, { identity: ID });
    expect(plane().style.getPropertyValue('--plane')).toBe('#FFD400');
    m.extendTrack([40.2, 0.3, 39000], { identity: ID });
    m.setPlane({ lat: 40.2, lon: 0.3, heading: 80 }, { identity: ID });
    expect(plane().style.getPropertyValue('--plane')).toBe('#FFD400');
    const css = readFileSync('css/style.css', 'utf8');
    expect(css).toMatch(/\.plane-marker \{ --plane: #FFD400; color: #1e2833;/); // contorno oscuro (currentColor)
    expect(css).toMatch(/\.plane-marker \.icon \{[^}]*fill: var\(--plane\); stroke: currentColor;/);
    expect(css).not.toMatch(/\.plane-marker \{[^}]*var\(--accent\)/);
  });
  it('K) posición antigua (.plane-old): el mismo amarillo, solo atenuado; quieto', async () => {
    const m = await make();
    m.setPlane({ lat: 40, lon: 0 }, { identity: ID });
    m.setPlane({ lat: 40.3, lon: 0.3, fresh: false }, { identity: ID });
    expect(ctx.log.markers[0].cls.has('plane-old')).toBe(true);
    expect(plane().style.getPropertyValue('--plane')).toBe('#FFD400');
    expect(frames).toHaveLength(0); // sin moverse hacia ella
    expect(readFileSync('css/style.css', 'utf8')).toContain('.plane-marker .plane-rot.plane-old { opacity: .5; }');
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
  it('ampliado: la ruta entera; al cerrar, la vista de antes (los gestos no cambian)', async () => {
    const m = await make();
    m.expanded(true);
    expect(ctx.log.view).toEqual(['fitBounds']);
    m.expanded(false);
    expect(ctx.log.view).toEqual(['fitBounds', 'jumpTo']);
  });
});
