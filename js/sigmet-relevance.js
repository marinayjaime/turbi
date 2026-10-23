// Relevancia de cada aviso SIGMET para el vuelo: ¿coinciden a la vez el LUGAR, la ALTITUD y la HORA a la que el avión
// pasaría por la zona? Solo con lo que Turbi ya tiene (la trayectoria estimada de buildProfile y el aviso tal como lo
// publica Aviation Weather); sin peticiones. La trayectoria es una APROXIMACIÓN (círculo máximo, ritmos de ascenso y
// descenso típicos, crucero estimado), nunca la ruta operacional: por eso cada dimensión lleva su incertidumbre.
//
//   'affects' — posible afectación: hay un tramo con coincidencia de lugar (dentro del margen lateral), altitud (la
//               banda de altitudes posibles del avión toca los niveles del aviso) y hora (con su margen).
//   'near'    — cercano o incierto: cerca, pero sin coincidencia clara o con algún dato desconocido (altitud, validez,
//               movimiento sin velocidad), o vigente hasta poco antes del paso (podría renovarse).
//   'none'    — sin coincidencia: los datos permiten descartarlo (altitud u hora claramente distintas).
// Un dato que falta nunca descarta un aviso: lo deja como incierto.
import { distanceKm, intermediatePoint } from './route.js';
import { cruiseFL, flightLevelAt, phaseAt } from './altitude.js';
import { segmentToPolygon } from './aviation-weather.js';

// Márgenes (justificación y efecto medido sobre los vuelos de Aena: docs y tests/sigmet-relevance.test.js).
export const MARGINS = {
  lateralKm: 25, // desvío típico de la ruta real respecto al círculo máximo en Europa (aerovías, SID/STAR) y redondeo del polígono
  nearKm: 100, // «cerca»: el mismo radio que ya usaba Turbi para mostrar un aviso
  timeMin: 15, // error de la hora de despegue estimada (rodaje, retrasos)…
  timeShare: 0.1, // …más un 10 % del tiempo ya volado (error de la duración estimada)
  renewalH: 3, // un aviso que caduca antes del paso puede renovarse (validez habitual de 4 h): incierto hasta 3 h después
  cruiseFt: 4000, // crucero real ±2 niveles respecto al estimado por Turbi
  driftKmh: 25, // movimiento indicado sin velocidad: margen lateral que crece ≈ 25 km/h (≈ 13 nudos), hasta 75 km
  driftMaxKm: 75,
  // Ritmos posibles (FL/min, centenas de pies por minuto): Turbi usa 20 de ascenso y 15 de descenso; la banda cubre
  // reactores comerciales habituales (1500–3000 ft/min al subir, 1000–3000 al bajar).
  climb: [15, 30],
  descent: [10, 30],
};
const DIRS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const HAZARD_TEXT = { TURB: 'turbulencia', TS: 'tormentas', MTW: 'ondas de montaña', TC: 'ciclón tropical' };

// Movimiento y evolución que trae el texto del aviso: «MOV NNE 15KT», «STNR», «INTSF», «WKN», «NC».
export function sigmetMotion(raw = '') {
  const m = raw.match(/\bMOV\s+(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\b(?:\s+(\d+)\s*(KT|KMH))?/);
  const trend = /\bINTSF\b/.test(raw) ? 'intensifica' : /\bWKN\b/.test(raw) ? 'debilita' : /\bNC\b/.test(raw) ? 'sin cambios' : null;
  if (/\bSTNR\b/.test(raw)) return { kind: 'stationary', trend };
  if (!m) return { kind: 'unknown', trend };
  const kmh = m[2] ? Number(m[2]) * (m[3] === 'KT' ? 1.852 : 1) : null;
  return { kind: kmh === null ? 'moving-unknown-speed' : 'moving', bearing: DIRS[m[1]], kmh, trend };
}

// Hora a la que corresponde la ZONA descrita por el aviso: la primera «OBS AT hhmmZ» o «FCST AT hhmmZ» del texto (la
// posición observada o prevista de partida; una segunda «FCST AT» describe la posición final). El texto solo da hora y
// minutos: el día es el más cercano a la validez del aviso. Sin esa hora, null: no se inventa (ni validFrom ni otra).
export function sigmetGeometryTime(s) {
  const m = (s?.raw ?? '').match(/\b(?:OBS|FCST) AT (\d{2})(\d{2})Z\b/);
  const ref = Number.isFinite(s?.validFrom) ? s.validFrom : Number.isFinite(s?.validTo) ? s.validTo : null;
  if (!m || ref === null || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(ref);
  const same = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]));
  return [same - 86400000, same, same + 86400000].reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
}

