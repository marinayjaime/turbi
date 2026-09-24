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

function normalize({ airport, type, row }) {
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
  };
}

const QUIET_STATES = [null, 'SCH', 'INI'];

export function buildLegs(entries) {
  const rows = entries.map(normalize).filter(Boolean);
  const legs = rows.filter(r => r.type === 'S').map(r => ({
    al: r.al, icao: r.icao, name: r.name, n: r.n,
    d: r.date, o: r.here, a: r.other, sd: r.sched, ed: r.est,
    sa: null, ea: null, td: r.term, ta: null, g: r.gate, st: r.st, ac: r.ac,
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
      if (QUIET_STATES.includes(best.st) && r.st) best.st = r.st;
      best.ac = best.ac ?? r.ac;
    } else {
      legs.push({
        al: r.al, icao: r.icao, name: r.name, n: r.n,
        d: r.date, o: r.other, a: r.here, sd: null, ed: null,
        sa: r.sched, ea: r.est, td: null, ta: r.term, g: null, st: r.st, ac: r.ac,
      });
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

const SAFE_AL = /^[A-Z0-9]{2}$/;
const SAFE_N = /^\d{1,4}[A-Z]?$/;

export function shardLegs(legs) {
  const files = {};
  const airlines = {};
  for (const { al, icao, name, n, ...leg } of legs) {
    if (!SAFE_AL.test(al) || !SAFE_N.test(n)) continue;
    const path = `${al}/${n}.json`;
    files[path] ??= { name, legs: [] };
    files[path].legs.push(leg);
    if (icao) airlines[icao] = al;
  }
  for (const f of Object.values(files)) {
    f.legs.sort((x, y) => (x.d + (x.sd ?? x.sa)).localeCompare(y.d + (y.sd ?? y.sa)));
  }
  return { files, airlines };
}
