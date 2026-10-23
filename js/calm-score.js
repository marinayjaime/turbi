// Calm Score: lo tranquilo que se PREVÉ el vuelo completo, de 0 a 100 (100 = lo más tranquilo). Resume el pronóstico
// que Turbi ya calcula (Turbi Index por punto, combinación ECMWF/GFS, js/models.js): no pide nada, no es una
// probabilidad ni una medición de las sacudidas, y es independiente de la confianza (que va aparte).
//
// Datos: view.route[i].score, el Turbi Index combinado (0–100) del punto i, con los puntos equiespaciados en el tiempo en
// el aire (view.durationMin). Cada punto vale su tramo de tiempo (regla del trapecio: los extremos, medio paso).
// Umbrales de nivel de Turbi: 25 ligera, 50 moderada, 75 fuerte (scoreToLevel).
//
// Exposición, separada por nivel y con la intensidad DENTRO de cada nivel (una ligera casi moderada pesa el triple que
// una ligera apenas perceptible):
//   ligera   e = 0,5 + (s − 25) / 25    ∈ [0,5, 1,5)   → L: FRACCIÓN del vuelo (como el titular: «10 % del vuelo»)
//   moderada e = 0,75 + 0,5 (s − 50)/25 ∈ [0,75, 1,25) → M: MINUTOS equivalentes (como el titular: «más de 15 min»)
//   fuerte   e = 1 + (s − 75) / 25      ∈ [1, 2]       → S: MINUTOS equivalentes (el titular: «cualquier minuto»)
// La ligera se mide en proporción porque en un vuelo largo se diluye; la moderada y la fuerte, en minutos absolutos,
// porque un cuarto de hora moderado pesa igual en un vuelo de una hora que en uno de diez.
//
//   X = 0,51·√L + 0,154·√M + 0,36·√S      Calm Score = round(100 · e^(−X))
//
// Raíces: rendimientos decrecientes, así un episodio breve y aislado resta poco y no hunde la nota, y la duración sigue
// contando. Calibración con los cortes del propio titular de Turbi (js/turbulence.js, verdict): ligera media en el 10 %
// del vuelo ≈ 85; ligera media todo el vuelo ≈ 60; 15 min de moderada media ≈ 55; un punto fuerte (≈ 4 min) ≈ 49.
// Coherencia: el número nunca contradice el titular que se ve en la misma ficha; se ajusta a su banda:
//   Tranquilo 100 · Mayormente tranquilo 80–99 · Algo de movimiento 50–79 · Turbulento 0–49.
//
// Sin datos no es calma: los puntos sin pronóstico no cuentan como tranquilos (la ligera se mide sobre el tiempo CON
// datos y los minutos moderados/fuertes se escalan a todo el vuelo); con cobertura < 80 %, ninguna nota (null).
export const CALM_MIN_COVERAGE = 0.8;
const K = { light: 0.51, moderate: 0.154, strong: 0.36 };
const BANDS = { Tranquilo: [100, 100], 'Mayormente tranquilo': [80, 99], 'Algo de movimiento': [50, 79], Turbulento: [0, 49] };
// Pronósticos guardados antes de existir route[i].score: el centro del nivel (sin distinguir dentro del nivel).
const LEVEL_MID = [12.5, 37.5, 62.5, 87.5];

const pointScore = p => (Number.isFinite(p?.score) ? p.score : Number.isInteger(p?.level) ? LEVEL_MID[p.level] ?? null : null);

export function calmScore(view) {
  const route = view?.route ?? [];
  const n = route.length;
  const D = view?.durationMin;
  const band = BANDS[view?.summary?.headline];
  if (n < 2 || !(D > 0) || !band) return null;
  const step = D / (n - 1);
  let valid = 0, light = 0, moderate = 0, strong = 0;
  route.forEach((p, i) => {
    const s = pointScore(p);
    if (s === null) return;
    const dt = i === 0 || i === n - 1 ? step / 2 : step;
    valid += dt;
    if (s >= 75) strong += (1 + Math.min(25, s - 75) / 25) * dt;
    else if (s >= 50) moderate += (0.75 + (0.5 * (s - 50)) / 25) * dt;
    else if (s >= 25) light += (0.5 + (s - 25) / 25) * dt;
  });
  const coverage = valid / D;
  if (coverage < CALM_MIN_COVERAGE) return null;
  const L = light / valid, M = (moderate * D) / valid, S = (strong * D) / valid;
  const raw = Math.round(100 * Math.exp(-(K.light * Math.sqrt(L) + K.moderate * Math.sqrt(M) + K.strong * Math.sqrt(S))));
  return { score: Math.min(band[1], Math.max(band[0], raw)), raw, coverage,
    lightShare: L, moderateMin: M, strongMin: S };
}