// Niveles escritos en el texto del aviso (formatos OACI): «SFC/FL060», «FL320/400», «FL250/FL350», «SFC/5000FT»,
// «3000/9000FT» (capa con sus dos límites), «TOP FL400», «TOP ABV FL400», «ABV FL300», «BLW FL100». En pies. kind dice
// qué límite da el aviso; el que no da queda DESCONOCIDO (null), nunca superficie ni infinito. null si no se reconoce.
const FT = (n, unit) => (unit === 'FL' ? Number(n) * 100 : unit === 'M' ? Math.round(Number(n) * 3.2808) : Number(n));
export function sigmetLevelsFromText(raw = '') {
  const text = raw.replace(/\s+/g, ' ');
  let m = text.match(/\b(SFC|FL\d{3}|\d{3,5}(?:FT|M))\/(FL)?(\d{3,5})(FT|M)?\b/);
  if (m) {
    const base = m[1] === 'SFC' ? 0 : m[1].startsWith('FL') ? FT(m[1].slice(2), 'FL') : FT(m[1].replace(/FT|M/, ''), m[1].endsWith('M') ? 'M' : 'FT');
    const unit = m[2] ? 'FL' : m[4] ? m[4] : /^\d{3}$/.test(m[3]) ? 'FL' : 'FT';
    return { kind: 'layer', base, top: FT(m[3], unit) };
  }
  if ((m = text.match(/\bTOP ABV FL(\d{3})\b/))) return { kind: 'top-above', base: null, top: FT(m[1], 'FL') };
  if ((m = text.match(/\bTOP (?:BLW )?FL(\d{3})\b/))) return { kind: 'top', base: null, top: FT(m[1], 'FL') };
  if ((m = text.match(/\bABV FL(\d{3})\b/))) return { kind: 'above', base: FT(m[1], 'FL'), top: null };
  if ((m = text.match(/\bBLW FL(\d{3})\b/))) return { kind: 'below', base: null, top: FT(m[1], 'FL') };
  return null;
}

// Alcance vertical del aviso, separando lo que AFIRMA de lo que PODRÍA abarcar porque un límite es desconocido:
//   sure     — [lo, hi] pies que el aviso cubre según sus límites conocidos (o null si no afirma ninguno);
//   possible — [lo, hi] hasta donde podría llegar (límite desconocido → superficie o sin techo).
// Solo cuenta como afirmado un rango con sus DOS límites dados por el aviso; un límite ausente es desconocido para
// cualquier fenómeno (también tormentas y ciclones con solo «TOP FLxxx»). Sin ningún nivel: nada afirmado.
export function sigmetVertical(s) {
  const p = sigmetLevelsFromText(s?.raw) ?? (s?.base != null && s?.top != null ? { kind: 'layer', base: s.base, top: s.top }
    : s?.top != null ? { kind: 'top', base: null, top: s.top } : s?.base != null ? { kind: 'above', base: s.base, top: null } : null);
  if (!p) return { sure: null, possible: [0, Infinity], kind: 'unknown' };
  if (p.kind === 'layer') return { sure: [p.base, p.top], possible: [p.base, p.top], kind: 'layer' };
  if (p.kind === 'top') return { sure: null, possible: [0, p.top], kind: 'top' };
  if (p.kind === 'top-above') return { sure: null, possible: [0, Infinity], kind: 'top-above' };
  if (p.kind === 'above') return { sure: null, possible: [p.base, Infinity], kind: 'above' };
  return { sure: null, possible: [0, p.top], kind: 'below' };
}

