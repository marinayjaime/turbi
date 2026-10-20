// Pintado del pronóstico v2: la tarjeta de Turbulencias (resumen, gráfica de barras, avisos, confianza, tramos y
// altitudes), Aviation Weather y frescura.
import { esc, flightCardHtml, formatDuration, TURB_LEVELS, DISCLAIMER, turbCardHtml, turbPlainCardHtml, turbGeneralHtml,
  turbTimelineHtml, segListHtml } from './ui.js';
import { icon } from './icons.js';
import { roughestSpan, weatherAlerts, flightPhase } from './card-model.js';
import { mapCardHtml } from './map.js';
import { advancedShellHtml } from './ui-advanced.js';
import { CAUSE_LABELS } from './turbi-index.js';
import { NO_PIREPS } from './aviation-weather.js';
import { agoText } from './storage.js';
import { altitudeText, altitudeRange, localHour } from './plain.js';
import { punctualityHtml } from './ui-punctuality.js';

const LEVELS = TURB_LEVELS;
// dot: nivel del punto de color que sustituye al emoji de antes (verde = ligera, ámbar = moderada, rojo = fuerte).
const HEAD = {
  Tranquilo: { dot: 1, text: 'No se espera turbulencia relevante.' },
  'Mayormente tranquilo': { dot: 1, text: 'Como mucho algún tramo breve de movimiento.' },
  'Algo de movimiento': { dot: 2, text: 'Habrá algún tramo con meneo.' },
  Turbulento: { dot: 3, text: 'Se esperan tramos de turbulencia moderada o fuerte.' },
};
const CONF = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const AGREEMENT = { alta: 'coinciden bastante', media: 'coinciden en parte', baja: 'coinciden poco' };
const causeText = causes => causes.map(c => CAUSE_LABELS[c] ?? c).join(' · ');

// Altura en km y pies (nunca «FL»).
export const flText = (min, max) => altitudeRange(min, max);

function confidenceHtml(c) {
  return `
      <details class="explain conf">
        <summary>${c.level ? CONF[c.level] : 'Sin cálculo'} <span class="info">ⓘ</span></summary>
        <ul>${c.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        <p>Depende de cuánto falta para el vuelo, de si coinciden los dos modelos del tiempo que usa Turbi
        (el europeo, ECMWF, y el estadounidense, GFS), de si hay datos de toda la ruta y de si las distintas señales de turbulencia apuntan a lo mismo.
        No es un porcentaje de acierto.</p>
      </details>`;
}

// Datos del cuerpo de la tarjeta: confianza del pronóstico con sus motivos, máximo, duración y momentos, y el reparto
// por niveles. El titular («General») y la cobertura incompleta van en el summary, visibles sin desplegar.
export function summaryHtml(view) {
  const s = view.summary;
  const facts = [['Máximo previsto', s.maxLevel > 0 ? `Turbulencia ${LEVELS[s.maxLevel].toLowerCase()}` : 'Sin turbulencia prevista']];
  if (s.maxLevel > 0) {
    facts.push(['Duración estimada', `≈ ${Math.max(5, Math.round(s.maxDurationMin / 5) * 5)} min`]);
    const shown = s.moments.slice(0, 2).map(m => `${m.startMin}–${m.endMin}`).join(' y ');
    const more = s.moments.length - 2;
    facts.push(['Momento', `aprox. ${shown} min después del despegue${more > 0 ? `, y ${more} ${more === 1 ? 'tramo' : 'tramos'} más` : ''}`]);
  }
  const bar = s.percentages.map((p, l) => (p ? `<span class="lvl${l}" style="flex:${p}"></span>` : '')).join('');
  return `
        <dl class="facts">
          <div class="conf-row"><dt>Confianza</dt><dd>${confidenceHtml(view.confidence)}</dd></div>
          ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        <div class="shares">
          <div class="sharebar">${bar}</div>
          <ul>${s.percentages.map((p, l) => `<li><span class="dot lvl${l}"></span>${LEVELS[l]} ${p} %</li>`).join('')}</ul>
        </div>`;
}

// Cobertura incompleta: afecta a la fiabilidad, así que se ve sin desplegar (condición 2 de Jaime, §10 bis).
function coverageHtml(view) {
  if (view.coverage === undefined || view.coverage >= 0.95) return '';
  return `
        <p class="note-small coverage">Faltan datos en el ${Math.max(5, Math.round(((1 - view.coverage) * 100) / 5) * 5)} % de la ruta: esos tramos (rayados en la gráfica) se muestran como nulos y podrían no serlo.</p>`;
}

