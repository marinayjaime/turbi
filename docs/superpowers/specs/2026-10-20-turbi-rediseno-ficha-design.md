# Turbi — Rediseño de la ficha (estética clara, mobile-first)

Fecha: 20/10/2026 · Referencia visual: `Interfaz Turbi para seguimiento de vuelos.png` (tres pantallas: en curso,
programado y finalizado, más estados alternativos y «Detalles avanzados» abierto). La imagen marca la dirección
visual; los datos que aparecen en ella (IB1668, PMI → MAD, 19:18, A321neo…) son solo ejemplos y nunca se escriben
en el código.

## 1. Intención

Turbi muestra hoy mucha información útil, pero acumulada: frases largas, secciones seguidas con el mismo peso y una
estética de cristal sobre una foto de cielo. Queremos que **conserve prácticamente el 100 % de sus capacidades** y que
**parezca tener mucha menos información**: una app móvil clara, ligera y premium (cerca de Apple/Flighty, no de un
dashboard ni de una web con tarjetas). Se consigue con jerarquía, espacio, visualización, agrupación y *progressive
disclosure*, no quitando funciones.

Es un **rediseño de presentación**. La única ampliación funcional es exponer la posición del avión (§9).

## 2. Objetivos, no objetivos y antiobjetivos

**Objetivos**
- Una sola dirección visual, la de la referencia, en toda la app (consulta, carga, ficha, selector de tramos y alias).
- Ficha reorganizada: hero, ruta, hora principal, tres tarjetas de resumen, «Ahora», «Horario», «Turbulencias»,
  «Radar» o «Ruta prevista/realizada», «Avión», «Resumen del vuelo» y «Detalles avanzados».
- La jerarquía cambia según la fase: programado, en curso o finalizado.
- Diseñar también los estados no ideales (§8).
- Texto en formato etiqueta + valor; las explicaciones largas quedan dentro de secciones desplegables.

**No objetivos** (no se tocan): búsqueda de vuelos, Aena, AeroDataBox, ADSBDB, adsb.lol, identificación del vuelo
físico, radar, `radarGate`, ETA, detección de aterrizaje, estados, horarios, refrescos, cálculo de turbulencias,
meteorología, fuentes, cachés ni backend de Render (salvo §9). No se hace deploy.

**Antiobjetivos** (fracaso aunque funcione):
- Quitar información útil porque no aparezca en la referencia. Lo que no cabe en la vista principal va a una sección
  desplegable o a «Detalles avanzados».
- Mostrar un dato inventado, interpolado, un *placeholder* falso o un dato antiguo como si fuera actual.
- Limitarse a cambiar el fondo oscuro por uno blanco.
- Romper el flujo móvil de Safari y la PWA (viewport, zonas seguras, teclado).
- Introducir frameworks (React, Vue, Svelte) o librerías solo para animar.
- Duplicar lógica: la interfaz consume los mismos objetos que hoy (`flight` card, `view` del pronóstico,
  `punctuality`, `radar`, `eta`).

## 3. Restricciones técnicas

- JavaScript con módulos ES sin *build* y HTML como cadenas (`flightCardHtml`, `forecastSectionHtml`…). Se sigue así.
- **Contrato del DOM que usa `js/app.js`** (se conserva o se adapta `app.js` solo en la presentación):
  - `.flight` es la tarjeta del vuelo y se sustituye entera (`outerHTML`) en cada lectura del radar y en cada refresco de
    Aena (`paintRadar`, `applyAenaLeg`). **Todo lo que dependa del estado del vuelo** (hero, ruta, hora principal, tarjetas
    de resumen, «Ahora», «Horario») va dentro de ese bloque, que se repinta junto.
  - `#forecast-area` (sección de turbulencias, con `#timeline`, `#seg-detail`, `button[data-seg]`, `#altitudes`,
    `#aviation`, `#trend`, `#speak`, `#fresh`, `#forecast-retry`, `.note`), `#punctuality`, `#map`, `.tm-remaining` (el
    contador de distancia restante solo repinta ese número), `.leg-switch` / `.leg-option[data-leg-key]` y
    `button[data-alias]`.
  - Los tests de flujo buscan `.flight`, un `h3.section` con el texto «Turbulencias», `.tm-cell` / `.tm-value`
    («Velocidad») y `.leg-option small`. Se mantienen esos *hooks* o se actualizan los tests solo si el cambio es una
    consecuencia legítima del nuevo DOM.
