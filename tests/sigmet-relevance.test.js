// Relevancia de los SIGMET para el vuelo (js/sigmet-relevance.js): lugar + altitud + hora de paso, sobre la misma
// trayectoria estimada que el pronóstico (buildProfile), y su paso por aviationView (js/forecast.js).
import { describe, it, expect } from 'vitest';
import { buildProfile } from '../js/altitude.js';
import { sigmetsNearRoute } from '../js/aviation-weather.js';
import { flightPath, sigmetRelevance, sigmetMessage, sigmetMotion, sigmetsWithoutArea, sigmetLevelsFromText, sigmetVertical, sigmetGeometryTime, MARGINS } from '../js/sigmet-relevance.js';
import { aviationView } from '../js/forecast.js';

const TFN = { lat: 28.4827, lon: -16.3415 }, BIO = { lat: 43.3011, lon: -2.9106 };
const MAD = { lat: 40.4719, lon: -3.5626 }, LHR = { lat: 51.4706, lon: -0.4619 };
const iso = s => Date.parse(s);
// La vista del pronóstico tal como la construye la app: ruta de buildProfile, despegue y minutos en el aire.
function view(o, d, takeoff, min) {
  const p = buildProfile(o, d, takeoff, min);
  return { route: p.points.map(x => ({ lat: x.lat, lon: x.lon })), depMs: p.departureMs, arrMs: p.arrivalMs, durationMin: p.durationMin, _p: p };
}
const box = (lat, lon, dLat, dLon) => [{ lat: lat - dLat, lon: lon - dLon }, { lat: lat - dLat, lon: lon + dLon }, { lat: lat + dLat, lon: lon + dLon }, { lat: lat + dLat, lon: lon - dLon }, { lat: lat - dLat, lon: lon - dLon }];
// Un aviso como lo da sigmetsNearRoute (ms, niveles en pies).
const sig = over => ({ hazard: 'TURB', qualifier: 'SEV', base: 30000, top: 40000, raw: 'SEV TURB FCST STNR NC', validFrom: iso('2026-10-23T06:00:00Z'), validTo: iso('2026-10-23T12:00:00Z'), ...over });
const rel = (s, v, o) => sigmetRelevance(s, flightPath(v), o);

// VY3261 TFN → BIO del 23/10/2026: despegue ≈ 07:17Z, 162 min en el aire. Aviso real LECM SIGMET 2.
const VY3261 = view(TFN, BIO, iso('2026-10-23T07:17:00Z'), 162);
const LECM = { hazard: 'TURB', qualifier: 'SEV', base: 0, top: 5000, validTo: 1792746000, validFrom: 1792738800, fir: 'LECM MADRID',
  coords: [{ lon: -1.883, lat: 43.615 }, { lon: -3.7, lat: 44.229 }, { lon: -3.7, lat: 43.483 }, { lon: -1.883, lat: 43.367 }, { lon: -1.883, lat: 43.615 }],
  raw: 'WSSP31 LEMM 230636 LECM SIGMET 2 VALID 230700/230900 LEVA- LECM MADRID FIR SEV TURB FCST N OF LINE N4329 W00342 - N4322 W00153 SFC/FL050 MOV NNE NC=' };

