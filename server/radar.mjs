// Radar (ADS-B) para vuelos cuya llegada no publica Aena (destino extranjero): ¿está el avión en el aire?
// Fuente gratuita y sin registro: adsb.lol. Solo se busca el vuelo consultado, por su indicativo exacto
// (código OACI de la aerolínea + número: EI737 → EIN737). Si la aerolínea emite con otro indicativo
// (p. ej. Aer Lingus EIN7LM), no se encuentra y no se dice nada: nunca se deduce qué avión es.
const ADSB = 'https://api.adsb.lol/v2';
// adsb.lol exige un User-Agent con contacto (si no, 403).
const UA = 'Turbi/1.0 (+https://github.com/marinayjaime/turbi)';
const MAX_SEEN_S = 180; // en zonas con poca cobertura las señales llegan más espaciadas
const PAUSE_MS = 1500; // espera antes de reintentar (adsb.lol responde 429 si se le pregunta demasiado seguido)
const RETRIES = 2;
const WINDOW_H = 20; // se mira el radar hasta 20 h después de la salida
const CANARY = new Set(['LPA', 'TFN', 'TFS', 'ACE', 'FUE', 'SPC', 'VDE', 'GMZ']);
const DEPARTED = 'BOR'; // Aena (salida): Finalizado = ha despegado

// Aena retira la salida unas 2 h después de despegar: se conserva (tal cual la dejó Aena) hasta el día siguiente,
// para poder seguir mirando el radar en vuelos largos.
export function keepDeparted(old, fresh, today) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const key = l => `${l.al}|${l.n}|${l.d}|${l.o}|${l.a}`;
  const present = new Set(fresh.map(key));
  return [...fresh, ...old.filter(l => (l.std ?? l.st) === DEPARTED && l.d >= yesterday && !present.has(key(l)))];
}

// Hora local de salida (en el aeropuerto de origen, España) → milisegundos UTC.
function departureMs(leg) {
  const local = leg.ed ?? (leg.sd ? `${leg.d}T${leg.sd}` : null);
  if (!local) return null;
  const guess = Date.parse(`${local}:00Z`);
  const tz = CANARY.has(leg.o) ? 'Atlantic/Canary' : 'Europe/Madrid';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).map(x => [x.type, x.value]));
  const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - guess;
  return guess - offset;
}

// Solo si Aena dice que ha salido y no informa de la llegada (destino fuera de Aena).
export function needsRadar(leg, nowMs) {
  if ((leg.std ?? leg.st) !== DEPARTED || leg.sta || !leg.icao) return false;
  const dep = departureMs(leg);
  return dep !== null && nowMs >= dep && nowMs - dep < WINDOW_H * 3600000;
}

const wait = ms => (ms ? new Promise(r => setTimeout(r, ms)) : null);

// null = la consulta ha fallado (red, 429…): no se sabe nada, que no es lo mismo que «no está en el aire».
async function lookup(fetchFn, callsign, pauseMs) {
  for (let i = 0; i <= RETRIES; i++) {
    if (i) await wait(pauseMs);
    try {
      const res = await fetchFn(`${ADSB}/callsign/${callsign}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (res.ok) return await res.json();
    } catch { /* se reintenta */ }
  }
  return null;
}

const airborne = a => typeof a.alt_baro === 'number' && (a.seen ?? 0) <= MAX_SEEN_S;

// siblings: el mismo vuelo con otros números (códigos compartidos); el avión emite con el de la operadora.
export async function findOnRadar({ leg, siblings = [], fetchFn = fetch, pauseMs = PAUSE_MS }) {
  const callsigns = [...new Set([leg, ...siblings].filter(l => l.icao).map(l => `${l.icao}${l.n}`))];
  let failed = false, a = null, callsign = callsigns[0];
  for (const [i, cs] of callsigns.entries()) {
    if (i) await wait(pauseMs);
    const r = await lookup(fetchFn, cs, pauseMs);
    if (!r) { failed = true; continue; }
    a = (r.ac ?? []).find(airborne);
    if (a) { callsign = cs; break; }
  }
  if (!a) return failed ? { state: 'no-disponible' } : { state: 'sin-datos', callsign };
  return {
    state: 'volando', callsign,
    altFt: a.alt_baro, altM: Math.round(a.alt_baro * 0.3048), kmh: Number.isFinite(a.gs) ? Math.round(a.gs * 1.852) : null,
    seenS: Math.round(a.seen ?? 0), source: 'adsb.lol',
  };
}
