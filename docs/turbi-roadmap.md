# Turbi — Roadmap

Fuente de verdad única del roadmap de Turbi (no crear otros archivos de roadmap).

## Fase cerrada (25/09/2026): llegada estimada internacional y relleno de indicativos

### Estado final
- **Llegada estimada** (`js/eta.js`; diseño en `docs/superpowers/specs/2026-09-25-turbi-eta-design.md`):
  - Prioridad: Aena (oficial o programada) > estimación Turbi antes del vuelo > estimación Turbi en vuelo con ADS-B, suavizada.
  - Siempre en la hora local del destino.
  - Sin señal ADS-B: hasta 12 min se mantiene tal cual; de 12 a 60 min pasa a «última disponible», con confianza baja; a partir de 60 min, «sin datos recientes», con confianza muy baja. Nunca vuelve a la estimación previa al vuelo. Límite absoluto: 24 h.
  - Todos los parámetros son heurísticas sin validar. **Congelado** hasta tener histórico real.
- **Radar** (`server/radar.mjs`):
  - Devuelve la velocidad vertical ADS-B directa (`vRateFpm`, de `baro_rate` o `geom_rate`) y la distancia al destino. Ya no calcula ninguna ETA.
  - Los números de 1 o 2 cifras se prueban también rellenados con ceros (UX15 → `AEA15`; si no aparece, `AEA015`). **Solo resuelve el relleno con ceros.**
- **Verificado en producción** (Render, commit `245e1c7` desplegado a mano el 25/09 hacia las 01:00 UTC):
  - `/health` mostraba `runs: 1` (servidor recién reiniciado).
  - AM22 → `AMX022` y UX39 → `AEA039`, encontrados en vuelo con `vRateFpm`.
  - AY1676 → `FIN1676`, sin variantes.
- **Tests:** 426 de 426.
- **Despliegue del servidor:** turbi-live se creó desde la URL pública del repositorio, así que Render no lo despliega automáticamente. Tras cambiar `server/` hay que hacer un Manual Deploy. Alternativa sin deploy hook: conectar GitHub en Render con Auto-Deploy en `main`, y quitar el paso `render` del workflow.

### Añadido después (25/09/2026): aterrizaje confirmado por ADS-B
- `server/radar.mjs` devuelve `{ state: 'aterrizado', callsign, seenS, distanceKm, source }` solo si se cumplen todas estas condiciones:
  - `alt_baro === 'ground'` (formato real de adsb.lol, comprobado);
  - señal y posición de 120 s o menos (`seen` y `seen_pos`);
  - posición válida a 8 km o menos del punto de referencia del aeropuerto de destino;
  - mismo indicativo;
  - ha pasado el tiempo mínimo físico desde la salida (línea recta a 950 km/h), para no confundirlo con el avión de ayer aparcado.
- Todos esos valores son heurísticas conservadoras.
- La app muestra «Aterrizado · Confirmado por radar ADS-B», sin el panel de vuelo.
- La app lo guarda en el navegador (`turbi-landed`, 7 días): al recargar no vuelve a «Ha salido», y una lectura posterior de «volando» no lo deshace.
- Aena manda si confirma la llegada. Desviado o cancelado: nunca «Aterrizado».
- Perder el radar, que pase la hora estimada o que el avión vaya bajo o lento nunca cuentan como aterrizaje.
- Pendiente (fase de histórico): guardar el aterrizaje confirmado en el histórico común, no solo en el navegador.

### Observado, sin resolver
- **Límite de adsb.lol:** resuelto con el limitador global y la pausa tras un 429 (ver la fase de identificación, más abajo).

## Fase cerrada (25/09/2026): identificación vuelo comercial → avión físico (hex ICAO)

**Problema** (diagnosticado con FR2311 PMI → LBA): Ryanair y otras emiten indicativos operativos alfanuméricos (p. ej. `RYR19HB`) que no son OACI + número. Nadie publica gratis la matrícula ni el hex por número de vuelo, y los indicativos se reasignan: nunca hay mapeos fijos.

