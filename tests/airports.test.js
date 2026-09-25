import { describe, it, expect, vi } from 'vitest';
import { findAirport, searchAirports } from '../js/airports.js';
import { parseCSVLine, toEntry } from '../scripts/build-airports.mjs';

const DB = {
  PMI: ['Palma de Mallorca Airport', 'Palma De Mallorca', 39.5517, 2.7388],
  BCN: ['Josep Tarradellas Barcelona-El Prat Airport', 'Barcelona', 41.2971, 2.0785],
  MAD: ['Adolfo Suárez Madrid–Barajas Airport', 'Madrid', 40.4719, -3.5626],
};

describe('findAirport', () => {
  it('encuentra por código sin importar mayúsculas ni espacios', () => {
    expect(findAirport(DB, ' pmi ')).toEqual({ iata: 'PMI', name: 'Palma de Mallorca Airport', city: 'Palma De Mallorca', lat: 39.5517, lon: 2.7388, tz: null }); // datos de prueba sin zona (la real está en data/airports.json)
  });
  it('código desconocido → null', () => {
    expect(findAirport(DB, 'ZZZ')).toBeNull();
  });
});

describe('searchAirports', () => {
  it('prioriza coincidencia de código y busca en ciudad sin acentos', () => {
    expect(searchAirports(DB, 'bc').map(a => a.iata)).toEqual(['BCN']);
    expect(searchAirports(DB, 'madrid').map(a => a.iata)).toEqual(['MAD']);
    expect(searchAirports(DB, 'suarez').map(a => a.iata)).toEqual(['MAD']);
    expect(searchAirports(DB, '')).toEqual([]);
  });
});

describe('build-airports', () => {
  const header = ['id', 'ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'continent', 'iso_country', 'iso_region', 'municipality', 'scheduled_service', 'icao_code', 'iata_code'];
  it('parseCSVLine respeta comillas y comas dentro de campos', () => {
    expect(parseCSVLine('1,"a, b","c ""d"""')).toEqual(['1', 'a, b', 'c "d"']);
  });
  it('toEntry filtra y redondea', () => {
    const row = parseCSVLine('3,"LEPA","large_airport","Palma de Mallorca Airport",39.551701,2.73881,27,"EU","ES","ES-PM","Palma De Mallorca","yes","LEPA","PMI"');
    expect(toEntry(row, header)).toEqual(['PMI', ['Palma de Mallorca Airport', 'Palma De Mallorca', 39.5517, 2.7388]]);
    const heli = parseCSVLine('4,"X","heliport","H",1,2,3,"EU","ES","ES-PM","P","yes","","ABC"');
    expect(toEntry(heli, header)).toBeNull();
    const noService = parseCSVLine('5,"Y","medium_airport","M",1,2,3,"EU","ES","ES-PM","P","no","","ABD"');
    expect(toEntry(noService, header)).toBeNull();
  });
});

import { vi } from 'vitest';
import { loadAirports } from '../js/airports.js';

describe('loadAirports', () => {
  it('si no carga, error en español y se puede reintentar', async () => {
    const msg = 'No se pudo cargar la lista de aeropuertos.';
    await expect(loadAirports(vi.fn(async () => ({ ok: false, status: 404 })))).rejects.toThrow(msg);
    await expect(loadAirports(vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } })))).rejects.toThrow(msg);
    await expect(loadAirports(vi.fn(async () => { throw new TypeError('Failed to fetch'); }))).rejects.toThrow(msg);
    expect(await loadAirports(vi.fn(async () => ({ ok: true, json: async () => ({ PMI: ['P', 'Palma', 1, 2] }) })))).toHaveProperty('PMI');
  });
});

import { toIcao } from '../scripts/build-airports.mjs';

