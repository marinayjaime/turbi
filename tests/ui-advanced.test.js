// Detalles avanzados (js/ui-advanced.js): tarjeta cerrada por defecto con las categorías técnicas. Cada categoría solo
// aparece si tiene contenido, y nada se inventa. Los `card` son literales.
import { describe, it, expect } from 'vitest';
import { advancedShellHtml, advancedFlightHtml, advancedHistoryHtml } from '../js/ui-advanced.js';
import { aviationHtml, freshnessHtml } from '../js/ui-forecast.js';
import { BUILD_ID } from '../js/build.js';
import { readFileSync } from 'node:fs';

const NOW = Date.parse('2026-10-20T08:00:00Z');
const card = over => ({ source: 'aena', aircraft: 'Modelo X', airline: 'Aerolínea Y', ...over });
const volando = over => ({ state: 'volando', seenS: 5, callsign: 'ABC123', altFt: 30000, altM: 9144, kmh: 800, vRateFpm: -640,
  lat: 40.12346, lon: -3.5, posAgeS: 5, match: 'ruta', ...over });
const has = (html, key) => html.includes(`data-card="adv-${key}"`);
const text = html => html.replace(/<[^>]+>/g, ''); // el texto que se lee (la antigüedad va en su <span class="adv-age">)

describe('advancedShellHtml', () => {
  it('es una tarjeta cerrada con los huecos de las categorías', () => {
    const html = advancedShellHtml();
    expect(html).toContain('<details class="card adv" data-card="advanced">');
    expect(html).not.toMatch(/<details[^>]*data-card="advanced"[^>]* open/);
    for (const id of ['adv-flight', 'adv-sources', 'adv-history', 'fresh', 'aviation']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('<details data-card="adv-weather"');
    expect(html).toMatch(/data-card="adv-weather"[^>]* hidden>/); // oculta hasta que app.js rellena #aviation
  });
  it('abierto solo si se pide', () => {
    expect(advancedShellHtml({ open: new Set(['advanced']) })).toMatch(/data-card="advanced" open/);
  });
});

describe('advancedFlightHtml', () => {
  it('un vuelo de Aena sin radar no tiene «Datos ADS-B»', () => {
    expect(has(advancedFlightHtml(card(), { nowMs: NOW }), 'adsb')).toBe(false);
  });
  it('con radar volando y lat sí, con la posición', () => {
    const html = advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW });
    expect(has(html, 'adsb')).toBe(true);
    expect(html).toContain('ABC123');
    expect(html).toContain('40.1235');
    expect(html).toContain('-3.5000');
    expect(html).toContain('9.144 m');
    expect(html).toContain('-640');
    expect(html).toContain('Última señal');
    expect(html).toContain('Por ruta');
  });
  it('señal reciente con el avión aún en el mapa (≤ 60 s): altitud, velocidad y posición sin antigüedad', () => {
    const html = text(advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW + 30000 }));
    expect(html).not.toMatch(/ft · 9\.144 m · hace|km\/h · hace|-3\.5000 · hace/);
  });
  it('entre 60 y 300 s (señal aún «live», el mapa ya quitó el avión): solo la posición lleva su antigüedad', () => {
    for (const s of [65, 120, 290]) {
      const html = text(advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW + (s - 5) * 1000 }));
      expect(html).not.toMatch(/ft · 9\.144 m · hace|km\/h · hace/);
      expect(html).toContain(`-3.5000 · hace ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`}`);
    }
  });
  it('la antigüedad de la Posición sale de posAgeS, no de la señal (seenS 1, posAgeS 50: a los 20 s el avión ya no está)', () => {
    const html = text(advancedFlightHtml(card({ radar: volando({ seenS: 1, posAgeS: 50 }), radarReceivedAt: NOW }), { nowMs: NOW + 20000 }));
    expect(html).toContain('-3.5000 · hace 1 min'); // 70 s de posición
    expect(html).toContain('hace 21 s'); // «Última señal» sigue midiendo el último mensaje
    expect(html).not.toMatch(/km\/h · hace/);
  });
  it('con la posición aún reciente (posAgeS 50, 5 s después) no lleva antigüedad aunque el mensaje sea más viejo', () => {
    const html = text(advancedFlightHtml(card({ radar: volando({ seenS: 40, posAgeS: 50 }), radarReceivedAt: NOW }), { nowMs: NOW + 5000 }));
    expect(html).not.toContain('-3.5000 · hace');
  });
  it('«Última señal» lleva su clase propia (el contador de app.js solo reescribe su valor)', () => {
    const html = advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW });
    expect(html).toContain('<div class="kv adv-signal"><span class="k">Última señal</span><span class="v">hace 5 s</span></div>');
  });
  it.each([['old', 6], ['stale', 13]])('señal %s: altitud, velocidades y posición llevan «· hace X min» (nunca parecen actuales)', (_lvl, min) => {
    const html = advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW + min * 60000 });
    for (const v of ['9.144 m', '800 km/h', '-640 ft/min', '-3.5000']) expect(text(html)).toContain(`${v} · hace ${min} min`);
    expect(html.match(/<span class="adv-age"[^>]*> · hace \d+ min<\/span>/g)).toHaveLength(4);
    expect(html).toContain('ABC123</span>'); // el indicativo no envejece
  });
  it('radar sin posición: no inventa lat/lon', () => {
    const html = advancedFlightHtml(card({ radar: volando({ lat: undefined, lon: undefined }), radarReceivedAt: NOW }), { nowMs: NOW });
    expect(html).not.toContain('Posición');
  });
  it('AeroDataBox con aircraftReg muestra la matrícula; Aena no', () => {
    const adb = advancedFlightHtml(card({ source: 'aerodatabox', aircraftReg: 'EC-ABC', aircraftHex: '34abcd' }), { nowMs: NOW });
    expect(adb).toContain('EC-ABC');
    expect(adb).toContain('34ABCD');
    const aena = advancedFlightHtml(card(), { nowMs: NOW });
    expect(aena).not.toContain('Matrícula');
    expect(has(aena, 'aircraft')).toBe(true);
  });
  it('conserva la atribución completa de la foto', () => {
    const html = advancedFlightHtml(card({ photo: { thumb: 'x', artist: 'Autor <b>', license: 'CC BY', page: 'https://c.example/p' } }), { nowMs: NOW });
    expect(html).toContain('Autor &lt;b&gt;');
    expect(html).toContain('CC BY');
    expect(html).toContain('href="https://c.example/p"');
  });
  it('sin photo.shared ni operator no hay «Códigos compartidos»', () => {
    expect(has(advancedFlightHtml(card(), { nowMs: NOW }), 'codeshare')).toBe(false);
    const op = advancedFlightHtml(card({ operator: 'Operadora Z' }), { nowMs: NOW });
    expect(has(op, 'codeshare')).toBe(true);
    expect(op).toContain('Operadora Z');
    expect(has(advancedFlightHtml(card({ photo: { shared: true } }), { nowMs: NOW }), 'codeshare')).toBe(true);
  });
  it('información técnica: clave física, códigos de Aena y BUILD_ID', () => {
    const html = advancedFlightHtml(card({ physicalKey: 'K-1', aenaCodes: { st: 'S1', std: null, sta: 'A2' } }), { nowMs: NOW });
    expect(html).toContain('K-1');
    expect(html).toContain('S1');
    expect(html).toContain('A2');
    expect(html).toContain(BUILD_ID);
  });
  it('fuentes: Aena con su antigüedad, AeroDataBox con sourceNote y radar adsb.lol', () => {
    const aena = advancedFlightHtml(card({ updatedAgo: 'hace 5 minutos', radar: volando(), radarReceivedAt: NOW }), { nowMs: NOW });
    expect(aena).toContain('Aena');
    expect(aena).toContain('hace 5 minutos');
    expect(aena).toContain('adsb.lol');
    const adb = advancedFlightHtml(card({ source: 'aerodatabox', sourceNote: 'Horario según AeroDataBox · consultado hace 1 minuto' }), { nowMs: NOW });
    expect(adb).toContain('Horario según AeroDataBox · consultado hace 1 minuto');
    expect(adb).not.toContain('adsb.lol');
  });
  it('conserva las categorías abiertas', () => {
    const html = advancedFlightHtml(card(), { open: new Set(['adv-aircraft']), nowMs: NOW });
    expect(html).toMatch(/data-card="adv-aircraft" open/);
    expect(html).not.toMatch(/data-card="adv-tech" open/);
  });
  it('sin emojis', () => {
    const html = advancedFlightHtml(card({ radar: volando(), radarReceivedAt: NOW, operator: 'Op', physicalKey: 'k' }), { nowMs: NOW });
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('advancedHistoryHtml', () => {
  it('solo las marcas que existen', () => {
    expect(advancedHistoryHtml({}, NOW)).toBe('');
    const html = advancedHistoryHtml({ queriedAt: NOW - 120000, trend: 'Sin cambios relevantes desde hace 1 hora.' }, NOW);
    expect(html).toContain('data-card="adv-history"');
    expect(html).toContain('hace 2 minutos');
    expect(html).toContain('Sin cambios relevantes');
    expect(html).not.toContain('Aena');
    expect(advancedHistoryHtml({ aenaUpdatedAgo: 'hace 3 minutos' }, NOW)).toContain('hace 3 minutos');
  });
});

describe('aviationHtml y freshnessHtml en Detalles avanzados', () => {
  const a = { icao: 'LEAA', iata: 'AAA', metarText: 'Viento', metarRaw: 'METAR RAW', tafText: ['t'], tafRaw: 'TAF RAW' };
  const av = { origin: a, destination: a, sigmets: [{ label: 'Turbulencia', raw: 'SIGMET RAW', crosses: true }], pireps: [{ label: 'P', raw: 'PIREP RAW' }] };
  it('siguen mostrando los partes oficiales desplegables', () => {
    const html = aviationHtml(av, NOW);
    expect(html.match(/<details class="raw">/g).length).toBe(6);
    for (const raw of ['METAR RAW', 'TAF RAW', 'SIGMET RAW', 'PIREP RAW']) expect(html).toContain(raw);
  });
  it('freshnessHtml mantiene su contenido', () => {
    const t = freshnessHtml({ queriedAt: NOW - 60000, models: ['ECMWF', 'GFS'], agreement: { level: 'alta' } }, NOW);
    expect(t).toContain('Consulta realizada hace 1 minuto');
    expect(t).toContain('Los dos modelos coinciden bastante');
  });
});

describe('integración mínima', () => {
  it('sw.js precachea js/ui-advanced.js', () => {
    expect(readFileSync('sw.js', 'utf8')).toContain("'js/ui-advanced.js'");
  });
});
