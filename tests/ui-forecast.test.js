import { describe, it, expect } from 'vitest';
import { summaryHtml, timelineHtml, segmentDetailHtml, altitudeHtml, freshnessHtml, aviationHtml, offlineBanner, renderForecast, flText } from '../js/ui-forecast.js';

const NOW = Date.parse('2026-09-24T10:18:00Z');
const seg = (level, startMin, endMin, extra = {}) => ({ level, startMin, endMin, causes: level ? ['vertical_shear', 'jet_stream'] : [], flMin: 350, flMax: 350, mid: { kmFromOrigin: 180 }, ...extra });
const view = {
  v: 2, flight: null, title: 'PMI → MAD', subtitle: 'IB1668 · Iberia', times: '17:55–19:25', fromCity: 'Palma de Mallorca', toCity: 'Madrid', originIata: 'PMI',
  durationMin: 90,
  summary: { headline: 'Mayormente tranquilo', verdict: 'tranquilo', maxLevel: 2, maxDurationMin: 12, moments: [{ startMin: 42, endMin: 54 }], percentages: [60, 30, 10, 0] },
  confidence: { level: 'alta', reasons: ['faltan menos de 24 h', 'ECMWF y GFS muestran un patrón parecido', 'cobertura meteorológica completa'] },
  segments: [seg(0, 0, 42), seg(2, 42, 54, { place: 'sobre el Golfo de León' }), seg(0, 54, 90)],
  altitudes: [300, 320, 340, 360, 380, 400].map((fl, i) => ({ flightLevel: fl, worst: [1, 1, 2, 1, 0, 0][i], share: [0.3, 0.3, 0.5, 0.2, 0, 0][i], isCruise: fl === 360, calmest: fl >= 380 })),
  models: ['ECMWF', 'GFS'], agreement: { level: 'alta' }, queriedAt: NOW - 18 * 60000, runs: { ECMWF: Date.parse('2026-09-24T00:00:00Z'), GFS: Date.parse('2026-09-24T06:00:00Z') },
};

describe('resumen', () => {
  it('responde: cómo será, máximo, duración, momento, confianza y porcentajes', () => {
    const h = summaryHtml(view);
    for (const t of ['Mayormente tranquilo', 'Máximo previsto', 'Turbulencia moderada', 'Duración estimada', '≈ 10 min', 'Momento', 'aprox. 42–54 min después del despegue', 'Confianza', 'Alta',
      'Nula', '60 %', 'Ligera', '30 %', 'Moderada', '10 %', 'Fuerte', '0 %']) expect(h).toContain(t);
    for (const r of view.confidence.reasons) expect(h).toContain(r);
  });
  it('con más de dos tramos indica cuántos más hay (coherente con la duración total)', () => {
    const moments = [{ startMin: 111, endMin: 128 }, { startMin: 264, endMin: 281 }, { startMin: 300, endMin: 320 }, { startMin: 340, endMin: 371 }];
    const h = summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 85, moments } });
    expect(h).toContain('aprox. 111–128 y 264–281 min después del despegue, y 2 tramos más');
  });
  it('sin turbulencia no muestra duración ni momento', () => {
    const h = summaryHtml({ ...view, summary: { headline: 'Tranquilo', maxLevel: 0, maxDurationMin: 0, moments: [], percentages: [100, 0, 0, 0] } });
    expect(h).toContain('Sin turbulencia prevista');
    expect(h).not.toContain('Duración estimada');
  });
  it('confianza sin cálculo', () => {
    expect(summaryHtml({ ...view, confidence: { level: null, reasons: ['falta más de una semana: el pronóstico aún no es útil'] } })).toContain('Sin cálculo');
  });
});

describe('cobertura, frescura y precisión', () => {
  it('con cobertura incompleta avisa en el resumen', () => {
    expect(summaryHtml({ ...view, coverage: 0.8 })).toContain('Faltan datos en el 20 % de la ruta');
    expect(summaryHtml({ ...view, coverage: 1 })).not.toContain('Faltan datos');
  });
  it('la duración se redondea a 5 min', () => {
    expect(summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 23 } })).toContain('≈ 25 min');
    expect(summaryHtml({ ...view, summary: { ...view.summary, maxDurationMin: 2 } })).toContain('≈ 5 min');
  });
  it('tramos sin datos se distinguen en la barra', () => {
    const h = timelineHtml({ ...view, segments: [seg(0, 0, 90, { missing: true })] });
    expect(h).toContain('class="seg lvl0 missing"');
  });
  it('METAR: antigüedad visible; viejo o ausente, dicho claramente; SIGMET/PIREP no disponibles ≠ ninguno', () => {
    const av = {
      updated: new Date(NOW - 2 * 3600000).toISOString(),
      origin: { icao: 'LEPA', metarText: 'Viento de 230° a 8 kt', metarRaw: 'M', metarAge: 'hace 40 min', metarStale: false, tafText: null },
      destination: { icao: 'LEMD', metarText: null, metarStale: true, tafText: null },
      sigmets: null, pireps: null,
    };
    const h = aviationHtml(av, NOW);
    expect(h).toContain('Viento de 230° a 8 kt (hace 40 min)');
    expect(h).toContain('El último parte tiene más de 3 h: no se muestra');
    expect(h).toContain('Avisos oficiales no disponibles ahora');
    expect(h).toContain('Informes de pilotos no disponibles ahora');
    expect(h).toContain('descargado hace 2 h');
  });
});