describe('toIcao', () => {
  const header = ['id', 'ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'continent', 'iso_country', 'iso_region', 'municipality', 'scheduled_service', 'icao_code', 'iata_code', 'gps_code'];
  it('IATA → OACI (icao_code, o gps_code si falta)', () => {
    expect(toIcao(['3', 'LEPA', 'large_airport', 'P', '1', '2', '3', 'EU', 'ES', 'ES-PM', 'P', 'yes', 'LEPA', 'PMI', 'LEPA'], header)).toEqual(['PMI', 'LEPA']);
    expect(toIcao(['4', 'X', 'medium_airport', 'M', '1', '2', '3', 'EU', 'ES', 'ES-PM', 'P', 'yes', '', 'ABC', 'LEXX'], header)).toEqual(['ABC', 'LEXX']);
    expect(toIcao(['5', 'X', 'medium_airport', 'M', '1', '2', '3', 'EU', 'ES', 'ES-PM', 'P', 'yes', '', 'ABD', ''], header)).toBeNull();
    expect(toIcao(['6', 'X', 'heliport', 'H', '1', '2', '3', 'EU', 'ES', 'ES-PM', 'P', 'yes', 'LEZZ', 'ABE', ''], header)).toBeNull();
  });
});

import { timezoneOf } from '../js/airports.js';
import { localToUtcMs, formatLocal } from '../js/time.js';
import { readFileSync } from 'node:fs';
describe('zona horaria IANA del aeropuerto, sin Open-Meteo', () => {
  const db = JSON.parse(readFileSync('data/airports.json', 'utf8'));
  it('PMI, DUB y JFK con su identificador IANA en data/airports.json', () => {
    expect(findAirport(db, 'PMI').tz).toBe('Europe/Madrid');
    expect(findAirport(db, 'DUB').tz).toBe('Europe/Dublin');
    expect(findAirport(db, 'JFK').tz).toBe('America/New_York');
  });
  it('cero llamadas a Open-Meteo si el aeropuerto trae su zona', async () => {
    const f = vi.fn();
    expect(await timezoneOf(findAirport(db, 'PMI'), f)).toBe('Europe/Madrid');
    expect(f).not.toHaveBeenCalled();
  });
  it('sin zona (caso de revisión): respaldo excepcional con Open-Meteo', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ timezone: 'Asia/Urumqi' }) }));
    expect(await timezoneOf({ iata: 'URC', lat: 43.9, lon: 87.5, tz: null }, f)).toBe('Asia/Urumqi');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('horario de verano e invierno con los identificadores (Intl hace el cambio)', () => {
    const tz = c => findAirport(db, c).tz;
    // 12:00 UTC en julio y en enero
    expect(formatLocal(Date.parse('2026-07-15T12:00:00Z'), tz('PMI'))).toBe('14:00');
    expect(formatLocal(Date.parse('2026-01-15T12:00:00Z'), tz('PMI'))).toBe('13:00');
    expect(formatLocal(Date.parse('2026-07-15T12:00:00Z'), tz('DUB'))).toBe('13:00');
    expect(formatLocal(Date.parse('2026-01-15T12:00:00Z'), tz('DUB'))).toBe('12:00');
    expect(formatLocal(Date.parse('2026-07-15T12:00:00Z'), tz('JFK'))).toBe('08:00');
    expect(formatLocal(Date.parse('2026-01-15T12:00:00Z'), tz('JFK'))).toBe('07:00');
    expect(localToUtcMs('2026-10-25', '12:00', tz('PMI'))).toBe(Date.parse('2026-10-25T11:00:00Z')); // ya en invierno
  });
  it('todos los identificadores del archivo los acepta Intl (o son null, para revisión)', () => {
    for (const [, r] of Object.entries(db)) {
      if (r[4] === null) continue;
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: r[4] })).not.toThrow();
    }
  });
});

import { resolveTimezones } from '../scripts/airport-tz.mjs';
describe('generación de zonas horarias (geo-tz, local)', () => {
  it('una zona válida se guarda; ambigua, vacía o no válida → null y a revisión (nunca se elige sola)', () => {
    const zones = { A: ['Europe/Madrid'], B: ['Asia/Shanghai', 'Asia/Urumqi'], C: [], D: ['Mars/Olympus'] };
    const db = Object.fromEntries(Object.keys(zones).map((k, i) => [k, [k, k, i, i]]));
    const find = (lat) => zones[Object.keys(zones)[lat]];
    const { db: out, review } = resolveTimezones(db, find);
    expect(out.A[4]).toBe('Europe/Madrid');
    expect([out.B[4], out.C[4], out.D[4]]).toEqual([null, null, null]);
    expect(review.map(r => [r.iata, r.reason])).toEqual([['B', 'ambiguo'], ['C', 'sin zona'], ['D', 'no válida para Intl']]);
    expect(review[0].candidates).toEqual(['Asia/Shanghai', 'Asia/Urumqi']);
  });
});
