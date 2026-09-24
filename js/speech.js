// «Escuchar previsión»: resumen corto leído con la síntesis de voz del propio dispositivo. Sin servicios externos.

const OPENING = {
  Tranquilo: 'se espera tranquilo',
  'Mayormente tranquilo': 'se espera mayoritariamente tranquilo',
  'Algo de movimiento': 'se espera con algo de movimiento',
  Turbulento: 'puede tener tramos de turbulencia',
};
const LEVEL = ['nula', 'ligera', 'moderada', 'fuerte'];

export function buildSpeech({ from, to, summary, confidence }) {
  const parts = [`Tu vuelo entre ${from} y ${to} ${OPENING[summary.headline] ?? 'tiene un pronóstico disponible'}.`];
  const m = summary.moments?.[0];
  if (summary.maxLevel > 0 && m) {
    const label = LEVEL[summary.maxLevel];
    parts.push(summary.maxDurationMin <= 10
      ? `Se prevé un tramo corto de turbulencia ${label} aproximadamente ${m.startMin} minutos después del despegue.`
      : `Se prevé turbulencia ${label} durante unos ${summary.maxDurationMin} minutos, aproximadamente ${m.startMin} minutos después del despegue.`);
  }
  if (confidence) parts.push(`Confianza ${confidence}.`);
  return parts.join(' ');
}

export const canSpeak = () => typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined';

export function speak(text) {
  if (!canSpeak()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'es-ES';
  speechSynthesis.speak(u);
}
