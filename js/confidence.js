// Confianza del pronóstico: alta, media o baja, con los motivos. Sin porcentajes (no hay calibración estadística).
// Diseño: docs/superpowers/specs/2026-09-24-turbi-v2-pronostico-design.md §5

const COMPONENTS = ['ellrod', 'shear', 'ri', 'cape', 'storm', 'w', 'mountain'];
const isNum = x => typeof x === 'number' && !Number.isNaN(x);

function leadTime(hours) {
  if (hours < 24) return { pts: 2, reason: 'faltan menos de 24 h' };
  const days = Math.round(hours / 24);
  const reason = days === 1 ? 'falta 1 día' : `faltan ${days} días`;
  return { pts: hours <= 72 ? 1 : 0, reason };
}

function modelAgreement(agreement, models) {
  switch (agreement.level) {
    case 'alta': return { pts: 2, reason: 'ECMWF y GFS muestran un patrón parecido' };
    case 'media': return { pts: 1, reason: 'ECMWF y GFS coinciden solo en parte' };
    case 'baja': return { pts: 0, reason: 'ECMWF y GFS discrepan' };
    default: return { pts: 0, reason: `solo hay un modelo disponible (${models.join(', ')})` };
  }
}

function coverageFactor(coverage) {
  if (coverage >= 0.95) return { pts: 1, reason: 'cobertura meteorológica completa' };
  if (coverage >= 0.7) return { pts: 0, reason: 'algunos puntos no tienen todos los datos' };
  return { pts: -1, reason: 'varios puntos no tienen todos los datos necesarios' };
}

// Saltos de 2 o más niveles entre puntos vecinos válidos.
function unstable(points) {
  const v = points.filter(p => p.valid);
  if (v.length < 3) return false;
  let jumps = 0;
  for (let i = 1; i < v.length; i++) if (Math.abs(v[i].level - v[i - 1].level) >= 2) jumps++;
  return jumps / (v.length - 1) > 0.2;
}

// Puntos de nivel ≥ moderada sostenidos por un único indicador alto (≥ 50) sin apoyo de los demás (< 25).
function singleIndicator(points) {
  const strong = points.filter(p => p.valid && p.level >= 2 && p.components);
  if (!strong.length) return false;
  const single = strong.filter(p => {
    const vals = COMPONENTS.map(k => p.components[k]).filter(isNum);
    const high = vals.filter(x => x >= 50).length;
    return high === 1 && vals.filter(x => x >= 25).length === 1;
  });
  return single.length / strong.length > 0.5;
}

export function computeConfidence({ departureMs, nowMs, models, agreement, coverage, points }) {
  const hours = (departureMs - nowMs) / 3600000;
  if (hours > 168) return { level: null, reasons: ['falta más de una semana: el pronóstico aún no es útil'] };

  const factors = [leadTime(hours), modelAgreement(agreement, models), coverageFactor(coverage)];
  if (unstable(points)) factors.push({ pts: -1, reason: 'el pronóstico cambia mucho de un punto a otro' });
  if (singleIndicator(points)) factors.push({ pts: -1, reason: 'los indicadores no coinciden entre sí' });

  const total = factors.reduce((s, f) => s + f.pts, 0);
  let level = total >= 4 ? 'alta' : total >= 2 ? 'media' : 'baja';
  if (hours > 72 && level === 'alta') level = 'media';
  return { level, reasons: factors.map(f => f.reason) };
}
