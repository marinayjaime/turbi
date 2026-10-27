// Qué avión se ve en el mapa (modelo y operadora), con lo que ya tiene la ficha. Va aparte de js/aircraft3d.js para que la
// ficha lo use sin cargar el modo 3D (geometría y decoraciones se descargan solo al activarlo).

// Modelo: el del avión que se ve en el radar (radar.type, código OACI de Flightradar24: el avión real de ese vuelo) y,
// si el radar no lo da, el previsto en el horario (card.aircraft: Aena o AeroDataBox). typeName traduce el código.
// Operadora: la confirmada por la ficha (card.opCode: Aena `op`, AeroDataBox «IsOperator» o FR24 operating_as; código
// IATA) y el prefijo OACI del indicativo de radio (callsign: siempre es la operadora que vuela). Nunca la aerolínea
// que solo comercializa el número (código compartido). Si las dos fuentes existen y no son la misma aerolínea del
// catálogo, la operadora queda sin confirmar (conflict) y no se pinta ninguna decoración.
const CALLSIGN_ICAO = /^([A-Z]{3})\d/;
export function identifyAircraft(card, typeName) {
  const radar = card?.radar ?? null;
  const live = typeof radar?.type === 'string' && radar.type ? typeName(radar.type) : null;
  const liveName = live && !live.startsWith('modelo ') ? live : null;
  const model = liveName ?? (typeof card?.aircraft === 'string' && card.aircraft && !card.aircraft.startsWith('modelo ') ? card.aircraft : null);
  const callsign = typeof radar?.callsign === 'string' ? radar.callsign.trim().toUpperCase() : '';
  return {
    model,
    modelSource: liveName ? 'radar' : model ? 'horario' : null,
    opIata: typeof card?.opCode === 'string' && card.opCode ? card.opCode.toUpperCase() : null,
    opIcao: CALLSIGN_ICAO.exec(callsign)?.[1] ?? null,
  };
}

