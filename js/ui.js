import { LEVELS, CAUSES } from './turbulence.js';
import { icon } from './icons.js';
import { flightPhase, mainTime, summaryTiles, milestones, signalState, formatCountdown } from './card-model.js';

const VERDICTS = {
  tranquilo: { emoji: '🟢', title: 'Tranquilo', text: 'No se espera turbulencia relevante.' },
  movimiento: { emoji: '🟡', title: 'Algo de movimiento', text: 'Habrá algún tramo con meneo.' },
  turbulento: { emoji: '🔴', title: 'Turbulento', text: 'Se esperan tramos de turbulencia moderada o fuerte.' },
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
const kv = (k, v, attrs = '') => `<div class="kv"><span class="k">${k}</span><span class="v"${attrs}>${v}</span></div>`;
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

// Chip del estado real (presentStatus / withRadar / withLanding) con su nota debajo. Un estado viejo («Embarcando» de
// hace 2 h) no se presenta como actual: chip gris con de cuándo es, y sin el avión animado (no se sabe si sigue volando).
function statusHtml(c) {
  if (c.stale) return `<span class="chip status tone-stale">${esc(c.status.text)} ${esc(c.updatedAgo)}</span>`;
  const fly = c.status.flying ? `<span class="fly" aria-hidden="true"><span class="fly-plane">${icon('plane', { size: 14 })}</span></span>` : '';
  return `<span class="chip status tone-${esc(c.status.tone)}${c.status.flying ? ' flying' : ''}">${esc(c.status.text)}${fly}</span>${
    c.status.note ? `\n          <p class="status-note">${esc(c.status.note)}</p>` : ''}`;
}

// Hero: foto (si la hay), número grande, «Aerolínea · Modelo» y el chip del estado. El logotipo solo se ve sin foto
// (CSS :has), así también aparece si la foto no carga y su figura se elimina.
function heroHtml(c) {
  const sub = [c.airline, c.aircraft, c.operator && `Operado por ${c.operator}`].filter(Boolean).map(esc).join(' · ');
  return `
      <header class="hero">${photoHtml(c)}
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
          ${statusHtml(c)}
          </div>
        </div>${c.stale ? `
        <p class="stale">${icon('alert', { size: 16 })}<span>Datos de Aena de ${esc(c.updatedAgo)}</span></p>` : ''}
      </header>`;
}

// Códigos grandes y la ciudad debajo (findAirport); sin ciudad conocida, solo el código.
function routeHtml(c) {
  const end = (code, city) => `<div class="rc"><strong>${esc(code)}</strong>${city ? `
          <span>${esc(city)}</span>` : ''}
        </div>`;
  return `
      <div class="route-codes">
        ${end(c.o, c.cities?.o)}
        <span class="rc-arrow" aria-hidden="true">${icon('plane', { size: 22 })}</span>
        ${end(c.a, c.cities?.a)}
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
const tmCell = (name, label, value, cls = '', extra = '') => `
          <div class="tm-cell"><span class="tm-icon">${icon(name, { size: 18 })}</span>
            <span class="tm-label">${label}</span>
            <span class="tm-value${cls}">${value}</span>${extra}</div>`;

// «Ahora» con el radar viendo el avión: cuatro celdas (sin dato, sin celda) y el indicador de señal de signalState:
// verde mientras la distancia aún se mueve, ámbar después y, desde STALE_MIN, celdas atenuadas con su antigüedad.
// Sin instante de recepción no hay antigüedad: ni «Última señal» ni indicador. Al desplegar: indicativo, fuente
// (proveedor solo en el title) y cómo se identificó el avión.
function flyingNowHtml(c, r, nowMs, open) {
  const sig = signalState(r, c.radarReceivedAt, nowMs);
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
    sig ? tmCell('signal', 'Última señal', esc(sig.text)) : '',
  ].join('');
  const live = sig?.level === 'live';
  const signal = sig ? `<span class="signal" data-signal-level="${sig.level}"><span class="dot tone-${live ? 'ok' : 'warn'}"></span>${
    live ? 'Señal radar reciente' : 'Sin señal reciente'}</span>` : '';
  const summary = `${head('Ahora', signal)}
          <div class="tm-grid${sig?.level === 'stale' ? ' is-stale' : ''}">${cells}
          </div>${sig?.level === 'stale' ? `
          <p class="tm-old">Datos del radar de hace ${esc(sig.text)}</p>` : ''}`;
  const body = `${r.callsign ? kv('Indicativo', esc(r.callsign)) : ''}${
    kv('Fuente', 'Radar ADS-B', ` title="Datos ADS-B de ${esc(r.source ?? 'adsb.lol')}"`)}${
    r.match === 'ruta' ? '\n          <p class="tm-match">Avión localizado por su ruta, posición y modelo: la aerolínea emite con otro indicativo.</p>' : ''}${
    r.aircraftChanged ? '\n          <p class="tm-match">Avión localizado por su indicativo: no es el que AeroDataBox tenía asignado a este vuelo.</p>' : ''}`;
  return details('now', 'now telemetry', open, summary, body);
}

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
  if (r?.state === 'sin-senal' || r?.state === 'sin-datos') return line('stale', 'Sin señal ADS-B reciente para este vuelo.');
  if (r?.state === 'no-disponible') return line('stale', 'El radar no responde ahora mismo.');
  return null;
}

// «Ahora» (§5.5): telemetría con el radar «volando»; si no, el mensaje del radar o, sin radar, el estado operativo y
// la terminal; y la puerta. No existe en un vuelo finalizado o cancelado. Con datos de Aena antiguos no hay
// telemetría (no se mezcla un radar actual con un estado viejo).
function nowHtml(c, phase, nowMs, open) {
  if (phase === 'finalizado' || phase === 'cancelado') return '';
  const r = c.stale ? null : c.radar;
  if (r?.state === 'volando') return flyingNowHtml(c, r, nowMs, open);
  const radarLine = radarLineHtml(r);
  const ground = radarLine ?? `
          <div class="now-ground">${icon('clock')}
            <div><p class="now-title">${esc(c.status.text)}${c.stale ? ` <small>${esc(c.updatedAgo)}</small>` : ''}</p>${
  c.dep?.terminal ? `<p class="now-meta">Terminal ${esc(c.dep.terminal)}</p>` : ''}</div>
          </div>`;
  const aena = c.source !== 'aerodatabox';
  const body = `${kv('Fuente', aena ? 'Aena' : 'AeroDataBox')}${aena && c.updatedAgo ? kv('Actualizado', esc(c.updatedAgo)) : ''}`;
  return details('now', 'now', open, `${head('Ahora')}${ground}${gateHtml(c)}`, body);
}

// «Horario» (§5.6): cuatro hitos (milestones) con su color por tipo, los avisos de Aena visibles sin desplegar y el
// pie de siempre (de dónde salen las horas). En el cuerpo, #punctuality: lo rellena app.js (situación de hoy al pintar
// y el historial cuando llega).
const SIDES = { 'dep-sched': 'Salida', 'dep-real': 'Salida', 'arr-sched': 'Llegada', 'arr-best': 'Llegada' };
function scheduleHtml(c, mt, open, punctualityBody) {
  const nextDay = Boolean(c.dep && c.arr && c.arr.date > c.dep.date);
  const items = milestones(c).map(m => `
            <li class="ms ms-${m.kind}"><span class="ms-dot"></span> <span class="ms-time">${esc(m.time)}${
  nextDay && m.kind !== 'pending' && m.key.startsWith('arr') ? '<small>+1</small>' : ''}</span> <span class="ms-cap">${
  esc(m.caption)}</span> <span class="ms-side">${SIDES[m.key]}</span></li>`).join('');
  // Nota de una hora estimada por Turbi, si la hora principal no la dice ya.
  const notes = [c.dep, c.arr].filter(s => s?.estimated && s.note && s.note !== mt?.note)
    .map(s => `\n          <p class="ms-note">${esc(s.note)}</p>`).join('');
  const p = c.punctuality;
  const alerts = [
    p?.dep?.alt && `Aena publica también otra hora de salida: ${p.dep.alt.map(esc).join(', ')}.`,
    p?.arr?.alt && `Aena publica también otra hora de llegada: ${p.arr.alt.map(esc).join(', ')}.`,
    p?.arr?.beforeTakeoff && p.arr.time && 'El avión aún no ha despegado: la llegada de Aena puede cambiar.',
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
// el aire. Nada estimado ni consumos.
function flightSummaryHtml(c) {
  const real = c.depFinal && c.arrFinal ? formatCountdown(c.arrMs - c.depMs) : null;
  const items = [
    Number.isFinite(c.km) && ['distance', 'Distancia en ruta directa', `${thousands(Math.round(c.km))} km`],
    real && ['clock', c.source === 'aerodatabox' ? 'Tiempo en el aire' : 'Duración real', real],
  ].filter(Boolean);
  if (!items.length) return '';
  return `
      <section class="card flight-summary" data-card="flight-summary">
        <h3 class="card-head">Resumen del vuelo</h3>
        <div class="fs-grid">${items.map(([name, k, v]) => `
          <div class="fs-item">${icon(name, { size: 18 })}${kv(k, esc(v))}</div>`).join('')}
        </div>
      </section>`;
}

// card: el de buildFlight (app.js), con los campos de presentación de js/card-model.js. open: qué data-card van
// abiertos (los conserva el repintado). punctualityBody: contenido inicial de #punctuality (situación de hoy).
export function flightCardHtml(c, { nowMs = Date.now(), open = new Set(), punctualityBody = '' } = {}) {
  const phase = flightPhase(c);
  const mt = mainTime(c, nowMs);
  return `
    <section class="flight" data-phase="${phase}">
      <div class="card flight-main">${heroHtml(c)}${routeHtml(c)}${mainTimeHtml(c, mt)}${tilesHtml(c)}
      </div>${nowHtml(c, phase, nowMs, open)}${scheduleHtml(c, mt, open, punctualityBody)}${
  phase === 'programado' ? aircraftHtml(c, open) : ''}${phase === 'finalizado' ? flightSummaryHtml(c) : ''}
    </section>`;
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
          <li${key === current ? ' class="current"' : ''}><strong>${v.emoji} ${v.title}</strong><br>${VERDICT_HELP[key]}</li>`).join('');
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

export function renderResult(el, view) {
  if (view.note) {
    el.innerHTML = `<div class="summary">${flightCardHtml(view.flight)}<p class="note">${esc(view.note)}</p></div>`;
    return;
  }
  const v = VERDICTS[view.verdict];
  const bar = view.segments.map(s =>
    `<div class="seg lvl${s.level}" style="flex:${Math.max(s.endMin - s.startMin, 1)}"></div>`).join('');
  const ticks = timeTicks(view.durationMin).map(m =>
    `<span style="left:${(m / view.durationMin) * 100}%">${m}′</span>`).join('');
  const bumpy = view.segments.filter(s => s.level > 0);
  const cards = bumpy.length
    ? bumpy.map(s => `
      <li class="card">
        <span class="dot lvl${s.level}"></span>
        <div>
          <strong>Min ${s.startMin}–${s.endMin} · ${cap(LEVELS[s.level])}</strong>
          <p>${esc(CAUSES[s.cause])}${s.place ? ` · ${esc(s.place)}` : ''}</p>
        </div>
      </li>`).join('')
    : '<li class="card empty">Ningún tramo con turbulencia.</li>';

  const head = view.flight
    ? `${flightCardHtml(view.flight)}<h3 class="section">Turbulencias</h3>`
    : `<p class="route">${esc(view.title)}</p><p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p>`;
  el.innerHTML = view.sectionOnly ? legacyBody(view, v, bar, ticks, cards, '') : legacyBody(view, v, bar, ticks, cards, head);
}

// Cálculo simplificado (v1). sectionOnly: sin la ficha, para la sección de turbulencias.
function legacyBody(view, v, bar, ticks, cards, head) {
  return `
    <div class="summary">
      ${head}
      <div class="verdict">
        <span class="emoji">${v.emoji}</span>
        <div><h2>${v.title}</h2><p>${v.text}</p></div>
      </div>
      <div class="pills">${explainHtml(view.verdict)}${reliabilityHtml(view.reliability)}</div>
    </div>
    <div class="timeline">
      <div class="bar">${bar}</div>
      <div class="ticks">${ticks}</div>
      <div class="ends"><span>Despegue</span><span>Aterrizaje</span></div>
    </div>
    <ul class="cards">${cards}</ul>`;
}
