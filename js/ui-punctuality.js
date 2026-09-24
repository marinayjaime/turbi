// Sección «Puntualidad»: situación de hoy y histórico del vuelo, en lenguaje llano.
import { esc, dateLabel } from './ui.js';
import { trend, qualityLabel, DOW_LABELS, SLOT_LABELS } from './punctuality.js';

const PLURAL_DAYS = ['Los domingos', 'Los lunes', 'Los martes', 'Los miércoles', 'Los jueves', 'Los viernes', 'Los sábados'];
const pct = x => `${Math.round(x * 100)} %`;
const pct1 = x => `${(Math.round(x * 1000) / 10).toString().replace('.', ',')} %`;
const longDate = iso => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  .format(new Date(`${iso}T12:00:00Z`));

export function signedDelay(min) {
  if (min === 0) return 'a su hora';
  return min > 0 ? `+${min} min` : `${-min} min antes`;
}

const bandOf = min => (min <= 15 ? 'ok' : min <= 30 ? 'warn' : min <= 60 ? 'late' : 'bad');

function nowRow(label, side, doneWord) {
  if (!side) return '';
  const changed = side.time && side.time !== side.sched;
  const times = changed ? `${esc(side.sched)} → ${esc(side.time)}` : `${esc(side.sched)} <small>(sin cambios)</small>`;
  const delay = typeof side.delay === 'number' && changed ? `<span class="pdelay pband-${bandOf(side.delay)}">${signedDelay(side.delay)}</span>` : '';
  const source = side.source ? ` · según Aena en ${esc(side.source)}` : '';
  return `<div class="prow"><span class="pk">${label}</span><span>${times}</span>${delay}<small>${side.final ? doneWord : 'prevista'}${source}</small></div>`;
}

function todayHtml(c, dayLabel = 'Hoy') {
  return `
    <p class="apt-sub">${esc(dayLabel)}</p>
    ${nowRow('Salida', c.dep, 'salió')}${nowRow('Llegada', c.arr, 'llegó')}
    <p class="pbadge pband-${c.band ?? 'ok'}">${esc(c.text)}</p>
    ${c.arr?.beforeTakeoff && c.arr.time ? '<p class="mismatch">El avión aún no ha despegado: la llegada es una estimación de Aena y puede cambiar.</p>' : ''}
    <p class="note-small">Horas publicadas por Aena. «Prevista» es una estimación y puede cambiar.</p>`;
}

function statLine(label, s) {
  if (!s) return '';
  const n = `${s.sample} ${s.sample === 1 ? 'vuelo' : 'vuelos'}`;
  const value = s.quality === 'insuficiente' ? `pocos datos (${n})`
    : `${pct(s.otp15)} · ${n}${s.quality === 'orientativa' ? ' · orientativo' : ''}`;
  return `<li><span>${esc(label)}</span><span>${value}</span></li>`;
}

function historyHtml(p) {
  const h = p.history;
  if (h === undefined) return '<p class="note-small">Buscando el historial de este vuelo…</p>';
  const d90 = h?.d90;
  if (!d90 || d90.quality === 'insuficiente') {
    const n = d90?.sample ? ` (solo hay ${d90.sample} ${d90.sample === 1 ? 'vuelo registrado' : 'vuelos registrados'})` : '';
    return `<p>Todavía no hay suficiente historial de este vuelo${n}.
      Turbi empezó a registrar la puntualidad el ${longDate(p.since)}.</p>`;
  }
  const verb = h.basis === 'arr' ? 'llegaron' : 'salieron';
  const label = qualityLabel(d90);
  const trendText = trend(h.d30, d90);
  const recent = h.last7.flights.map(([d, delay, x]) => `<li><span class="dot pband-${x ? 'bad' : bandOf(delay ?? 0)}"></span>${esc(dateLabel(d))} · ${x === 1 ? 'cancelado' : x === 2 ? 'desviado' : delay === null ? 'sin dato final' : signedDelay(delay)}</li>`).join('');
  const rows = [
    statLine('Últimos 30 días', h.d30),
    statLine('Últimos 90 días', d90),
    statLine(`Ruta ${p.route[0]} → ${p.route[1]} (todas las aerolíneas)`, h.route),
    statLine(`${p.airline} en esta ruta`, h.airlineRoute),
    p.dow !== null ? statLine(`${PLURAL_DAYS[p.dow]} en esta ruta`, h.dow?.[p.dow]) : '',
    p.slot !== null ? statLine(`Salidas de ${SLOT_LABELS[p.slot].replace('–', ' a ')} en esta ruta`, h.slot?.[p.slot]) : '',
  ].join('');
  const within = x => (x <= 0 ? `${verb} a su hora o antes` : `con ${x} min de retraso o menos`);
  return `
    <p class="apt-sub">Historial (últimos 90 días)</p>
    <p class="pbig">${pct(d90.otp15)}</p>
    <p>de estos vuelos ${verb} con 15 min de retraso o menos${d90.quality === 'orientativa' ? ' (dato orientativo, aún hay pocos vuelos)' : ''}.</p>
    ${h.basis === 'dep' ? '<p class="note-small">Para este destino solo hay datos de salida.</p>' : ''}
    <dl class="facts">
      <div><dt>Retraso habitual</dt><dd>${signedDelay(d90.median)}</dd></div>
      <div><dt>3 de cada 4</dt><dd>${within(d90.p75)}</dd></div>
      <div><dt>9 de cada 10</dt><dd>${within(d90.p90)}</dd></div>
      <div><dt>Cancelaciones o desvíos</dt><dd>${pct1(d90.cancelRate ?? 0)}</dd></div>
      ${label ? `<div><dt>Valoración</dt><dd>Puntualidad ${label}</dd></div>` : ''}
    </dl>
    <p class="note-small">${d90.sample} vuelos analizados. El «retraso habitual» es el valor típico (la mediana), que no se deja arrastrar por unos pocos vuelos muy retrasados.</p>
    ${trendText ? `<p class="trend">${esc(trendText)}</p>` : ''}
    <details class="explain">
      <summary>Ver histórico <span class="info">ⓘ</span></summary>
      <h4>Últimos 7 vuelos</h4><ul class="plist">${recent}</ul>
      <h4>Comparación</h4><ul class="pstats">${rows}</ul>
      <p class="note-small">Puntual = llega con 15 min de retraso o menos (criterio habitual en aviación). Las cancelaciones se cuentan aparte.
      El día y la franja horaria se calculan con todos los vuelos de la ruta para tener datos suficientes.</p>
    </details>`;
}

// p = { current, history (undefined = cargando, null = sin datos), flight, airline, route: [o, a], dow, slot, since, dayLabel }
export function punctualityHtml(p) {
  return `
    <h3 class="section">Puntualidad</h3>
    ${todayHtml(p.current, p.dayLabel)}
    ${historyHtml(p)}`;
}

export { DOW_LABELS };