describe('relevancia de los SIGMET para el vuelo', () => {
  it('regresión VY3261 TFN–BIO: el aviso real (SFC–FL050, caduca a las 09:00Z; paso ≈ 09:55Z) es cercano e incierto; el mismo renovado, posible afectación en el descenso', () => {
    const [near] = sigmetsNearRoute([LECM], VY3261.route, VY3261.depMs, VY3261.arrMs); // lo que ya se mostraba
    expect(near.distanceKm).toBe(14);
    const r = rel(near, VY3261);
    expect(r.tier).toBe('near');
    expect(r.reasons).toContain('caduca-antes');
    expect(sigmetMessage(near, r, { from: 'Tenerife', to: 'Bilbao' })).toBe('Aviso SIGMET de turbulencia fuerte cerca de la ruta: vigente hasta las 09:00 UTC, antes de la hora prevista de paso; podría renovarse; se desplaza y no indica a qué hora corresponde su zona');
    // Renovado: un aviso nuevo con su propia hora de zona («FCST AT 0900Z»), que sigue moviéndose sin velocidad indicada.
    const renewed = { ...near, validFrom: iso('2026-10-23T09:00:00Z'), validTo: iso('2026-10-23T11:00:00Z'), raw: near.raw.replace('SEV TURB FCST', 'SEV TURB FCST AT 0900Z') };
    const r2 = rel(renewed, VY3261);
    expect(r2.tier).toBe('affects');
    expect(r2.where).toBe('descent');
    expect(sigmetMessage(renewed, r2, { from: 'Tenerife', to: 'Bilbao' })).toBe('Posible aviso SIGMET de turbulencia fuerte durante el descenso a Bilbao');
    expect(new Date(r2.passage.from).toISOString().slice(11, 16)).toBe('09:57'); // dentro de la zona (sin el margen por movimiento) y por debajo de FL050
  });

  it('coincidencia en las tres dimensiones (crucero, FL300–400, vigente al paso) → posible afectación «durante el crucero»', () => {
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const mid = v._p.points[Math.floor(v._p.points.length / 2)];
    const r = rel(sig({ coords: box(mid.lat, mid.lon, 0.3, 0.4) }), v);
    expect(r.tier).toBe('affects');
    expect(r.where).toBe('cruise');
    expect(sigmetMessage(sig({}), r, { to: 'Londres' })).toBe('Posible aviso SIGMET de turbulencia fuerte durante el crucero');
  });

  it('lugar sí, altitud no (SFC–FL100 en mitad del crucero) → sin coincidencia; lugar sí, hora no → sin coincidencia', () => {
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const mid = v._p.points[Math.floor(v._p.points.length / 2)];
    const coords = box(mid.lat, mid.lon, 0.3, 0.4);
    expect(rel(sig({ coords, base: 0, top: 10000 }), v).tier).toBe('none');
    // Empieza después del paso (≈ 09:00Z) y caduca más de 3 h antes del paso.
    expect(rel(sig({ coords, validFrom: iso('2026-10-23T10:30:00Z'), validTo: iso('2026-10-23T14:00:00Z') }), v).tier).toBe('none');
    expect(rel(sig({ coords, validFrom: iso('2026-10-23T01:00:00Z'), validTo: iso('2026-10-23T05:00:00Z') }), v).tier).toBe('none');
    // Caducado poco antes del paso, pero «WKN» (se debilita): no se espera su renovación.
    expect(rel(sig({ coords, validFrom: iso('2026-10-23T06:00:00Z'), validTo: iso('2026-10-23T08:20:00Z'), raw: 'SEV TURB FCST STNR WKN' }), v).tier).toBe('none');
  });

  it('cercano sin intersección (≈ 60 km) → incierto, con la distancia; lejos (> 100 km) → ni siquiera se muestra', () => {
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const mid = v._p.points[Math.floor(v._p.points.length / 2)];
    const off = sig({ coords: box(mid.lat, mid.lon + 1.1, 0.2, 0.2) }); // ≈ 60 km al este de la ruta
    const r = rel(off, v);
    expect(r.tier).toBe('near');
    expect(r.reasons).toEqual(['lejos']);
    expect(sigmetMessage(off, r)).toMatch(/^Aviso SIGMET de turbulencia fuerte cerca de la ruta: a unos \d+ km de la trayectoria estimada$/);
    expect(sigmetsNearRoute([{ ...off, validFrom: off.validFrom / 1000, validTo: off.validTo / 1000, coords: box(mid.lat, mid.lon + 2.5, 0.2, 0.2) }], v.route, v.depMs, v.arrMs)).toEqual([]);
  });

  it('información incompleta → incierto, nunca descartado: sin altitud, sin validez, sin zona (de la región del vuelo) y moviéndose sin velocidad', () => {
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const mid = v._p.points[Math.floor(v._p.points.length / 2)];
    const coords = box(mid.lat, mid.lon, 0.3, 0.4);
    const noAlt = rel(sig({ coords, base: null, top: null }), v);
    expect(noAlt).toMatchObject({ tier: 'near', reasons: ['altitud-desconocida'] });
    expect(rel(sig({ coords, validFrom: null, validTo: null }), v)).toMatchObject({ tier: 'near', reasons: ['hora-desconocida'] });
    expect(rel(sig({ coords: [] }), v)).toMatchObject({ tier: 'near', reasons: ['sin-zona'] });
    // Sin base/top en los campos pero sí en el texto del aviso (pasa en algunos FIR): se usan los del texto.
    expect(sigmetLevelsFromText('WSDL31 EDZE 230930 EDUU SIGMET 3 VALID 231000/231200 EDZF- EDUU RHEIN UIR SEV TURB FCST AT 1100Z WI N5028 E01309 - N4911 E01248 FL320/400 WKN=')).toEqual({ kind: 'layer', base: 32000, top: 40000 });
    expect(sigmetLevelsFromText('EDGG LANGEN FIR SEV TURB FCST WI N4907 E00612 - N5010 E00811 SFC/FL060 INTSF=')).toEqual({ kind: 'layer', base: 0, top: 6000 });
    // Un límite que el aviso no da queda desconocido (null), nunca superficie ni infinito.
    expect(sigmetLevelsFromText('EMBD TS FCST TOP FL400 MOV E 10KT NC')).toEqual({ kind: 'top', base: null, top: 40000 });
    expect(sigmetLevelsFromText('SEV TURB FCST ABV FL300 STNR')).toEqual({ kind: 'above', base: 30000, top: null });
    expect(sigmetLevelsFromText('SEV MTW FCST SFC/5000FT STNR')).toEqual({ kind: 'layer', base: 0, top: 5000 });
    // Lo que el aviso AFIRMA (sure) frente a lo que podría abarcar (possible): solo un rango con sus dos límites; también
    // para tormentas, cuyo «TOP» no dice la base.
    expect(sigmetVertical({ hazard: 'TS', raw: 'EMBD TS FCST TOP FL400' })).toMatchObject({ sure: null, possible: [0, 40000] });
    expect(sigmetVertical({ hazard: 'TS', raw: 'EMBD TS FCST SFC/FL400' })).toMatchObject({ sure: [0, 40000] });
    expect(sigmetVertical({ hazard: 'TURB', raw: 'SEV TURB FCST TOP FL400' })).toMatchObject({ sure: null, possible: [0, 40000] });
    expect(sigmetVertical({ hazard: 'TURB', raw: 'SEV TURB FCST ABV FL300' })).toMatchObject({ sure: null, possible: [30000, Infinity] });
    expect(sigmetVertical({ hazard: 'TURB', raw: 'SEV TURB FCST', base: null, top: null })).toMatchObject({ sure: null, possible: [0, Infinity] });
    expect(sigmetLevelsFromText('VALID 230700/230900 LEVA- LECM MADRID FIR EMBD TS OBS MOV E')).toBeNull(); // la validez no son niveles
    expect(rel(sig({ coords, base: null, top: null, raw: 'SEV TURB FCST FL300/400 STNR NC' }), v).tier).toBe('affects');
    // Coincidencia que depende del margen (un aviso alto cerca del destino: solo si el avión descendiera tarde): posible
    // afectación, pero sin afirmar la fase.
    const nearDest = box(VY3261._p.points.at(-3).lat, VY3261._p.points.at(-3).lon, 0.25, 0.25);
    const high = rel(sig({ coords: nearDest, base: 30000, top: 40000, validFrom: iso('2026-10-23T09:00:00Z'), validTo: iso('2026-10-23T11:00:00Z') }), VY3261);
    expect(high.tier).toBe('affects');
    expect(high.where).toBeNull();
    expect(sigmetMessage(sig({}), high, { to: 'Bilbao' })).toBe('Posible aviso SIGMET de turbulencia fuerte en la trayectoria prevista');
    expect(rel(sig({ coords, base: null, top: null, raw: 'SEV TURB FCST SFC/FL060 STNR NC' }), v).tier).toBe('none'); // crucero, muy por encima
    // Un límite desconocido no descarta, pero tampoco se convierte en certeza: incierto, «altitud incompleta». Por encima
    // del techo conocido o por debajo de la base conocida, sí se descarta. Tormentas con solo «TOP»: igual (incierto).
    expect(rel(sig({ coords, base: 30000, top: null }), v)).toMatchObject({ tier: 'near', reasons: ['altitud-incompleta'] });
    expect(rel(sig({ coords, base: null, top: 40000 }), v)).toMatchObject({ tier: 'near', reasons: ['altitud-incompleta'] });
    expect(rel(sig({ coords, base: 42000, top: null }), v).tier).toBe('none'); // todo por encima del avión
    expect(rel(sig({ coords, hazard: 'TS', qualifier: 'EMBD', base: null, top: 40000, raw: 'EMBD TS FCST TOP FL400 STNR' }), v)).toMatchObject({ tier: 'near', reasons: ['altitud-incompleta'] });
    // Sin polígono: incierto si es de la región OACI del origen o del destino; de otra región, no se relaciona.
    const items = [{ hazard: 'TS', qualifier: 'EMBD', fir: 'LECM MADRID', coords: [], raw: 'LECM TS', validFrom: 1792738800, validTo: 1792760400 },
      { hazard: 'TURB', qualifier: 'SEV', fir: 'UHMM MAGADAN', coords: [], raw: 'UHMM TURB', validFrom: 1792738800, validTo: 1792760400 }];
    const noArea = sigmetsWithoutArea(items, { originIcao: 'LEMD', destinationIcao: 'EGLL', depMs: v.depMs, arrMs: v.arrMs });
    expect(noArea.map(s => s.raw)).toEqual(['LECM TS']);
    expect(sigmetMessage(noArea[0], noArea[0].relevance)).toBe('Aviso SIGMET de tormentas cerca de la ruta: sin zona delimitada');
    // Movimiento sin velocidad: el margen lateral crece con el tiempo hasta el paso (aquí ≈ 3 h → +75 km).
    const offFar = box(mid.lat, mid.lon + 1.8, 0.2, 0.2); // ≈ 120 km: fuera de «cerca»…
    const moving = sig({ coords: offFar, raw: 'SEV TURB FCST AT 0600Z MOV E NC', validFrom: iso('2026-10-23T06:00:00Z') });
    expect(rel({ ...moving, raw: 'SEV TURB FCST STNR NC' }, v).tier).toBe('none');
    expect(rel(moving, v)).toMatchObject({ tier: 'near', reasons: ['lejos', 'movimiento-sin-velocidad'] }); // …pero se mueve
    // El margen por movimiento incierto acerca a «cerca», nunca da «posible afectación» por sí solo.
    const close = sig({ coords: box(mid.lat, mid.lon + 1.1, 0.2, 0.2), raw: 'SEV TURB FCST AT 0600Z MOV W NC' }); // ≈ 60 km
    expect(rel(close, v).tier).toBe('near');
  });

  it('movimiento con velocidad: el polígono se desplaza hasta la hora de paso (entra en la ruta o sale de ella)', () => {
    expect(sigmetMotion('SEV TURB FCST MOV NNE 15KT NC')).toMatchObject({ kind: 'moving', bearing: 22.5, trend: 'sin cambios' });
    expect(sigmetMotion('TS OBS STNR INTSF')).toMatchObject({ kind: 'stationary', trend: 'intensifica' });
    expect(sigmetMotion('SEV TURB FCST')).toMatchObject({ kind: 'unknown' });
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const mid = v._p.points[Math.floor(v._p.points.length / 2)]; // paso ≈ 09:00Z, 3 h después de su emisión (06:00Z)
    const west = box(mid.lat, mid.lon - 2.2, 0.3, 0.3); // ≈ 180 km al oeste a las 06:00Z
    expect(rel(sig({ coords: west, raw: 'SEV TURB FCST AT 0600Z STNR NC' }), v).tier).toBe('none');
    expect(rel(sig({ coords: west, raw: 'SEV TURB FCST AT 0600Z MOV E 30KT NC' }), v).tier).toBe('affects'); // 3 h × 55 km/h ≈ 165 km al este
    // La hora de partida es la de la ZONA (OBS/FCST AT), no validFrom: la misma zona a las 08:30Z apenas se ha movido al paso.
    expect(rel(sig({ coords: west, raw: 'SEV TURB FCST AT 0830Z MOV E 30KT NC' }), v).tier).toBe('none');
    const onRoute = box(mid.lat, mid.lon, 0.3, 0.3);
    expect(rel(sig({ coords: onRoute, raw: 'SEV TURB OBS AT 0600Z MOV W 40KT NC' }), v).tier).not.toBe('affects'); // ya se ha ido
    // Se mueve y no dice a qué hora corresponde su zona: no se desplaza desde una hora inventada; queda incierto.
    expect(rel(sig({ coords: onRoute, raw: 'SEV TURB FCST MOV W 40KT NC' }), v)).toMatchObject({ tier: 'near', reasons: ['movimiento-sin-hora'] });
    expect(rel(sig({ coords: west, raw: 'SEV TURB FCST MOV E 30KT NC' }), v).tier).not.toBe('affects');
    // Hora de la zona: «OBS AT 0601Z» el mismo día; «FCST AT 2350Z» con validez desde las 00:00Z → el día anterior.
    expect(sigmetGeometryTime({ raw: 'TS OBS AT 0601Z E OF LINE', validFrom: iso('2026-10-23T06:00:00Z') })).toBe(iso('2026-10-23T06:01:00Z'));
    expect(sigmetGeometryTime({ raw: 'SEV TURB FCST AT 2350Z WI', validFrom: iso('2026-10-24T00:00:00Z') })).toBe(iso('2026-10-23T23:50:00Z'));
    expect(sigmetGeometryTime({ raw: 'SEV TURB FCST WI N4000', validFrom: iso('2026-10-24T00:00:00Z') })).toBeNull();
  });

  it('cruce entre dos puntos de muestreo de la ruta: un polígono estrecho que cae entre dos puntos de view.route se detecta', () => {
    const v = view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120);
    const [a, b] = [v._p.points[12], v._p.points[13]];
    const m = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
    const thin = box(m.lat, m.lon, 0.03, 0.6); // ≈ 7 km de ancho, a medio camino entre los dos puntos (≈ 60 km entre ellos)
    for (const p of [a, b]) expect(Math.abs(p.lat - m.lat)).toBeGreaterThan(0.1); // ningún punto de muestreo cae dentro
    expect(rel(sig({ coords: thin }), v, { margins: { ...MARGINS, lateralKm: 0 } }).tier).toBe('affects');
  });

  it('cambio de fecha en UTC: un vuelo que despega a las 23:20Z y un aviso del día siguiente (00:00–04:00Z) coinciden; uno que caducó a las 19:00Z, no', () => {
    const v = view(MAD, LHR, iso('2026-10-23T23:20:00Z'), 120);
    const late = v._p.points[Math.floor(v._p.points.length * 0.6)]; // pasado de medianoche
    expect(late.time).toBeGreaterThan(iso('2026-10-24T00:00:00Z'));
    const coords = box(late.lat, late.lon, 0.3, 0.4);
    expect(rel(sig({ coords, validFrom: iso('2026-10-24T00:00:00Z'), validTo: iso('2026-10-24T04:00:00Z') }), v).tier).toBe('affects');
    expect(rel(sig({ coords, validFrom: iso('2026-10-23T15:00:00Z'), validTo: iso('2026-10-23T19:00:00Z') }), v).tier).toBe('none');
    expect(rel(sig({ coords, validFrom: iso('2026-10-23T20:00:00Z'), validTo: iso('2026-10-23T23:30:00Z') }), v)).toMatchObject({ tier: 'near', reasons: ['caduca-antes'] });
  });

  it('programado o en curso: la clasificación depende de la trayectoria prevista, no de la hora de la consulta; aviationView lo une todo', () => {
    const v = { ...view(MAD, LHR, iso('2026-10-23T08:00:00Z'), 120), originIata: 'MAD', destinationIata: 'LHR', fromCity: 'Madrid', toCity: 'Londres' };
    const mid = v._p.points[Math.floor(v._p.points.length / 2)];
    const raw = { hazard: 'TURB', qualifier: 'SEV', base: 30000, top: 40000, raw: 'SEV TURB FCST STNR NC', fir: 'LFFF FRANCE',
      validFrom: iso('2026-10-23T06:00:00Z') / 1000, validTo: iso('2026-10-23T12:00:00Z') / 1000, coords: box(mid.lat, mid.lon, 0.3, 0.4) };
    const av = { sigmet: { updated: 'x', items: [raw] }, icao: { MAD: 'LEMD', LHR: 'EGLL' } };
    const scheduled = aviationView(av, v, iso('2026-10-22T20:00:00Z')); // la víspera
    const inFlight = aviationView(av, v, iso('2026-10-23T08:40:00Z')); // en el aire
    for (const a of [scheduled, inFlight]) {
      expect(a.sigmets).toHaveLength(1);
      expect(a.sigmets[0]).toMatchObject({ relevance: { tier: 'affects', where: 'cruise' }, message: 'Posible aviso SIGMET de turbulencia fuerte durante el crucero', label: 'Turbulencia fuerte' });
      expect(a.sigmetsNoArea).toEqual([]);
    }
    expect(aviationView({ metar: {}, icao: {} }, v, 0).sigmets).toBeNull(); // sin archivo de SIGMET: no disponible, no «ninguno»
  });
});
