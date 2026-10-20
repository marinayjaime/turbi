// «Detalles avanzados» (§5.11): la tarjeta cerrada por defecto donde va toda la información técnica que ya no ocupa la
// vista principal. Cada categoría es un <details data-card="adv-…"> y solo existe si tiene contenido: lo que Turbi no
// sabe no se muestra (ni «—» ni valores por defecto) y nada se inventa. Solo presentación: no consulta ni calcula nada
// nuevo (la antigüedad de la señal sale de signalState, de card-model.js).
import { esc, thousands } from './ui.js';
import { icon } from './icons.js';
import { signalState, planeOnMap, positionAgeS, ageText } from './card-model.js';
import { agoText } from './storage.js';
import { BUILD_ID } from './build.js';

const row = (k, v, cls = '') => `<div class="kv${cls ? ` ${cls}` : ''}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const isOpen = (open, key) => (open.has(key) ? ' open' : '');

// Categoría desplegable: cabecera con icono, título y chevron (que gira al abrir, como en el resto de tarjetas).
function category(key, title, iconName, inner, open) {
  return `
      <details class="adv-cat" data-card="${key}"${isOpen(open, key)}>
        <summary class="adv-sum">${icon(iconName, { size: 18 })}<span class="adv-title">${title}</span>${icon('chevron', { size: 16 })}</summary>
        <div class="adv-body">${inner}</div>
      </details>`;
}

// Atribución completa de la foto (autor, licencia y enlace): la licencia la exige, así que se mantiene entera.
function photoCredit(p) {
  if (!p?.artist) return '';
  const who = p.page ? `<a href="${esc(p.page)}" target="_blank" rel="noopener">${esc(p.artist)}</a>` : esc(p.artist);
  return row('Foto', `${who}${p.license ? `, ${esc(p.license)}` : ''}`);
}

// Cómo se identificó el avión en el radar (radar.match, tal cual lo devuelve el servidor).
export const MATCH = { ruta: 'Por ruta', transpondedor: 'Por transpondedor', indicativo: 'Por indicativo' };

function aircraftRows(c) {
  const rows = [];
  if (c.aircraft) rows.push(row('Modelo', esc(c.aircraft)));
  if (c.airline) rows.push(row('Aerolínea', esc(c.airline)));
  if (c.operator) rows.push(row('Operado por', esc(c.operator)));
  // Matrícula y transpondedor solo los da AeroDataBox.
  if (c.source === 'aerodatabox' && c.aircraftReg) rows.push(row('Matrícula', esc(c.aircraftReg)));
  if (c.source === 'aerodatabox' && c.aircraftHex) rows.push(row('Transpondedor', esc(String(c.aircraftHex).toUpperCase())));
  const credit = photoCredit(c.photo);
  if (credit) rows.push(credit);
  return rows;
}

// « · hace X» de un dato ADS-B que ya no es reciente (mismo texto en el HTML y en el contador de app.js).
export const ageSuffix = sig => ` · hace ${sig.text}`;

function adsbRows(c, nowMs) {
  const r = c.radar;
  if (r?.state !== 'volando') return [];
  const rows = [];
  const sig = signalState(r, c.radarReceivedAt, nowMs);
  // Lectura que ya no es reciente (old / stale): altitud, velocidades y posición llevan su antigüedad para que nunca
  // parezcan actuales (§10 bis.2). El indicativo y la identificación no envejecen. .adv-age: el contador de señal de
  // app.js reescribe su texto cada segundo, como el de «Última señal».
  const age = sig ? `<span class="adv-age">${esc(ageSuffix(sig))}</span>` : '';
  const aged = sig && sig.level !== 'live' ? age : '';
  if (r.callsign) rows.push(row('Indicativo', esc(r.callsign)));
  if (Number.isFinite(r.altFt)) rows.push(row('Altitud', `${thousands(Math.round(r.altFt))} ft${Number.isFinite(r.altM) ? ` · ${thousands(Math.round(r.altM))} m` : ''}${aged}`));
  if (Number.isFinite(r.kmh)) rows.push(row('Velocidad', `${thousands(Math.round(r.kmh))} km/h${aged}`));
  if (Number.isFinite(r.vRateFpm)) rows.push(row('Velocidad vertical', `${r.vRateFpm > 0 ? '+' : ''}${thousands(Math.round(r.vRateFpm))} ft/min${aged}`));
  // .adv-signal: el contador de señal de app.js reescribe solo este valor cada segundo (sin repintar #adv-flight).
  if (sig) rows.push(row('Última señal', `hace ${esc(sig.text)}`, 'adv-signal'));
  // La posición lleva solo la antigüedad de la POSICIÓN (posAgeS), nunca la de la señal: en cuanto el mapa quita el
  // avión (planeOnMap null, más de 60 s) se muestra «· hace X» (data-pos: el contador de app.js la reescribe con la de
  // la posición). Sin posAgeS la antigüedad es desconocida y no se muestra la fila, como el mapa no pinta el avión.
  const posAge = positionAgeS(r, c.radarReceivedAt, nowMs);
  if (Number.isFinite(r.lat) && Number.isFinite(r.lon) && posAge !== null) {
    const posAged = planeOnMap(r, c.radarReceivedAt, nowMs) ? '' : `<span class="adv-age" data-pos>${esc(ageSuffix({ text: ageText(posAge) }))}</span>`;
    rows.push(row('Posición', `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}${posAged}`));
  }
  if (MATCH[r.match]) rows.push(row('Identificación', MATCH[r.match]));
  return rows;
}

// Turbi no tiene una lista de códigos comerciales: solo el aviso de código compartido (photo.shared) y «Operado por».
function codeshareRows(c) {
  const rows = [];
  if (c.photo?.shared) rows.push('<p class="adv-note">Vuelo con código compartido: Aena no indica qué aerolínea lo opera.</p>');
  if (c.operator) rows.push(row('Operado por', esc(c.operator)));
  return rows;
}

function techRows(c) {
  const rows = [];
  if (c.physicalKey) rows.push(row('Clave del vuelo físico', `<code>${esc(c.physicalKey)}</code>`));
  const a = c.aenaCodes;
  if (a?.st) rows.push(row('Código de estado (st)', esc(a.st)));
  if (a?.std) rows.push(row('Código std', esc(a.std)));
  if (a?.sta) rows.push(row('Código sta', esc(a.sta)));
  rows.push(row('Versión de Turbi', esc(BUILD_ID)));
  return rows;
}

// Parte de vuelo de «Fuentes utilizadas»: de dónde sale cada dato de la ficha. Los modelos del tiempo y Aviation
// Weather Center van en #adv-sources (#fresh), que escribe forecastExtras.
function sourceRows(c) {
  const rows = [];
  if (c.source === 'aerodatabox') {
    if (c.sourceNote) rows.push(row('AeroDataBox', esc(c.sourceNote)));
  } else {
    rows.push(row('Aena', c.updatedAgo ? `horario y estado · ${esc(c.updatedAgo)}` : 'horario y estado'));
  }
  if (['volando', 'aterrizado', 'reciente'].includes(c.radar?.state)) rows.push(row('Radar ADS-B', 'adsb.lol'));
  return rows;
}

// Categorías de la ficha (#adv-flight). open: Set de data-card abiertos, para conservarlos al repintar.
export function advancedFlightHtml(card, { open = new Set(), nowMs = Date.now() } = {}) {
  const cats = [
    ['adv-aircraft', 'Datos del avión', 'plane', aircraftRows(card)],
    ['adv-adsb', 'Datos ADS-B', 'signal', adsbRows(card, nowMs)],
    ['adv-codeshare', 'Códigos compartidos', 'route', codeshareRows(card)],
    ['adv-tech', 'Información técnica', 'info', techRows(card)],
    ['adv-sources', 'Fuentes utilizadas', 'sources', sourceRows(card)],
  ];
  return cats.filter(([, , , rows]) => rows.length).map(([key, title, ic, rows]) => category(key, title, ic, rows.join(''), open)).join('');
}

// Historial: solo marcas de tiempo que ya existen (consulta, Aena) y la tendencia del pronóstico; no hay registro nuevo.
export function advancedHistoryHtml({ queriedAt, aenaUpdatedAgo, trend } = {}, nowMs = Date.now(), { open = new Set() } = {}) {
  const rows = [];
  if (Number.isFinite(queriedAt)) rows.push(row('Consulta realizada', agoText(nowMs - queriedAt)));
  if (aenaUpdatedAgo) rows.push(row('Última actualización de Aena', esc(aenaUpdatedAgo)));
  if (trend) rows.push(`<p class="adv-note">${esc(trend)}</p>`);
  return rows.length ? category('adv-history', 'Historial de actualizaciones', 'clock', rows.join(''), open) : '';
}

// Armazón de la tarjeta, cerrada salvo que `open` diga lo contrario. Los huecos los rellenan app.js (#adv-flight,
// #adv-history) y forecastExtras (#aviation, #fresh). «El tiempo en los aeropuertos» es una categoría fija con su hueco:
// nace oculta (hidden) y app.js la muestra cuando #aviation tiene contenido; #adv-sources acoge la frescura del
// pronóstico (se oculta por CSS mientras #fresh está vacío).
export function advancedShellHtml({ open = new Set() } = {}) {
  return `
    <details class="card adv" data-card="advanced"${isOpen(open, 'advanced')}>
      <summary class="card-sum"><div class="card-head"><h3 class="card-title">Detalles avanzados</h3>${icon('chevron', { size: 18 })}</div></summary>
      <div class="card-body adv-cats">
        <div id="adv-flight"></div>
        <details data-card="adv-weather"${isOpen(open, 'adv-weather')} hidden>
          <summary class="adv-sum">${icon('turbulence', { size: 18 })}<span class="adv-title">El tiempo en los aeropuertos</span>${icon('chevron', { size: 16 })}</summary>
          <div class="adv-body"><div id="aviation"></div></div>
        </details>
        <div id="adv-sources"><p id="fresh" class="fresh"></p></div>
        <div id="adv-history"></div>
      </div>
    </details>`;
}
