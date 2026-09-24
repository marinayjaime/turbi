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

// card = { al, title, route, tabs: [{ date, active }], status: { text, tone }, o, a, duration,
//          dep: { date, time, est, terminal, gate }, arr: { date, time, est, terminal } | null, aircraft }
function flightCardHtml(c) {
  const meta = (t, g) => [t && `Terminal ${esc(t)}`, g && `Puerta ${esc(g)}`].filter(Boolean).join(' · ') || '&nbsp;';
  const nextDay = x => (c.dep && x.date > c.dep.date ? ' · +1 día' : '');
  const side = (label, x) => x ? `
      <div class="side">
        <p class="lbl">${label}${label === 'Llegada' ? nextDay(x) : ''}</p>
        <p class="big${x.est && x.est > x.time ? ' late' : ''}">${esc(x.est ?? x.time)}</p>
        ${x.est ? `<p class="was">Programada ${esc(x.time)}</p>` : ''}
        <p class="meta">${meta(x.terminal, x.gate)}</p>
      </div>` : `
      <div class="side"><p class="lbl">${label}</p><p class="big">—</p></div>`;
  return `
    <section class="flight">
      <div class="flight-head">
        <img class="logo" src="https://pics.avs.io/200/80/${esc(c.al)}.png" alt="" onerror="this.remove()">
        <div><h2>${esc(c.title)}</h2><p>${esc(c.route)}</p></div>
      </div>
      ${c.tabs.length > 1 ? `<nav class="tabs">${c.tabs.map(t =>
        `<button type="button" data-date="${esc(t.date)}"${t.active ? ' class="active"' : ''}>${esc(dateLabel(t.date))}</button>`).join('')}</nav>` : ''}
      <span class="status tone-${esc(c.status.tone)}">${esc(c.status.text)}</span>
      <div class="route-line">
        <strong>${esc(c.o)}</strong>
        <span class="line"><em>${esc(formatDuration(c.duration))}</em><span class="plane">✈</span></span>
        <strong>${esc(c.a)}</strong>
      </div>
      <div class="sides">${side('Salida', c.dep)}${side('Llegada', c.arr)}</div>
      <p class="foot">${c.aircraft ? `Avión ${esc(c.aircraft)} · ` : ''}Fuente: Aena · hora local de cada aeropuerto</p>
    </section>`;
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
      <span class="badge">Fiabilidad ${esc(view.reliability)}</span>
    </div>
    <div class="timeline">
      <div class="bar">${bar}</div>
      <div class="ticks">${ticks}</div>
      <div class="ends"><span>Despegue</span><span>Aterrizaje</span></div>
    </div>
    <ul class="cards">${cards}</ul>`;
}
