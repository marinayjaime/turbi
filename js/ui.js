import { LEVELS, CAUSES } from './turbulence.js';

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
const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

// Radar: panel de telemetría (estado, velocidad, altitud y distancia; fuente y última señal debajo).
// La hora de llegada estimada va en la ficha, en «Llegada estimada». Proveedor (adsb.lol) solo en el title.
function radarHtml(r) {
  if (!r) return '';
  if (r.state === 'volando') {
    const cell = (label, value, unit, extra = '') => `
        <div class="tm-cell"><span class="tm-label">${label}</span>
          <span class="tm-value${extra}">${value === null ? '—' : `${esc(value)}${unit ? `<small>${unit}</small>` : ''}`}</span></div>`;
    return `
      <div class="telemetry">
        <div class="tm-grid">
        <div class="tm-cell"><span class="tm-label">Estado</span>
          <span class="tm-value tm-flying">Volando<span class="fly" aria-hidden="true"><span class="fly-plane">✈</span></span></span></div>${
  cell('Velocidad', r.kmh ? r.kmh : null, 'km/h')}${
  cell('Altitud', Number.isFinite(r.altM) ? thousands(Math.round(r.altM / 100) * 100) : null, 'm')}${
  cell('Distancia restante', Number.isFinite(r.remainingKm) ? thousands(r.remainingKm) : null, 'km')}
        </div>
        <div class="tm-foot"><span class="tm-source" title="Datos ADS-B de ${esc(r.source ?? 'adsb.lol')}">Radar ADS-B</span>${''
  }<span class="tm-signal">Última señal hace ${esc(r.seenS)} s · ${esc(r.callsign)}</span></div>
      </div>`;
  }
  if (r.state === 'reciente') return ''; // lo dice el estado: «Última señal: volando hace X min»
  if (r.state === 'sin-senal' || r.state === 'sin-datos') return '<p class="radar muted">Sin señal ADS-B reciente para este vuelo.</p>';
  return '<p class="radar muted">El radar no responde ahora mismo.</p>';
}

// Foto real de la aerolínea que opera el vuelo con ese modelo (Wikimedia Commons), con autor y licencia.
function photoHtml(c) {
  const p = c.photo;
  if (!p?.thumb) return '';
  return `
      <figure class="plane-photo">
        <img src="${esc(p.thumb)}" alt="${esc(c.aircraft ?? '')}" onerror="this.closest('figure').remove()">
        ${p.artist || p.shared ? `<figcaption>${p.shared ? 'Vuelo con código compartido: Aena no indica qué aerolínea lo opera. ' : ''}${p.artist
          ? `Foto: <a href="${esc(p.page)}" target="_blank" rel="noopener">${esc(p.artist)}</a>, ${esc(p.license)}` : ''}</figcaption>` : ''}
      </figure>`;
}

// card = { al, number, airline, operator, title, route, status: { text, tone }, o, a, duration,
//          dep: { date, time, est, late, terminal, gate }, arr: { date, time, est, late, terminal } | null, aircraft, photo }
export function flightCardHtml(c) {
  const meta = (t, g) => [t && `Terminal ${esc(t)}`, g && `Puerta ${esc(g)}`].filter(Boolean).join(' · ') || '&nbsp;';
  const nextDay = x => (c.dep && x.date > c.dep.date ? ' · +1 día' : '');
  const side = (label, x) => x?.estimated ? `
      <div class="side">
        <p class="lbl">${label} estimada${nextDay(x)}</p>
        <p class="big estimated">${esc(x.time)}</p>
        <p class="est-note">${esc(x.note)}</p>
      </div>` : x ? `
      <div class="side">
        <p class="lbl">${label}${label === 'Llegada' ? nextDay(x) : ''}</p>
        <p class="big${x.late ? ' late' : ''}">${esc(x.est ?? x.time)}</p>
        ${x.est ? `<p class="was">Programada ${esc(x.time)}</p>` : ''}
        <p class="meta">${meta(x.terminal, null)}</p>
      </div>` : `
      <div class="side"><p class="lbl">${label}</p><p class="big">—</p></div>`;
  return `
    <section class="flight">
${photoHtml(c)}
      <div class="flight-head">
        <div class="flight-id">
          <h2>${esc(c.number ?? c.title)}</h2>
          <img class="logo" src="img/logos/${esc(c.al)}.png" alt="${esc(c.airline ?? '')}"
            onerror="if (!this.dataset.retry) { this.dataset.retry = 1; this.src = 'https://pics.avs.io/200/80/${esc(c.al)}.png'; } else this.remove();">
        </div>
        ${c.aircraft ? `<p class="aircraft">${esc(c.aircraft)}</p>` : ''}
        <p>${c.number && c.airline ? `${esc(c.airline)} · ` : ''}${esc(c.route)}${c.operator ? ` · Operado por ${esc(c.operator)}` : ''}</p>
      </div>
      ${!c.stale && c.radar?.state === 'volando' ? '' // el panel del radar ya dice «Volando», justo debajo
        : c.stale
        // Un estado viejo («Embarcando» de hace 2 h) no se presenta como actual: se dice de cuándo es.
        ? `<span class="status tone-stale">${esc(c.status.text)} ${esc(c.updatedAgo)}</span>
      <p class="stale">Los datos de Aena son de ${esc(c.updatedAgo)}: pueden haber cambiado desde entonces.</p>`
        : `<span class="status tone-${esc(c.status.tone)}${c.status.flying ? ' flying' : ''}">${esc(c.status.text)}${c.status.flying
          ? '<span class="fly" aria-hidden="true"><span class="fly-plane">✈</span></span>' : ''}</span>`}
      ${c.stale ? '' : radarHtml(c.radar)}
      <div class="route-line">
        <strong>${esc(c.o)}</strong>
        <span class="line"><em>${c.durationEstimated ? '≈ ' : ''}${esc(formatDuration(c.duration))}</em><span class="plane">✈</span></span>
        <strong>${esc(c.a)}</strong>
      </div>
      <div class="sides">${side('Salida', c.dep)}${side('Llegada', c.arr)}</div>
      ${c.dep && !c.past ? `
      <div class="gate${c.dep.gate ? '' : ' pending'}">
        <span class="gate-k">Puerta de embarque</span>
        <span class="gate-v">${!c.dep.gate ? 'Aún sin asignar' : /^[A-Z]$/i.test(c.dep.gate) ? `Zona ${esc(c.dep.gate)}` : esc(c.dep.gate)}</span>
        ${c.gateChanged ? '<span class="tag warn">Cambio de puerta</span>' : ''}
        ${c.dep.gate && /^[A-Z]$/i.test(c.dep.gate) ? '<small>Por ahora solo se conoce la zona; la puerta exacta se anuncia más cerca de la salida.</small>' : ''}
      </div>` : ''}
      ${c.past ? '<p class="foot">Horas finales publicadas por Aena y guardadas por Turbi.</p>'
        : c.updatedAgo ? `<p class="foot">Datos actualizados ${esc(c.updatedAgo)}</p>` : ''}
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

  el.innerHTML = `
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