// La trayectoria estimada del pronóstico (la misma de buildProfile): posición proporcional al tiempo sobre el círculo
// máximo, nivel de vuelo nominal y la banda de niveles posibles en cada minuto.
export function flightPath(view, { margins = MARGINS } = {}) {
  const route = view?.route ?? [];
  const D = view?.durationMin;
  if (route.length < 2 || !(D > 0) || !Number.isFinite(view.depMs)) return null;
  const o = route[0], d = route.at(-1);
  const km = distanceKm(o, d);
  const cruise = cruiseFL(km);
  const band = min => ({
    lo: Math.max(0, Math.min(cruise - margins.cruiseFt / 100, min * margins.climb[0], (D - min) * margins.descent[0])),
    hi: Math.max(0, Math.min(cruise + margins.cruiseFt / 100, min * margins.climb[1], (D - min) * margins.descent[1])),
  });
  return { o, d, km, D, cruise, depMs: view.depMs, band, fl: min => flightLevelAt(min, D, cruise), phase: min => phaseAt(min, D, cruise),
    at: f => (f <= 0 ? { lat: o.lat, lon: o.lon } : f >= 1 ? { lat: d.lat, lon: d.lon } : intermediatePoint(o, d, f)) };
}

function shift(coords, km, bearing, lat) {
  const r = (bearing * Math.PI) / 180;
  const dLat = (km * Math.cos(r)) / 110.574, dLon = (km * Math.sin(r)) / (111.32 * Math.cos((lat * Math.PI) / 180));
  return coords.map(c => ({ lat: c.lat + dLat, lon: c.lon + dLon }));
}