- Los textos que `app.js` compara para decidir (`ENDED_ESTIMATED`, `NO_ARRIVAL_NOTE`, `LANDED_NOTE` en
  `js/radar.js`) **no cambian**: forman parte de la lógica. Se muestran con otro estilo, pero con el mismo texto.
- Mapa: Leaflet 1.9.4 y teselas de OpenStreetMap, como hoy (`js/map.js`). No se añade ninguna API de mapas.
- Prioridad absoluta: iPhone, Safari móvil y PWA. En desktop, la misma columna centrada (máximo 480 px) sobre el fondo claro.
- Reglas de viewport que se conservan tal cual, con sus tests: `.screen` con `100dvh` (respaldo `100vh`) y centrado en
  grid; `padding-block` con `max(safe-area-inset-top, safe-area-inset-bottom)`; `100svh` solo con
  `.screen:focus-within` (teclado iOS); `#result-view` con flujo y scroll normales y zonas seguras.
- Versionado al terminar: `BUILD_ID`, caché del service worker (`turbi-v81` → `v82`), los *query strings* de
  `index.html` y `sw.js`, y la lista `SHELL` (ficheros nuevos dentro y `img/sky.jpg` fuera). La PWA instalada recibe la
  versión por el aviso «Hay una versión nueva» de siempre.

## 4. Sistema visual

- **Fondo** `#F4F8FC`, liso, sin foto y sin capas fijas. El cielo (`img/sky.jpg`) desaparece de toda la app.
- **Tarjetas** blancas, borde `1px rgba(15, 40, 80, 0.07)`, sombra muy suave (p. ej.
  `0 1px 2px rgba(15,40,80,.04), 0 8px 24px rgba(15,40,80,.05)`), radio de unos 20 px y 16 px de separación vertical.
- **Colores** (tokens en `:root`): azul Turbi (primario, enlaces y estimación Turbi), azul marino oscuro (texto
  principal), grises para lo secundario, verde (confirmado/real, positivo), ámbar (aviso, turbulencia moderada) y rojo
  (solo lo realmente negativo: cancelado, desviado, turbulencia fuerte, confianza baja). Turbulencia: verde = ligera,
  ámbar = moderada, rojo = fuerte, gris claro = nula.
- **Tipografía**: la del sistema (`-apple-system`, SF Pro). Números importantes grandes (hora principal ~40 px, códigos
  de aeropuerto ~30 px), etiquetas de 12–13 px en gris, cifras con `tabular-nums`. Jerarquía por tamaño y espacio, con
  poco *bold* y pocas mayúsculas.
- **Iconos**: un único conjunto lineal en SVG *inline* (trazo de 1,5–1,75 px, esquinas redondeadas), en un módulo nuevo
  `js/icons.js` sin dependencias: altitud, velocidad, posición/distancia, señal, reloj, avión, ruta, turbulencia,
  fuentes, escudo (confianza), chevron, refrescar, atrás y ampliar. **Ningún emoji** en la interfaz: los 🟢🟡🔴, 🔊 y ✈
  actuales se sustituyen por iconos o puntos de color.
- **Interacciones**: tarjetas desplegables con chevron que rota (150–250 ms), expansión y *fade* suaves, y números que
  se actualizan sin saltos (`tabular-nums`, sin cambiar el ancho de la caja). Solo CSS y `<details>` o un pequeño
  manejador propio; sin librerías. Se respeta `prefers-reduced-motion`.
- **Barra superior** de la ficha: «‹» (Nueva consulta, con `aria-label`) a la izquierda, logotipo de Turbi en el centro
  y el icono de actualizar a la derecha. Las funciones son las de hoy (`#back`, `#refresh`).
