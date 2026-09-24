// Pintado del pronóstico v2: resumen, confianza, timeline interactiva, altitudes, Aviation Weather y frescura.
import { esc, flightCardHtml, formatDuration } from './ui.js';
import { CAUSE_LABELS } from './turbi-index.js';
import { NO_PIREPS } from './aviation-weather.js';
import { agoText } from './storage.js';

const LEVELS = ['Nula', 'Ligera', 'Moderada', 'Fuerte'];
const HEAD = {
  Tranquilo: { emoji: '🟢', text: 'No se espera turbulencia relevante.' },
  'Mayormente tranquilo': { emoji: '🟢', text: 'Como mucho algún tramo breve de movimiento.' },
  'Algo de movimiento': { emoji: '🟡', text: 'Habrá algún tramo con meneo.' },
  Turbulento: { emoji: '🔴', text: 'Se esperan tramos de turbulencia moderada o fuerte.' },
};
const CONF = { alta: 'Alta', media: 'Media', baja: 'Baja' };
const AGREEMENT = { alta: 'acuerdo alto', media: 'acuerdo medio', baja: 'acuerdo bajo' };
const utcHH = ms => `${String(new Date(ms).getUTCHours()).padStart(2, '0')} UTC`;
const pad3 = n => String(Math.round(n)).padStart(3, '0');
const causeText = causes => causes.map(c => CAUSE_LABELS[c] ?? c).join(' · ');

export function flText(min, max) {
  if (max === 0) return 'cerca del suelo';
  const a = min === 0 ? 'suelo' : `FL${pad3(min)}`;
  return min === max ? a : `${a}–FL${pad3(max)}`;
}

function confidenceHtml(c) {
  return `
      <details class="explain conf">
        <summary>${c.level ? CONF[c.level] : 'Sin cálculo'} <span class="info">ⓘ</span></summary>
        <ul>${c.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        <p>La confianza combina la antelación, el acuerdo entre dos modelos meteorológicos (ECMWF y GFS),
        la cobertura de datos a lo largo de la ruta y la coherencia de los indicadores. No es un porcentaje de acierto.</p>
      </details>`;
}

