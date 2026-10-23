// Calm Score: lo tranquilo que se PREVÉ el vuelo completo, de 0 a 100 (100 = lo más tranquilo). Resume el pronóstico
// que Turbi ya calcula (Turbi Index por punto, combinación ECMWF/GFS, js/models.js): no pide nada, no es una
// probabilidad ni una medición de las sacudidas, y es independiente de la confianza (que va aparte).
//
// Datos: view.route[i].score, el Turbi Index combinado (0–100) del punto i, con los puntos equiespaciados en el tiempo en
// el aire (view.durationMin). Cada punto vale su tramo de tiempo (regla del trapecio: los extremos, medio paso).
//
// 1) Severidad por minuto w(s), CONTINUA y creciente en el Turbi Index, con los umbrales de nivel de Turbi como anclas
//    (25 ligera, 50 moderada, 75 fuerte) y cada nivel bastante más pesado que el anterior:
//      s ≤ 25 → 0 · 50 → 0,4 · 75 → 4,6 · 100 → 20   (lineal entre anclas)
//    Así una ligera apenas perceptible casi no pesa, una ligera casi moderada pesa como el inicio de la moderada, y un
//    pronóstico que cruza un umbral por décimas cambia la nota por décimas (sin saltos).
// 2) Exposición E = Σ w·Δt (minutos de severidad), escalada a todo el vuelo si faltan puntos (sin datos no es calma).
// 3) Duración del vuelo: E se reparte entre √(D / 60 min). Ni proporción pura (diluiría un cuarto de hora moderado en un
//    vuelo largo) ni minutos puros (no distinguiría una hora ligera en un vuelo de una hora de la misma en uno de diez).
// 4) Calm Score = round(100 · e^(−K·(√(E' + 2) − √2))), con E' = E / √(D/60). La raíz da rendimientos decrecientes: un
//    episodio breve resta poco y no hunde la nota; la duración sigue contando. El desplazamiento (+2) deja la pendiente
//    finita al empezar: un rastro mínimo de turbulencia resta décimas, no varios puntos de golpe. K sale del ancla:
//    15 min de moderada media en un vuelo de 2 h → 50 (el corte de «Turbulento» del titular de Turbi).
// El número y el titular («Tranquilo», «Algo de movimiento»…) miden cosas distintas: el titular es una categoría con
// umbrales; el número, una escala continua. Cerca de un umbral pueden no coincidir del todo, y es lo esperado.
//
// Fiabilidad: sin nota (null) si falta pronóstico en más del 20 % del vuelo o si un hueco seguido supera 15 min (lo que
// dura el episodio moderado más corto que cambia el titular: un hueco así podría esconderlo entero).
export const CALM_MIN_COVERAGE = 0.8;
export const CALM_MAX_GAP_MIN = 15;
const SEVERITY = [[25, 0], [50, 0.4], [75, 4.6], [100, 20]];
const E0 = 2;
// Pronósticos guardados antes de existir route[i].score: el centro del nivel (sin distinguir dentro del nivel).
const LEVEL_MID = [12.5, 37.5, 62.5, 87.5];

const pointScore = p => (Number.isFinite(p?.score) ? p.score : Number.isInteger(p?.level) ? LEVEL_MID[p.level] ?? null : null);
export function severity(s) {
  if (s <= SEVERITY[0][0]) return 0;
  for (let i = 1; i < SEVERITY.length; i++) {
    const [x1, y1] = SEVERITY[i];
    if (s <= x1) { const [x0, y0] = SEVERITY[i - 1]; return y0 + ((s - x0) / (x1 - x0)) * (y1 - y0); }
  }
  return SEVERITY.at(-1)[1];
}

// K: el ancla (15 min a 62,5 en 2 h → 50), calculada una vez.
const ANCHOR = (severity(62.5) * 15) / Math.sqrt(2);
const K = Math.log(2) / (Math.sqrt(ANCHOR + E0) - Math.sqrt(E0));

export function calmScore(view) {
  const route = view?.route ?? [];
  const n = route.length;
  const D = view?.durationMin;
  if (n < 2 || !(D > 0)) return null;
  const step = D / (n - 1);
  let valid = 0, exposure = 0, gap = 0, maxGap = 0;
  route.forEach((p, i) => {
    const s = pointScore(p);
    const dt = i === 0 || i === n - 1 ? step / 2 : step;
    if (s === null) { gap += dt; maxGap = Math.max(maxGap, gap); return; }
    gap = 0;
    valid += dt;
    exposure += severity(s) * dt;
  });
  const coverage = valid / D;
  if (coverage < CALM_MIN_COVERAGE || maxGap > CALM_MAX_GAP_MIN) return null;
  const E = (exposure * D) / valid;
  const score = Math.round(100 * Math.exp(-K * (Math.sqrt(E / Math.sqrt(D / 60) + E0) - Math.sqrt(E0))));
  return { score, coverage, exposure: E };
}
