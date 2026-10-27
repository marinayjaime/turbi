import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveAircraft, buildAircraftGeometry, GENERIC_SPEC } from '../js/aircraft3d.js';
import { identifyAircraft } from '../js/aircraft-id.js';
import { aircraftName } from '../js/plain.js';
import { trailGeometry, aircraftLabel } from '../js/map3d.js';

const index = JSON.parse(readFileSync('data/aircraft3d/index.json', 'utf8'));
const modelIds = readdirSync('data/aircraft3d/models').map(f => f.replace(/\.json$/, ''));
const liveryIds = readdirSync('data/aircraft3d/liveries').map(f => f.replace(/\.json$/, ''));
const resolve = card => resolveAircraft(index, identifyAircraft(card, aircraftName));

describe('avión 3D: modelo y decoración', () => {
  it('orden de preferencia: modelo + decoración de la operadora; modelo con colores neutros; genérico', () => {
    // 1) Ryanair 737 MAX 8 (FR24 da el tipo real; Aena, la operadora; el indicativo coincide).
    expect(resolve({ opCode: 'FR', aircraft: 'Boeing 737-800', radar: { type: 'B38M', callsign: 'RYR7XA' } }))
      .toMatchObject({ modelId: 'b737-max8', liveryId: 'ryanair', level: 'exact' });
    // 2) Operadora sin decoración en el catálogo, o con decoración pero no hecha para ese modelo (Ryanair A320).
    expect(resolve({ opCode: 'UX', aircraft: 'Boeing 737-800' })).toMatchObject({ modelId: 'b737-800', liveryId: null, level: 'neutral', why: 'operadora-sin-decoracion' });
    expect(resolve({ opCode: 'FR', aircraft: 'Airbus A320' })).toMatchObject({ modelId: 'a320ceo', liveryId: null, level: 'neutral', why: 'decoracion-no-hecha-para-el-modelo' });
    // 3) Modelo sin recurso 3D o desconocido: genérico, nunca la decoración de la operadora.
    expect(resolve({ opCode: 'LG', radar: { type: 'DH8D', callsign: 'LGL82T' } })).toMatchObject({ modelId: 'generic', liveryId: null, level: 'generic', why: 'modelo-sin-recurso' });
    expect(resolve({ opCode: 'FR' })).toMatchObject({ modelId: 'generic', level: 'generic', why: 'modelo-desconocido' });
  });

  it('operadora, no la que comercializa: sin operadora confirmada usa el indicativo; si se contradicen, colores neutros', () => {
    // Número de Iberia operado por Air Nostrum: Aena no da `op` (opCode null) y el número no cuenta; el indicativo ANE sí.
    expect(resolve({ al: 'IB', aircraft: 'Bombardier CRJ1000', radar: { callsign: 'ANE8862' } })).toMatchObject({ liveryId: 'air-nostrum', level: 'exact' });
    expect(resolve({ al: 'IB', aircraft: 'Bombardier CRJ1000' })).toMatchObject({ liveryId: null, level: 'neutral', why: 'operadora-desconocida' });
    // Aena dice FR y el indicativo es de otra aerolínea (avión fletado, Malta Air…): no se afirma la decoración.
    expect(resolve({ opCode: 'FR', aircraft: 'Boeing 737-800', radar: { callsign: 'MAY4211' } })).toMatchObject({ liveryId: null, level: 'neutral', why: 'operadora-sin-confirmar' });
    // El modelo del radar (el avión real) manda sobre el previsto en el horario.
    expect(identifyAircraft({ aircraft: 'Airbus A320', radar: { type: 'A21N' } }, aircraftName)).toMatchObject({ model: 'Airbus A321neo', modelSource: 'radar' });
  });

  it('catálogo coherente: cada modelo y decoración del índice tiene su archivo y cada nombre de Turbi existe en js/plain.js', () => {
    for (const id of Object.values(index.types)) expect(modelIds).toContain(id);
    for (const [id, l] of Object.entries(index.liveries)) {
      expect(liveryIds).toContain(id);
      for (const m of l.models) expect(modelIds).toContain(m);
    }
    const names = new Set(['B738', 'B38M', 'A320', 'A20N', 'A21N', 'A321', 'A319', 'CRK', 'AT76', 'AT75', 'E295', 'E190', 'A359', 'B789', 'BCS3', 'A332', 'A333'].map(aircraftName));
    for (const n of names) expect(index.types[n], n).toBeTruthy();
  });

  it('Ryanair, Iberia y Vueling: nombre, procedencia de cada rasgo y combinaciones que no se confunden entre sí', () => {
    const liv = id => JSON.parse(readFileSync(`data/aircraft3d/liveries/${id}.json`, 'utf8'));
    const [ryr, ibe, vlg] = ['ryanair', 'iberia', 'vueling'].map(liv);
    for (const l of [ryr, ibe, vlg]) { expect(l.paint.title.text).toBeTruthy(); expect(l.basis).toMatch(/\S/); }
    // Más allá del color de la cola: nombre (texto y color), panza y winglets distintos.
    const key = l => JSON.stringify([l.paint.title.text, l.paint.title.color, l.paint.belly?.color ?? null, l.paint.tail.color, l.paint.winglets]);
    expect(new Set([ryr, ibe, vlg].map(key)).size).toBe(3);
    expect(new Set([ryr, ibe, vlg].map(l => l.paint.title.color)).size).toBe(3);
  });

  it('geometría de cada modelo: índices válidos, normales unitarias, UV en [0, 1] y del largo real', () => {
    for (const id of modelIds) {
      const spec = JSON.parse(readFileSync(`data/aircraft3d/models/${id}.json`, 'utf8'));
      const g = buildAircraftGeometry(spec);
      const n = g.positions.length / 3;
      expect(Math.max(...g.indices), id).toBeLessThan(n);
      for (let i = 0; i < g.normals.length; i += 3) expect(Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])).toBeCloseTo(1, 3);
      expect(Math.min(...g.uvs)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...g.uvs)).toBeLessThanOrEqual(1);
      let y0 = Infinity, y1 = -Infinity, x1 = 0;
      for (let i = 0; i < g.positions.length; i += 3) { y0 = Math.min(y0, g.positions[i + 1]); y1 = Math.max(y1, g.positions[i + 1]); x1 = Math.max(x1, Math.abs(g.positions[i])); }
      expect(y1 - y0, id).toBeCloseTo(spec.length, 0);
      expect(x1 * 2, id).toBeGreaterThan(spec.span * 0.95);
      expect(x1 * 2, id).toBeLessThan(spec.span * 1.1);
    }
    expect(buildAircraftGeometry(GENERIC_SPEC).indices.length).toBeGreaterThan(0);
  });
});

