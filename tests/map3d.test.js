// @vitest-environment jsdom
// Experiencia del modo 3D (js/map3d.js): el mapa y el avión sin texto encima, avión y cámara en un solo bucle por fotograma,
// la cámara no pelea con el dedo y el contexto geográfico se ve a los zooms de la cámara 3D. MapLibre se simula.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRouteMap, PLANE_GLIDE_MS } from '../js/map.js';
import { contextLayers, keepDistantLabels, groundWidthStops, smoothAngle, blendCamera, horizonClipY } from '../js/map3d.js';
import { fakeMapLibre } from './fixtures/fake-maplibre.js';

const OPTS = { origin: { iata: 'AAA', lat: 39, lon: 0 }, destination: { iata: 'BBB', lat: 42, lon: 3 }, route: [{ lat: 39, lon: 0 }, { lat: 42, lon: 3 }] };
const ID = 'v1|abc';
const A = { lat: 39.4, lon: -0.5, alt: 36000, heading: 20, fresh: true }, B = { lat: 39.5, lon: -0.45, alt: 36100, heading: 24, fresh: true };
const wrap = d => ((((d + 180) % 360) + 360) % 360) - 180;
const STYLE_LAYERS = [
  { id: 'background', type: 'background' }, { id: 'water', type: 'fill', source: 'openmaptiles' },
  { id: 'highway_motorway_inner', type: 'line', source: 'openmaptiles' }, { id: 'label_city', type: 'symbol', source: 'openmaptiles' },
];
let frames, t, reduced, ctx, map, rm, hero;
const clock = { raf: cb => { frames.push(cb); return frames.length; }, caf: id => { frames[id - 1] = null; }, now: () => t, reducedMotion: () => reduced };
const tick = (ms = 16) => { t += ms; const run = frames.splice(0); for (const f of run) f?.(t); };

// Lo mínimo del mapa que usa el 3D (centro, zoom, giro, inclinación, capas y una transformación que gestionan los gestos).
function fake3dMap(Base) {
  return class extends Base {
    constructor(o) {
      super(o);
      this.center = { lng: -0.5, lat: 39 }; this.bearing = 0; this.pitch = 0; this.elevation = 0; this.padding = { top: 0, bottom: 0, left: 0, right: 0 };
      this.layers = STYLE_LAYERS.map(l => ({ ...l })); this.layout = {}; this.paintP = { 'water/fill-color': '#cbd9e4' }; this.sources = {};
      this.jumps = []; this.moving = false; this.painter = { context: { gl: new globalThis.WebGL2RenderingContext() } };
      const self = this;
      this._camera = { transform: { setCenter(c) { self.center = { lng: c.lng, lat: c.lat }; self.directs = (self.directs ?? 0) + 1; }, setElevation(e) { self.elevation = e; } } };
      this.style = { placement: { collisionIndex: new CollisionIndex() } };
      this.base = { calculateTileZoom: () => 30 };
      this.touchZoomRotate = { disableRotation() {}, enable() {}, enableRotation() {} };
      this.box = document.createElement('div');
    }
    getCanvasContainer() { return this.box; }
    getContainer() { return { clientHeight: 800, getBoundingClientRect: () => ({ top: 0, bottom: 800, width: 390, height: 800 }) }; }
    getStyle() { return { layers: this.layers.map(l => ({ ...l })), sources: { openmaptiles: {} } }; }
    getSource(id) { return id === 'openmaptiles' ? this.base : super.getSource(id); }
    addSource(id, s) { this.sources[id] = s; super.addSource(id, s); }
    removeSource(id) { delete this.sources[id]; delete this[`src_${id}`]; }
    getLayer(id) { return this.layers.find(l => l.id === id); }
    addLayer(l, before) { const i = this.layers.findIndex(x => x.id === before); this.layers.splice(i < 0 ? this.layers.length : i, 0, l); super.addLayer(l); }
    removeLayer(id) { this.layers = this.layers.filter(l => l.id !== id); }
    getLayoutProperty(id, k) { return this.layout[`${id}/${k}`]; }
    setLayoutProperty(id, k, v) { this.layout[`${id}/${k}`] = v; }
    getPaintProperty(id, k) { return this.paintP[`${id}/${k}`]; }
    setPaintProperty(id, k, v) { this.paintP[`${id}/${k}`] = v; }
    setSourceTileLodParams() {}
    getMaxZoom() { return 22; }
    getBearing() { return this.bearing; }
    getPitch() { return this.pitch; }
    getPadding() { return this.padding; }
    setPadding(p) { this.padding = p; }
    getCenterElevation() { return this.elevation; }
    isMoving() { return this.moving; }
    triggerRepaint() {}
    jumpTo(v) {
      this.jumps.push(v);
      if (v.center) this.center = Array.isArray(v.center) ? { lng: v.center[0], lat: v.center[1] } : v.center;
      for (const [k, m] of [['zoom', 'zoom'], ['bearing', 'bearing'], ['pitch', 'pitch'], ['elevation', 'elevation'], ['padding', 'padding']]) if (v[k] !== undefined) this[m] = v[k];
    }
    off() {}
  };
}
class CollisionIndex { constructor() { this.perspectiveRatioCutoff = 0.6; } }

