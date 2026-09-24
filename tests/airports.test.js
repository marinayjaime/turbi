import { describe, it, expect } from 'vitest';
import { findAirport, searchAirports } from '../js/airports.js';
import { parseCSVLine, toEntry } from '../scripts/build-airports.mjs';

const DB = {
  PMI: ['Palma de Mallorca Airport', 'Palma De Mallorca', 39.5517, 2.7388],
  BCN: ['Josep Tarradellas Barcelona-El Prat Airport', 'Barcelona', 41.2971, 2.0785],
  MAD: ['Adolfo Suárez Madrid–Barajas Airport', 'Madrid', 40.4719, -3.5626],
};

describe('findAirport', () => {
  it('encuentra por código sin importar mayúsculas ni espacios', () => {
    expect(findAirport(DB, ' pmi ')).toEqual({ iata: 'PMI', name: 'Palma de Mallorca Airport', city: 'Palma De Mallorca', lat: 39.5517, lon: 2.7388 });
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