describe('modo 3D: estela y etiqueta', () => {
  const project = (lon, lat, m) => ({ x: lon, y: -lat, z: m });
  it('la estela va a la altitud real de cada punto; un tramo sin altitud no se pinta en 3D (el 2D lo sigue mostrando)', () => {
    const t = trailGeometry([[40, -3, 1000], [40.1, -3, 2000], [40.2, -3, null], [40.3, -3, 3000], [40.4, -3, 4000]], project);
    // Dos tramos con altitud en sus dos puntos: 6 vértices de cinta y 6 de cortina cada uno.
    expect(t.ribbon.length / 9).toBe(12);
    expect(t.curtain.length / 9).toBe(12);
    const zs = new Set(); for (let i = 2; i < t.ribbon.length; i += 9) zs.add(Math.round(t.ribbon[i]));
    expect([...zs].sort((a, b) => a - b)).toEqual([305, 610, 914, 1219]);
  });
  it('la etiqueta dice lo que es: decoración simplificada, colores neutros con el motivo o genérico', () => {
    expect(aircraftLabel({ level: 'exact', operator: 'Ryanair' }, { modelSource: 'radar' }, 'Boeing 737-800')).toBe('Boeing 737-800 · colores de Ryanair, simplificados');
    expect(aircraftLabel({ level: 'neutral', why: 'operadora-sin-confirmar' }, { modelSource: 'horario' }, 'Airbus A320')).toBe('Airbus A320 (previsto en el horario) · colores neutros (operadora sin confirmar)');
    expect(aircraftLabel({ level: 'generic', why: 'modelo-sin-recurso' }, { model: 'Dash 8-400' }, '')).toBe('Avión genérico: Dash 8-400 aún sin modelo 3D');
  });
});