- PWA: `theme-color` y `manifest.json` (`background_color`, `theme_color`) pasan a los colores claros. La barra de estado
  de iOS deja de ser `black-translucent`, porque con fondo claro daría texto blanco sobre blanco. Hay que verificar en un
  iPhone que las zonas seguras siguen bien en Safari y en la PWA instalada.

## 5. La ficha, sección a sección

Origen de cada dato entre paréntesis. **Regla general**: si un dato no existe, no se muestra (ni «—» de relleno ni un
valor por defecto), salvo en el «Horario», donde un hito pendiente se marca como pendiente (`--:--`).

### 5.1 Cabecera (hero)
- La foto actual (`card.photo`, de Wikimedia) ocupa la parte superior de la tarjeta y se funde con un degradado hacia
  el blanco. La atribución (autor y licencia, o «imagen representativa» / «código compartido») **se mantiene** en un
  pie pequeño: es obligatoria por la licencia.
- Debajo, a la izquierda, el número (`card.number`) grande y «Aerolínea · Modelo» (`airline`, `aircraft`) en gris. Si
  hay operador distinto, «Operado por …» va en la misma línea o en «Detalles avanzados». Sin foto (AeroDataBox, foto que
  no carga), la tarjeta empieza por el número, con el logotipo de la aerolínea si existe (`img/logos`).
- A la derecha, el chip del **estado real** (`card.status.text` y `tone`, que salen de `presentStatus`, `withRadar` y
  `withLanding`): verde = ok, azul = info y en vuelo, ámbar = warn, rojo = bad, gris = antiguo. La nota del estado
  («Confirmado por radar ADS-B», «Según la llegada estimada por Turbi») va como línea pequeña bajo el chip o la hora.
- Datos de Aena antiguos (`card.stale`): chip gris con «… hace X» y una línea ámbar corta («Datos de Aena de hace X»).
  Como hoy, no se muestra la telemetría.

### 5.2 Ruta
`PMI → MAD` con códigos grandes (`card.o`, `card.a`) y la ciudad debajo en pequeño (de `findAirport` / `card.route`;
si no se conoce la ciudad, solo el código). Sin frases.

### 5.3 Hora principal
Una hora grande con su etiqueta, y a la derecha un dato secundario derivado. **Qué hora se muestra no cambia**: es la
que ya muestra hoy la ficha en su lado correspondiente (`card.dep` / `card.arr`, con `est ?? time`, o `etaSide` para la
estimación Turbi).
- **Antes de salir**: la salida (`dep.est ?? dep.time`); etiqueta «Salida prevista» o «Salida programada». A la derecha,
  «Sale en X h Y min», si aún no ha pasado. *No* «Embarque en»: Turbi no conoce la hora de embarque.
- **En el aire** (salida confirmada o radar «volando»): la llegada visible (Aena o estimación Turbi); etiqueta «Llegada
  estimada» o «Llegada prevista»; a la derecha, «Llega en X min». La nota de la estimación Turbi (`arr.note`) va en
  pequeño.
- **Finalizado** (llegada final de Aena o aterrizaje ADS-B): la llegada; etiqueta «Llegada final» (Aena) o «Aterrizado
  · radar ADS-B» (ADS-B sin confirmación de Aena). A la derecha, «Duración X h Y min», solo si hay salida y llegada
  reales.
- Cancelado o desviado: no hay hora principal; el chip rojo y la puntualidad lo dicen.
- Llegada al día siguiente: «+1 día», como hoy.

### 5.4 Tres tarjetas de resumen
Una fila de tres en móvil (≥ 340 px; por debajo, ajuste con *wrap*). Una tarjeta sin dato no se muestra, y la fila se
reparte entre las que quedan.
- **Puntualidad**: el retraso de hoy (`currentPunctuality`: `+N min` / `N min antes` / «En hora» / «Cancelado») con el
  color de su banda. Solo en vuelos de Aena.
