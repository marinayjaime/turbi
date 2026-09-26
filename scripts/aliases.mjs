// Números comerciales que Aena no publica pero asocia a un vuelo que sí publica (BA8462 → CJ8462, BA CityFlyer).
// Nunca es un alias silencioso: la app lo ofrece para que el usuario lo confirme, y solo en las rutas respaldadas.
//
// codigosCompania (6 posiciones, sin documentar): [0]/[1] = operadora (IATA/OACI), [2]/[3] = código comercial
// (IATA/OACI; en las filas del día [2] viene vacío y [3] trae el IATA). La misma posición significa cosas distintas según
// la fila (operadora ajena IB → YW, marca con otra numeración NAY → NT, códigos que no son aerolíneas: 1L, W1, BH…),
// así que ningún código se usa por aparecer: todo alias debe superar TODAS estas condiciones.
//
// Relación X → M (X publicada por Aena, M comercial):
//   A1. En la fila, [0] es X: la propia aerolínea es la operadora (excluye IB → YW, donde YW es la operadora).
//   A2. X y M están en el catálogo de Aena de la descarga, cada una con un único OACI (IATA ↔ OACI coherente), y es el
//       mismo OACI que se anotó con la evidencia.
//   A3. Al menos una evidencia con el par completo: [2] = M y [3] = OACI(M).
//   A4. Ninguna colisión: si Aena publica M+n (n de cualquier número con evidencia) como otro vuelo físico, las
//       numeraciones son distintas y la relación entera se descarta (NAY/RSC → NT).
//   A5. Al menos MIN_NUMBERS números distintos con evidencia.
// Número M+n → X+n:
//   B1. Alguna fila de X+n nombra a M en la posición comercial ([2], o [3] si [2] está vacío).
//   B2. Aena no publica M+n directamente.
//   B3. Un único destino X+n.
//   B4. Solo las rutas con evidencia en las que Aena publica ahora X+n.
//
// Persistencia: las evidencias se guardan MAX_AGE_DAYS días desde que se vieron, pero en cada descarga completa se
// vuelven a comprobar todas las condiciones con los datos actuales; un alias nunca sobrevive a una condición rota.
import { normalize, recoverablePairs } from './aena.mjs';
import { physicalFlightKey } from '../js/physical-flight.js';

export const MIN_NUMBERS = 3;
export const MAX_AGE_DAYS = 14;
const IATA = /^[A-Z0-9]{2}$/;
const DAY_MS = 86400000;

const clean = v => (v === undefined || v === null || v === 'null' ? '' : String(v).trim());

// Catálogo de la descarga: IATA → OACI, solo si la relación es única en los dos sentidos.
export function catalog(entries) {
  const recoverable = recoverablePairs(entries);
  const byIata = new Map(), byIcao = new Map();
  for (const e of entries) {
    const r = normalize(e, recoverable);
    if (!r?.icao) continue;
    (byIata.get(r.al) ?? byIata.set(r.al, new Set()).get(r.al)).add(r.icao);
    (byIcao.get(r.icao) ?? byIcao.set(r.icao, new Set()).get(r.icao)).add(r.al);
  }
  const out = new Map();
  for (const [iata, icaos] of byIata) {
    const [icao] = icaos;
    if (icaos.size === 1 && byIcao.get(icao).size === 1) out.set(iata, icao);
  }
  return out;
}

// Evidencias de esta descarga: { X, xi, M, mi, n, o, a, strong, seen }.
export function collectEvidence(entries, today) {
  const recoverable = recoverablePairs(entries);
  const icaoOf = catalog(entries);
  const out = [];
  for (const e of entries) {
    const r = normalize(e, recoverable);
    if (!r) continue;
    const c = String(e.row.codigosCompania ?? '').split(',').map(clean);
    if (c[0] !== r.al) continue; // A1
    let M = null, strong = false;
    if (c[2]) {
      if (IATA.test(c[2]) && c[2] !== r.al && icaoOf.has(c[2]) && c[3] === icaoOf.get(c[2])) { M = c[2]; strong = true; }
    } else if (IATA.test(c[3] ?? '') && c[3] !== r.al) {
      M = c[3];
    }
    if (!M || !icaoOf.has(r.al) || !icaoOf.has(M)) continue; // A2 (el resto se comprueba al validar)
    const [o, a] = r.type === 'S' ? [r.here, r.other] : [r.other, r.here];
    if (!o || !a) continue;
    out.push({ X: r.al, xi: icaoOf.get(r.al), M, mi: icaoOf.get(M), n: r.n, o, a, strong, seen: today });
  }
  return out;
}

