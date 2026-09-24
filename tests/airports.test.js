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