- **Fuente**: de dónde salen la hora y el estado. «Aena», «AeroDataBox», «Radar + Aena» o «Radar + AeroDataBox»
  (radar volando o aterrizado), o «Estimación Turbi» (sin Aena ni AeroDataBox para la llegada). Es una derivación
  directa de los datos, no un algoritmo nuevo.
- **Confianza**: confianza de la **información temporal / ETA**, que ya existe en `js/eta.js` (`eta.confidence`):
  Aena oficial `high` → «Alta», Aena programada `medium` → «Media», estimación Turbi `medium` / `low` / `very-low` →
  «Media» / «Baja» / «Muy baja». Verde, ámbar o rojo como refuerzo. Con «Baja» o «Muy baja», la línea pequeña «La
  información puede ser limitada o proceder de fuentes no oficiales». No se crea ninguna confianza nueva. Sin
  `eta.confidence` (AeroDataBox, consulta manual), la tarjeta no aparece y la fila se reparte entre las restantes, sin
  huecos. La confianza del **pronóstico** sigue dentro de la tarjeta de Turbulencias.

### 5.5 «Ahora»
- **En el aire con radar** (`radar.state === 'volando'`): punto verde y «Señal radar reciente» en la cabecera. Cuatro
  celdas: Altitud (`radar.altFt` en pies, con los metros en pequeño), Velocidad (`kmh`), Distancia restante
  (`remainingKm`, animada con `.tm-remaining`, como hoy) y Última señal (`seenS`, «X s» o «X min»). Al desplegar: el
  indicativo, «Avión localizado por su ruta, posición y modelo…» (`match === 'ruta'`), `aircraftChanged` y la fuente
  (adsb.lol).
- **Señal reciente pero no actual** (`radar.state === 'reciente'`): punto ámbar, «Sin señal reciente», y en las celdas
  «Última señal: X min» con el resto en «—». Ver §8.
- **Localizando** (`localizando`): punto azul animado y «Buscando el avión en el radar…».
- **Sin señal / no disponible** (`sin-senal`, `sin-datos`, `no-disponible`): punto gris y el texto corto actual.
- **En tierra antes de salir**: el estado operativo de Aena y, si existen, «Terminal X · Puerta Y». Se conservan toda la
  lógica de puerta y sus textos (zona de una letra, «Aún sin asignar», «Cambio de puerta»).
- **Finalizado**: la tarjeta «Ahora» no aparece.

### 5.6 «Horario»
Línea de tiempo horizontal con cuatro hitos: salida programada, salida real o prevista, llegada programada y llegada
final, prevista o estimada. Datos de `card.dep` / `card.arr` y `currentPunctuality` (`sched`, `time`, `final`).
- Gris: programado. Verde: real o final (Aena `final`). Azul: estimación Turbi (`arr.estimated`). Previsto por Aena
  (aún no final): punto azul marino con contorno y la etiqueta «Prevista». Hito que aún no existe: `--:--` y
  «Pendiente» en gris.
- Los avisos de discrepancia (`dep.alt`, `arr.alt`, `beforeTakeoff`) se ven sin desplegar, como una línea ámbar corta.
- **Al desplegar**: la puntualidad completa de hoy y el historial (`punctualityHtml`: 90 días, retraso habitual,
  percentiles, cancelaciones, los últimos 7 vuelos y la comparación), con el nuevo estilo y el contenedor
  `#punctuality` (se rellena de forma asíncrona, como hoy).
- AeroDataBox: los mismos hitos con sus horas (programada / revisada / real) y la línea «Horario según AeroDataBox ·
  consultado hace X».

### 5.7 «Turbulencias»
- Cabecera: «General» con el nivel (`summary.headline`, coloreado por `maxLevel`) y, a la derecha, «Tramo más movido»
  (`summary.moments[0]`). La hora del tramo: si origen y destino comparten zona horaria, la hora local
  (`forecastProfile.departureMs + min`); si no, «min 35–48». Turbi no inventa una zona horaria intermedia.
