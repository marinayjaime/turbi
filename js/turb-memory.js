// Último pronóstico de turbulencias válido de cada VUELO FÍSICO (physicalFlightKey en Aena, adbPhysicalKey en
// AeroDataBox), para el «Resumen del vuelo» una vez aterrizado: solo un resumen pequeño, nunca el pronóstico entero.
// Se guarda mientras el vuelo está programado o en curso; tras el aterrizaje solo se lee (nada se calcula después).
// En memoria y en localStorage (pocos registros, fuera los de más de 7 días). Nunca lanza: sin almacenamiento queda
// en memoria y Turbi sigue igual.
import { verdict as legacyVerdict } from './turbulence.js';

const STORE = 'turbi-turb-estimates';
const MAX = 20;
const TTL_MS = 7 * 24 * 3600000;
const HEADLINES = ['Tranquilo', 'Mayormente tranquilo', 'Algo de movimiento', 'Turbulento'];
// Titular del cálculo simplificado (v1): el mismo que muestra su tarjeta (VERDICTS de js/ui.js).
const LEGACY_HEADLINE = { tranquilo: 'Tranquilo', movimiento: 'Algo de movimiento', turbulento: 'Turbulento' };
const mem = new Map();

const levelOk = l => Number.isInteger(l) && l >= 0 && l <= 3;
const valid = d => Boolean(d) && HEADLINES.includes(d.headline) && levelOk(d.maxLevel) && Number.isFinite(d.queriedAt);

// Pronóstico v2 (forecastView): lo que ya dice su resumen, tal cual.
export function forecastDigest(view) {
  const s = view?.summary;
  if (!s) return null;
  const d = { headline: s.headline, verdict: s.verdict, maxLevel: s.maxLevel, maxDurationMin: s.maxDurationMin,
    percentages: s.percentages, confidence: view.confidence?.level ?? null, queriedAt: view.queriedAt };
  return valid(d) ? d : null;
}

// Cálculo simplificado (v1): solo veredicto, tramos y duración; sin confianza ni porcentajes (no los tiene).
export function legacyDigest(legacy, queriedAt) {
  const segs = Array.isArray(legacy?.segments) ? legacy.segments : [];
  if (!segs.length || !Number.isFinite(legacy.durationMin)) return null;
  const v = legacy.verdict ?? legacyVerdict(segs, legacy.durationMin);
  const maxLevel = Math.max(...segs.map(s => s.level));
  const maxDurationMin = maxLevel > 0 ? segs.filter(s => s.level === maxLevel).reduce((a, s) => a + s.endMin - s.startMin, 0) : 0;
  const d = { headline: LEGACY_HEADLINE[v], verdict: v, maxLevel, maxDurationMin, queriedAt };
  return valid(d) ? d : null;
}

const readAll = storage => { try { return JSON.parse(storage?.getItem(STORE) ?? '{}') ?? {}; } catch { return {}; } };

export function rememberTurb(key, digest, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (!key || !valid(digest)) return;
  mem.set(key, digest);
  try {
    const all = readAll(storage);
    for (const [k, d] of Object.entries(all)) if (!valid(d) || nowMs - d.queriedAt > TTL_MS) delete all[k];
    delete all[key]; // se reinserta al final: el orden de claves es el de uso
    all[key] = digest;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[k];
    storage?.setItem(STORE, JSON.stringify(all));
  } catch { /* sin almacenamiento: queda en memoria */ }
}

// El resumen guardado de ESE vuelo físico, o null (ninguno, caducado o con otra forma).
export function recallTurb(key, nowMs = Date.now(), storage = globalThis.localStorage) {
  if (!key) return null;
  let d = mem.get(key);
  if (!d) { try { d = readAll(storage)[key]; } catch { d = null; } }
  return valid(d) && nowMs - d.queriedAt <= TTL_MS ? d : null;
}
