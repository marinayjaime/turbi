// Histórico de puntualidad: observaciones finales de Aena → registros en la rama «data» → agregados por vuelo.
// Diseño: docs/superpowers/specs/2026-09-24-turbi-punctuality-design.md
import { mkdir, readdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { normalize } from './aena.mjs';
import {
  delayMinutes, stats, lastFlights, withinDays, slotOf, dowOf, pack, unpack,
} from '../js/punctuality.js';

const ARR_FINAL = new Set(['LND', 'IBK', 'OPE', 'OPF', 'BOR']); // En tierra / Entrega equip. / Finalizado
const DEP_FINAL = 'BOR'; // Finalizado
const KEEP_DAYS = 100;
const DAY_MS = 86400000;
const SAFE = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;

const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const physKey = l => `${l.d}|${l.o}|${l.a}|${l.sd ?? ''}|${l.sa ?? ''}`;
const isNum = v => typeof v === 'number';

// Observaciones de esta descarga: solo horas en estado final, cancelaciones y desvíos.
// legs = buildLegs(entries), para asociar cada fila a su vuelo físico (fecha de salida).
export function observe(entries, legs) {
  const byDep = new Map(), byArr = new Map();
  for (const l of legs) {
    byDep.set(`${l.al}|${l.n}|${l.o}|${l.a}|${l.d}`, l);
    if (l.sa) {
      const arrDate = l.sd && l.sa < l.sd ? nextDay(l.d) : l.d;
      byArr.set(`${l.al}|${l.n}|${l.o}|${l.a}|${arrDate}|${l.sa}`, l);
    }
  }
  const out = new Map();
  const touch = (leg, flight) => {
    const k = physKey(leg);
    if (!out.has(k)) out.set(k, { d: leg.d, o: leg.o, a: leg.a, sd: leg.sd, sa: leg.sa, f: [] });
    const o = out.get(k);
    if (!o.f.includes(flight)) o.f.push(flight);
    return o;
  };

  for (const e of entries) {
    const r = normalize(e);
    if (!r) continue;
    const flight = `${r.al}${r.n}`;
    if (r.type === 'S') {
      const leg = byDep.get(`${r.al}|${r.n}|${r.here}|${r.other}|${r.date}`);
      if (!leg) continue;
      if (r.st === DEP_FINAL) touch(leg, flight).dd = delayMinutes(r.date, r.sched, r.est);
      else if (r.st === 'CAN') touch(leg, flight).x = 1;
      else if (r.st === 'DES') touch(leg, flight).x = 2;
    } else {
      const leg = byArr.get(`${r.al}|${r.n}|${r.other}|${r.here}|${r.date}|${r.sched}`);
      if (!leg) continue;
      if (ARR_FINAL.has(r.st)) touch(leg, flight).ad = delayMinutes(r.date, r.sched, r.est);
      else if (r.st === 'CAN') touch(leg, flight).x = 1;
      else if (r.st === 'DES') touch(leg, flight).x = 2;
    }
  }
  // Solo interesa lo que aporta un dato (hora final, cancelación o desvío).
  for (const [k, o] of out) if (!isNum(o.dd) && !isNum(o.ad) && o.x === undefined) out.delete(k);
  return out;
}

const storeKey = r => `${physKey(r)}|${r.f[0]}`;
const arrDateOf = r => (r.sd && r.sa && r.sa < r.sd ? nextDay(r.d) : r.d);
const arrKey = r => `${r.o}|${r.a}|${r.sa}|${arrDateOf(r)}`;
const shares = (a, b) => a.f.some(x => b.f.includes(x));

// Fusiona observaciones en el almacén (Map clave → registro). Devuelve los días modificados.
// Un vuelo es el mismo si coincide su clave física Y comparte algún número de vuelo.
// Una llegada sin salida (Aena ya retiró la fila de salida) se une al vuelo ya guardado con esa llegada.
export function mergeRecords(store, observations) {
  const byPhys = new Map(), byArr = new Map(), byDep = new Map();
  const depKey = r => `${r.o}|${r.a}|${r.d}|${r.sd}`;
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  const index = (key, r) => {
    push(byPhys, physKey(r), key);
    if (r.sd && r.sa) { push(byArr, arrKey(r), key); push(byDep, depKey(r), key); }
  };
  for (const [key, r] of store) index(key, r);
  const find = (keys, o) => keys?.find(k => store.has(k) && shares(store.get(k), o));

  const changed = new Set();
  for (const o of observations.values()) {
    // Llegada sin salida (Aena ya retiró la fila de salida) o salida sin llegada (falló la descarga de llegadas):
    // se unen al vuelo ya guardado.
    let k = (!o.sd && o.sa ? find(byArr.get(arrKey(o)), o) : null)
      ?? (o.sd && !o.sa ? find(byDep.get(depKey(o)), o) : null)
      ?? find(byPhys.get(physKey(o)), o);
    const isNew = !k;
    if (isNew) k = storeKey(o);
    const before = store.has(k) ? JSON.stringify(store.get(k)) : null;
    const r = store.get(k) ?? { d: o.d, o: o.o, a: o.a, sd: o.sd, sa: o.sa, x: 0, f: [] };
    if (o.dd !== undefined) r.dd = o.dd;
    if (o.ad !== undefined) r.ad = o.ad;
    const operated = isNum(r.dd) || isNum(r.ad);
    if (o.x === 2) r.x = 2;
    else if (o.x === 1 && !operated) r.x = 1; // una cancelación no borra un vuelo que ya operó
    else if (operated && r.x === 1) r.x = 0;
    for (const f of o.f) if (!r.f.includes(f)) r.f.push(f);
    store.set(k, r);
    if (isNew) index(k, r);
    if (JSON.stringify(r) !== before) changed.add(r.d);
  }
  return changed;
}

export function prune(store, today, days = KEEP_DAYS) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
  for (const [k, r] of store) if (r.d <= from) store.delete(k);
}

