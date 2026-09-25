// Pintado del pronóstico v2: resumen, confianza, timeline interactiva, altitudes, Aviation Weather y frescura.
import { esc, flightCardHtml, formatDuration } from './ui.js';
import { CAUSE_LABELS } from './turbi-index.js';
import { NO_PIREPS } from './aviation-weather.js';
import { agoText } from './storage.js';
import { altitudeText, altitudeRange, localHour } from './plain.js';
import { punctualityHtml } from './ui-punctuality.js';

const LEVELS = ['Nula', 'Ligera', 'Moderada', 'Fuerte'];
const HEAD = {
  Tranquilo: { emoji: '🟢', text: 'No se espera turbulencia relevante.' },
  'Mayormente tranquilo': { emoji: '🟢', text: 'Como mucho algún tramo breve de movimiento.' },
  'Algo de movimiento': { emoji: '🟡', text: 'Habrá algún tramo con meneo.' },
  Turbulento: { emoji: '🔴', text: 'Se esperan tramos de turbulencia moderada o fuerte.' },
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

export function summaryHtml(view) {
  const s = view.summary;
  const head = HEAD[s.headline] ?? HEAD['Algo de movimiento'];
  const facts = [['Máximo previsto', s.maxLevel > 0 ? `Turbulencia ${LEVELS[s.maxLevel].toLowerCase()}` : 'Sin turbulencia prevista']];
  if (s.maxLevel > 0) {
    facts.push(['Duración estimada', `≈ ${Math.max(5, Math.round(s.maxDurationMin / 5) * 5)} min`]);
    const shown = s.moments.slice(0, 2).map(m => `${m.startMin}–${m.endMin}`).join(' y ');
    const more = s.moments.length - 2;
    facts.push(['Momento', `aprox. ${shown} min después del despegue${more > 0 ? `, y ${more} ${more === 1 ? 'tramo' : 'tramos'} más` : ''}`]);
  }
  const bar = s.percentages.map((p, l) => (p ? `<span class="lvl${l}" style="flex:${p}"></span>` : '')).join('');
  return `
    <div class="headline">
      <span class="emoji">${head.emoji}</span>
      <div><h2>${esc(s.headline)}</h2><p>${head.text}</p></div>
    </div>
    <dl class="facts">
      ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}
      <div class="conf-row"><dt>Confianza</dt><dd>${confidenceHtml(view.confidence)}</dd></div>
    </dl>
    ${view.coverage !== undefined && view.coverage < 0.95
      ? `<p class="note-small">Faltan datos en el ${Math.max(5, Math.round(((1 - view.coverage) * 100) / 5) * 5)} % de la ruta: esos tramos (rayados en la barra) se muestran como nulos y podrían no serlo.</p>`
      : ''}
    <div class="shares">
      <div class="sharebar">${bar}</div>
      <ul>${s.percentages.map((p, l) => `<li><span class="dot lvl${l}"></span>${LEVELS[l]} ${p} %</li>`).join('')}</ul>
    </div>`;
}

const ticks = d => { const step = d <= 90 ? 15 : d <= 240 ? 30 : 60; const t = []; for (let m = 0; m <= d; m += step) t.push(m); return t; };

export function timelineHtml(view) {
  const bar = view.segments.map((s, i) => `<button type="button" class="seg lvl${s.level}${s.missing ? ' missing' : ''}" data-seg="${i}"
      style="flex:${Math.max(s.endMin - s.startMin, 1)}" aria-label="Min ${s.startMin}–${s.endMin} · ${LEVELS[s.level]}"></button>`).join('');
  const bumpy = view.segments.filter(s => s.level > 0);
  const cards = bumpy.length ? bumpy.map(s => `
      <li class="card">
        <span class="dot lvl${s.level}"></span>
        <div>
          <strong>Min ${s.startMin}–${s.endMin} · ${LEVELS[s.level]}</strong>
          <p>${esc(causeText(s.causes))} · ${esc(flText(s.flMin, s.flMax))}${s.place ? ` · ${esc(s.place)}` : ''}</p>
        </div>
      </li>`).join('') : '<li class="card empty">Ningún tramo con turbulencia.</li>';
  return `
    <div class="timeline">
      <div class="bar">${bar}</div>
      <div class="ticks">${ticks(view.durationMin).map(m => `<span style="left:${(m / view.durationMin) * 100}%">${m}′</span>`).join('')}</div>
      <div class="ends"><span>Despegue</span><span>Toca un tramo</span><span>Aterrizaje</span></div>
    </div>
    <div id="seg-detail" class="seg-detail" hidden></div>
    <ul class="cards">${cards}</ul>`;
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
        <ul>${Object.entries(HEAD).map(([k, v]) => `<li${k === current ? ' class="current"' : ''}><strong>${v.emoji} ${k}</strong><br>${v.text}</li>`).join('')}</ul>
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
export const FORECAST_UNAVAILABLE = 'Previsión de turbulencias no disponible temporalmente';
const FORECAST_LOADING = '<p class="forecast-loading">Calculando la previsión de turbulencias…</p>';

function headHtml(view, nowMs) {
  const punct = view.punctuality ? `<section id="punctuality">${punctualityHtml(view.punctuality)}</section>` : '';
  const head = view.flight
    ? `${flightCardHtml(view.flight)}${punct}<h3 class="section">Turbulencias</h3>`
    : `<p class="route">${esc(view.title)}</p><p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p>`;
  return `
    <div class="summary">
      ${view.saved ? offlineBanner(view.saved, nowMs) : ''}
      ${head}
    </div>`;
}

// Armazón que se pinta en cuanto se conoce el vuelo: ficha (Aena, horas, foto, estado, radar), puntualidad y la
// sección de turbulencias aún calculando.
export function flightShellHtml({ flight, punctuality = null }) {
  return `${headHtml({ flight, punctuality })}
    <div id="forecast-area">
      ${FORECAST_LOADING}
    </div>`;
}

// Ficha con aviso (vuelo terminado, sin hora de llegada, cancelado, demasiado lejano…): no hay previsión que calcular,
// pero la sección Turbulencias está siempre y dice por qué.
export function flightNoteHtml({ flight, punctuality = null, note }) {
  return `${headHtml({ flight, punctuality })}
    <div id="forecast-area">
      <p class="note">${esc(note)}</p>
    </div>`;
}

export function forecastUnavailableHtml(err) {
  const why = err?.rateLimited
    ? `Open-Meteo ha recibido demasiadas consultas.${err.retryAfterMs ? ` Puedes reintentar en unos ${Math.ceil(err.retryAfterMs / 1000)} s.` : ''}`
    : esc(err?.message ?? 'No se ha podido obtener.');
  return `
      <div class="forecast-error">
        <p><strong>${FORECAST_UNAVAILABLE}</strong></p>
        <p class="note-small">${why}</p>
        <button type="button" id="forecast-retry" class="pill-btn">Reintentar</button>
      </div>`;
}

// Contenido de la sección de turbulencias (sin la ficha).
export function forecastSectionHtml(view, nowMs) {
  return `
    <div class="summary">
      ${summaryHtml(view)}
      <p id="trend" class="trend"${view.trend ? '' : ' hidden'}>${esc(view.trend ?? '')}</p>
      <div class="pills">${explainHtml(view.summary.headline)}<button type="button" id="speak" class="pill-btn" hidden>🔊 Escuchar previsión</button></div>
    </div>
    <section id="timeline">${timelineHtml(view)}</section>
    <section id="altitudes">${altitudeHtml(view.altitudes)}</section>
    <section id="aviation">${aviationHtml(view.aviation, nowMs)}</section>
    <div id="map" class="map" hidden></div>
    <p id="fresh" class="fresh">${freshnessHtml(view, nowMs)}</p>
    <p class="disclaimer">Estimación orientativa para pasajeros a partir de modelos meteorológicos públicos. No es información operacional ni de seguridad.</p>`;
}

// Todo junto (pronóstico guardado sin conexión y consultas manuales).
export function renderForecast(el, view, nowMs) {
  el.innerHTML = `${headHtml(view, nowMs)}
    <div id="forecast-area">${forecastSectionHtml(view, nowMs)}</div>`;
}

export { formatDuration };