// Contenido de #timeline (gráfica, eje y #seg-detail): app.js lo repinta tras nameSegments.
export const timelineHtml = view => turbTimelineHtml(view);

// Tramos con turbulencia, con causa, altura y lugar (#segments, en el cuerpo): app.js lo repinta tras nameSegments.
export function segmentListHtml(view) {
  return segListHtml(view.segments.filter(s => s.level > 0).map(s => ({
    level: s.level, title: `Min ${s.startMin}–${s.endMin} · ${LEVELS[s.level]}`,
    detail: `${esc(causeText(s.causes))} · ${esc(flText(s.flMin, s.flMax))}${s.place ? ` · ${esc(s.place)}` : ''}`,
  })));
}

// Avisos meteorológicos en una línea compacta (§10 bis.1): solo lo que ya devuelven sigmetsNearRoute y
// pirepsNearRoute (weatherAlerts). Ámbar si algún SIGMET cruza la ruta. «Ver detalles» abre «El tiempo en los
// aeropuertos» de Detalles avanzados (data-open, Tarea 8). Sin avisos o sin datos (null), nada.
export function weatherAlertsHtml(aviation) {
  const alerts = weatherAlerts(aviation);
  if (!alerts.length) return '';
  return `
        <div class="wx-alerts">${alerts.map(a => `
          <p class="wx-alert tone-${a.crosses ? 'warn' : 'neutral'}">${icon('alert', { size: 16 })}<span>${esc(a.text)}${a.label ? ` · ${esc(a.label)}` : ''}</span></p>`).join('')}
          <button type="button" class="wx-more" data-open="adv-weather">Ver detalles</button>
        </div>`;
}

export function segmentDetailHtml(seg, originIata) {
  const place = seg.place ?? `a ${Math.round(seg.mid.kmFromOrigin)} km de ${originIata}`;
  const rows = [];
  if (seg.level > 0) rows.push(['Causa probable', causeText(seg.causes) || 'Varias señales débiles a la vez']);
  rows.push(['Altura del avión', flText(seg.flMin, seg.flMax)]);
  rows.push(['Ubicación aproximada', place]);
  return `
    <p class="seg-title"><span class="dot lvl${seg.level}"></span><strong>Min ${seg.startMin}–${seg.endMin}</strong> · ${LEVELS[seg.level]}</p>
    <dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${seg.missing ? '<p class="note-small">En este tramo faltan datos de algún modelo: tómalo con más cautela.</p>' : ''}`;
}

export function altitudeHtml(rows) {
  if (!rows?.length) return '';
  const share = r => (r.worst === null ? '—' : r.worst === 0 ? '0 %' : `${Math.max(10, Math.round((r.share * 100) / 10) * 10)} %`);
  return `
    <h3 class="section">Condiciones por altitud</h3>
    <ul class="alt-table">
      <li class="head"><span>Altura</span><span></span><span>Turbulencia</span><span class="share">% del trayecto</span></li>${rows.map(r => `
      <li${r.calmest ? ' class="calm"' : ''}>
        <span class="fl">${esc(altitudeText(r.flightLevel).split(' (')[0])}</span>
        <span class="dot lvl${r.worst ?? 0}"></span>
        <span class="lvl">${r.worst === null ? '—' : LEVELS[r.worst]}</span>
        <span class="share">${share(r)}</span>
        ${r.calmest || r.isCruise ? `<span class="tags">${r.calmest ? '<span class="tag">Más tranquila</span>' : ''}${r.isCruise ? '<span class="tag muted">altura prevista de tu vuelo</span>' : ''}</span>` : ''}
      </li>`).join('')}
    </ul>
    <p class="note-small">Cómo se prevé el aire a distintas alturas por las que vuelan los aviones comerciales, en la parte central del viaje.
    La altitud real del vuelo depende del plan de vuelo, tráfico, control aéreo, peso y condiciones operativas.</p>`;
}

