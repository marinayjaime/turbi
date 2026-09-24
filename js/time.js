// Las horas se calculan con el nombre de zona (p. ej. 'Europe/Madrid') para que
// el desfase sea el de la fecha del vuelo, también en los cambios de hora.

export function offsetSecAt(timeZone, ms) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(ms).find(p => p.type === 'timeZoneName').value; // 'GMT+02:00' o 'GMT'
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

// dateStr 'YYYY-MM-DD', timeStr 'HH:MM' en hora local de timeZone.
export function localToUtcMs(dateStr, timeStr, timeZone) {
  const asUtc = Date.parse(`${dateStr}T${timeStr}:00Z`);
  const guess = asUtc - offsetSecAt(timeZone, asUtc) * 1000;
  return asUtc - offsetSecAt(timeZone, guess) * 1000;
}

export function formatLocal(ms, timeZone) {
  return new Date(ms + offsetSecAt(timeZone, ms) * 1000).toISOString().slice(11, 16);
}