// s: un aviso de sigmetsNearRoute (con coords, hazard, qualifier, base, top, validFrom, validTo en ms y raw).
export function sigmetRelevance(s, path, { margins = MARGINS } = {}) {
  if (!path || !(s?.coords?.length >= 3)) return { tier: 'near', reasons: ['sin-zona'] };
  const motion = sigmetMotion(s.raw);
  // Niveles: sin base pero con techo → desde la superficie (convenio OACI, p. ej. «TOP FL400»); con base y sin techo →
  // por encima de la base («ABV FL300»); sin ninguno → altitud desconocida.
  const vert = sigmetVertical(s);
  const overlaps = (r, lo, hi) => Boolean(r) && hi >= r[0] && lo <= r[1];
  const timeKnown = Number.isFinite(s.validFrom) && Number.isFinite(s.validTo);
  // Movimiento: el polígono se proyecta desde la hora de SU geometría (OBS/FCST AT). Si el aviso se mueve y no hay esa
  // hora, su posición al paso es desconocida: no se desplaza y ese aviso no puede pasar de incierto.
  const anchor = sigmetGeometryTime(s);
  const moving = motion.kind === 'moving' || motion.kind === 'moving-unknown-speed';
  const positionKnown = !moving || anchor !== null;
  // Tramos cortos (≤ 5 km y ≤ 1/120 del vuelo): cruces exactos tramo-polígono e interpolación de hora y altitud dentro.
  const N = Math.max(120, Math.ceil(path.km / 5));
  let best = { rank: 0 };
  const hits = [];
  for (let k = 0; k < N; k++) {
    const f0 = k / N, f1 = (k + 1) / N;
    const m0 = f0 * path.D, m1 = f1 * path.D, mid = (m0 + m1) / 2;
    const t0 = path.depMs + m0 * 60000, t1 = path.depMs + m1 * 60000, tm = path.depMs + mid * 60000;
    // Lugar: el polígono desplazado hasta la hora de paso si el aviso dice hacia dónde y a qué velocidad se mueve.
    let coords = s.coords, drift = 0;
    if (motion.kind === 'moving' && anchor !== null) coords = shift(s.coords, (motion.kmh * (tm - anchor)) / 3600000, motion.bearing, s.coords[0].lat);
    else if (motion.kind === 'moving-unknown-speed' && anchor !== null) drift = Math.min(margins.driftMaxKm, (Math.abs(tm - anchor) / 3600000) * margins.driftKmh);
    else if (moving) drift = margins.driftMaxKm; // se mueve y no se sabe desde cuándo: todo el margen, solo para «cerca»
    const dist = segmentToPolygon(path.at(f0), path.at(f1), coords);
    // «Dentro» (posible afectación) solo con la geometría del aviso: el margen por movimiento incierto solo acerca a «cerca».
    const lateral = dist <= margins.lateralKm ? 'in' : dist <= margins.nearKm + drift ? 'near' : 'out';
    if (lateral === 'out') continue;
    // Altitud: la banda de niveles posibles del avión en el tramo (pies) frente a los niveles del aviso.
    const b0 = path.band(m0), b1 = path.band(m1);
    const lo = Math.min(b0.lo, b1.lo) * 100, hi = Math.max(b0.hi, b1.hi) * 100;
    // match: la banda toca lo que el aviso AFIRMA; unknown: solo lo que podría abarcar (un límite desconocido); no: nada.
    const vertical = overlaps(vert.sure, lo, hi) ? 'match' : overlaps(vert.possible, lo, hi) ? 'unknown' : 'no';
    // Hora: el paso por el tramo, con su margen, frente a la validez.
    const T = (margins.timeMin + margins.timeShare * mid) * 60000;
    let time = 'unknown';
    if (timeKnown) {
      if (t0 - T <= s.validTo && t1 + T >= s.validFrom) time = 'match';
      else if (t1 + T < s.validFrom) time = 'no'; // el aviso empieza después del paso
      else time = t0 - T - s.validTo <= margins.renewalH * 3600000 && motion.trend !== 'debilita' ? 'after-expiry' : 'no';
    }
    let rank = 0;
    const why = [];
    if (lateral === 'in' && vertical === 'match' && time === 'match' && positionKnown) rank = 2;
    else if (vertical !== 'no' && time !== 'no') {
      rank = 1;
      if (lateral === 'near') why.push('lejos');
      if (vertical === 'unknown') why.push(vert.kind === 'unknown' ? 'altitud-desconocida' : 'altitud-incompleta');
      if (time === 'unknown') why.push('hora-desconocida');
      if (time === 'after-expiry') why.push('caduca-antes');
      if (moving && anchor === null) why.push('movimiento-sin-hora');
      else if (drift) why.push('movimiento-sin-velocidad');
    }
    // nominal: el nivel previsto por Turbi (sin margen) ya está dentro de los niveles del aviso; solo entonces se puede
    // nombrar la fase con confianza (si la coincidencia depende del margen, no se afirma ni la fase ni la altitud).
    if (rank === 2) hits.push({ mid, phase: path.phase(mid), t0, t1, nominal: overlaps(vert.sure, path.fl(mid) * 100, path.fl(mid) * 100) });
    // El tramo más relevante (y, a igualdad, el más cercano) da la distancia, la hora y los motivos.
    if (rank > best.rank || (rank === best.rank && rank > 0 && dist < best.dist)) best = { rank, dist, mid, t0, t1, why };
  }
  const tier = best.rank === 2 ? 'affects' : best.rank === 1 ? 'near' : 'none';
  const out = { tier, reasons: tier === 'near' ? best.why : [], motion: motion.kind, trend: motion.trend };
  if (best.rank) Object.assign(out, { distanceKm: Math.round(best.dist), passage: { from: best.t0, to: best.t1 } });
  if (tier === 'affects') {
    out.passage = { from: hits[0].t0, to: hits.at(-1).t1 };
    out.where = whereText(hits, path);
  }
  return out;
}

