// Números comerciales que Aena no publica pero asocia a un vuelo que sí publica (data/flights/_aliases.json, generado
// por scripts/aliases.mjs). Nunca se usan en silencio: la app ofrece el vuelo de Aena y el usuario lo confirma.
import { parseFlightNumber, fetchSchedule } from './schedule.js';

const BASE = 'data/flights/';

async function getJson(url, fetchFn) {
  try {
    const res = await fetchFn(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Alias del número escrito (IATA u OACI, como en fetchSchedule), o null.
export async function findAlias(number, fetchFn = fetch) {
  const parsed = parseFlightNumber(number);
  if (!parsed) return null;
  let prefix = parsed.prefix;
  if (prefix.length === 3) {
    prefix = (await getJson(`${BASE}airlines.json`, fetchFn))?.[prefix];
    if (!prefix) return null;
  }
  const alias = (await getJson(`${BASE}_aliases.json`, fetchFn))?.aliases?.[`${prefix}${parsed.n}`];
  return alias?.al && alias.n && alias.routes?.length ? alias : null;
}

// Solo los tramos de las rutas respaldadas por la evidencia del alias: nunca otro vuelo del mismo número.
export const aliasLegs = (legs, alias) => legs.filter(l => alias.routes.some(([o, a]) => l.o === o && l.a === a));

// Candidato para una fecha: { alias, schedule (solo rutas respaldadas), legs (de esa fecha) } o null.
export async function aliasOffer(number, date, fetchFn = fetch, liveBase = undefined) {
  const alias = await findAlias(number, fetchFn);
  if (!alias) return null;
  const schedule = await fetchSchedule(`${alias.al}${alias.n}`, fetchFn, liveBase);
  if (!schedule) return null;
  const legs = aliasLegs(schedule.legs, alias);
  const onDate = legs.filter(l => l.d === date);
  return onDate.length ? { alias, schedule: { ...schedule, legs }, legs: onDate } : null;
}

// ADSBDB: una ruta distinta es un veto absoluto; coincidencia, desconocido (404) o fallo temporal no lo impiden
// (en esos casos el candidato se apoya solo en Aena y el usuario confirma).
export function adsbdbVetoes(adsb, legs) {
  if (adsb?.status !== 'found' || !adsb.iata) return false;
  const [o, a] = adsb.iata;
  return !legs.some(l => l.o === o && l.a === a);
}
