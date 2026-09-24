// Funciones puras para convertir los datos de Aena Infovuelos en horarios por vuelo.
// Entrada: [{ airport, type: 'S' | 'L', row }] (row = objeto tal cual lo devuelve Aena).

const MAX_FLIGHT_MIN = 20 * 60;

const clean = v => (v === undefined || v === null || v === '' || v === 'null' ? null : String(v).trim() || null);
const isoDate = ddmmyyyy => {
  const [d, m, y] = ddmmyyyy.split('/');
  return `${y}-${m}-${d}`;
};
const hhmm = t => (clean(t) ? t.slice(0, 5) : null);
const naiveMin = (date, time) => Date.parse(`${date}T${time}:00Z`) / 60000;

export function normalize({ airport, type, row }) {
  const al = clean(row.iataCompania);
  const n = clean(row.numVuelo);
  const date = clean(row.fecha);
  const sched = hhmm(row.horaProgramada);
  if (!al || !n || !date || !sched) return null;
  const estTime = hhmm(row.horaEstimada);
  const estDate = clean(row.fechaEstimada);
  return {
    type,
    al,
    icao: clean(row.oaciCompania),
    name: clean(row.nombreCompania),
    n: n.replace(/^0+(?=\d)/, ''),
    here: airport,
    other: clean(row.iataOtro),
    date: isoDate(date),
    sched,
    est: estTime && estDate ? `${isoDate(estDate)}T${estTime}` : null,
    term: clean(row.terminal),
    gate: clean(row.puertaPrimera),
    st: clean(row.estado),
    ac: clean(row.tipoAeronave),
    // Primer código de codigosCompania distinto de la propia aerolínea = quien opera (IB1243 → YW, Air Nostrum).
    opx: (() => { const c = clean(String(row.codigosCompania ?? '').split(',')[0]); return c && c !== al ? c : null; })(),
  };
}

const QUIET_STATES = [null, 'SCH', 'INI'];

const rowKey = r => [r.type, r.al, r.n, r.here, r.other, r.date, r.sched].join('|');

// Aena a veces publica dos filas del mismo vuelo (mismo número, fecha y hora programada) con horas
// estimadas distintas. Principal = la que trae estado (si no, la primera); las otras horas se conservan
// como alternativas (alt) para mostrarlas, nunca se descartan en silencio.
function dedupeRows(rows) {
  const groups = new Map();
  for (const r of rows) (groups.get(rowKey(r)) ?? groups.set(rowKey(r), []).get(rowKey(r))).push(r);
  return [...groups.values()].map(g => {
    const primary = g.find(r => r.st) ?? g[0];
    const alt = [...new Set(g.map(r => r.est).filter(e => e && e !== primary.est))];
    return alt.length ? { ...primary, alt } : primary;
  });
}

export function buildLegs(entries) {
  const rows = dedupeRows(entries.map(normalize).filter(Boolean));
  const legs = rows.filter(r => r.type === 'S').map(r => ({
    al: r.al, icao: r.icao, name: r.name, n: r.n,
    d: r.date, o: r.here, a: r.other, sd: r.sched, ed: r.est,
    sa: null, ea: null, td: r.term, ta: null, g: r.gate, st: r.st, std: r.st, sta: null, ac: r.ac,
    ...(r.alt ? { edAlt: r.alt } : {}), opx: r.opx,
  }));

  const key = (al, n, o, a) => `${al}|${n}|${o}|${a}`;
  const byRoute = new Map();
  for (const leg of legs) {
    const k = key(leg.al, leg.n, leg.o, leg.a);
    if (!byRoute.has(k)) byRoute.set(k, []);
    byRoute.get(k).push(leg);
  }

  for (const r of rows.filter(x => x.type === 'L')) {
    const arrMin = naiveMin(r.date, r.sched);
    let best = null, bestDiff = Infinity;
    for (const leg of byRoute.get(key(r.al, r.n, r.other, r.here)) ?? []) {
      if (leg.sa !== null) continue;
      const diff = arrMin - naiveMin(leg.d, leg.sd);
      if (diff >= 0 && diff <= MAX_FLIGHT_MIN && diff < bestDiff) { best = leg; bestDiff = diff; }
    }
    if (best) {
      best.sa = r.sched;
      best.ea = r.est;
      best.ta = r.term;
      best.sta = r.st;
      if (r.alt) best.eaAlt = r.alt;
      // Estado mostrado: el de la llegada si la salida no dice nada o ya está «Finalizado» (BOR) y la llegada informa.
      if (r.st && (QUIET_STATES.includes(best.st) || (best.st === 'BOR' && !QUIET_STATES.includes(r.st)))) best.st = r.st;
      best.ac = best.ac ?? r.ac;
      best.opx = best.opx ?? r.opx;
    } else {
      legs.push({
        al: r.al, icao: r.icao, name: r.name, n: r.n,
        d: r.date, o: r.other, a: r.here, sd: null, ed: null,
        sa: r.sched, ea: r.est, td: null, ta: r.term, g: null, st: r.st, std: null, sta: r.st, ac: r.ac,
        ...(r.alt ? { eaAlt: r.alt } : {}), opx: r.opx,
      });
    }
  }
  return assignOperators(legs);
}

