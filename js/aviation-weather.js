// METAR, TAF, SIGMET y PIREP de Aviation Weather (NOAA), descargados cada hora por GitHub Actions
// (la API no admite CORS). Todo es opcional: si falta, el pronóstico sigue funcionando.
// Diseño: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §10

export const NO_PIREPS = 'No hay informes recientes disponibles en esta zona.';
const FILES = { metar: 'data/aviation/metar.json', taf: 'data/aviation/taf.json', sigmet: 'data/aviation/sigmet.json', pirep: 'data/aviation/pirep.json', icao: 'data/icao.json' };

export async function loadAviation(fetchFn = fetch) {
  const entries = await Promise.all(Object.entries(FILES).map(async ([key, url]) => {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(10000) });
      return [key, res.ok ? await res.json() : null];
    } catch {
      return [key, null];
    }
  }));
  return Object.fromEntries(entries);
}

// --- METAR ---

function wxText(wx = '') {
  if (!wx) return null;
  if (wx.includes('TS')) return wx.includes('RA') ? 'tormenta con lluvia' : 'tormenta';
  if (wx.includes('SH')) return 'chubascos';
  if (wx.includes('RA')) return 'lluvia';
  if (wx.includes('DZ')) return 'llovizna';
  if (wx.includes('SN')) return 'nieve';
  if (wx.includes('FG')) return 'niebla';
  if (wx.includes('BR')) return 'neblina';
  return null;
}

function visibilityText(visib) {
  const v = visib === '6+' ? 6 : Number(visib);
  if (!Number.isFinite(v)) return null;
  return v >= 5 ? 'buena visibilidad' : v >= 3 ? 'visibilidad moderada' : 'visibilidad reducida';
}

function cloudText(clouds = []) {
  const layer = clouds.find(c => ['BKN', 'OVC'].includes(c.cover)) ?? clouds[0];
  if (!layer || ['CAVOK', 'NSC', 'SKC', 'CLR', 'NCD'].includes(layer.cover)) return 'sin nubes significativas';
  if (['BKN', 'OVC'].includes(layer.cover)) {
    if (layer.base < 1000) return `nubes bajas (${layer.base} ft)`;
    return `${layer.cover === 'OVC' ? 'cielo cubierto' : 'cielo nuboso'} (${layer.base} ft)`;
  }
  return layer.cover === 'SCT' ? 'nubes dispersas' : 'algunas nubes';
}

export function summarizeMetar(m) {
  if (!m) return null;
  const wind = !m.wspd ? 'Viento en calma'
    : `${m.wdir === 'VRB' ? 'Viento variable' : `Viento de ${m.wdir}°`} a ${m.wspd} kt${m.wgst ? ` con rachas de ${m.wgst} kt` : ''}`;
  return [wind, visibilityText(m.visib), wxText(m.wx), cloudText(m.clouds), typeof m.temp === 'number' ? `${m.temp} °C` : null]
    .filter(Boolean).join(' · ');
}

// --- TAF ---

const utcHour = s => String(new Date(s * 1000).getUTCHours()).padStart(2, '0');

export function summarizeTaf(t) {
  if (!t) return null;
  const out = [];
  for (const f of t.fcsts ?? []) {
    const tag = [f.prob ? `PROB${f.prob}` : null, f.change].filter(Boolean).join(' ');
    const when = `(${tag ? `${tag} ` : ''}${utcHour(f.from)}–${utcHour(f.to)} UTC)`;
    const wx = f.wx ?? '';
    if (wx.includes('TS')) out.push(`Posibles tormentas ${when}`);
    else if (wx.includes('SH')) out.push(`Chubascos ${when}`);
    if (f.wgst >= 25) out.push(`Rachas de hasta ${f.wgst} kt ${when}`);
    const v = f.visib === '6+' ? 6 : Number(f.visib);
    if (Number.isFinite(v) && v < 3) out.push(`Visibilidad reducida ${when}`);
  }
  const unique = [...new Set(out)];
  return unique.length ? unique : ['Sin fenómenos significativos previstos'];
}

// --- Geometría (proyección local equirectangular, suficiente a estas distancias) ---

const KM_LAT = 110.574;
const toXY = (p, ref) => ({ x: (p.lon - ref.lon) * 111.32 * Math.cos(ref.lat * Math.PI / 180), y: (p.lat - ref.lat) * KM_LAT });

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// Distancia (km) de un punto a un polígono; 0 si está dentro.
function distToPolygon(point, coords) {
  const poly = coords.map(c => toXY(c, point));
  const o = { x: 0, y: 0 };
  if (inside(o, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, segDist(o, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

// Distancia (km) de un tramo de ruta a un polígono; 0 si lo toca o lo cruza.
function segmentToPolygon(p1, p2, coords) {
  const poly = coords.map(c => toXY(c, p1));
  const a = { x: 0, y: 0 }, b = toXY(p2, p1);
  if (inside(a, poly) || inside(b, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const c = poly[i], e = poly[(i + 1) % poly.length];
    if (segmentsCross(a, b, c, e)) return 0;
    d = Math.min(d, segDist(c, a, b), segDist(a, c, e), segDist(b, c, e));
  }
  return d;
}

// Distancia (km) de un punto a la ruta (polilínea).
function distToRoute(point, route) {
  const pts = route.map(r => toXY(r, point));
  const o = { x: 0, y: 0 };
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(o, pts[i], pts[i + 1]));
  return pts.length === 1 ? Math.hypot(pts[0].x, pts[0].y) : d;
}

// --- SIGMET ---

const HAZARDS = { TURB: 'Turbulencia', TS: 'Tormentas', MTW: 'Onda de montaña', TC: 'Ciclón tropical' };
const fl = ft => `FL${String(Math.round(ft / 100)).padStart(3, '0')}`;

export function sigmetsNearRoute(sigmets, route, depMs, arrMs, maxKm = 100) {
  if (!Array.isArray(sigmets)) return [];
  return sigmets
    .filter(s => HAZARDS[s.hazard] && s.coords?.length >= 3)
    .filter(s => s.validFrom * 1000 <= arrMs && s.validTo * 1000 >= depMs)
    .map(s => ({
      s,
      d: route.length > 1
        ? Math.min(...route.slice(1).map((p, i) => segmentToPolygon(route[i], p, s.coords)))
        : distToPolygon(route[0], s.coords),
    }))
    .filter(({ d }) => d <= maxKm)
    .map(({ s, d }) => ({
      label: `${HAZARDS[s.hazard]}${s.qualifier === 'SEV' ? ' fuerte' : ''}`,
      levels: s.top ? (s.base ? `${fl(s.base)}–${fl(s.top)}` : `hasta ${fl(s.top)}`) : null,
      crosses: d === 0,
      distanceKm: Math.round(d),
      validTo: s.validTo * 1000,
      raw: s.raw,
      coords: s.coords,
    }));
}

// --- PIREP ---

const INTENSITY = {
  NEG: 'sin turbulencia', SMTH: 'sin turbulencia', LGT: 'ligera', 'LGT-MOD': 'ligera a moderada',
  MOD: 'moderada', 'MOD-SEV': 'moderada a fuerte', SEV: 'fuerte', EXTRM: 'extrema',
};

export function pirepsNearRoute(pireps, route, nowMs, maxKm = 150, maxAgeH = 3) {
  if (!Array.isArray(pireps)) return [];
  return pireps
    .filter(p => p.int && nowMs - p.t <= maxAgeH * 3600000)
    .filter(p => distToRoute(p, route) <= maxKm)
    .map(p => ({ ...p, label: INTENSITY[p.int] ?? p.int.toLowerCase() }));
}
