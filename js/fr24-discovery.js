// Vuelo encontrado SOLO por Flightradar24 (ni Aena ni AeroDataBox lo tienen): reglas compartidas por la app (js/app.js)
// y el servidor (server/fr24-discover.mjs). Sin DOM ni red.
//   - Descubrir (Flight Positions, en vivo) solo para la fecha de HOY: un vuelo de ayer no se reconstruye con posiciones.
//   - Un vuelo ya descubierto se sigue pudiendo abrir hasta 2 días después (lo recuerda el servidor); su cierre es el de
//     Flight Summary (fr24HistoryDue), nunca una suposición por la hora.
const DAY = 86400000;
const H = 3600000;
const dayIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(ms);

// La fecha de HOY en España (la del formulario) o en UTC (de madrugada pueden no coincidir).
export const discoveryLive = (date, nowMs) => date === dayIn(nowMs, 'Europe/Madrid') || date === dayIn(nowMs, 'UTC');
// Hoy, ayer o anteayer (en España): un vuelo descubierto se puede volver a abrir.
export const discoveryKnown = (date, nowMs) => [0, 1, 2].some(d => date === dayIn(nowMs - d * DAY, 'Europe/Madrid')) || discoveryLive(date, nowMs);

// Vuelo físico descubierto: número, fecha buscada y ruta IATA. Es el ?leg= de /radar-fr24 y la clave de la ficha.
export const fr24Key = (number, date, o, a) => `fr24|${number}|${date}|${o}|${a}`;

// Cierre con Flight Summary: 1 h después de la ETA de FR24 (la misma hora que historyDue de AeroDataBox) o, sin ETA,
// 20 h después de verlo volando (ningún vuelo dura más).
export const FR24_MAX_FLIGHT_MS = 20 * H;
export function fr24HistoryDue(rec, nowMs) {
  const eta = Date.parse(rec?.eta ?? ''), seen = Date.parse(rec?.discoveredAt ?? '');
  if (Number.isFinite(eta)) return nowMs >= eta + H;
  return Number.isFinite(seen) && nowMs >= seen + FR24_MAX_FLIGHT_MS;
}
