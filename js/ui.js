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

export function renderResult(el, view) {
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

  el.innerHTML = `
    <div class="summary">
      <p class="route">${esc(view.title)}</p>
      <p class="sub">${esc(view.subtitle)} · ${esc(view.times)}</p>
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

export function renderHistory(listEl, entries, onPick) {
  listEl.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'history-item';
    btn.innerHTML = `<strong>${esc(e.number || `${e.origin.iata} → ${e.destination.iata}`)}</strong>
      <span>${esc(e.origin.iata)} → ${esc(e.destination.iata)} · ${esc(e.date)} ${esc(e.time)}</span>`;
    btn.addEventListener('click', () => onPick(e));
    li.append(btn);
    listEl.append(li);
  }
}