- **Gráfica compacta de barras verticales**: el perfil (`view.segments`, sobre el tiempo **en el aire**, como hoy)
  muestreado en barras finas a lo largo del vuelo. Altura según la intensidad de cada punto (el índice 0–100 si el
  `view` lo trae; si no, el nivel). Color por nivel. Los tramos sin datos (`missing`), rayados. Eje con 3–4 horas (o
  minutos, con la misma regla). Tocar la gráfica selecciona el tramo y abre `#seg-detail`: se conservan `data-seg` y
  `segmentDetailHtml`.
- **Al desplegar**: confianza del pronóstico (`view.confidence`, con sus motivos), máximo, duración y momentos,
  reparto por niveles, cobertura incompleta, tendencia (`#trend`), «Escuchar previsión» (`#speak`, con icono y sin
  emoji), la lista de tramos con causa, altura y lugar, «Condiciones por altitud» y «¿Qué significa?».
- Estados: «Calculando…» (esqueleto suave), cálculo simplificado v1 (misma tarjeta, con una línea que lo dice),
  «Previsión no disponible» con «Reintentar», y las notas que hoy sustituyen al pronóstico (`.note`, mismo texto).
- El aviso legal («Estimación orientativa… no es información operacional») sigue visible, en pequeño, al final de la
  ficha.

### 5.8 «Radar» (en el aire) / «Ruta prevista» (antes) / «Ruta realizada» (finalizado)
- Mapa Leaflet en una tarjeta propia, **fuera de `.flight`**, para que no se destruya en cada repintado. Se pinta en
  cuanto se conoce la ruta: el arco de círculo máximo entre los aeropuertos (`buildRoute`, ya existente), sin esperar
  a la meteorología. Cuando llega el pronóstico, se añaden como hoy SIGMET y PIREP; los colores de turbulencia sobre la
  ruta se mantienen.
- Teselas de OSM más suaves por CSS (`filter` de saturación/brillo sobre la capa) para acercarse a la referencia, con
  los extremos como puntos marcados con su código IATA.
- **Avión**: un marcador con el icono de avión, orientado si hay rumbo, solo si el radar está «volando» **y** trae
  `lat` / `lon` (§9). Cada lectura nueva mueve el marcador; no hay animación entre lecturas ni interpolación. Sin
  coordenadas, la misma tarjeta sin avión.
- Debajo del mapa, en el aire: Indicativo (`radar.callsign`), Avión (modelo) e Identificación («Directa» si el
  indicativo es exacto, «Por ruta» si `match === 'ruta'`). No se muestra «Estable»: no existe ese dato.
- Ampliar: un botón abre el mapa a pantalla completa (overlay propio) y lo cierra.

### 5.9 «Avión» (antes de salir)
Miniatura de la foto, modelo y aerolínea. Matrícula y transpondedor solo en vuelos de AeroDataBox (`reg`, `modeS`).
**No hay antigüedad del avión**: no existe ese dato y no se muestra.

### 5.10 «Resumen del vuelo» (finalizado)
Solo lo que Turbi ya posee: distancia en ruta directa (`profile.km`, con esa etiqueta, porque no es la ruta volada),
duración de bloque real (salida y llegada reales) y tiempo en el aire solo con las horas de pista de AeroDataBox. No
hay consumo ni cifras estimadas nuevas.

### 5.11 «Detalles avanzados ›» (cerrado por defecto)
Una tarjeta con categorías desplegables; cada una aparece solo si tiene contenido:
- **Datos del avión**: modelo, aerolínea, operador, atribución completa de la foto, matrícula y transpondedor
  (AeroDataBox).
- **Fuentes utilizadas**: Aena (hace cuánto), AeroDataBox (`sourceNote` / `adbInfo`), radar ADS-B (adsb.lol),
  modelos ECMWF/GFS y su hora (`freshnessHtml`) y Aviation Weather Center.
- **Datos ADS-B**: indicativo, altitud en pies y metros, velocidad vertical (`vRateFpm`), última señal, posición y tipo
  de identificación.
- **El tiempo en los aeropuertos**: METAR/TAF resumidos, SIGMET y PIREP (todo `aviationHtml`, con sus partes oficiales
  desplegables).