export function freshnessHtml(view, nowMs, timeZone = undefined) {
  const parts = [`Consulta realizada ${agoText(nowMs - view.queriedAt)}`];
  const runs = Object.entries(view.runs ?? {});
  const NAMES = { ECMWF: 'europeo', GFS: 'estadounidense' };
  if (runs.length) parts.push(`Previsión del tiempo calculada ${runs.map(([m, t]) => `a las ${localHour(t, timeZone)} (modelo ${NAMES[m] ?? m})`).join(' y ')}`);
  parts.push(view.models.length > 1
    ? `Los dos modelos ${AGREEMENT[view.agreement?.level] ?? 'no se han podido comparar'}`
    : `Solo se ha podido consultar el modelo ${{ ECMWF: 'europeo (ECMWF)', GFS: 'estadounidense (GFS)' }[view.models[0]] ?? view.models[0]}`);
  return parts.map(esc).join(' · ');
}

function metarLine(a) {
  if (a.metarText) return `${a.metarText}${a.metarAge ? ` (${a.metarAge})` : ''}`;
  return a.metarStale ? 'El último parte tiene más de 3 h: no se muestra.' : 'Sin parte meteorológico disponible';
}

function airportBlock(label, a) {
  const taf = a.tafText ? `<ul>${a.tafText.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p>Sin previsión disponible</p>';
  const raw = (name, text) => (text ? `<details class="raw"><summary>${name}</summary><code>${esc(text)}</code></details>` : '');
  return `
      <div class="apt">
        <p class="apt-title">${label} · ${esc(a.icao ?? a.iata)}</p>
        <p class="apt-label">Ahora</p><p>${esc(metarLine(a))}</p>${raw('Ver parte oficial (METAR)', a.metarRaw)}
        <p class="apt-label">Previsión en el aeropuerto</p>${taf}${raw('Ver previsión oficial (TAF)', a.tafRaw)}
      </div>`;
}

export function aviationHtml(av, nowMs = Date.now()) {
  if (!av) return '';
  const sig = av.sigmets === null ? '<p>Avisos oficiales no disponibles ahora.</p>' : av.sigmets.length ? `<ul>${av.sigmets.map(s => `<li><strong>${esc(s.label)}</strong>${s.levels ? ` · ${esc(s.levels)}` : ''} · ${s.crosses ? 'cruza la ruta' : `a ${s.distanceKm} km de la ruta`}
        <details class="raw"><summary>Ver aviso oficial (SIGMET)</summary><code>${esc(s.raw)}</code></details></li>`).join('')}</ul>`
    : '<p>Ningún aviso oficial de turbulencia, tormentas o viento sobre montañas cerca de la ruta.</p>';
  const pir = av.pireps === null ? '<p>Informes de pilotos no disponibles ahora.</p>' : av.pireps.length ? `<ul>${av.pireps.map(p => `<li><strong>${esc(p.label)}</strong>${p.altitude ? ` · a ${esc(p.altitude)}` : ''}
        <details class="raw"><summary>Ver informe original</summary><code>${esc(p.raw)}</code></details></li>`).join('')}</ul>`
    : `<p>${NO_PIREPS}</p>`;
  return `
    <h3 class="section">El tiempo en los aeropuertos y avisos</h3>
    ${airportBlock('Salida', av.origin)}${airportBlock('Llegada', av.destination)}
    <p class="apt-sub">Avisos oficiales en la ruta</p>${sig}
    <p class="apt-sub">Informes de otros pilotos</p>${pir}
    <p class="note-small">Los pilotos informan de turbulencias sobre todo en EE. UU. y el Atlántico Norte: que no haya informes no significa que no haya turbulencia.
    Fuente: Aviation Weather Center (NOAA)${av.updated ? `, descargado ${agoText(nowMs - Date.parse(av.updated))}` : ''}.</p>`;
}

export function offlineBanner(savedAt, nowMs) {
  return `<p class="offline">Pronóstico guardado · consultado ${agoText(nowMs - savedAt)}. Sin conexión: no se ha actualizado.</p>`;
}

const CAUSE_HELP = {
  clear_air: 'Cambios bruscos del viento en altura (índice de Ellrod), típicos cerca de la corriente en chorro. No hay nubes que la anuncien.',
  vertical_shear: 'Mucha diferencia de velocidad o dirección del viento entre dos alturas cercanas.',
  instability: 'Capa de aire poco estable, donde la cizalladura genera remolinos con más facilidad.',
  vertical_motion: 'Corrientes verticales fuertes previstas por el modelo.',
  convection: 'Nubes de desarrollo vertical. Afecta sobre todo al despegar y aterrizar.',
  thunderstorm: 'Tormentas previstas en la zona.',
  mountain_wave: 'Viento fuerte que cruza cordilleras (Pirineos, Alpes…) y ondula el aire.',
  jet_stream: 'Corriente de viento muy fuerte en altura; acompaña a menudo a la turbulencia en aire claro.',
};

export function explainHtml(current) {
  return `
      <details class="explain">
        <summary>¿Qué significa? <span class="info">ⓘ</span></summary>
        <h4>Resumen</h4>
        <ul>${Object.entries(HEAD).map(([k, v]) => `<li${k === current ? ' class="current"' : ''}><strong><span class="dot lvl${v.dot}"></span>${k}</strong><br>${v.text}</li>`).join('')}</ul>
        <h4>Intensidad</h4>
        <ul>
          <li><span class="dot lvl1"></span><strong>Ligera</strong> · Pequeños botes. Normalmente se puede caminar por la cabina.</li>
          <li><span class="dot lvl2"></span><strong>Moderada</strong> · Movimientos claros: suele encenderse la señal del cinturón y cuesta caminar.</li>
          <li><span class="dot lvl3"></span><strong>Fuerte</strong> · Movimientos bruscos; los objetos sueltos pueden moverse. Es poco frecuente.</li>
        </ul>
        <p>La turbulencia es habitual en la aviación comercial. Llevar el cinturón abrochado mientras estás sentado reduce mucho el riesgo de lesiones.</p>
        <h4>Causas</h4>
        <ul>${Object.entries(CAUSE_HELP).map(([k, t]) => `<li><strong>${CAUSE_LABELS[k]}</strong> · ${t}</li>`).join('')}</ul>
        <h4>Cómo se calcula</h4>
        <p>Turbi calcula a qué altura irá el avión en cada momento del vuelo y mira cómo estará el viento y la temperatura a esa altura
        (entre unos 7 y 13 km) según dos modelos del tiempo: el europeo (ECMWF) y el estadounidense (GFS). Con varias señales conocidas de turbulencia
        obtiene una puntuación interna de 0 a 100 que se traduce en nula, ligera, moderada o fuerte.
        Es una estimación propia, no la medida de turbulencia que usan las aerolíneas.</p>
      </details>`;
}

// La ficha del vuelo va primero y no depende de la meteorología: el pronóstico se pinta después en #forecast-area,
// y si Open-Meteo falla (429, red, modelos) solo esa sección lo dice. Un error meteorológico nunca sustituye la ficha.
// Cada estado de la sección es una tarjeta con el título «Turbulencias» (app-flow lo busca).
export const FORECAST_UNAVAILABLE = 'Previsión de turbulencias no disponible temporalmente';
// «Calculando…»: el texto y un esqueleto suave de la gráfica (decorativo).
export const forecastLoadingHtml = () => turbPlainCardHtml(`
      <p class="forecast-loading">Calculando la previsión de turbulencias…</p>
      <div class="tchart skeleton" aria-hidden="true"></div>`, 'turb-loading');
// La nota que sustituye al pronóstico (vuelo terminado, cancelado, sin llegada…): su texto tal cual, porque app.js lo
// compara con ENDED_ESTIMATED / NO_ARRIVAL_NOTE para sustituirlo.
export const forecastNoteHtml = note => turbPlainCardHtml(`<p class="note">${esc(note)}</p>`);

function headHtml(view, nowMs) {
  // La puntualidad va dentro del «Horario» de la ficha (#punctuality): aquí solo su contenido inicial (situación de hoy).
  // El título «Turbulencias» ya no va aquí: lo lleva la propia tarjeta, dentro de #forecast-area.
  const punctualityBody = view.punctuality ? punctualityHtml(view.punctuality) : '';
  const head = view.flight
    ? flightCardHtml(view.flight, { nowMs, punctualityBody })
    : `<div class="card query-head"><p class="route">${esc(view.title)}</p><p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p>${view.sourceInfo ? `<p class="note-small source-info">${esc(view.sourceInfo)}</p>` : ''}</div>`;
  return `
    <div class="summary">
      ${view.saved ? offlineBanner(view.saved, nowMs) : ''}
      ${head}
    </div>`;
}

// Bloques que siguen a #forecast-area, en su orden fijo (§9 bis): la tarjeta del mapa (título según la fase) y
// «Detalles avanzados». Nunca cambian de sitio: un vuelo que pasa de programado a en curso y a finalizado no recrea el
// nodo de Leaflet, y cuando una nota sustituye al pronóstico ni el mapa ni los detalles desaparecen.
const afterForecastHtml = (phase, { map = true } = {}) => `${map ? `
    ${mapCardHtml(phase)}` : ''}${advancedShellHtml()}`;

// Armazón que se pinta en cuanto se conoce el vuelo: ficha (Aena, horas, foto, estado, radar), puntualidad, la
// tarjeta de turbulencias aún calculando, el mapa y Detalles avanzados.
export function flightShellHtml({ flight, punctuality = null }) {
  return `${headHtml({ flight, punctuality })}
    <div id="forecast-area">${forecastLoadingHtml()}
    </div>${afterForecastHtml(flightPhase(flight))}`;
}

// Ficha con aviso (vuelo terminado, sin hora de llegada, cancelado, demasiado lejano…): no hay previsión que calcular,
// pero la tarjeta Turbulencias está siempre y dice por qué.
export function flightNoteHtml({ flight, punctuality = null, note }) {
  return `${headHtml({ flight, punctuality })}
    <div id="forecast-area">${forecastNoteHtml(note)}
    </div>${afterForecastHtml(flightPhase(flight))}`;
}

export function forecastUnavailableHtml(err) {
  const why = err?.rateLimited
    ? `Open-Meteo ha recibido demasiadas consultas.${err.retryAfterMs ? ` Puedes reintentar en unos ${Math.ceil(err.retryAfterMs / 1000)} s.` : ''}`
    : esc(err?.message ?? 'No se ha podido obtener.');
  return turbPlainCardHtml(`
      <div class="forecast-error">
        <p><strong>${FORECAST_UNAVAILABLE}</strong></p>
        <p class="note-small">${why}</p>
        <button type="button" id="forecast-retry" class="pill-btn">Reintentar</button>
      </div>`);
}

// Contenido de #forecast-area con pronóstico: la tarjeta de Turbulencias (§5.7) y, fuera de ella, el aviso legal.
// open: los data-card abiertos (los conserva el repintado). preLanding (§10.2): el pronóstico que ya estaba en pantalla
// cuando el vuelo aterriza, con su etiqueta. #fresh y #aviation viven en Detalles avanzados y #map en su tarjeta.
export function forecastSectionHtml(view, nowMs, { preLanding = false, open = new Set() } = {}) {
  const s = view.summary;
  const span = roughestSpan(view);
  const summary = `${turbGeneralHtml({ level: s.maxLevel, headline: s.headline, span: span?.text ?? null })}
        <section id="timeline">${timelineHtml(view)}</section>${coverageHtml(view)}
        <div id="wx-alerts">${weatherAlertsHtml(view.aviation)}</div>`;
  const head = HEAD[s.headline] ?? HEAD['Algo de movimiento'];
  const body = `
        <p class="turb-lead">${head.text}</p>${summaryHtml(view)}
        <p id="trend" class="trend"${view.trend ? '' : ' hidden'}>${esc(view.trend ?? '')}</p>
        <button type="button" id="speak" class="pill-btn speak" hidden>${icon('sound', { size: 16 })}Escuchar previsión</button>
        <section id="segments">${segmentListHtml(view)}</section>
        <section id="altitudes">${altitudeHtml(view.altitudes)}</section>
        <div class="pills">${explainHtml(s.headline)}</div>`;
  return `${turbCardHtml({ open, preLanding, summary, body })}
    ${DISCLAIMER}`;
}

// Todo junto (pronóstico guardado sin conexión y consultas manuales), con el mismo orden de bloques que la ficha.
// El guardado no lleva mapa: sin conexión no se pide nada a la red (ni Leaflet ni teselas), como antes.
export function renderForecast(el, view, nowMs) {
  el.innerHTML = `${headHtml(view, nowMs)}
    <div id="forecast-area">${forecastSectionHtml(view, nowMs)}</div>${
  afterForecastHtml(view.flight ? flightPhase(view.flight) : 'programado', { map: !view.saved })}`;
}

export { formatDuration };