const evKey = ev => [ev.X, ev.xi, ev.M, ev.mi, ev.n, ev.o, ev.a, ev.strong].join('|');

// Une las evidencias anteriores (sin caducar) con las nuevas; de cada una se queda la fecha más reciente.
export function mergeEvidence(previous, current, today) {
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - MAX_AGE_DAYS * DAY_MS).toISOString().slice(0, 10);
  const byKey = new Map();
  for (const ev of [...previous, ...current]) {
    if (!ev?.seen || ev.seen < oldest) continue;
    const k = evKey(ev);
    if (!byKey.has(k) || byKey.get(k).seen < ev.seen) byKey.set(k, ev);
  }
  return [...byKey.values()].sort((x, y) => evKey(x).localeCompare(evKey(y)));
}

// Valida las evidencias contra los datos ACTUALES (catálogo de la descarga y tramos publicados) y devuelve los alias.
// Devuelve { aliases: { M+n: { al, n, name, routes: [[o, a]], lastEvidence } }, rejected: [{ pair, reason }] }.
export function validateAliases(evidence, legs, icaoOf) {
  const legsByNum = new Map();
  for (const l of legs) (legsByNum.get(`${l.al}${l.n}`) ?? legsByNum.set(`${l.al}${l.n}`, []).get(`${l.al}${l.n}`)).push(l);

  const pairs = new Map();
  for (const ev of evidence) {
    const k = `${ev.X}→${ev.M}`;
    (pairs.get(k) ?? pairs.set(k, []).get(k)).push(ev);
  }
  const rejected = [];
  const candidates = new Map(); // M+n → [{ X, n, evs }]
  for (const [pair, evs] of pairs) {
    const { X, M } = evs[0];
    const reason = (() => {
      if (!icaoOf.has(X) || !icaoOf.has(M)) return 'aerolínea fuera del catálogo actual de Aena';
      if (evs.some(ev => ev.xi !== icaoOf.get(X) || ev.mi !== icaoOf.get(M))) return 'la relación IATA ↔ OACI ha cambiado';
      if (!evs.some(ev => ev.strong)) return 'sin par IATA + OACI explícito';
      const nums = [...new Set(evs.map(ev => ev.n))];
      const collisions = nums.filter(n => {
        const mine = new Set((legsByNum.get(`${X}${n}`) ?? []).map(physicalFlightKey));
        return (legsByNum.get(`${M}${n}`) ?? []).some(l => !mine.has(physicalFlightKey(l)));
      });
      if (collisions.length) return `${collisions.length} colisiones de número (${M}${collisions[0]}…)`;
      if (nums.length < MIN_NUMBERS) return `solo ${nums.length} números con evidencia (mínimo ${MIN_NUMBERS})`;
      return null;
    })();
    if (reason) { rejected.push({ pair, reason }); continue; }
    for (const n of new Set(evs.map(ev => ev.n))) {
      const k = `${M}${n}`;
      (candidates.get(k) ?? candidates.set(k, []).get(k)).push({ X, n, evs: evs.filter(ev => ev.n === n) });
    }
  }

  const aliases = {};
  for (const [k, list] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    if (legsByNum.has(k)) { rejected.push({ pair: k, reason: 'Aena ya publica el número comercial' }); continue; } // B2
    if (list.length > 1) { rejected.push({ pair: k, reason: 'varios destinos posibles' }); continue; } // B3
    const { X, n, evs } = list[0];
    const published = legsByNum.get(`${X}${n}`) ?? [];
    const routes = [...new Set(evs.map(ev => `${ev.o}|${ev.a}`))].sort()
      .filter(r => published.some(l => `${l.o}|${l.a}` === r)); // B4
    if (!routes.length) { rejected.push({ pair: k, reason: 'Aena ya no publica el vuelo en la ruta con evidencia' }); continue; }
    aliases[k] = {
      al: X, n, name: published.find(l => l.name)?.name ?? null,
      routes: routes.map(r => r.split('|')),
      lastEvidence: evs.map(ev => ev.seen).sort().at(-1),
    };
  }
  return { aliases, rejected };
}

// Una descarga completa: evidencias nuevas + anteriores sin caducar, todo revalidado con los datos actuales.
// previous: el _aliases.json publicado antes (o null). legs: los tramos que se publican (con nombre de aerolínea).
export function buildAliases(entries, legs, previous, today) {
  const evidence = mergeEvidence(previous?.evidence ?? [], collectEvidence(entries, today), today);
  const { aliases, rejected } = validateAliases(evidence, legs, catalog(entries));
  return { evidence, aliases, rejected };
}