- **Códigos compartidos**: el aviso de código compartido y «Operado por» cuando existan. Turbi no tiene una lista de
  códigos comerciales: no se inventa.
- **Información técnica**: clave del vuelo físico, códigos de estado de Aena (`st`, `std`, `sta`), `BUILD_ID`.
- **Historial de actualizaciones**: consulta realizada hace X, última actualización de Aena y de AeroDataBox, y la
  tendencia del pronóstico (`forecastTrend`). Solo marcas de tiempo que ya existen; no se crea un registro nuevo.

## 6. Tres jerarquías según la fase
- **Programado**: hero → ruta → hora de salida → resumen → Ahora (puerta/estado) → Horario → Turbulencias → Avión →
  Ruta prevista → Detalles.
- **En curso**: hero → ruta → llegada → resumen → Ahora (radar) → Horario → Turbulencias → Radar → Detalles.
- **Finalizado**: hero → ruta → llegada final → resumen → Horario → Ruta realizada → Turbulencias (ver §10, pregunta 2)
  → Resumen del vuelo → Detalles.
- La fase sale de los datos actuales (`legPhase`, estado presentado, radar y aterrizaje). Es una función pura de
  presentación con tests propios.

## 7. Otras pantallas
- **Consulta**: misma estética (tarjeta blanca sobre `#F4F8FC`, logotipo, campos claros, botón azul) y la misma
  funcionalidad y textos de ayuda. Se mantienen las reglas de centrado y teclado.
- **Carga**: tarjeta blanca con *spinner* azul.
- **Selector de tramos y oferta de alias**: tarjetas blancas con opciones grandes; sobre la ficha, el selector es una
  fila compacta de chips de ruta. Los atributos de datos no cambian.
- **Pronóstico guardado sin conexión** y **consulta manual** (sin ficha): cabecera simple con la ruta y las horas, y
  la misma tarjeta de Turbulencias. El aviso «sin conexión» se ve como una franja ámbar corta.
- Aviso de nueva versión: el mismo, con el nuevo estilo.

## 8. Estados alternativos que se diseñan y prueban
Radar sin señal reciente · radar buscando el avión · turbulencia fuerte · confianza baja (con la línea «La información
puede ser limitada…») · información incompleta (tarjetas que se omiten) · Aena sin datos o antigua · solo
AeroDataBox · retrasado · cancelado · desviado · varios tramos · alias / código compartido · aterrizaje ADS-B sin
confirmar por Aena · aterrizaje oficial · previsión no disponible · cálculo simplificado · más de una semana vista.
Cada uno tiene un caso en una página de prueba local (§11).

## 9. Ampliación del radar: posición del avión
- `server/radar.mjs` → `flyingResult` (el único sitio que construye `state: 'volando'`; lo usan el indicativo, el hex
  y AeroDataBox) añade `lat` y `lon` (redondeados a 4 decimales) y `posAgeS` (`Math.round(a.seen_pos)`, la antigüedad
  REAL de la posición; decisión de Jaime, 20/10/2026) **solo** si `a.lat`, `a.lon` y `a.seen_pos` son finitos y
  `seen_pos ≤ 60 s`. Los tres campos van juntos; si no, ninguno aparece. Sin `seen_pos` no hay posición: `seen` (último
  mensaje) ya no la sustituye. No cambia nada más: ni la identificación, ni la selección, ni el *polling*, ni la ETA,
  ni los estados, ni `seenS`.
- Frontend: pinta el avión solo con `state === 'volando'`, `lat` / `lon` y `posAgeS` finitos y una antigüedad de la
  posición (`posAgeS` + caché del servidor + tiempo desde la recepción; nunca `seenS`) de 60 s o menos; en cualquier
  otro caso, la ruta sin avión. Nunca interpola. «Última señal» sigue midiendo el último mensaje (`seenS`).
- Tests: `flyingResult` con coordenadas válidas, sin coordenadas, con coordenadas no finitas y con una posición antigua;
  el contrato de la respuesta (`radar-states`, `radar-adb`); y la presentación del mapa con y sin avión.
