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
// Códigos de avión de Aena (IATA u OACI) → nombre llano.
const AIRCRAFT = {
  A318: 'Airbus A318', 318: 'Airbus A318',
  A319: 'Airbus A319', 319: 'Airbus A319', A320: 'Airbus A320', 320: 'Airbus A320', '32A': 'Airbus A320', A32A: 'Airbus A320',
  A20N: 'Airbus A320neo', '32N': 'Airbus A320neo',
  A321: 'Airbus A321', 321: 'Airbus A321', '32B': 'Airbus A321', A32B: 'Airbus A321', A21N: 'Airbus A321neo', '32Q': 'Airbus A321neo',
  A332: 'Airbus A330-200', 332: 'Airbus A330-200', A333: 'Airbus A330-300', 333: 'Airbus A330-300', A339: 'Airbus A330neo', 339: 'Airbus A330neo',
  A343: 'Airbus A340-300', 343: 'Airbus A340-300',
  A359: 'Airbus A350-900', 359: 'Airbus A350-900', A35K: 'Airbus A350-1000', 351: 'Airbus A350-1000', A388: 'Airbus A380', 388: 'Airbus A380',
  BCS1: 'Airbus A220-100', 221: 'Airbus A220-100', BCS3: 'Airbus A220-300', 223: 'Airbus A220-300',
  B733: 'Boeing 737-300', 733: 'Boeing 737-300', '733W': 'Boeing 737-300', '73C': 'Boeing 737-300',
  B736: 'Boeing 737-600', 736: 'Boeing 737-600',
  B737: 'Boeing 737-700', 737: 'Boeing 737-700', '737W': 'Boeing 737-700', '73G': 'Boeing 737-700', '73W': 'Boeing 737-700',
  B738: 'Boeing 737-800', 738: 'Boeing 737-800', '738W': 'Boeing 737-800', '73H': 'Boeing 737-800', '7S8': 'Boeing 737-800',
  B739: 'Boeing 737-900', 739: 'Boeing 737-900', '739W': 'Boeing 737-900', '73J': 'Boeing 737-900',
  B38M: 'Boeing 737 MAX 8', '7M8': 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', '7M9': 'Boeing 737 MAX 9',
  B752: 'Boeing 757-200', 752: 'Boeing 757-200', B763: 'Boeing 767-300', 763: 'Boeing 767-300', '76W': 'Boeing 767-300',
  B764: 'Boeing 767-400', 764: 'Boeing 767-400',
  B772: 'Boeing 777-200', 772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', '77L': 'Boeing 777-200LR',
  B773: 'Boeing 777-300', 773: 'Boeing 777-300', B77W: 'Boeing 777-300ER', '77W': 'Boeing 777-300ER',
  B788: 'Boeing 787-8', 788: 'Boeing 787-8', B789: 'Boeing 787-9', 789: 'Boeing 787-9', B78X: 'Boeing 787-10', 781: 'Boeing 787-10',
  E170: 'Embraer 170', E70: 'Embraer 170', E75L: 'Embraer 175', E7W: 'Embraer 175',
  E190: 'Embraer 190', E90: 'Embraer 190', E195: 'Embraer 195', E95: 'Embraer 195',
  E290: 'Embraer E190-E2', 290: 'Embraer E190-E2', E295: 'Embraer E195-E2', 295: 'Embraer E195-E2',
  CRJ9: 'Bombardier CRJ900', CRK: 'Bombardier CRJ1000', CRJX: 'Bombardier CRJ1000',
  AT72: 'ATR 72', AT7: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600', DH8D: 'Dash 8-400', DH4: 'Dash 8-400',
  A139: 'Helicóptero AW139', AWH: 'Helicóptero AW139',
};

// Nombre → artículo de Wikipedia (en inglés) cuya foto principal ilustra el modelo (scripts/fetch-aircraft-photos.mjs).
export const PHOTO_ARTICLE = {
  'Airbus A318': 'Airbus A318', 'Airbus A319': 'Airbus A319', 'Airbus A320': 'Airbus A320', 'Airbus A320neo': 'Airbus A320neo family',
  'Airbus A321': 'Airbus A321', 'Airbus A321neo': 'Airbus A321neo', 'Airbus A330-200': 'Airbus A330', 'Airbus A330-300': 'Airbus A330',
  'Airbus A330neo': 'Airbus A330neo', 'Airbus A340-300': 'Airbus A340', 'Airbus A350-900': 'Airbus A350', 'Airbus A350-1000': 'Airbus A350',
  'Airbus A380': 'Airbus A380', 'Airbus A220-100': 'Airbus A220', 'Airbus A220-300': 'Airbus A220',
  'Boeing 737-300': 'Boeing 737 Classic', 'Boeing 737-600': 'Boeing 737 Next Generation', 'Boeing 737-700': 'Boeing 737 Next Generation',
  'Boeing 737-800': 'Boeing 737 Next Generation', 'Boeing 737-900': 'Boeing 737 Next Generation',
  'Boeing 737 MAX 8': 'Boeing 737 MAX', 'Boeing 737 MAX 9': 'Boeing 737 MAX', 'Boeing 757-200': 'Boeing 757',
  'Boeing 767-300': 'Boeing 767', 'Boeing 767-400': 'Boeing 767', 'Boeing 777-200': 'Boeing 777', 'Boeing 777-200LR': 'Boeing 777',
  'Boeing 777-300': 'Boeing 777', 'Boeing 777-300ER': 'Boeing 777', 'Boeing 787-8': 'Boeing 787 Dreamliner', 'Boeing 787-9': 'Boeing 787 Dreamliner',
  'Boeing 787-10': 'Boeing 787 Dreamliner', 'Embraer 170': 'Embraer E-Jet family', 'Embraer 175': 'Embraer E-Jet family',
  'Embraer 190': 'Embraer E-Jet family', 'Embraer 195': 'Embraer E-Jet family', 'Embraer E190-E2': 'Embraer E-Jet E2 family',
  'Embraer E195-E2': 'Embraer E-Jet E2 family', 'Bombardier CRJ900': 'Bombardier CRJ700 series', 'Bombardier CRJ1000': 'Bombardier CRJ700 series',
  'ATR 72': 'ATR 72', 'ATR 72-500': 'ATR 72', 'ATR 72-600': 'ATR 72', 'Dash 8-400': 'De Havilland Canada Dash 8', 'Helicóptero AW139': 'AgustaWestland AW139',
};

export const photoSlug = article => article.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Nombre del archivo de la foto del modelo (img/aircraft/<slug>.jpg), o null si no se conoce el modelo.
export function aircraftPhoto(code) {
  const name = code ? AIRCRAFT[String(code).toUpperCase()] : null;
  return name && PHOTO_ARTICLE[name] ? photoSlug(PHOTO_ARTICLE[name]) : null;
}

export function aircraftName(code) {
  if (!code) return null;
  return AIRCRAFT[String(code).toUpperCase()] ?? `modelo ${code}`;
}
