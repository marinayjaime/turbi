// Tarjeta del mapa (js/map.js): título por fase, marcador del avión solo con posición real y Leaflet prescindible.
// Leaflet se simula con un `L` falso en globalThis: se cuentan marcadores creados, movidos y quitados.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { routeLines, mapCardHtml, createRouteMap } from '../js/map.js';

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
      const m = { ...layer(), ll, o, setLatLng(p) { log.moved.push(p); this.ll = p; return this; } };
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
    const m = await createRouteMap(el(), OPTS);
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