- Sin deploy: el *Manual Deploy* de Render se hará al validar el rediseño. Hasta entonces, el frontend funciona con el
  servidor actual (sin coordenadas = ruta sin avión).

## 9 bis. Estructura del DOM y repintados (decisión de diseño, de Claude)
- **Orden fijo de bloques**, sin reordenar en vivo: `.flight` (hero, ruta, hora principal, resumen, Ahora, Horario y,
  según la fase, Avión o Resumen del vuelo) → Turbulencias (`#forecast-area`) → Mapa (Radar / Ruta prevista / Ruta
  realizada) → Detalles avanzados. Dentro de `.flight` el contenido sí depende de la fase en cada repintado; fuera de
  `.flight` solo cambian los títulos y el contenido, nunca la posición. Así un vuelo abierto que pasa de programado a
  en curso y a finalizado no recrea el nodo de Leaflet. (Diferencia aceptada con la referencia: en «finalizado», la
  ruta va después de Turbulencias.)
- **Repintado de `.flight` sin perder estado**: `app.js` pasa a repintar mediante un único ayudante
  (`repaintFlight`) que conserva qué desplegables estaban abiertos (por `data-card`) y vuelve a colocar el nodo
  `#punctuality` ya cargado (historial asíncrono) en su hueco del «Horario». Es un cambio de presentación en `app.js`:
  no toca cuándo ni por qué se repinta.
- **«Detalles avanzados» es una tarjeta propia, fuera de `.flight` y fuera de `#forecast-area`.** `#aviation`, `#fresh`
  y el historial de `#trend` se mueven a ella (`forecastExtras` escribe en los nuevos huecos). Las categorías que salen
  de la ficha (avión, ADS-B, Aena, técnica) se regeneran desde el mismo `repaintFlight` en su propio hueco
  (`#adv-flight`). Así, cuando Aena da el vuelo por terminado y `applyAenaLeg` sustituye `#forecast-area` por la nota,
  ni el mapa ni los detalles desaparecen.
- **Barras de turbulencias**: muestreo uniforme del perfil en el aire (unas 40–60 barras). Cada barra toma el nivel del
  tramo que la contiene; la altura usa la puntuación 0–100 del punto si el `view` la expone y, si no, una altura fija
  por nivel. Nula = barra mínima gris punteada, como la línea base de la referencia.

## 10. Decisiones de Jaime (20/10/2026)
1. **«Confianza» de la fila de resumen = confianza de la hora / ETA** (`js/eta.js`), como se describe en §5.4.
2. **Turbulencias en un vuelo finalizado, opción (b).**
   - Si el pronóstico ya estaba en pantalla en esta sesión cuando el vuelo pasa a finalizado (llegada final de Aena en
     `applyAenaLeg` o aterrizaje ADS-B en `paintRadar`), se **conserva** con la etiqueta visible **«Previsión mostrada
     antes del aterrizaje»**. Nunca se presenta como turbulencia observada ni como un dato posterior al vuelo. Para
     ello, `applyAenaLeg` deja de sustituir `#forecast-area` cuando ya contiene un pronóstico pintado (`currentView`
     de este vuelo). Así se cambia solo qué se ve, no cuándo se consulta nada.
   - Si se abre directamente un vuelo ya terminado, o si no había pronóstico en pantalla, se queda la nota corta actual
     (mismos textos de `js/radar.js`).
   - Después del aterrizaje no hay ningún cálculo meteorológico nuevo.
   - Cancelado o desviado: la nota de siempre, aunque hubiera pronóstico (*decisión de Claude*: ese vuelo no ha volado
     esa ruta).

## 10 bis. Condiciones de la aprobación (Jaime, 20/10/2026)
1. **Avisos meteorológicos visibles.** METAR/TAF, SIGMET y PIREP completos van en «Detalles avanzados», pero si la
   lógica actual detecta algo relevante, la tarjeta principal de Turbulencias lo indica en una línea compacta (icono,
   texto corto y enlace «Ver detalles», que abre esa categoría):
   - `view.aviation.sigmets` con elementos → «N avisos oficiales (SIGMET)», en ámbar si alguno `crosses` la ruta, con
     la etiqueta del primero (`label`);
   - `view.aviation.pireps` con elementos → «N informes de pilotos cerca de la ruta», con la etiqueta del primero.
   Sin lógica meteorológica nueva: solo lo que ya devuelven `sigmetsNearRoute` y `pirepsNearRoute`. Si están vacíos o
   no disponibles (`null`), no hay línea en la tarjeta principal.