describe('timeline', () => {
  it('cada tramo es un botón con su índice; detalle con causas, altitud y ubicación', () => {
    const h = timelineHtml(view);
    expect(h.match(/<button[^>]+data-seg="\d+"/g)).toHaveLength(3);
    const d = segmentDetailHtml(view.segments[1], 'PMI');
    for (const t of ['Min 42–54', 'Moderada', 'Causa probable', 'Cambio brusco del viento con la altura', 'Corriente de viento muy fuerte en altura', 'Altura del avión', '10,7 km (35.000 pies)', 'Ubicación aproximada', 'sobre el Golfo de León']) expect(d).toContain(t);
  });
  it('sin nombre de lugar usa km desde el origen; tramo nulo sin causas', () => {
    expect(segmentDetailHtml(seg(1, 0, 10), 'PMI')).toContain('a 180 km de PMI');
    expect(segmentDetailHtml(seg(0, 0, 10), 'PMI')).not.toContain('Causa probable');
  });
  it('rango de altitud y suelo', () => {
    expect(flText(300, 360)).toBe('entre 9,1 y 11 km');
    expect(flText(0, 0)).toBe('cerca del suelo');
    expect(flText(0, 90)).toBe('del suelo a unos 2,7 km');
  });
  it('tramo sin datos lo indica', () => {
    expect(segmentDetailHtml(seg(0, 0, 10, { missing: true }), 'PMI')).toContain('faltan datos');
  });
});

describe('condiciones por altitud', () => {
  it('filas FL300–FL400, destaca la más tranquila, marca el crucero y lleva el aviso', () => {
    const h = altitudeHtml(view.altitudes);
    for (const km of ['9,1 km', '9,8 km', '10,4 km', '11 km', '11,6 km', '12,2 km', '30.000 pies']) expect(h).toContain(km);
    expect(h).not.toMatch(/FL\d/);
    expect(h).toContain('Más tranquila');
    expect(h).toContain('altura prevista de tu vuelo');
    expect(h).toContain('La altitud real del vuelo depende del plan de vuelo, tráfico, control aéreo, peso y condiciones operativas.');
    expect(h).not.toMatch(/deber[ií]a volar/i);
  });
  it('vacía → nada', () => {
    expect(altitudeHtml([])).toBe('');
  });
});

describe('frescura', () => {
  it('distingue consulta realizada y ejecución del modelo', () => {
    const h = freshnessHtml(view, NOW, 'UTC');
    expect(h).toContain('Consulta realizada hace 18 min');
    expect(h).toContain('Previsión del tiempo calculada a las 00:00 (modelo europeo) y a las 06:00 (modelo estadounidense)');
    expect(h).toContain('Los dos modelos coinciden bastante');
  });
  it('sin hora de modelo no la inventa', () => {
    const h = freshnessHtml({ ...view, runs: {} }, NOW, 'UTC');
    expect(h).not.toContain('Previsión del tiempo calculada');
  });
});

describe('Aviation Weather', () => {
  it('METAR/TAF resumidos con el original desplegable; SIGMET; sin PIREP → mensaje prudente', () => {
    const av = {
      updated: '2026-09-24T10:00:00Z',
      origin: { iata: 'PMI', icao: 'LEPA', metarText: 'Viento de 230° a 8 kt', metarRaw: 'METAR LEPA …', tafText: ['Sin fenómenos significativos previstos'], tafRaw: 'TAF LEPA …' },
      destination: { iata: 'MAD', icao: 'LEMD', metarText: null, tafText: null },
      sigmets: [{ label: 'Turbulencia fuerte', levels: 'FL300–FL400', crosses: true, distanceKm: 0, raw: 'SIGMET …' }],
      pireps: [],
    };
    const h = aviationHtml(av, NOW);
    for (const t of ['LEPA', 'Viento de 230° a 8 kt', 'METAR LEPA …', 'TAF LEPA …', 'Turbulencia fuerte', 'FL300–FL400', 'cruza la ruta', 'No hay informes recientes disponibles en esta zona.', 'Sin parte meteorológico disponible']) expect(h).toContain(t);
    expect(h).not.toContain('no hay turbulencia');
  });
  it('sin datos → nada', () => {
    expect(aviationHtml(null)).toBe('');
  });
});

describe('pronóstico guardado', () => {
  it('franja clara, nunca como actualizado', () => {
    expect(offlineBanner(NOW - 2 * 3600000, NOW)).toContain('Pronóstico guardado · consultado hace 2 h');
  });
});

describe('renderForecast', () => {
  it('monta todas las secciones y el aviso orientativo; escapa HTML', () => {
    const el = { innerHTML: '' };
    renderForecast(el, { ...view, title: '<b>x</b>' }, NOW);
    for (const id of ['trend', 'timeline', 'seg-detail', 'altitudes', 'aviation', 'map', 'fresh']) expect(el.innerHTML).toContain(`id="${id}"`);
    expect(el.innerHTML).toContain('Estimación orientativa para pasajeros');
    expect(el.innerHTML).not.toContain('<b>x</b>');
    expect(el.innerHTML).not.toMatch(/no pone en peligro|no pasa nada/);
  });
});
