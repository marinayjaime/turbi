// Traducción de la jerga aeronáutica a datos que entiende cualquiera: km y pies en vez de «FL»,
// km/h en vez de nudos, puntos cardinales, metros y nombres de avión.

const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const km1 = fl => {
  const km = Math.round((fl * 100 * 0.3048) / 100) / 10;
  return String(km).replace('.', ',').replace(/,0$/, '');
};

export function altitudeText(fl) {
  if (fl <= 0) return 'el suelo';
  return `${km1(fl)} km (${thousands(Math.round(fl) * 100)} pies)`;
}

export function altitudeRange(min, max) {
  if (max <= 0) return 'cerca del suelo';
  if (min === max) return `a unos ${altitudeText(max)}`;
  if (min <= 0) return `del suelo a unos ${km1(max)} km`;
  return `entre ${km1(min)} y ${km1(max)} km`;
}

export const kmh = kt => Math.round((kt * 1.852) / 5) * 5;
export const metres = ft => Math.round((ft * 0.3048) / 50) * 50;

const POINTS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
export const compass = deg => `del ${POINTS[Math.round(deg / 45) % 8]}`;

export function localHour(ms, timeZone) {
  return new Intl.DateTimeFormat('es-ES', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

// Códigos de tipo de avión (OACI de 4 letras o IATA de 3) más habituales en España.
const AIRCRAFT = {
  A319: 'Airbus A319', 319: 'Airbus A319', A320: 'Airbus A320', 320: 'Airbus A320', A20N: 'Airbus A320neo', '32N': 'Airbus A320neo',
  A321: 'Airbus A321', 321: 'Airbus A321', A21N: 'Airbus A321neo', '32Q': 'Airbus A321neo', A32A: 'Airbus A320', A32B: 'Airbus A321',
  A332: 'Airbus A330-200', 332: 'Airbus A330-200', A333: 'Airbus A330-300', 333: 'Airbus A330-300', A339: 'Airbus A330neo', A359: 'Airbus A350-900', 359: 'Airbus A350-900',
  A35K: 'Airbus A350-1000', A388: 'Airbus A380', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300', 223: 'Airbus A220-300',
  B737: 'Boeing 737-700', '73G': 'Boeing 737-700', B738: 'Boeing 737-800', 738: 'Boeing 737-800', B38M: 'Boeing 737 MAX 8', '7M8': 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9', B752: 'Boeing 757-200', B763: 'Boeing 767-300', B772: 'Boeing 777-200', B77W: 'Boeing 777-300ER', '77W': 'Boeing 777-300ER',
  B788: 'Boeing 787-8', 788: 'Boeing 787-8', B789: 'Boeing 787-9', 789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  E190: 'Embraer 190', E195: 'Embraer 195', E295: 'Embraer E195-E2', CRJ9: 'Bombardier CRJ900', CRJX: 'Bombardier CRJ1000',
  AT72: 'ATR 72', AT76: 'ATR 72-600', AT75: 'ATR 72-500', DH8D: 'Dash 8-400',
};

export function aircraftName(code) {
  if (!code) return null;
  return AIRCRAFT[String(code).toUpperCase()] ?? code;
}