2. **Lo antiguo nunca parece actual.** La frescura detallada va a «Detalles avanzados», pero en la interfaz principal
   sigue visible todo lo que afecta a la fiabilidad: chip y línea de Aena antigua (`card.stale`), estados del radar
   (`reciente`, `sin-senal`, `localizando`, `no-disponible`), nota de la ETA retenida (`etaSide().note`), «Confianza»,
   banda «sin conexión» del pronóstico guardado y cobertura incompleta del pronóstico. Además, como el radar deja de
   sondear tras una lectura «volando», la tarjeta envejece en pantalla:
   - **«Última señal» se actualiza en vivo** (presentación, sin peticiones): antigüedad = `seenS` + tiempo en la caché del
     servidor (`checked`) + tiempo desde que se recibió, la misma cuenta que `distanceReference`.
   - **Indicador de señal**: verde («Señal radar reciente») mientras la antigüedad sea menor que `MAX_EXTRAPOLATION_S`
     (300 s, el umbral existente a partir del cual la distancia deja de moverse); después, ámbar («Sin señal
     reciente»). A partir de `STALE_MIN` (12 min, de `eta.js`), las celdas de telemetría se atenúan y llevan «hace X
     min».
   - **Avión en el mapa**: se pinta solo mientras la posición tenga 60 s o menos. Pasado ese tiempo sin una lectura
     nueva, el avión **desaparece** y quedan la ruta y los aeropuertos; la ficha sigue diciendo que la señal está
     desactualizada. No hay marcador de «última posición» y la posición no se interpola ni se extrapola (Jaime,
     20/10/2026).
   Estos umbrales son constantes existentes (o la regla de 60 s aprobada): no se crea lógica nueva de radar.

## 11. Verificación
- Toda la suite (`npm test`), más los tests nuevos de presentación: la fase, la fuente, la hora principal y su dato
  secundario, el muestreo de barras, los hitos del horario y las tarjetas omitidas sin datos.
- Una página local de muestras (`scripts/` o `tests/`, sin publicar) que pinta la ficha con objetos `card` y `view`
  representativos de cada estado del §8, para comparar contra la referencia en un viewport de iPhone (390 × 844) y en
  desktop. Las capturas se revisan contra la imagen (espaciado, jerarquía, densidad, tamaños, bordes, tipografía,
  colores y proporciones) y se corrigen las diferencias importantes antes de dar el trabajo por terminado.
- Comprobación final en un iPhone real (Safari y PWA instalada) antes del deploy.

## 12. Lo que queda a criterio de quien lo construya
Los valores exactos de espaciado, radios, sombras y tamaños dentro de los rangos de §4; los trazados de los iconos; el
número de barras de la gráfica; el filtro CSS del mapa; cómo se reparten los cambios entre `ui.js`,
`ui-forecast.js`, `ui-punctuality.js` y módulos nuevos de presentación (`js/icons.js`, `js/ui-card.js`…); y el
mecanismo de los desplegables (`<details>` o propio), siempre que se cumpla el contrato del DOM del §3.

## 13. Regla de la capa de presentación (Jaime, 20/10/2026)
`js/card-model.js` es estrictamente presentación: recibe los resultados de la lógica actual (`eta.js`, `legPhase`,
`presentStatus`, `withRadar`, `withLanding`, `currentPunctuality`, el pronóstico) y decide cómo mostrarlos. No recalcula
la ETA, no crea otra confianza, no redefine estados, no cambia prioridades entre fuentes, no decide aterrizajes y no
duplica reglas del radar. Solo hace derivaciones visuales: qué bloques se muestran, orden de hitos, barras, etiquetas y
formatos.