// op = aerolínea que opera el vuelo físico, solo si es segura: la indica Aena (codigosCompania) o no hay códigos
// compartidos. Si varios números comparten vuelo y ninguno lo indica, no se pone (no se adivina).
function assignOperators(legs) {
  const groups = new Map();
  for (const l of legs) {
    const k = `${l.d}|${l.o}|${l.a}|${l.sd ?? `L${l.sa}`}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(l);
  }
  for (const g of groups.values()) {
    const explicit = [...new Set(g.map(l => l.opx).filter(Boolean))];
    const op = explicit.length === 1 ? explicit[0] : explicit.length ? null : g.length === 1 ? g[0].al : null;
    for (const l of g) {
      delete l.opx;
      if (op) l.op = op;
    }
  }
  return legs;
}

// Modo horario: las fechas refrescadas vienen de `fresh`; el resto se conserva de `old`,
// descartando lo anterior a ayer.
export function mergeLegs(old, fresh, freshDates, today) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const kept = old.filter(l => !freshDates.includes(l.d) && l.d >= yesterday);
  return [...fresh, ...kept];
}

// Aena retira la salida unas 2 h después de despegar: se conserva (tal cual la dejó Aena) hasta el día siguiente,
// para poder seguir mirando el radar en vuelos largos.
export function keepDeparted(old, fresh, today) {
  const key = l => `${l.al}|${l.n}|${l.d}|${l.o}|${l.a}`;
  const present = new Set(fresh.map(key));
  return [...fresh, ...departedLegs(old, today).filter(l => !present.has(key(l)))];
}

// Salidas ya despegadas de ayer y hoy (lo que se guarda en data/flights/_departed.json para la siguiente descarga).
export function departedLegs(legs, today) {
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return legs.filter(l => (l.std ?? l.st) === 'BOR' && l.d >= yesterday);
}

const SAFE_AL = /^[A-Z0-9]{2}$/;
const SAFE_N = /^\d{1,4}[A-Z]?$/;

export function shardLegs(legs, updated = undefined) {
  const files = {};
  const airlines = {};
  for (const { al, icao, name, n, ...leg } of legs) {
    if (!SAFE_AL.test(al) || !SAFE_N.test(n)) continue;
    const path = `${al}/${n}.json`;
    files[path] ??= updated ? { name, updated, legs: [] } : { name, legs: [] };
    files[path].legs.push(leg);
    if (icao) airlines[icao] = al;
  }
  for (const f of Object.values(files)) {
    f.legs.sort((x, y) => (x.d + (x.sd ?? x.sa)).localeCompare(y.d + (y.sd ?? y.sa)));
  }
  return { files, airlines };
}

// Si alguna descarga de Aena falla, rellena ese hueco con la publicación anterior.
// failed: [{ airport, type: 'S' | 'L' }]; aenaAirports: aeropuertos de la red Aena.
export function patchFailed(fresh, old, failed, aenaAirports = []) {
  if (!failed.length) return fresh;
  const key = l => `${l.al}|${l.n}|${l.d}|${l.o}|${l.a}`;
  let out = fresh.slice();
  for (const { airport, type } of failed) {
    if (type === 'S') {
      out = out.filter(l => l.o !== airport).concat(old.filter(l => l.o === airport));
      continue;
    }
    const oldByKey = new Map(old.filter(l => l.a === airport).map(l => [key(l), l]));
    out = out.map(l => {
      const prev = l.a === airport && l.sa === null ? oldByKey.get(key(l)) : null;
      return prev ? { ...l, sa: prev.sa, ea: prev.ea, ta: prev.ta, sta: prev.sta ?? null, ...(prev.eaAlt ? { eaAlt: prev.eaAlt } : {}) } : l;
    });
    const present = new Set(out.map(key));
    for (const l of oldByKey.values()) {
      if (!aenaAirports.includes(l.o) && !present.has(key(l))) out.push(l);
    }
  }
  return out;
}

// Auditoría: cada hora publicada por Turbi debe coincidir exactamente con la fila de Aena de la que sale.
export function auditLegs(entries, legs) {
  const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const byDep = new Map(), byArr = new Map();
  for (const l of legs) {
    byDep.set(`${l.al}|${l.n}|${l.o}|${l.a}|${l.d}|${l.sd}`, l);
    if (l.sa) byArr.set(`${l.al}|${l.n}|${l.o}|${l.a}|${l.sd && l.sa < l.sd ? nextDay(l.d) : l.d}|${l.sa}`, l);
  }
  let checked = 0;
  const mismatches = [];
  const published = new Map();
  for (const e of entries) {
    const r = normalize(e);
    if (!r || !r.est) continue;
    (published.get(rowKey(r)) ?? published.set(rowKey(r), new Set()).get(rowKey(r))).add(r.est);
    const leg = r.type === 'S'
      ? byDep.get(`${r.al}|${r.n}|${r.here}|${r.other}|${r.date}|${r.sched}`)
      : byArr.get(`${r.al}|${r.n}|${r.other}|${r.here}|${r.date}|${r.sched}`);
    if (!leg) continue;
    checked++;
    const turbi = r.type === 'S' ? leg.ed : leg.ea;
    const alts = (r.type === 'S' ? leg.edAlt : leg.eaAlt) ?? [];
    // Correcto si Turbi muestra esa hora o la conserva como alternativa publicada por Aena.
    if (turbi !== r.est && !alts.includes(r.est)) {
      mismatches.push({ flight: `${r.al}${r.n}`, side: r.type === 'S' ? 'salida' : 'llegada', airport: r.here, aena: r.est, turbi });
    }
  }
  const duplicates = [...published.values()].filter(s => s.size > 1).length;
  return { checked, mismatches, duplicates };
}