async function setup3d({ plane = true } = {}) {
  ctx = fakeMapLibre();
  vi.stubGlobal('maplibregl', { ...ctx.L, Map: fake3dMap(ctx.L.Map), LngLat: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } } });
  document.body.innerHTML = '<section class="map-hero"><div id="map"></div><div class="map-mode"></div></section>';
  hero = document.querySelector('.map-hero');
  rm = await createRouteMap(document.getElementById('map'), OPTS, clock);
  map = ctx.log.map;
  if (plane) rm.setPlane(A, { identity: ID });
  rm.setAircraft({ model: 'Boeing 737-800' });
  await rm.setMode('3d');
  expect(rm.mode()).toBe('3d');
  for (let i = 0; i < 100; i++) tick(); // acaba la entrada en 3D
  map.jumps.length = 0;
}
const press = sel => hero.querySelector(sel).click();
const followOn = () => hero.querySelector('[data-cam="follow"]').getAttribute('aria-pressed') === 'true';
const point = (type, id = 1, target = map.box) => { const e = new Event(type, { bubbles: true }); Object.assign(e, { pointerId: id, button: 0, pointerType: 'touch', clientX: 100, clientY: 100 }); target.dispatchEvent(e); };

beforeEach(() => {
  frames = []; t = 1000; reduced = false;
  vi.stubGlobal('WebGL2RenderingContext', class {});
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('modo 3D: el mapa y el avión, sin texto encima', () => {
  it('sin .map3d-info ni nada escrito sobre el mapa; el avión, solo para lectores de pantalla; todos los controles siguen', async () => {
    await setup3d();
    expect(hero.querySelector('.map3d-info')).toBeNull();
    expect(readFileSync('css/style.css', 'utf8')).not.toContain('map3d-info');
    expect(hero.querySelector('.map3d-model').classList.contains('sr-only')).toBe(true);
    expect(hero.querySelector('.map3d-ui').querySelector('.map3d-age, .map3d-note')).toBeNull();
    for (const c of ['in', 'out', 'more', 'left', 'right', 'tilt-side', 'tilt-top', 'follow', 'reset']) expect(hero.querySelector(`[data-cam="${c}"]`)).not.toBeNull();
    for (const v of ['behind', 'side', 'diagonal', 'top']) expect(hero.querySelector(`[data-view="${v}"]`)).not.toBeNull();
    press('[data-cam="more"]');
    expect(hero.querySelector('.map3d-more').hidden).toBe(false);
  });

  it('el encuadre reserva solo lo que ocupan los botones de arriba y la barra: sin el hueco de la antigua etiqueta', async () => {
    await setup3d();
    hero.querySelector('.map-mode').getBoundingClientRect = () => ({ bottom: 48 });
    hero.querySelector('.map3d-bar').getBoundingClientRect = () => ({ top: 742 });
    press('[data-view="side"]');
    for (let i = 0; i < 80; i++) tick();
    expect(map.padding).toEqual({ top: 48, bottom: 58, left: 0, right: 0 });
    expect(Number.isFinite(map.zoom) && map.zoom > 15).toBe(true);
  });
});

describe('modo 3D: avión y cámara en un solo bucle', () => {
  it('el avión avanza en CADA fotograma (sin el límite de 50 ms), la cámara con él y nunca pasa de la última posición real', async () => {
    await setup3d();
    rm.setPlane(B, { identity: ID });
    const seen = [];
    for (let i = 0; i < 40; i++) { tick(); seen.push(map.center.lat); }
    expect(new Set(seen).size).toBe(40);
    for (let i = 1; i < 40; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    t += PLANE_GLIDE_MS; // llega; sin más lecturas, quieto en B (sin extrapolar)
    for (let i = 0; i < 10; i++) { tick(); expect(map.center.lat).toBeLessThanOrEqual(B.lat); }
    expect(map.center).toEqual({ lng: B.lon, lat: B.lat });
    expect(map.elevation).toBeCloseTo(B.alt * 0.3048, 3);
  });

  it('el rumbo cambia de forma continua y por el camino corto: de 350° a 10° son 20°, no una vuelta', () => {
    let h = 350; const steps = [];
    for (let i = 0; i < 300; i++) { const n = smoothAngle(h, 10, 16, 900); steps.push(Math.abs(wrap(n - h))); h = n; }
    expect(Math.max(...steps)).toBeLessThan(0.5);
    expect(steps.reduce((a, b) => a + b, 0)).toBeLessThan(21);
    expect(wrap(h - 10)).toBeCloseTo(0, 0);
    const mid = blendCamera({ center: [0, 0], elevation: 0, zoom: 10, pitch: 0, bearing: 350 }, { center: [0, 0], elevation: 0, zoom: 10, pitch: 0, bearing: 10 }, 0.5);
    expect(Math.abs(wrap(mid.bearing - 0))).toBeLessThan(0.01);
  });

  it('con prefers-reduced-motion: sin transiciones de cámara ni giro suavizado', async () => {
    reduced = true;
    await setup3d();
    const before = map.jumps.length;
    press('[data-view="top"]');
    tick();
    expect(map.pitch).toBe(0);
    expect(map.jumps.length).toBe(before + 1);
    rm.setPlane({ ...B, heading: 200 }, { identity: ID });
    tick();
    expect(map.center).toEqual({ lng: B.lon, lat: B.lat }); // sin recorrido
    expect(wrap(map.bearing - 200)).toBeCloseTo(0, 5); // sin giro suavizado
  });
});

describe('modo 3D: la cámara no pelea con el gesto', () => {
  it('con un dedo en el mapa no hay ni un jumpTo (cortaría el gesto) y solo el centro acompaña al avión; el arrastre deja de seguir y se respeta', async () => {
    await setup3d();
    rm.setPlane(B, { identity: ID });
    tick();
    map.jumps.length = 0; map.directs = 0;
    point('pointerdown');
    const { bearing, pitch, zoom } = map;
    for (let i = 0; i < 20; i++) tick();
    expect(map.jumps).toHaveLength(0);
    expect(map.directs).toBeGreaterThan(15);
    expect([map.bearing, map.pitch, map.zoom]).toEqual([bearing, pitch, zoom]);
    map.fire('dragstart', { originalEvent: { touches: [{}] } });
    expect(followOn()).toBe(false);
    map.center = { lng: 3, lat: 41 }; // donde lo deja el dedo
    point('pointerup', 1, window);
    for (let i = 0; i < 20; i++) tick();
    expect(map.center).toEqual({ lng: 3, lat: 41 }); // sin snap al avión
  });

  it('tras girar con dos dedos sigue siguiendo sin saltar: se queda con el giro elegido; y «Seguir» vuelve poco a poco', async () => {
    await setup3d();
    point('pointerdown', 1); point('pointerdown', 2);
    tick();
    map.bearing = wrap(map.bearing + 40); map.pitch = 50; map.zoom = 16; // lo que hace el gesto
    const chosen = map.bearing;
    point('pointerup', 1, window); point('pointerup', 2, window);
    tick();
    expect(followOn()).toBe(true);
    expect(Math.abs(wrap(map.bearing - chosen))).toBeLessThan(0.5);
    expect([map.pitch, map.zoom]).toEqual([50, 16]);
    // Un dedo se lo lleva lejos; «Seguir avión»: sin salto al primer fotograma y llegando al avión.
    map.fire('dragstart', { originalEvent: { touches: [{}] } });
    map.center = { lng: map.center.lng + 0.2, lat: map.center.lat };
    point('pointerdown', 3); tick(); point('pointerup', 3, window); tick();
    const far = map.center.lng;
    press('[data-cam="follow"]');
    tick(); tick();
    expect(Math.abs(map.center.lng - far)).toBeLessThan(0.01);
    for (let i = 0; i < 80; i++) tick();
    expect(map.center.lng).toBeCloseTo(A.lon, 6);
    expect([map.pitch, map.zoom]).toEqual([50, 16]); // su encuadre
  });

  it('cambiar de perspectiva con el avión en marcha: el avión no se mueve del centro, sin saltos de giro ni de zoom', async () => {
    await setup3d();
    rm.setPlane(B, { identity: ID });
    for (let i = 0; i < 5; i++) tick();
    press('[data-view="side"]');
    let prev = { b: map.bearing, z: map.zoom, p: map.pitch };
    const shown = () => rm.planeState();
    expect(shown().shown).toBe(true);
    for (let i = 0; i < 60; i++) {
      const before = map.center.lat;
      tick();
      // El centro no se aparta de la recta del avión: siempre avanza y a su paso (nunca vuelve a un punto de partida fijo).
      expect(map.center.lat).toBeGreaterThanOrEqual(before);
      expect(map.center.lat - before).toBeLessThan((B.lat - A.lat) * (16 / PLANE_GLIDE_MS) * 1.3);
      expect(Math.abs(wrap(map.bearing - prev.b))).toBeLessThan(6);
      expect(Math.abs(map.zoom - prev.z)).toBeLessThan(0.5);
      expect(Math.abs(map.pitch - prev.p)).toBeLessThan(4);
      prev = { b: map.bearing, z: map.zoom, p: map.pitch };
    }
    expect(map.pitch).toBe(90);
  });
});

describe('modo 3D: contexto geográfico y rendimiento', () => {
  it('ciudades, costa, fronteras y carreteras a los zooms de la cámara 3D; sin calles, comercios ni otras fuentes', () => {
    const { under, over } = contextLayers({ zc: 7 });
    const all = [...under, ...over];
    for (const l of all) {
      expect(l.source).toBe('openmaptiles');
      expect(l.maxzoom).toBeUndefined(); // nada se apaga por el zoom alto de la cámara
    }
    const ids = all.map(l => l.id);
    for (const id of ['map3d-city', 'map3d-capital', 'map3d-town', 'map3d-country', 'map3d-water-name', 'map3d-road-motorway', 'map3d-road-major', 'map3d-border-country', 'map3d-urban']) expect(ids).toContain(id);
    expect(JSON.stringify(all)).not.toMatch(/poi|building|minor|service|path|"track"/);
    expect(all.find(l => l.id === 'map3d-city').layout['text-field']).toEqual(['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']]);
    // Sin los nombres de las teselas lejanas (de nivel bajo) amontonados en el horizonte.
    expect(JSON.stringify(all.find(l => l.id === 'map3d-city').filter)).toContain('["zoom"]');
    // El ancho compensa la distancia al suelo: al doble de zoom de referencia, el doble; sin altitud (NaN), el ancho tal cual.
    const w = groundWidthStops(1, 7);
    expect(w.slice(0, 3)).toEqual(['interpolate', ['exponential', 2], ['zoom']]);
    expect(w.at(-1)).toBeCloseTo(1 + 2 ** 17, 5);
    expect(groundWidthStops(1, NaN)).toBe(1);
  });

  it('las etiquetas lejanas no se descartan solo mientras dure el 3D (el corte vuelve al salir)', () => {
    const map = { style: { placement: { collisionIndex: new CollisionIndex() } } };
    const restore = keepDistantLabels(map);
    expect(new CollisionIndex().perspectiveRatioCutoff).toBe(0);
    restore();
    expect(new CollisionIndex().perspectiveRatioCutoff).toBe(0.6);
    expect(keepDistantLabels({ style: {} })).toBeNull(); // otra versión de MapLibre: se fuerzan las ciudades
    // Lo privado de MapLibre que usa el 3D sigue en la copia incluida (al actualizarla, este test avisa).
    const vendor = readFileSync('js/vendor/maplibre/maplibre-gl.mjs', 'utf8');
    for (const name of ['perspectiveRatioCutoff=.6', 'get transform(){return this._camera']) expect(vendor).toContain(name);
    expect(contextLayers({ overlap: true }).over.find(l => l.id === 'map3d-city').layout['text-allow-overlap']).toBe(true);
    expect(contextLayers().over.find(l => l.id === 'map3d-city').layout['text-allow-overlap']).toBeUndefined();
  });

  it('siguen las defensas de teselas y salir de 3D deja el estilo 2D exactamente como estaba', async () => {
    await setup3d();
    const before = STYLE_LAYERS.map(l => ({ ...l }));
    expect(map.opts.zoomLevelsToOverscale).toBe(22 - 14); // no se trocea el mapa base por encima de su nivel 14
    expect(map.base.calculateTileZoom()).toBe(22); // nivel de tesela acotado (30 sin el tope)
    expect(map.sources['map3d-ground'].maxzoom).toBe(4);
    expect(map.paintP['background/background-opacity']).toBe(0); // la capa background, sin su cobertura de teselas
    expect(map.layout['label_city/visibility']).toBe('none');
    expect(map.layers.some(l => l.id === 'map3d-city')).toBe(true);
    expect(new CollisionIndex().perspectiveRatioCutoff).toBe(0);
    await rm.setMode('2d');
    expect(map.layers.filter(l => !['route', 'track', 'track-halo'].includes(l.id))).toEqual(before);
    expect(map.layout['label_city/visibility']).toBeUndefined(); // como estaba: sin nada explícito
    expect(map.paintP['background/background-opacity']).toBeUndefined();
    expect(map.paintP['water/fill-color']).toBe('#cbd9e4');
    expect(map.base.calculateTileZoom).toBeUndefined();
    expect(map.sources['map3d-ground']).toBeUndefined();
    expect(new CollisionIndex().perspectiveRatioCutoff).toBe(0.6);
    expect(hero.querySelector('.map3d-ui')).toBeNull();
    // Y el bucle del 3D ha acabado: el avión vuelve a su recorrido de 2D sin mover la cámara.
    const jumps = map.jumps.length;
    rm.setPlane(B, { identity: ID });
    for (let i = 0; i < 10; i++) tick();
    expect(map.jumps.length).toBe(jumps);
  });

  it('la neblina va donde está el horizonte del suelo: arriba de la vista si se mira hacia abajo, al centro de lado', () => {
    expect(horizonClipY(90, 36.87)).toBe(0);
    expect(horizonClipY(78, 36.87)).toBeCloseTo(0.64, 1);
    expect(horizonClipY(0, 36.87)).toBeGreaterThan(5);
  });
});
