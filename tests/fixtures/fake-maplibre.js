// MapLibre simulado para los tests (js/map.js lo toma de globalThis.maplibregl): registra lo mismo que observaban los
// tests con el antiguo Leaflet simulado, en coordenadas [lat, lon]:
//   log.maps / log.mapsRemoved: mapas creados y destruidos; log.map: el último creado;
//   log.view: lo que mueve la vista (fitBounds, jumpTo…), nunca la vista inicial del constructor;
//   log.markers: marcadores del AVIÓN (.plane-marker) con path (todas sus posiciones), ll, removed, rot (.plane-rot) y
//     cls.has(clase) de ese .plane-rot; log.airports: los de los aeropuertos;
//   log.lines: una por fuente GeoJSON dibujada como línea, con coords, o.dashArray (ruta prevista, SIGMET) y live (con
//     algún punto y su mapa sin destruir), o.color (el de la última capa) y o.layers (cada capa: id, color, ancho,
//     opacidad). La estela es la línea sin dashArray. Una colección de segmentos (la estela por altitud) se lee como una
//     sola línea (coords, sin repetir las uniones) y además l.segments: [{ coords, alt }] (alt: pies o undefined).
// fail: el constructor falla como sin WebGL (el mapa no se crea).
export function fakeMapLibre({ fail = false } = {}) {
  const log = { maps: 0, mapsRemoved: 0, markers: [], airports: [], view: [], lines: [] };
  const lines = d => (d?.type === 'Feature' ? [d] : d?.features ?? []).filter(f => f.geometry?.type === 'LineString');
  const coordsOf = d => {
    const out = [];
    for (const f of lines(d)) {
      for (const [lon, lat] of f.geometry.coordinates) if (!(out.at(-1)?.[0] === lat && out.at(-1)?.[1] === lon)) out.push([lat, lon]);
    }
    return out;
  };
  const segmentsOf = d => lines(d).map(f => ({ coords: f.geometry.coordinates.map(([lon, lat]) => [lat, lon]), alt: f.properties?.alt }));
  class Map {
    constructor(opts) {
      if (fail) throw new Error('WebGL no disponible');
      log.maps++;
      log.map = this;
      this.opts = opts;
      this.removed = false;
      this.data = {};
      this.lines = {};
      this.center = { lng: 0, lat: 0 };
      this.zoom = 3;
      this.cooperativeGestures = { enabled: true, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
      this.touchZoomRotate = { disableRotation() {} };
    }
    once(ev, cb) { if (ev === 'load') queueMicrotask(cb); return this; }
    on(ev, cb) { (this.handlers ??= {})[ev] = [...(this.handlers[ev] ?? []), cb]; return this; }
    // Para las pruebas: lanza un evento del mapa (p. ej. 'dragstart' con originalEvent: lo mueve el usuario).
    fire(ev, e = {}) { for (const cb of this.handlers?.[ev] ?? []) cb(e); }
    loaded() { return true; }
    addSource(id, src) {
      const self = this;
      this.data[id] = src.data;
      this[`src_${id}`] = { setData(d) { self.data[id] = d; const l = self.lines[id]; if (l) { l.coords = coordsOf(d); l.segments = segmentsOf(d); l.live = !self.removed && l.coords.length > 0; } } };
    }
    getSource(id) { return this[`src_${id}`]; }
    addLayer(layer) {
      if (layer.type !== 'line') return;
      let l = this.lines[layer.source];
      if (!l) {
        l = this.lines[layer.source] = { id: layer.source, coords: coordsOf(this.data[layer.source]), segments: segmentsOf(this.data[layer.source]), o: { layers: [] }, live: false };
        l.live = l.coords.length > 0;
        log.lines.push(l);
      }
      if (layer.paint?.['line-dasharray']) l.o.dashArray = layer.paint['line-dasharray'];
      if (layer.paint?.['line-color']) l.o.color = layer.paint['line-color']; // texto o expresión de MapLibre
      l.o.layers.push({ id: layer.id, color: layer.paint?.['line-color'], width: layer.paint?.['line-width'], opacity: layer.paint?.['line-opacity'] ?? 1 });
    }
    // Como MapLibre: un maxZoom presente pero no numérico (p. ej. undefined) hace fallar el encuadre.
    fitBounds(_b, o = {}) { if ('maxZoom' in o && !Number.isFinite(o.maxZoom)) throw new Error('Invalid LngLat object: (NaN, NaN)'); log.view.push('fitBounds'); }
    jumpTo(v) { log.view.push('jumpTo'); if (v?.center) this.center = v.center; if (Number.isFinite(v?.zoom)) this.zoom = v.zoom; }
    getCenter() { return this.center; }
    getZoom() { return this.zoom; }
    resize() {}
    remove() { log.mapsRemoved++; this.removed = true; for (const l of Object.values(this.lines)) l.live = false; }
  }
  class Marker {
    constructor({ element }) {
      this.el = element;
      this.path = [];
      this.ll = null;
      this.removed = false;
      (element.classList.contains('plane-marker') ? log.markers : log.airports).push(this);
    }
    setLngLat([lon, lat]) { this.ll = [lat, lon]; this.path.push([lat, lon]); return this; }
    addTo(map) { this.map = map; return this; }
    remove() { this.removed = true; }
    getElement() { return this.el; }
    get rot() { return this.el.querySelector('.plane-rot'); }
    get cls() { return { has: c => Boolean(this.rot?.classList.contains(c)) }; }
  }
  return { L: { Map, Marker }, log };
}