export function summaryHtml(view) {
  const s = view.summary;
  const head = HEAD[s.headline] ?? HEAD['Algo de movimiento'];
  const facts = [['Máximo previsto', s.maxLevel > 0 ? `Turbulencia ${LEVELS[s.maxLevel].toLowerCase()}` : 'Sin turbulencia prevista']];
  if (s.maxLevel > 0) {
    facts.push(['Duración estimada', `${s.maxDurationMin} min`]);
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
    <div class="shares">
      <div class="sharebar">${bar}</div>
      <ul>${s.percentages.map((p, l) => `<li><span class="dot lvl${l}"></span>${LEVELS[l]} ${p} %</li>`).join('')}</ul>
    </div>`;
}

const ticks = d => { const step = d <= 90 ? 15 : d <= 240 ? 30 : 60; const t = []; for (let m = 0; m <= d; m += step) t.push(m); return t; };

export function timelineHtml(view) {
  const bar = view.segments.map((s, i) => `<button type="button" class="seg lvl${s.level}" data-seg="${i}"
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
  if (seg.level > 0) rows.push(['Causa probable', causeText(seg.causes) || 'Varios indicadores débiles']);
  rows.push(['Altitud aproximada', flText(seg.flMin, seg.flMax)]);
  rows.push(['Ubicación aproximada', place]);
  return `
    <p class="seg-title"><span class="dot lvl${seg.level}"></span><strong>Min ${seg.startMin}–${seg.endMin}</strong> · ${LEVELS[seg.level]}</p>
    <dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    ${seg.missing ? '<p class="note-small">En este tramo faltan datos de algún modelo: tómalo con más cautela.</p>' : ''}`;
}

export function altitudeHtml(rows) {
  if (!rows?.length) return '';
  const share = r => (r.worst === null ? 'sin datos' : r.worst === 0 ? 'sin turbulencia prevista'
    : `en el ${Math.max(10, Math.round((r.share * 100) / 10) * 10)} % del crucero`);
  return `
    <h3 class="section">Condiciones por altitud</h3>
    <ul class="alt-table">${rows.map(r => `
      <li${r.calmest ? ' class="calm"' : ''}>
        <span class="fl">FL${r.flightLevel}</span>
        <span class="dot lvl${r.worst ?? 0}"></span>
        <span class="lvl">${r.worst === null ? '—' : LEVELS[r.worst]}</span>
        <span class="share">${share(r)}</span>
        ${r.calmest ? '<span class="tag">Más tranquila</span>' : ''}${r.isCruise ? '<span class="tag muted">crucero estimado</span>' : ''}
      </li>`).join('')}
    </ul>
    <p class="note-small">Condiciones atmosféricas previstas en cada nivel durante el crucero.
    La altitud real del vuelo depende del plan de vuelo, tráfico, control aéreo, peso y condiciones operativas.</p>`;
}

export function freshnessHtml(view, nowMs) {
  const parts = [`Consulta realizada ${agoText(nowMs - view.queriedAt)}`];
  const runs = Object.entries(view.runs ?? {});
  if (runs.length) parts.push(`Ejecución del modelo: ${runs.map(([m, t]) => `${m} ${utcHH(t)}`).join(' · ')}`);
  parts.push(view.models.length > 1
    ? `Modelos: ${view.models.join(' y ')} (${AGREEMENT[view.agreement?.level] ?? 'acuerdo no disponible'})`
    : `Modelo: ${view.models[0]}`);
  return parts.map(esc).join(' · ');
}

function airportBlock(label, a) {
  const taf = a.tafText ? `<ul>${a.tafText.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p>Sin TAF disponible</p>';
  const raw = (name, text) => (text ? `<details class="raw"><summary>${name} original</summary><code>${esc(text)}</code></details>` : '');
  return `
      <div class="apt">
        <p class="apt-title">${label} · ${esc(a.icao ?? a.iata)}</p>
        <p>${esc(a.metarText ?? 'Sin METAR disponible')}</p>${raw('METAR', a.metarRaw)}
        <p class="apt-sub">Previsión (TAF)</p>${taf}${raw('TAF', a.tafRaw)}
      </div>`;
}

export function aviationHtml(av) {
  if (!av) return '';
  const sig = av.sigmets.length ? `<ul>${av.sigmets.map(s => `<li><strong>${esc(s.label)}</strong>${s.levels ? ` · ${esc(s.levels)}` : ''} · ${s.crosses ? 'cruza la ruta' : `a ${s.distanceKm} km de la ruta`}
        <details class="raw"><summary>SIGMET original</summary><code>${esc(s.raw)}</code></details></li>`).join('')}</ul>`
    : '<p>Ningún SIGMET de turbulencia, tormentas u onda de montaña cerca de la ruta.</p>';
  const pir = av.pireps.length ? `<ul>${av.pireps.map(p => `<li><strong>${esc(p.label)}</strong>${p.fl ? ` · FL${pad3(p.fl)}` : ''}
        <details class="raw"><summary>Informe original</summary><code>${esc(p.raw)}</code></details></li>`).join('')}</ul>`
    : `<p>${NO_PIREPS}</p>`;
  return `
    <h3 class="section">Meteorología aeronáutica</h3>
    ${airportBlock('Salida', av.origin)}${airportBlock('Llegada', av.destination)}
    <p class="apt-sub">SIGMET cerca de la ruta</p>${sig}
    <p class="apt-sub">Informes de pilotos (PIREP)</p>${pir}
    <p class="note-small">Los PIREP cubren sobre todo EE. UU. y el Atlántico Norte: que no haya informes no significa que no haya turbulencia.
    Fuente: Aviation Weather Center (NOAA)${av.updated ? `, descargado a las ${utcHH(Date.parse(av.updated))}` : ''}.</p>`;
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
        <p>Turbi estima la altitud del avión en cada momento y analiza el viento y la temperatura previstos por ECMWF y GFS en varias capas
        (aprox. FL240–FL440). Combina varios indicadores en un índice interno de 0 a 100 (Turbi Index) que se traduce en nula, ligera, moderada o fuerte.
        Es una estimación propia, no la medida de turbulencia que usan las aerolíneas.</p>
      </details>`;
}

export function renderForecast(el, view, nowMs) {
  const head = view.flight
    ? `${flightCardHtml(view.flight)}<h3 class="section">Turbulencias</h3>`
    : `<p class="route">${esc(view.title)}</p><p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p>`;
  el.innerHTML = `
    <div class="summary">
      ${view.saved ? offlineBanner(view.saved, nowMs) : ''}
      ${head}
      ${summaryHtml(view)}
      <p id="trend" class="trend"${view.trend ? '' : ' hidden'}>${esc(view.trend ?? '')}</p>
      <div class="pills">${explainHtml(view.summary.headline)}<button type="button" id="speak" class="pill-btn" hidden>🔊 Escuchar previsión</button></div>
    </div>
    <section id="timeline">${timelineHtml(view)}</section>
    <section id="altitudes">${altitudeHtml(view.altitudes)}</section>
    <section id="aviation">${aviationHtml(view.aviation)}</section>
    <div id="map" class="map" hidden></div>
    <p id="fresh" class="fresh">${freshnessHtml(view, nowMs)}</p>
    <p class="disclaimer">Estimación orientativa para pasajeros a partir de modelos meteorológicos públicos. No es información operacional ni de seguridad.</p>`;
}

export { formatDuration };