**Cómo funciona** (`server/identify.mjs`, `server/adsb.mjs`, `server/live.mjs`):
- Solo si falla el indicativo exacto y Aena confirma salida, operadora (y su código OACI) y tipo de avión. Si Aena tiene otro vuelo de la misma operadora y ruta a ±2 h, no se intenta.
- Candidatos: SOLO de las consultas por zona (como mucho 3, radio 150 NM) a lo largo de la ruta. Deben cumplir todo a la vez: prefijo OACI de la operadora, tipo compatible con el de Aena, pasillo de 180 km (las rutas ATC reales se separan hasta ~140 km del círculo máximo), rumbo a 60° o menos, recorrido físicamente posible (ni más de 1.100 km/h + 50 km, ni menos de 300 km/h tras 45 min de rodaje y ascenso: descarta vuelos que salieron después).
- Más de 12 candidatos → ambiguo, sin consultar las bases de rutas. Con 12 o menos, se consultan **las dos** bases públicas para todos los candidatos (adsbdb y la base VRS que publica ADSB.lol; caché por indicativo, 6 h). Los indicativos operativos se reutilizan y cualquiera de las dos puede tener una asignación antigua: basta con que una confirme origen y destino exactos; si confirman aviones distintos, ambiguo.
- Cada candidato no elegido tiene que quedar descartado por una prueba (una base responde con otra ruta, o su traza muestra que no salió de nuestro origen). Si de alguno no se sabe nada, o falla una zona, una base o una traza, no se elige por descarte (no disponible).
- **Traza** (`adsb.lol/data/traces`, por el mismo limitador): si ninguna base confirma (caso FR7211: `RYR76YY`, adsbdb con una ruta antigua) y el origen es de Aena, vale como prueba que ese indicativo despegó del origen a ±2 h de la salida y se alejó de él. No vale si una base dice que ese indicativo sale de nuestro origen hacia otro destino, ni si otra salida de Aena de la misma operadora desde ese origen (a cualquier destino) explica la posición del avión. En un origen extranjero no se usa: no conocemos todas sus salidas. Una traza publicada con retraso que aún no cubre la salida no cuenta como «no salió».
- Después, seguimiento solo por `/v2/hex/`. Registro en memoria por vuelo físico, compartido por códigos compartidos y usuarios. Una identificación en curso por vuelo; las de vuelos distintos, una detrás de otra; 10 min sin reintentar tras un fallo.
- **El hex no se invalida por una sola lectura:** hacen falta 3 seguidas con otro indicativo o una contradicción física clara (imposible por distancia, a más de 400 km de la ruta, o en tierra lejos del origen y del destino). Sin indicativo o sin señal no cuenta.
- **Asíncrona:** la respuesta del radar nunca espera a la identificación (`identifying: true`, sin caché); la app vuelve a mirar una sola vez a los 20 s. La ficha nunca espera.
- La app lo dice en el panel: «Avión localizado por su ruta, posición y modelo: la aerolínea emite con otro indicativo».
- Todos los umbrales están en `LIMITS`: **heurísticas ajustables**, no valores demostrados.

**adsb.lol** (no publica su límite; medido: tras ~3 peticiones seguidas, 429 con 1,1 s y con 2 s de separación):
- Un único limitador global para indicativo, zona, hex y trazas. Además de la separación, **como mucho 4 peticiones en cualquier minuto** (la identificación usa como mucho 3 y deja una para el radar): el 25/09/2026, con 5–8 s de separación, adsb.lol dio 8 × 429 en 64 peticiones, siempre tras 6–7 en ~1 min. La identificación tarda más (1–2 min), pero sin pausas de 60 s que dejan a todos sin radar. El radar normal (indicativo y hex) va por delante; una consulta de identificación nunca sale si hay una de radar esperando, y deja al menos 5 s desde la anterior.
- 429 → pausa global (Retry-After si viene; si no, 60 s), sin reintentar en la misma operación. Se cancelan en el acto las consultas de identificación pendientes. Durante la pausa: «no disponible» sin llamar a adsb.lol. Se conservan las cachés (radar 60 s por vuelo y por vuelo físico).

**Verificado con datos reales (25/09/2026, 09:00–09:10 UTC, código del servidor, limitador de producción):**
- FR2311: 6 Ryanair pasaban los filtros gratuitos; adsbdb dejó uno solo (`RYR19HB`, PMI→LBA) → hex `4d225e`, seguido después por hex. 4 consultas a adsb.lol, ningún 429. Guardado como regresión en `tests/fixtures/fr2311-2026-09-25.json` (el código no conoce FR2311).
- FR9322 (`RYR9322`) y UX1153 (`AEA1153`): encontrados por su indicativo, como antes; ninguna identificación ni consulta por zona.
- IB613: no aparecía como `IBE613`; identificado por ruta (emite `IBE0613`).
- IB715 e IB659: no se intentan (otro vuelo de Iberia en la misma ruta a menos de 2 h).
- **Pendiente de observar en producción:** frecuencia de 429 con uso real; ajustar `LIMITS` y las separaciones con casos reales.

## Fase cerrada (25/09/2026): Aena no es el guardián del radar (`radarGate`)

**Problema** (casos reales: UX6030, FR8606, LS1246): el radar dependía del estado de Aena (salida BOR o llegada FLY/FNL). Con un estado de puerta retrasado («Última llamada» con el avión ya en el aire), una llegada desde el extranjero sin hora de salida o un estado intermedio de llegada, Turbi ni siquiera miraba ADS-B.