// Avisos SIN zona delimitada (sin polígono): no se pueden situar respecto a la ruta, pero tampoco se descartan si son de
// la misma región OACI (dos primeras letras del FIR) que el origen o el destino y están vigentes durante el vuelo:
// quedan como inciertos. Los de otras regiones no tienen relación con el vuelo que se pueda establecer.
const KNOWN = ['TURB', 'TS', 'MTW', 'TC'];
export function sigmetsWithoutArea(items, { originIcao, destinationIcao, depMs, arrMs }) {
  if (!Array.isArray(items)) return [];
  const regions = new Set([originIcao, destinationIcao].filter(Boolean).map(c => c.slice(0, 2)));
  return items
    .filter(s => KNOWN.includes(s.hazard) && !(s.coords?.length >= 3))
    .filter(s => regions.has(String(s.fir ?? '').slice(0, 2)))
    .filter(s => !Number.isFinite(s.validFrom) || !Number.isFinite(s.validTo) || (s.validFrom * 1000 <= arrMs && s.validTo * 1000 >= depMs))
    .map(s => ({ hazard: s.hazard, qualifier: s.qualifier ?? null, base: s.base ?? null, top: s.top ?? null, raw: s.raw,
      fir: s.fir ?? null, validFrom: Number.isFinite(s.validFrom) ? s.validFrom * 1000 : null,
      validTo: Number.isFinite(s.validTo) ? s.validTo * 1000 : null, relevance: { tier: 'near', reasons: ['sin-zona'] } }));
}

// Dónde, solo si los tramos que coinciden lo dicen sin ambigüedad: todo en el ascenso cerca del origen, todo en el
// descenso cerca del destino, todo en crucero, mirando solo los tramos en los que el nivel previsto (sin margen) ya está
// dentro de los niveles del aviso. Sin ninguno así, o con fases mezcladas, null (no se afirma una fase que no se conoce).
function whereText(all, path) {
  const hits = all.filter(h => h.nominal);
  if (!hits.length) return null;
  const phases = new Set(hits.map(h => h.phase));
  const first = hits[0].mid / path.D, last = hits.at(-1).mid / path.D;
  if (phases.size === 1 && phases.has('descent') && first >= 0.5) return 'descent';
  if (phases.size === 1 && phases.has('climb') && last <= 0.5) return 'climb';
  if (phases.size === 1 && phases.has('cruise')) return 'cruise';
  return null;
}

// Texto del aviso según su clasificación. cities: { from, to } (ciudades de la ficha).
const hhmm = ms => new Date(ms).toISOString().slice(11, 16);
export function sigmetMessage(s, rel, cities = {}) {
  const what = `${HAZARD_TEXT[s.hazard] ?? 'fenómeno'}${s.qualifier === 'SEV' && s.hazard !== 'TC' ? ' fuerte' : ''}`;
  if (rel.tier === 'affects') {
    const where = rel.where === 'descent' && cities.to ? ` durante el descenso a ${cities.to}`
      : rel.where === 'climb' && cities.from ? ` durante el ascenso desde ${cities.from}`
      : rel.where === 'cruise' ? ' durante el crucero' : ' en la trayectoria prevista';
    return `Posible aviso SIGMET de ${what}${where}`;
  }
  const why = [];
  if (rel.reasons?.includes('caduca-antes') && Number.isFinite(s.validTo)) why.push(`vigente hasta las ${hhmm(s.validTo)} UTC, antes de la hora prevista de paso; podría renovarse`);
  if (rel.reasons?.includes('lejos') && Number.isFinite(rel.distanceKm)) why.push(`a unos ${rel.distanceKm} km de la trayectoria estimada`);
  if (rel.reasons?.includes('altitud-desconocida')) why.push('el aviso no indica su altitud');
  if (rel.reasons?.includes('altitud-incompleta')) why.push('el aviso no indica todos sus límites de altitud');
  if (rel.reasons?.includes('hora-desconocida')) why.push('el aviso no indica su validez');
  if (rel.reasons?.includes('movimiento-sin-velocidad')) why.push('se desplaza sin velocidad indicada');
  if (rel.reasons?.includes('movimiento-sin-hora')) why.push('se desplaza y no indica a qué hora corresponde su zona');
  if (rel.reasons?.includes('sin-zona')) why.push('sin zona delimitada');
  return `Aviso SIGMET de ${what} cerca de la ruta${why.length ? `: ${why.join('; ')}` : ''}`;
}