// Agregados por número de vuelo y ruta, para el navegador (uno por vuelo).
export function aggregateFlights(records, today) {
  const recent = withinDays(records, today, 90);
  const group = (keyFn) => {
    const m = new Map();
    for (const r of recent) for (const k of [].concat(keyFn(r)).filter(Boolean)) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const byRoute = group(r => `${r.o}-${r.a}`);
  const byAirlineRoute = group(r => [...new Set(r.f.map(f => `${f.slice(0, 2)}|${r.o}-${r.a}`))]);
  const byFlight = group(r => r.f.map(f => `${f}|${r.o}-${r.a}`));

  const cache = new Map();
  const cached = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
  const splitBy = (recs, fn, basis) => {
    const m = {};
    for (const r of recs) { const k = fn(r); if (k === null) continue; (m[k] ??= []).push(r); }
    return Object.fromEntries(Object.entries(m).map(([k, rs]) => [k, stats(rs, basis)]));
  };

  const files = {};
  for (const [key, recs] of byFlight) {
    const [flight, route] = key.split('|');
    if (!SAFE.test(flight)) continue;
    const basis = recs.some(r => isNum(r.ad)) ? 'arr' : 'dep';
    const field = basis === 'arr' ? 'ad' : 'dd';
    const usable = recs.filter(r => r.x !== 0 || isNum(r[field]));
    const last = lastFlights(usable, 7);
    const routeRecs = byRoute.get(route);
    const path = `${flight.slice(0, 2)}/${flight.slice(2)}.json`;
    files[path] ??= { updated: today, routes: {} };
    files[path].routes[route] = {
      basis,
      last7: { ...stats(last, basis), flights: last.map(r => [r.d, r[field] ?? null, r.x]) },
      d30: stats(withinDays(recs, today, 30), basis),
      d90: stats(recs, basis),
      route: cached(`r|${route}|${basis}`, () => stats(routeRecs, basis)),
      airlineRoute: cached(`ar|${flight.slice(0, 2)}|${route}|${basis}`, () => stats(byAirlineRoute.get(`${flight.slice(0, 2)}|${route}`), basis)),
      dow: cached(`dow|${route}|${basis}`, () => splitBy(routeRecs, r => dowOf(r.d), basis)),
      slot: cached(`slot|${route}|${basis}`, () => splitBy(routeRecs, r => (r.sd ? slotOf(r.sd) : null), basis)),
    };
  }
  return { files };
}

// --- Entrada/salida (GitHub Actions) ---

export async function loadStore(daysDir) {
  const store = new Map();
  let names = [];
  try { names = await readdir(daysDir); } catch { return store; }
  for (const name of names.filter(n => n.endsWith('.json'))) {
    try {
      for (const row of JSON.parse(await readFile(`${daysDir}/${name}`, 'utf8'))) {
        const r = unpack(row);
        store.set(storeKey(r), r);
      }
    } catch (err) {
      console.warn(`Puntualidad: no se pudo leer ${name}: ${err.message}`);
    }
  }
  return store;
}

export async function saveDays(daysDir, store, days, today) {
  await mkdir(daysDir, { recursive: true });
  const byDay = new Map();
  for (const r of store.values()) if (days.has(r.d)) (byDay.get(r.d) ?? byDay.set(r.d, []).get(r.d)).push(r);
  for (const d of days) {
    const rows = (byDay.get(d) ?? []).sort((a, b) => physKey(a).localeCompare(physKey(b))).map(pack);
    await writeFile(`${daysDir}/${d}.json`, `${rows.map(r => JSON.stringify(r)).join(',\n').replace(/^/, '[\n')}\n]\n`);
  }
  // Días fuera de la ventana de retención.
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const name of await readdir(daysDir)) if (name.endsWith('.json') && name.slice(0, 10) <= from) await rm(`${daysDir}/${name}`);
}

// storeDir: copia local de la rama «data». outDir: _site/data/punctuality.
export async function buildPunctuality({ entries, legs, storeDir, outDir, today }) {
  const daysDir = `${storeDir}/punctuality/days`;
  // Sin copia de la rama «data» (p. ej. fallo de red al clonar) no se toca nada: mejor sin datos una hora que un histórico vacío.
  try { await access(`${storeDir}/.git`); } catch { throw new Error(`no hay copia del histórico en ${storeDir}`); }
  const store = await loadStore(daysDir);
  const changed = mergeRecords(store, observe(entries, legs));
  prune(store, today);
  await saveDays(daysDir, store, changed, today);

  const { files } = aggregateFlights([...store.values()], today);
  await rm(outDir, { recursive: true, force: true });
  for (const [path, body] of Object.entries(files)) {
    await mkdir(`${outDir}/${path.split('/')[0]}`, { recursive: true });
    await writeFile(`${outDir}/${path}`, JSON.stringify(body));
  }
  return { records: store.size, changedDays: changed.size, flights: Object.keys(files).length };
}