**Regla única** (`js/radar-gate.js`, función pura compartida por la app y el servidor): `none` (cero radar) · `direct` (hex ya conocido, indicativo y variantes seguras) · `identify` (lo anterior + identificación por ruta).
- **Nunca:** cancelado, desviado o llegada final (LND, IBK, OPE, OPF, BOR de llegada).
- **Con confirmación de Aena** (salida BOR, llegada FLY/FNL): `identify`, como antes (20 h desde la salida; sin salida de Aena, alrededor de su llegada).
- **Sin confirmación** (cualquier estado no final, sin lista cerrada: EMB, ULL, CER, INI, SCH…):
  - `firstDepMs` = la primera salida conocida (programada o estimada) → desde `firstDepMs − 5 min`, `direct`;
  - `latestDepMs` = `ed ?? sd` → desde `latestDepMs + 15 min`, `identify`;
  - llegada prevista = la de Aena o, si no la publica, `latestDepMs` + duración estimada (con retraso de salida, la ventana no se cierra antes de tiempo) → pasada `+ 60 min`, `none`;
  - origen extranjero sin salida: salida estimada = llegada de Aena − duración estimada de la ruta.
- Márgenes en `RADAR_GATE` (heurísticas ajustables).

**Estado en la ficha:** si ADS-B ve el avión volando, «Volando» y panel completo ganan a los estados de puerta de Aena (ULL, EMB, CER…). Si no lo ve y Aena aún no confirma la salida, se queda el estado de Aena y no se muestra «Sin señal ADS-B» (no se asume que haya despegado). Aena manda en cancelado, desviado y llegada oficial.

**adsb.lol:** sin cambios (5 s entre peticiones, 8 s para la identificación, pausa tras 429, cachés y prioridades).

## Pendiente

### Radar: indicativos de 4 cifras con cero (observado, sin implementar)
- Iberia emite los números de 3 cifras con un cero delante: IB613 → `IBE0613` (visto el 25/09/2026). La búsqueda por indicativo exacto solo rellena 1–2 cifras; hoy estos vuelos solo aparecen si la identificación por ruta los encuentra. Decidir si se prueba también la variante de 4 cifras (una consulta más a adsb.lol).
- Identificar qué aerolínea opera en los códigos compartidos (hoy Aena no lo indica).

### Fase de histórico: predicción frente a realidad

**Problema arquitectónico (identificado el 25/09/2026).** Las ETA calculadas en vuelo (`estimated-inflight`) solo se guardan en el navegador de quien consulta (`localStorage`, clave `turbi-eta`, en `js/eta.js`). No pasan a ningún histórico común. Otro dispositivo, o el mismo tras borrar sus datos, no puede saber qué estimó Turbi durante el vuelo.
- Ejemplo: EI737 del 24/09 muestra «Llegada —» en el histórico, porque nunca se guardó una ETA en vuelo. **Es el comportamiento correcto y no se cambia.**

**Requisitos:**
- Cuando Turbi calcule una ETA `estimated-inflight`, guardar snapshots relevantes de forma persistente en el histórico de Turbi (no solo en el navegador).
- Conservar al menos la **última ETA válida** de cada vuelo.
- Asociarla al vuelo (número y códigos compartidos), la fecha y la ruta (origen–destino).
- Guardar con ella la marca de tiempo de la observación ADS-B, la confianza y el método; y, para validar, también la fase, la distancia restante y la antigüedad de la señal.
- Que después cualquier dispositivo pueda mostrar en la ficha **«Última estimación Turbi registrada durante el vuelo»**.
- **No reconstruir retrospectivamente** la ETA de vuelos para los que nunca se guardó una: sin snapshot, «Llegada —».
- Nunca presentarla como oficial ni como llegada real.

**Validación (una vez haya histórico):**
- Comparar cada ETA guardada con la llegada real, cuando se conozca por una fuente verificable. Hoy Aena no publica la llegada de los destinos extranjeros.
- Medir el error por fase, distancia y antigüedad de la señal, y **solo entonces** ajustar las heurísticas de `js/eta.js`, que siguen congeladas.

**Por decidir al diseñar la fase** (no decidido aún):
- **Quién calcula y guarda los snapshots:**
  - el servidor (`turbi-live`, que ya consulta el radar), con la misma lógica de `js/eta.js`;
  - o la app, enviándolos al servidor.
- **Dónde se guardan:** por ejemplo, junto al histórico de puntualidad en la rama `data`. Cuidado: el disco de Render gratis no persiste.
- Cada cuánto se guarda un snapshot y cuánto tiempo se conserva.
