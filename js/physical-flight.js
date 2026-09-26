// Vuelo físico: el avión concreto que hace un trayecto, compartido por todos sus códigos comerciales. Definición
// ÚNICA para todo Turbi (radar, identificación, asignación de operadora): mismo día, origen y destino y la misma
// hora de SALIDA de Aena o, si Aena no la publica (origen extranjero), la misma hora de LLEGADA. Sin ninguna de las
// dos, el vuelo solo es igual a sí mismo (nunca se agrupa con otros de la misma ruta).
export function physicalFlightKey(leg) {
  const time = leg.sd ? leg.sd : leg.sa ? `L${leg.sa}` : `F${leg.al}${leg.n}`;
  return `${leg.d}|${leg.o}|${leg.a}|${time}`;
}

export const samePhysicalFlight = (a, b) => physicalFlightKey(a) === physicalFlightKey(b);
