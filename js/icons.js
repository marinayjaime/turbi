// Iconos lineales de Turbi: un único conjunto en SVG inline, sin dependencias. Todos comparten la misma rejilla
// (24 × 24), el mismo trazo (1,75, esquinas redondeadas) y el color del texto que los rodea (currentColor), así un
// icono se tiñe con el color de su contexto (gris en una etiqueta, azul en un botón) sin variantes por color.
// Sin etiqueta son decorativos (aria-hidden: el texto de al lado ya lo dice); con etiqueta, role="img" y aria-label,
// para los botones que solo llevan el icono.

const PATHS = {
  // Flecha hacia arriba sobre el suelo.
  altitude: '<path d="M3 20h18"/><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>',
  // Velocímetro: media esfera con la aguja.
  speed: '<path d="M4 16a8 8 0 0 1 16 0"/><path d="m12 16 4-5"/><circle cx="12" cy="16" r="1"/>',
  // Marcador de posición.
  distance: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>',
  // Antena emitiendo (señal del radar).
  signal: '<circle cx="12" cy="12" r="1.5"/><path d="M8.5 8.5a5 5 0 0 0 0 7"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'
    + '<path d="M5.6 5.6a9 9 0 0 0 0 12.8"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  // Avión visto desde arriba, con el morro a la derecha.
  plane: '<path d="M21 12c0-.8-.7-1.5-1.5-1.5H15L10 3H8l2.5 7.5H6L4 8H2.5l1 4-1 4H4l2-2.5h4.5L8 21h2l5-7.5h4.5'
    + 'c.8 0 1.5-.7 1.5-1.5z"/>',
  // Dos puntos unidos por un trazado en S.
  route: '<circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6"/>',
  // Tres ondas: aire movido.
  turbulence: '<path d="M3 7c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>'
    + '<path d="M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  // Pila de datos (fuentes).
  sources: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>'
    + '<path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  // Escudo (confianza).
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z"/>',
  // Hacia la derecha: el que abre una tarjeta (se gira con CSS al desplegarla).
  chevron: '<path d="m9 6 6 6-6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  // Puerta de embarque: puerta con su tirador.
  gate: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><path d="M14 12h1"/>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/>',
  alert: '<path d="M10.3 4.2 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/>'
    + '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
};

// Solo para el texto de aria-label (lo único variable que entra en el SVG).
const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function icon(name, { size = 20, label = null } = {}) {
  const body = Object.hasOwn(PATHS, name) ? PATHS[name] : null;
  if (!body) throw new Error(`Icono desconocido: ${name}`);
  const a11y = label == null ? 'aria-hidden="true"' : `role="img" aria-label="${attr(label)}"`;
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${body}</svg>`;
}
