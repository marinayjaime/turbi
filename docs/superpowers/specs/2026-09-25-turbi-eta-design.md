# Turbi — Llegada estimada en vuelos internacionales: diseño

Fecha: 2026-09-25 · Código: `js/eta.js` (tests: `tests/eta.test.js`)

## 1. Problema
En los vuelos de España al extranjero, Aena publica la salida pero no la llegada: no da ni hora programada, ni estimada, ni estado. Antes, la ficha mostraba «Llegada —».

## 2. Jerarquía de fuentes
Se aplica en este orden y nunca se mezclan fuentes:

| Orden | Método | Fuente | Confianza |
|---|---|---|---|
| 1 | `official` | Hora estimada o final de Aena (`ea`) | alta |
| 2 | `scheduled` | Hora programada de Aena (`sa`) | media |
| 3 | `estimated-preflight` | Turbi: salida (Aena) + duración estimada por la distancia | baja |
| 4 | `estimated-inflight` | Turbi: la anterior, corregida con el radar ADS-B y suavizada | media en crucero con señal reciente; si no, baja |

- Una hora de Aena **nunca** se sustituye por una estimación Turbi.
- Si el vuelo está cancelado o desviado, no se muestra llegada: no se calcula contra el destino original.
- El estado ADS-B (radar) va aparte, en `js/radar.js`, y la ficha lo muestra como dato complementario.

## 3. Cálculo en vuelo
- **Fase:** sale de la velocidad vertical ADS-B directa (`baro_rate`, o `geom_rate` si falta) que devuelve `server/radar.mjs`. Si no hay velocidad vertical, se deduce de la altitud y la distancia.
- **Tiempo restante según el radar:**
  - Crucero hasta unos 150 km del destino (distancia × 1,05, a la velocidad medida si es válida; si no, a 800 km/h), más 23 min de descenso y aproximación.
  - A menos de 100 km: distancia × 1,3 a 400 km/h, más 5 min.
  - La velocidad instantánea no se toma como velocidad media hasta el destino.
- **Mezcla con el plan:** ETA = w × radar + (1 − w) × plan.
  - w vale 0,4 a más de 500 km, 0,7 entre 100 y 500 km y 0,9 a menos de 100 km.
  - Se reduce a la mitad durante la subida o con una velocidad no válida.
  - Se reduce de forma continua según la antigüedad de la señal (`seenS`): ×1 hasta 10 s, y después baja en línea recta hasta ×0,3 a los 180 s (el servidor descarta señales más viejas). Una señal más antigua nunca pesa igual que una más reciente. A menos de 100 km del destino, el factor se eleva al cuadrado.
- **Suavizado:** cada actualización se mueve como mucho la mitad de la diferencia, y nunca más de 8 min (4 min a menos de 100 km).
- **Límites:**
  - Nunca se da una hora anterior a ahora + 5 min (+ 3 min a menos de 30 km) con el avión en el aire.
  - Se ignoran los saltos de posición imposibles (más de 100 km hacia atrás, o más de 1.300 km/h entre dos lecturas).
- **Radar perdido:** el tiempo sin señal se mide desde la última observación ADS-B (consulta − `seenS`), no desde la consulta.
  - Se conserva la última ETA en vuelo durante 60 min.
  - Con menos de 12 min de antigüedad mantiene su confianza.
  - A partir de 12 min, la confianza pasa a baja y la ficha dice «Última estimación Turbi disponible (hace X min…)».
- Se muestra redondeada a 5 min y en la hora local del aeropuerto de destino: se calcula en UTC y se convierte con su zona horaria, cambio de día incluido.
- La última ETA en vuelo se guarda en memoria y, para que sobreviva a reabrir la app, también en el almacenamiento del navegador (`turbi-eta`, con limpieza a las 24 h).

## 4. Parámetros = heurísticas
**Todos los valores anteriores son heurísticas razonables, no valores demostrados**: 800 km/h, 150 km y 23 min, ×1,05, pesos del 40/70/90 %, factores de subida y velocidad, curva de antigüedad (10 s, 180 s, 0,3), 12/60 min, límites de salto, suavizado (½, 8/4 min), mínimos de 5/3 min y redondeo a 5 min.

Pendiente: guardar la ETA predicha (con su método, distancia y fase) y compararla con la llegada real cuando se conozca, para medir el error por fase y distancia y ajustar estos valores.

## 5. Interfaz
- **Aena:** «Llegada 19:42», como hasta ahora.
- **Turbi:** «Llegada estimada 19:42» en color neutro, con una nota debajo: «Estimación Turbi», «Estimación Turbi actualizada en vuelo» o «Última estimación Turbi disponible…». Nunca «prevista».
- La duración de un vuelo sin llegada de Aena lleva un «≈» discreto.
- **Aviso de llegada pasada:**
  - Si la llegada era una estimación Turbi: «Según la estimación de Turbi, el vuelo ya habría aterrizado».
  - Si el radar ve el avión en el aire, el aviso se sustituye para no contradecirlo.
