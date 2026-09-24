// dateStr 'YYYY-MM-DD', timeStr 'HH:MM', offsetSec = desfase del lugar respecto a UTC.
export function localToUtcMs(dateStr, timeStr, offsetSec) {
  return Date.parse(`${dateStr}T${timeStr}:00Z`) - offsetSec * 1000;
}

export function formatLocal(ms, offsetSec) {
  return new Date(ms + offsetSec * 1000).toISOString().slice(11, 16);
}
