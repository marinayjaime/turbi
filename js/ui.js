import { LEVELS, CAUSES } from './turbulence.js';
import { icon } from './icons.js';
import { flightPhase, mainTime, summaryTiles, milestones, signalState, formatCountdown, turbulenceBars, AIRBORNE_LABEL, monoNow, mapPhase, hasDeparted } from './card-model.js';
import { formatLocal } from './time.js';

// dot: el punto de color que sustituye al emoji de antes (verde, ámbar, rojo = ligera, moderada, fuerte).
const VERDICTS = {
  tranquilo: { dot: 1, title: 'Tranquilo', text: 'No se espera turbulencia relevante.' },
  movimiento: { dot: 2, title: 'Algo de movimiento', text: 'Habrá algún tramo con meneo.' },
  turbulento: { dot: 3, title: 'Turbulento', text: 'Se esperan tramos de turbulencia moderada o fuerte.' },
};
const cap = s => s[0].toUpperCase() + s.slice(1);

export const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function timeTicks(durationMin) {
  const step = durationMin <= 90 ? 15 : durationMin <= 240 ? 30 : 60;
  const out = [];
  for (let m = 0; m <= durationMin; m += step) out.push(m);
  return out;
}

export function formatDuration(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h && m ? `${h}h ${m}min` : h ? `${h}h` : `${m}min`;
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dateLabel = iso => DATE_FMT.format(new Date(`${iso}T12:00:00Z`)).replace('.', '');

// La fecha pedida no tiene ese vuelo: se dice (nunca se enseña otro día en su lugar) y se listan los días que sí tiene.
export function missingDateText(flight, requested, dates, today) {
  if (requested < today) {
    return `No hay datos del ${flight} del ${dateLabel(requested)}: Aena no publica vuelos pasados y Turbi solo guarda los que salieron ayer y hoy.`;
  }
  const upcoming = dates.filter(d => d >= today && d !== requested).slice(0, 5);
  const head = requested === today ? `Aena no tiene hoy el ${flight} (puede que hoy no opere).` : `Aena no tiene el ${flight} el ${dateLabel(requested)}.`;
  return upcoming.length ? `${head} Sí lo tiene: ${upcoming.map(dateLabel).join(' · ')}.` : head;
}

// Miles con punto (4.800), también con 4 cifras (Intl en español no lo pone).
export const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// ---- Ficha del vuelo (spec 2026-10-20 §5.1–5.6, §5.9–5.10) ----
// Solo presentación: qué hora, qué fase, qué fuente y qué confianza lo decide js/card-model.js con lo que ya trae el
// card. Regla general: un dato que no existe no se muestra (ni «—» ni valor por defecto); la única excepción son los
// hitos del Horario, que dicen «--:--» y «Pendiente».
const chevron = () => icon('chevron', { size: 18 });
export const kv = (k, v, attrs = '') => `<div class="kv"><span class="k">${k}</span><span class="v"${attrs}>${v}</span></div>`;
// Cabecera de un desplegable: título a la izquierda y chevron a la derecha (gira con CSS al abrirlo).
const head = (title, aside = '') => `<span class="card-head"><span class="card-title">${title}</span>${aside}${chevron()}</span>`;
const details = (key, cls, open, summary, body) => `
      <details class="card ${cls}" data-card="${key}"${open.has(key) ? ' open' : ''}>
        <summary class="card-sum">${summary}</summary>
        <div class="card-body">${body}</div>
      </details>`;

// Foto real de la aerolínea que opera el vuelo con ese modelo (Wikimedia Commons), con autor y licencia: la atribución
// es obligatoria por la licencia y se queda en el pie de la foto, tal cual.
function photoHtml(c) {
  const p = c.photo;
  if (!p?.thumb) return '';
  return `
      <figure class="plane-photo">
        <img src="${esc(p.thumb)}" alt="${esc(c.aircraft ?? '')}" onerror="this.closest('figure').remove()">
        ${p.artist || p.shared || p.representative ? `<figcaption>${p.representative ? 'Imagen representativa de la aerolínea · '
          : p.shared ? 'Vuelo con código compartido: Aena no indica qué aerolínea lo opera. ' : ''}${p.artist
          ? `Foto: <a href="${esc(p.page)}" target="_blank" rel="noopener">${esc(p.artist)}</a>, ${esc(p.license)}` : ''}</figcaption>` : ''}
      </figure>`;
}

// Texto visible del chip: solo presentación. Internamente Turbi sigue usando «Volando» (Aena FLY y withRadar) en su lógica,
// comparaciones y tests funcionales; en la nueva interfaz se lee «En vuelo».
const STATUS_LABEL = { Volando: 'En vuelo' };
export const statusLabel = text => STATUS_LABEL[text] ?? text;

// Chip del estado real (presentStatus / withRadar / withLanding) con su nota debajo. Un estado viejo («Embarcando» de
// hace 2 h) no se presenta como actual: chip gris con de cuándo es, y sin el avión animado (no se sabe si sigue volando).
function statusHtml(c) {
  if (c.stale) return `<span class="chip status tone-stale">${esc(statusLabel(c.status.text))} ${esc(c.updatedAgo)}</span>`;
  const fly = c.status.flying ? `<span class="fly" aria-hidden="true"><span class="fly-plane">${icon('plane', { size: 14 })}</span></span>` : '';
  return `<span class="chip status tone-${esc(c.status.tone)}${c.status.flying ? ' flying' : ''}">${esc(statusLabel(c.status.text))}${fly}</span>${
    c.status.note ? `\n          <p class="status-note">${esc(c.status.note)}</p>` : ''}`;
}

// Calm Score (js/calm-score.js) bajo el estado, discreto: «87/100» (el número grande, «/100» pequeño y gris) y «CALM
// SCORE» debajo; al tocarlo, qué significa. Color del número según la propia nota: alta (≥ 80) verde, intermedia (50–79)
// ámbar, baja (< 50) rojo suave; el valor va siempre en texto, el color solo lo refuerza. Solo
// con pronóstico (c.calm, que pone app.js) y mientras el vuelo no ha terminado: tras aterrizar, cancelar o desviarse la
// ficha ya no muestra el pronóstico. Color: el del titular del pronóstico (lvl-ink, como «General»), nunca el único dato.
const calmTone = s => (s >= 80 ? 'high' : s >= 50 ? 'mid' : 'low');
export function calmHtml(c, open = false) {
  const k = c.calm;
  if (!k || !Number.isFinite(k.score) || !['programado', 'en-curso'].includes(flightPhase(c))) return '';
  return `
          <details class="calm" data-card="calm"${open ? ' open' : ''}>
            <summary class="calm-sum calm-${calmTone(k.score)}"><span class="calm-num"><span class="calm-val">${k.score}</span><span class="calm-max" aria-hidden="true">/100</span><span class="sr-only"> de 100</span></span><span class="calm-label">Calm Score</span><span class="sr-only">, ver qué significa</span></summary>
            <p class="calm-info">Pronóstico de lo tranquilo que será el vuelo completo, de 0 a 100 (100 = lo más tranquilo). Resume la intensidad y la duración de la turbulencia prevista. No es una probabilidad ni una medición; la fiabilidad va aparte, en «Confianza».${c.calmSigmet ? `
              <span class="calm-sigmet">Hay un aviso oficial SIGMET que podría afectar al vuelo: esta puntuación resume los modelos meteorológicos y no incorpora ese aviso.</span>` : ''}</p>
          </details>`;
}

// Hero: foto (si la hay), número grande, «Aerolínea · Modelo» y el chip del estado. El logotipo solo se ve sin foto
// (CSS :has), así también aparece si la foto no carga y su figura se elimina.
function heroHtml(c, open = new Set(), { photo = true } = {}) {
  const sub = [c.airline, c.aircraft, c.operator && `Operado por ${c.operator}`].filter(Boolean).map(esc).join(' · ');
  return `
      <header class="hero">${photo ? photoHtml(c) : ''}
        <div class="hero-head">
          <div class="hero-id">
            <div class="hero-num">
              <h2>${esc(c.number ?? c.title)}</h2>
              <img class="logo" src="img/logos/${esc(c.al)}.png" alt="${esc(c.airline ?? '')}"
                onerror="if (!this.dataset.retry) { this.dataset.retry = 1; this.src = 'https://pics.avs.io/200/80/${esc(c.al)}.png'; } else this.remove();">
            </div>
            ${sub ? `<p class="hero-sub">${sub}</p>` : ''}
          </div>
          <div class="hero-status">
          ${statusHtml(c)}${calmHtml(c, open.has('calm'))}
          </div>
        </div>${c.stale ? `
        <p class="stale">${icon('alert', { size: 16 })}<span>Datos de Aena de ${esc(c.updatedAgo)}</span></p>` : ''}
      </header>`;
}

// Bloque origen → destino del hero: rejilla simétrica de 3 columnas (CSS: 1fr · auto · 1fr). Código IATA grande y la
// ciudad debajo (findAirport), con el mismo marcado a los dos lados; sin ciudad conocida, solo el código. En medio, el
// avión sobre una línea y debajo la duración prevista (card.duration), con «≈» si es un cálculo de Turbi
// (durationEstimated); sin duración, solo el avión. Lo visible es decorativo (aria-hidden): los lectores de pantalla
// leen una sola frase, «Origen X (ciudad) → Destino Y (ciudad)» y la duración.
function routeHtml(c) {
  const end = (side, code, city) => `<div class="rc rc-${side}" aria-hidden="true"><strong>${esc(code)}</strong>${city ? `
          <span>${esc(city)}</span>` : ''}
        </div>`;
  const dur = Number.isFinite(c.duration) ? formatCountdown(c.duration * 60000) : null;
  const said = (code, city) => `${code}${city ? ` (${city})` : ''}`;
  const spoken = `Origen ${said(c.o, c.cities?.o)} → Destino ${said(c.a, c.cities?.a)}${
    dur ? ` · duración ${c.durationEstimated ? 'estimada ' : ''}${dur}` : ''}`;
  return `
      <div class="route-codes">
        <p class="sr-only">${esc(spoken)}</p>
        ${end('from', c.o, c.cities?.o)}
        <div class="rc-mid" aria-hidden="true"><span class="rc-arrow" aria-hidden="true">${icon('plane', { size: 22 })}</span>${dur ? `
          <span class="rc-dur">${c.durationEstimated ? '≈ ' : ''}${esc(dur)}</span>` : ''}</div>
        ${end('to', c.a, c.cities?.a)}
      </div>`;
}

// Hora principal (mainTime): la hora que ya muestra la ficha en el lado que toca por la fase. La estimación propia de
// Turbi va en azul (no es un dato oficial); su nota, en pequeño. A la derecha, la cuenta atrás o la duración.
function mainTimeHtml(c, t) {
  if (!t) return '';
  const side = t.label.startsWith('Salida') ? c.dep : c.arr;
  return `
      <div class="main-time">
        <div class="mt-main">
          <span class="mt-time${side?.estimated ? ' turbi' : ''}">${esc(t.time)}${t.plusDay ? '<small>+1 día</small>' : ''}</span>
          <span class="mt-label">${esc(t.label)}</span>${t.note ? `
          <p class="mt-note">${esc(t.note)}</p>` : ''}
        </div>${t.aside ? `
        <div class="mt-aside">${kv(esc(t.aside.label), esc(t.aside.value))}</div>` : ''}
      </div>`;
}

// Fila de resumen (summaryTiles): la tarjeta sin dato no está y la fila se reparte entre las que quedan. El tono
// (banda de puntualidad o nivel de confianza) colorea solo el valor.
const TILE_ICONS = { punctuality: 'clock', source: 'sources', confidence: 'shield' };
function tilesHtml(c) {
  const tiles = summaryTiles(c);
  const row = tiles.map(t => `
        <div class="tile"${t.tone ? ` data-tone="${esc(t.tone)}"` : ''}>${icon(TILE_ICONS[t.key], { size: 18 })}${kv(esc(t.label), esc(t.value))}</div>`).join('');
  return `
      <div class="tiles">${row}
      </div>${tiles.some(t => t.limited) ? `
      <p class="limited">${icon('info', { size: 16 })}<span>La información puede ser limitada o proceder de fuentes no oficiales.</span></p>` : ''}`;
}

// Puerta de embarque: la lógica y los textos de siempre (zona de una letra, «Aún sin asignar», «Cambio de puerta»).
// Ni en el histórico ni en AeroDataBox (sourceNote), que no dan puerta.
function gateHtml(c) {
  if (!c.dep || c.past || c.sourceNote) return '';
  const zone = c.dep.gate && /^[A-Z]$/i.test(c.dep.gate);
  return `
          <div class="gate${c.dep.gate ? '' : ' pending'}">
            <span class="gate-k">Puerta de embarque</span>
            <span class="gate-v">${!c.dep.gate ? 'Aún sin asignar' : zone ? `Zona ${esc(c.dep.gate)}` : esc(c.dep.gate)}</span>
            ${c.gateChanged ? '<span class="tag warn">Cambio de puerta</span>' : ''}
            ${zone ? '<small>Por ahora solo se conoce la zona; la puerta exacta se anuncia más cerca de la salida.</small>' : ''}
          </div>`;
}

// Celda de telemetría: icono, etiqueta y valor (unidad en <small>); extra, una línea pequeña aparte (los metros).
const tmCell = (name, label, value, cls = '', extra = '', cellCls = '') => `
          <div class="tm-cell${cellCls}"><span class="tm-icon">${icon(name, { size: 18 })}</span>
            <span class="tm-label">${label}</span>
            <span class="tm-value${cls}">${value}</span>${extra}</div>`;

// «Ahora» con el radar viendo el avión: cuatro celdas (sin dato, sin celda) y el indicador de señal de signalState:
// verde mientras la distancia aún se mueve, ámbar después y, desde STALE_MIN, celdas atenuadas con su antigüedad.
// Sin instante de recepción no hay antigüedad: ni «Última señal» ni indicador. Al desplegar: indicativo, fuente
// (proveedor solo en el title) y cómo se identificó el avión.
// monoMs: el «ahora» del reloj monotónico, el de c.radarReceivedMono (la antigüedad nunca usa la hora del móvil).
function flyingNowHtml(c, r, monoMs, open) {
  const sig = signalState(r, c.radarReceivedMono, monoMs);
  const meters = Number.isFinite(r.altM) ? thousands(Math.round(r.altM / 100) * 100) : null;
  const alt = Number.isFinite(r.altFt)
    ? tmCell('altitude', 'Altitud', `${thousands(Math.round(r.altFt / 100) * 100)}<small>ft</small>`, '', meters ? `
            <small class="tm-sub">${meters} m</small>` : '')
    : meters ? tmCell('altitude', 'Altitud', `${meters}<small>m</small>`) : '';
  const cells = [
    alt,
    r.kmh ? tmCell('speed', 'Velocidad', `${esc(r.kmh)}<small>km/h</small>`) : '',
    // .tm-remaining: el contador de app.js reescribe su primer nodo (el número) cada segundo.
    Number.isFinite(r.remainingKm) ? tmCell('distance', 'Restante', `${thousands(r.remainingKm)}<small>km</small>`, ' tm-remaining') : '',
    // .tm-signal: el contador de señal de app.js reescribe su valor cada segundo (sin repintar la tarjeta).
    sig ? tmCell('signal', 'Última señal', esc(sig.text), '', '', ' tm-signal') : '',
  ].join('');
  const stale = sig?.level === 'stale';
  const summary = `${head('Ahora', signalHtml(sig))}
          <div class="tm-grid${stale ? ' is-stale' : ''}">${cells}
          </div>${stale ? tmOldHtml(sig) : ''}`;
  const body = `${r.callsign ? kv('Indicativo', esc(r.callsign)) : ''}${
    (r.source === 'fr24' ? kv('Fuente', 'Flightradar24', ' title="Datos de Flightradar24"')
      : kv('Fuente', 'Radar ADS-B', ` title="Datos ADS-B de ${esc(r.source ?? 'adsb.lol')}"`))}${
    r.match === 'ruta' ? '\n          <p class="tm-match">Avión localizado por su ruta, posición y modelo: la aerolínea emite con otro indicativo.</p>' : ''}${
    r.aircraftChanged ? '\n          <p class="tm-match">Avión localizado por su indicativo: no es el que AeroDataBox tenía asignado a este vuelo.</p>' : ''}`;
  return details('now', `now telemetry${stale ? ' aged' : ''}`, open, summary, body);
}

// Indicador de señal (verde mientras la distancia aún se mueve, ámbar después) y la línea «Datos del radar de hace X»
// desde STALE_MIN. Exportados para el contador de señal de app.js, que los repinta en su sitio cada segundo con el
// mismo HTML que la tarjeta (sin peticiones ni repintar el resto). Sin señal (sig null), nada.
export function signalHtml(sig) {
  if (!sig) return '';
  const live = sig.level === 'live';
  return `<span class="signal" data-signal-level="${sig.level}"><span class="dot tone-${live ? 'ok' : 'warn'}"></span>${
    live ? 'Señal radar reciente' : 'Sin señal reciente'}</span>`;
}
export const tmOldHtml = sig => `
          <p class="tm-old">Datos del radar de hace ${esc(sig.text)}</p>`;

// Mensaje corto del radar cuando no hay telemetría (mismos textos de siempre). null: el radar no dice nada.
function radarLineHtml(r) {
  const line = (tone, text) => `
          <p class="radar muted"><span class="dot tone-${tone}"></span>${text}</p>`;
  if (r?.state === 'reciente') {
    const ago = !Number.isFinite(r.ageMin) ? null : r.ageMin < 1 ? 'menos de 1 min' : `${r.ageMin} min`;
    return `
          <p class="radar-recent"><span class="chip tone-warn">${ago ? `Última señal · hace ${esc(ago)}` : 'Sin señal reciente'}</span></p>`;
  }
  if (r?.state === 'localizando') return line('info pulse', 'Buscando el avión en el radar…');
  if (r?.state === 'sin-senal' || r?.state === 'sin-datos') {
    return line('stale', r.source === 'fr24' ? 'Sin señal reciente del radar para este vuelo.' : 'Sin señal ADS-B reciente para este vuelo.');
  }
  if (r?.state === 'no-disponible') return line('stale', 'El radar no responde ahora mismo.');
  return null;
}

// «Ahora» (§5.5): telemetría con el radar «volando»; si no, el mensaje del radar o, sin radar, el estado operativo y
// la terminal; y la puerta. No existe en un vuelo finalizado o cancelado. Con datos de Aena antiguos no hay
// telemetría (no se mezcla un radar actual con un estado viejo).
function nowHtml(c, phase, monoMs, open) {
  if (phase === 'finalizado' || phase === 'cancelado') return '';
  const r = c.stale ? null : c.radar;
  if (r?.state === 'volando') return flyingNowHtml(c, r, monoMs, open);
  const radarLine = radarLineHtml(r);
  const ground = radarLine ?? `
          <div class="now-ground">${icon('clock')}
            <div><p class="now-title">${esc(c.status.text)}${c.stale ? ` <small>${esc(c.updatedAgo)}</small>` : ''}</p>${
  c.dep?.terminal ? `<p class="now-meta">Terminal ${esc(c.dep.terminal)}</p>` : ''}</div>
          </div>`;
  const aena = !['aerodatabox', 'fr24'].includes(c.source);
  const body = `${kv('Fuente', aena ? 'Aena' : c.source === 'fr24' ? 'Flightradar24' : 'AeroDataBox')}${aena && c.updatedAgo ? kv('Actualizado', esc(c.updatedAgo)) : ''}`;
  return details('now', 'now', open, `${head('Ahora')}${ground}${gateHtml(c)}`, body);
}

// «Horario» (§5.6): cuatro hitos (milestones) con su color por tipo, los avisos de Aena visibles sin desplegar y el
// pie de siempre (de dónde salen las horas). En el cuerpo, #punctuality: lo rellena app.js (situación de hoy al pintar
// y el historial cuando llega).
const SIDES = { 'dep-sched': 'Salida', 'dep-real': 'Salida', 'arr-sched': 'Llegada', 'arr-best': 'Llegada' };
function scheduleHtml(c, mt, open, punctualityBody) {
  const nextDay = Boolean(c.dep && c.arr && c.arr.date > c.dep.date);
  // La terminal de llegada (Aena), en pequeño bajo el último hito: la de salida ya va en «Ahora».
  const arrTerminal = c.arr?.terminal ? ` <span class="ms-term">Terminal ${esc(c.arr.terminal)}</span>` : '';
  const items = milestones(c).map(m => `
            <li class="ms ms-${m.kind}"><span class="ms-dot"></span> <span class="ms-time">${esc(m.time)}${
  nextDay && m.kind !== 'pending' && m.key.startsWith('arr') ? '<small>+1</small>' : ''}</span> <span class="ms-cap">${
  esc(m.caption)}</span> <span class="ms-side">${SIDES[m.key]}</span>${m.key === 'arr-best' ? arrTerminal : ''}</li>`).join('');
  // Nota de una hora estimada por Turbi, si la hora principal no la dice ya.
  const notes = [c.dep, c.arr].filter(s => s?.estimated && s.note && s.note !== mt?.note)
    .map(s => `\n          <p class="ms-note">${esc(s.note)}</p>`).join('');
  const p = c.punctuality;
  const alerts = [
    p?.dep?.alt && `Aena publica también otra hora de salida: ${p.dep.alt.map(esc).join(', ')}.`,
    p?.arr?.alt && `Aena publica también otra hora de llegada: ${p.arr.alt.map(esc).join(', ')}.`,
    // Solo si NADA indica que haya salido (Aena sin estado de salida no basta: el radar o lo ya visto lo desmienten).
    p?.arr?.beforeTakeoff && p.arr.time && !hasDeparted(c) && 'El avión aún no ha despegado: la llegada de Aena puede cambiar.',
  ].filter(Boolean).map(t => `\n          <p class="ms-alert">${icon('alert', { size: 16 })}<span>${t}</span></p>`).join('');
  const foot = c.past ? (c.arr?.estimated ? 'Hora de salida publicada por Aena y guardada por Turbi; la llegada es una estimación de Turbi.'
    : c.dep?.estimated ? 'Hora de llegada publicada por Aena y guardada por Turbi; la salida es una estimación de Turbi.'
    : 'Horas finales publicadas por Aena y guardadas por Turbi.')
    : c.sourceNote ? esc(c.sourceNote) // vuelos sin Aena (AeroDataBox): de dónde es el horario
    : c.updatedAgo ? `Datos actualizados ${esc(c.updatedAgo)}` : '';
  const summary = `${head('Horario')}
          <ol class="milestones">${items}
          </ol>${notes}${alerts}${foot ? `\n          <p class="foot">${foot}</p>` : ''}`;
  return details('schedule', 'schedule', open, summary, `<section id="punctuality">${punctualityBody}</section>`);
}

// «Avión» (§5.9, antes de salir): miniatura, modelo y aerolínea; matrícula y transpondedor solo si existen
// (AeroDataBox). No hay antigüedad del avión. Sin nada que desplegar, tarjeta fija.
function aircraftHtml(c, open) {
  const thumb = c.photo?.thumb;
  if (!c.aircraft && !thumb && !c.aircraftReg) return '';
  const row = `
          <div class="ac-row">${thumb ? `
            <img class="ac-thumb" src="${esc(thumb)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
            <div class="ac-id">${c.aircraft ? `<p class="ac-model">${esc(c.aircraft)}</p>` : ''}${c.airline ? `<p class="ac-airline">${esc(c.airline)}</p>` : ''}</div>${
  c.aircraftReg ? `\n            ${kv('Matrícula', esc(c.aircraftReg))}` : ''}
          </div>`;
  const body = `${c.aircraftHex ? kv('Transpondedor', esc(String(c.aircraftHex).toUpperCase())) : ''}${
    c.operator ? kv('Operado por', esc(c.operator)) : ''}`;
  if (!body) return `
      <section class="card aircraft" data-card="aircraft">
        <h3 class="card-head">Avión</h3>${row}
      </section>`;
  return details('aircraft', 'aircraft', open, `${head('Avión')}${row}`, body);
}

// «Resumen del vuelo» (§5.10, finalizado): solo lo que Turbi ya tiene. Distancia en ruta directa (no es la volada);
// con salida y llegada reales, la duración: de bloque en Aena y, con las horas de pista de AeroDataBox, el tiempo en
// el aire. Nada estimado ni consumos, salvo «Turbulencias estimadas»: el último pronóstico que Turbi calculó ANTES del
// aterrizaje (c.turbEstimate, js/turb-memory.js), dicho siempre como previsión, nunca como turbulencia observada.
function flightSummaryHtml(c) {
  const real = c.depFinal && c.arrFinal ? formatCountdown(c.arrMs - c.depMs) : null;
  const items = [
    Number.isFinite(c.km) && ['distance', 'Distancia en ruta directa', esc(`${thousands(Math.round(c.km))} km`)],
    real && ['clock', ['aerodatabox', 'fr24'].includes(c.source) ? AIRBORNE_LABEL : 'Duración real', esc(real)],
    c.turbEstimate && ['turbulence', 'Turbulencias estimadas', turbEstimateHtml(c.turbEstimate)],
  ].filter(Boolean);
  if (!items.length) return '';
  return `
      <section class="card flight-summary" data-card="flight-summary">
        <h3 class="card-head">Resumen del vuelo</h3>
        <div class="fs-grid">${items.map(([name, k, v]) => `
          <div class="fs-item"${name === 'turbulence' ? ' data-fs="turbulence"' : ''}>${icon(name, { size: 18 })}${kv(k, v)}</div>`).join('')}
        </div>
      </section>`;
}
// Titular y, debajo, el máximo estimado con la duración aproximada de ese nivel (el mismo redondeo que la tarjeta). En
// pasado: es lo que Turbi estimó para un vuelo ya terminado, no lo que el avión midió.
function turbEstimateHtml(t) {
  const mins = Number.isFinite(t.maxDurationMin) && t.maxDurationMin > 0 ? ` · ≈ ${Math.max(5, Math.round(t.maxDurationMin / 5) * 5)} min` : '';
  const line = t.maxLevel > 0 ? `Máximo estimado: ${TURB_LEVELS[t.maxLevel]}${mins}` : 'No se estimó turbulencia relevante';
  return `<span class="lvl-ink${t.maxLevel}">${esc(t.headline)}</span><span class="fs-sub">${esc(line)}</span>`;
}

// card: el de buildFlight (app.js), con los campos de presentación de js/card-model.js. open: qué data-card van
// abiertos (los conserva el repintado). punctualityBody: contenido inicial de #punctuality (situación de hoy).
// mapSlot: la ficha lleva el mapa del vuelo (js/app.js). En el aire o aterrizado (mapPhase), el vuelo y su mapa son lo
// principal: cabecera (número, aerolínea, estado y ruta) sin tarjeta, el hueco #map-slot (el mapa a todo el ancho, que
// js/app.js conserva entre repintados), debajo la hora principal y «Ahora» (altitud, velocidad, restante, señal) y
// después, como tarjetas secundarias, fuente/confianza con la foto, el Horario y el Resumen del vuelo. Antes de volar o
// cancelado, la ficha de siempre, sin mapa.
export function flightCardHtml(c, { nowMs = Date.now(), monoMs = monoNow(), open = new Set(), punctualityBody = '', mapSlot = false } = {}) {
  const phase = flightPhase(c);
  const mt = mainTime(c, nowMs);
  if (mapSlot && mapPhase(c)) {
    return `
    <section class="flight flight-live" data-phase="${phase}">
      <div class="live-top">${heroHtml(c, open, { photo: false })}${routeHtml(c)}
      </div>
      <div id="map-slot" class="map-slot"></div>
      <div class="live-data">${mainTimeHtml(c, mt)}${nowHtml(c, phase, monoMs, open)}
      </div>
      <div class="card flight-main live-more">${photoHtml(c)}${tilesHtml(c)}
      </div>${scheduleHtml(c, mt, open, punctualityBody)}${phase === 'finalizado' ? flightSummaryHtml(c) : ''}
    </section>`;
  }
  return `
    <section class="flight" data-phase="${phase}">
      <div class="card flight-main">${heroHtml(c, open)}${routeHtml(c)}${mainTimeHtml(c, mt)}${tilesHtml(c)}
      </div>${nowHtml(c, phase, monoMs, open)}${scheduleHtml(c, mt, open, punctualityBody)}${
  phase === 'programado' ? aircraftHtml(c, open) : ''}${phase === 'finalizado' ? flightSummaryHtml(c) : ''}
    </section>`;
}

// ---- Tarjeta de Turbulencias (spec 2026-10-20 §5.7 y §9 bis) ----
// La comparten el pronóstico v2 (js/ui-forecast.js) y el cálculo simplificado v1 (renderResult, más abajo): un
// <details> con lo esencial en el <summary> (título, «General», «Tramo más movido», la gráfica de barras y lo que afecta
// a la fiabilidad) y el detalle al desplegar. Vive aquí porque ui-forecast.js ya importa ui.js (al revés sería un ciclo).
export const TURB_LEVELS = ['Nula', 'Ligera', 'Moderada', 'Fuerte'];
export const DISCLAIMER = '<p class="disclaimer">Estimación orientativa para pasajeros a partir de modelos meteorológicos públicos. No es información operacional ni de seguridad.</p>';
const turbTitle = '<h3 class="section card-title">Turbulencias</h3>';

// La tarjeta desplegable. Solo antes del aterrizaje: con el vuelo terminado no se pinta (app.js, syncTurbArea).
export function turbCardHtml({ open = new Set(), summary, body }) {
  return `
    <details class="card turb" data-card="turbulence"${open.has('turbulence') ? ' open' : ''}>
      <summary class="card-sum">
        <div class="card-head">${turbTitle}${chevron()}</div>${summary}
      </summary>
      <div class="card-body">${body}
      </div>
    </details>`;
}

// Estados sin pronóstico (calculando, no disponible, la nota que lo sustituye): tarjeta fija con el mismo título. Sin
// data-card: no hay nada que desplegar ni pronóstico que conservar.
export const turbPlainCardHtml = (inner, cls = '') => `
    <section class="card turb turb-plain${cls ? ` ${cls}` : ''}">
      <h3 class="section card-head">Turbulencias</h3>${inner}
    </section>`;

// «General» (titular, coloreado por el nivel máximo) y, a la derecha, «Tramo más movido» si lo hay.
export function turbGeneralHtml({ level, headline, span = null }) {
  const lvl = Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0;
  return `
        <div class="turb-head">
          <div class="turb-general lvl-ink${lvl}">${icon('turbulence', { size: 24 })}${kv('General', esc(headline))}</div>${span ? `
          <div class="turb-span">${kv('Tramo más movido', esc(span))}</div>` : ''}
        </div>`;
}

// Barras: con view.route (pronóstico v2), turbulenceBars tal cual. Sin él (cálculo v1 o un pronóstico guardado antes
// de existir route), el mismo muestreo sobre un perfil de un punto por minuto hecho con los tramos; un tramo marcado
// sin datos (missing) queda sin nivel, como un punto del modelo no válido.
export function barsFor(view) {
  if (view.route?.length) return turbulenceBars(view);
  const segs = view.segments ?? [];
  const n = Math.max(1, Math.round(view.durationMin));
  const route = Array.from({ length: n + 1 }, (_, i) => {
    const m = (i * view.durationMin) / n;
    let s = segs[0];
    for (const x of segs) if (x.startMin <= m) s = x;
    return { level: s && !s.missing ? s.level : null };
  });
  return turbulenceBars({ ...view, route });
}

// Eje con 4 marcas: horas locales si origen y destino comparten zona (la regla de roughestSpan: Turbi no inventa una
// zona intermedia); si no, minutos desde el despegue. data-min: el minuto de cada marca, sea cual sea el texto.
function axisHtml(view) {
  const d = view.durationMin;
  const hours = view.originTz && view.originTz === view.destinationTz && Number.isFinite(view.depMs);
  const marks = [...new Set([0, Math.round(d / 15) * 5, Math.round((2 * d) / 15) * 5, Math.round(d)])].filter(m => m <= d);
  return `
        <div class="ticks">${marks.map(m => `<span data-min="${m}" style="left:${d ? (m / d) * 100 : 0}%">${
  hours ? formatLocal(view.depMs + m * 60000, view.originTz) : `${m}′`}</span>`).join('')}</div>`;
}

// Gráfica de barras verticales (#timeline): cada barra es un botón con el tramo que la contiene (data-seg; app.js abre
// su detalle en #seg-detail). Altura fija por nivel (el view no trae la puntuación 0–100 por punto); nula, la barra
// mínima; sin datos, rayada. interactive: false (cálculo v1, sin currentView en app.js, así que no hay detalle que
// abrir): barras como <span> decorativos, sin data-seg ni paradas de tabulación, y tocar la gráfica abre la tarjeta.
export function turbTimelineHtml(view, { interactive = true } = {}) {
  const segs = view.segments ?? [];
  const bars = barsFor(view).map(b => {
    const cls = `tbar ${b.level === null ? 'missing' : `lvl${b.level}`}`;
    if (!interactive) return `<span class="${cls}"></span>`;
    const s = segs[b.seg];
    const label = `${s ? `Min ${s.startMin}–${s.endMin} · ` : ''}${b.level === null ? 'Sin datos' : TURB_LEVELS[b.level]}`;
    return `<button type="button" class="${cls}" data-seg="${b.seg}" aria-label="${label}"></button>`;
  }).join('');
  if (!interactive) return `
        <div class="tchart" aria-hidden="true">${bars}</div>${axisHtml(view)}`;
  return `
        <div class="tchart" role="group" aria-label="Turbulencia a lo largo del vuelo">${bars}</div>${axisHtml(view)}
        <div id="seg-detail" class="seg-detail" hidden></div>`;
}

// Lista de tramos con turbulencia (cuerpo de la tarjeta). rows: [{ level, title, detail }].
export function segListHtml(rows) {
  const items = rows.length ? rows.map(r => `
          <li class="seg-card">
            <span class="dot lvl${r.level}"></span>
            <div>
              <strong>${r.title}</strong>
              <p>${r.detail}</p>
            </div>
          </li>`).join('') : '<li class="seg-card empty">Ningún tramo con turbulencia.</li>';
  return `<ul class="seg-list">${items}</ul>`;
}

const RELIABILITY = [
  { key: 'alta', label: 'Alta', when: 'Faltan menos de 24 h', text: 'El pronóstico a tan poco plazo suele acertar. Lo que ves es muy probable.' },
  { key: 'media', label: 'Media', when: 'Faltan de 1 a 3 días', text: 'Orientativo: las zonas de viento fuerte y las tormentas aún pueden moverse o cambiar.' },
  { key: 'baja', label: 'Baja', when: 'Faltan de 3 a 7 días', text: 'Solo una idea general. Vuelve a consultar más cerca del vuelo.' },
  { key: null, label: 'Sin cálculo', when: 'Más de 7 días', text: 'A esa distancia el pronóstico no sirve.' },
];

function reliabilityHtml(current) {
  const items = RELIABILITY.map(r => `
        <li${r.key === current ? ' class="current"' : ''}><strong>${r.label}</strong> · ${r.when}<br>${r.text}</li>`).join('');
  return `
      <details class="reliability">
        <summary>Fiabilidad ${esc(current)} <span class="info">ⓘ</span></summary>
        <p>Indica cuánto puedes fiarte del pronóstico de turbulencia. Depende de cuánto falta para el vuelo:
        cuanto más lejos, más puede cambiar el tiempo previsto (vientos en altura y tormentas).</p>
        <ul>${items}
        </ul>
      </details>`;
}

const VERDICT_HELP = {
  tranquilo: 'Como mucho algún bote suelto en menos del 10 % del vuelo.',
  movimiento: 'Tramos de turbulencia ligera, o moderada durante poco tiempo (15 min o menos).',
  turbulento: 'Turbulencia moderada durante más de 15 min, o algún tramo fuerte.',
};
const LEVEL_HELP = [
  null,
  ['Ligera', 'Pequeños botes. Normalmente se puede caminar por la cabina.'],
  ['Moderada', 'Movimientos claros: suele encenderse la señal del cinturón y cuesta caminar.'],
  ['Fuerte', 'Movimientos bruscos; los objetos sueltos pueden moverse. Es poco frecuente.'],
];
const CAUSE_HELP = {
  ellrod: 'Cambios bruscos del viento en altura, típicos cerca de la corriente en chorro. No hay nubes que la anuncien.',
  shear: 'Mucha diferencia de velocidad del viento entre dos alturas cercanas.',
  convection: 'Nubes de tormenta. Afecta sobre todo al despegar y aterrizar.',
  mountain: 'Viento fuerte que cruza cordilleras (Pirineos, Alpes…) y ondula el aire.',
};

function explainHtml(current) {
  const verdicts = Object.entries(VERDICTS).map(([key, v]) => `
          <li${key === current ? ' class="current"' : ''}><strong><span class="dot lvl${v.dot}"></span>${v.title}</strong><br>${VERDICT_HELP[key]}</li>`).join('');
  const levels = LEVEL_HELP.slice(1).map(([name, text], i) => `
          <li><span class="dot lvl${i + 1}"></span><strong>${name}</strong> · ${text}</li>`).join('');
  const causes = Object.entries(CAUSE_HELP).map(([key, text]) => `
          <li><strong>${CAUSES[key]}</strong> · ${text}</li>`).join('');
  return `
      <details class="explain">
        <summary>¿Qué significa? <span class="info">ⓘ</span></summary>
        <h4>Veredicto</h4>
        <ul>${verdicts}
        </ul>
        <h4>Intensidad de cada tramo</h4>
        <ul>${levels}
        </ul>
        <p>La turbulencia es habitual en la aviación comercial. Llevar el cinturón abrochado mientras estás sentado reduce mucho el riesgo de lesiones.</p>
        <h4>Causas</h4>
        <ul>${causes}
        </ul>
        <h4>La barra</h4>
        <p>Va del despegue al aterrizaje. Cada color es un tramo del vuelo, y debajo se detalla en qué minuto empieza y acaba.</p>
      </details>`;
}

const SIMPLIFIED = 'Cálculo simplificado: los modelos ECMWF y GFS no han dado datos para esta ruta.';

// Cálculo simplificado (v1): respaldo si los modelos ECMWF/GFS no dan datos, y consulta manual. Misma tarjeta de
// Turbulencias que el pronóstico v2, con la línea que dice que es el cálculo simplificado. sectionOnly: sin la ficha,
// para #forecast-area. open: como en el pronóstico v2 (los desplegables abiertos al repintar).
export function renderResult(el, view, { open = new Set() } = {}) {
  if (view.note) {
    el.innerHTML = `${flightCardHtml(view.flight)}${turbPlainCardHtml(`<p class="note">${esc(view.note)}</p>`)}`;
    return;
  }
  const v = VERDICTS[view.verdict];
  const max = Math.max(0, ...view.segments.map(s => s.level));
  const rows = view.segments.filter(s => s.level > 0).map(s => ({
    level: s.level, title: `Min ${s.startMin}–${s.endMin} · ${cap(LEVELS[s.level])}`,
    detail: `${esc(CAUSES[s.cause])}${s.place ? ` · ${esc(s.place)}` : ''}`,
  }));
  const summary = `${turbGeneralHtml({ level: max, headline: v.title })}
        <section id="timeline">${turbTimelineHtml(view, { interactive: false })}</section>
        <p class="note-small simplified">${SIMPLIFIED}</p>`;
  const body = `
        <p class="turb-lead">${v.text}</p>
        <div class="pills">${explainHtml(view.verdict)}${reliabilityHtml(view.reliability)}</div>
        <section id="segments">${segListHtml(rows)}</section>`;
  const card = turbCardHtml({ open, summary, body });
  // En la ficha el aviso legal va al final de la ficha (afterForecastHtml), fuera de #forecast-area.
  if (view.sectionOnly) { el.innerHTML = card; return; }
  const head = view.flight
    ? flightCardHtml(view.flight)
    : `<div class="summary card query-head"><p class="route">${esc(view.title)}</p><p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p></div>`;
  el.innerHTML = `${head}${card}${DISCLAIMER}`;
}
