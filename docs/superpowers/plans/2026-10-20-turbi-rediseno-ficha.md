# Rediseño de la ficha de Turbi — Plan de implementación

> **Para agentes:** SUB-SKILL OBLIGATORIA: usa superpowers:subagent-driven-development (recomendado) o
> superpowers:executing-plans para ejecutar este plan tarea a tarea. Los pasos usan casillas (`- [ ]`).

**Objetivo:** Turbi pasa a una estética clara y mobile-first que sigue la referencia visual. La ficha se reorganiza
(hero, resumen, Ahora, Horario, Turbulencias, mapa con la posición real del avión y Detalles avanzados) sin cambiar la
lógica funcional.

**Arquitectura:** HTML como cadenas en módulos ES, sin *build*, como hoy. Un módulo nuevo de **modelo de presentación**
(`js/card-model.js`, con funciones puras y testeadas) traduce el objeto `card` y el `view` del pronóstico actuales a lo
que se pinta: fase, hora principal, fuente, confianza, hitos y barras. Los módulos `ui*.js` solo generan el HTML.
`app.js` solo cambia en cómo repinta: un ayudante conserva los desplegables abiertos, el mapa vive fuera de `.flight`,
un contador en vivo envejece la señal y el pronóstico se conserva tras el aterrizaje.

**Tecnología:** JavaScript vanilla (módulos ES), CSS, Leaflet 1.9.4 y OSM (ya en uso), Vitest y jsdom. Para las capturas,
Chrome sin interfaz (`/Applications/Google Chrome.app`).

**Spec:** `docs/superpowers/specs/2026-10-20-turbi-rediseno-ficha-design.md` (léelo entero antes de empezar; los §
de este plan se refieren a él).

## Restricciones globales

- No cambian búsqueda, Aena, AeroDataBox, ADSBDB, adsb.lol, identificación, radar, `radarGate`, ETA, aterrizaje,
  estados, horarios, refrescos, turbulencias, meteorología, cachés ni backend, salvo los `lat`/`lon` de la Tarea 1.
- No se añaden frameworks ni librerías nuevas, no se hace deploy y no se borran tests para que la suite pase. Un test
  solo se actualiza si el cambio es consecuencia legítima del nuevo DOM; en el commit se dice cuál y por qué.
- No se escribe en el código ningún dato de la referencia (IB1668, PMI, 19:18, A321neo, 35.000 ft…).
- Si un dato no existe, no se muestra: ni «—», ni *placeholder*, ni un valor por defecto. Única excepción: los hitos
  del Horario muestran `--:--` y «Pendiente».
- Ningún emoji en la interfaz.
- Iconos: SVG lineales de `js/icons.js`.
- Textos en español con tildes.
- Los textos `ENDED_ESTIMATED`, `NO_ARRIVAL_NOTE` y `LANDED_NOTE` (`js/radar.js`) no cambian.
- Tokens de color: fondo `#F4F8FC`, tarjeta `#FFFFFF`, borde `rgba(15, 40, 80, 0.07)`, sombra
  `0 1px 2px rgba(15,40,80,.04), 0 8px 24px rgba(15,40,80,.05)` y radio de tarjeta de 20 px.
- Transiciones de 150–250 ms, con `prefers-reduced-motion` respetado.
- Se conservan con sus tests: `.screen` (`min-height: 100vh; 100dvh`; grid centrado; `padding-block` con
  `max(safe-area…) + 16px`), `.screen:focus-within` (`100vh; 100svh`, el único uso de `100svh`) y el *padding* de
  zonas seguras de `#result-view`.
- Comentarios y nombres en el estilo del código actual: español y comentarios densos que explican el porqué.
- Trabajo en la rama `feat/rediseno-claro` (worktree con superpowers:using-git-worktrees). Cada tarea termina con
  `npm test` en verde y un commit con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Puntos de revisión

1. **Repintado con un desplegable abierto**: una lectura del radar o un refresco de Aena mientras el usuario tiene
   abierto «Horario» o «Detalles avanzados» no lo cierra ni borra el historial de puntualidad ya cargado (Tarea 8).
2. **Ficha que se queda abierta mucho tiempo en vuelo**: tras 6 y 13 min sin lecturas nuevas, la señal pasa a ámbar,
   la telemetría se atenúa y el avión del mapa queda hueco. Nada aparenta ser actual (Tareas 2 y 8).
3. **Vuelo que aterriza con el pronóstico en pantalla**: el pronóstico se queda con «Previsión mostrada antes del
   aterrizaje». Si el vuelo se cancela o se desvía, se ve la nota (Tarea 8).
4. **Datos parciales**: vuelo de AeroDataBox sin foto, sin puntualidad y sin confianza; respuesta del radar del
   servidor actual sin `lat`/`lon`. La fila de resumen no deja huecos y el mapa no muestra el avión (Tareas 2, 4 y 6).
5. **iPhone con teclado y barras de Safari**: la pantalla de consulta sigue centrada, sin saltos al abrir el teclado y
   sin franjas de otro color tras quitar la foto (Tarea 3; comprobación manual en la Tarea 10).

---

### Tarea 1: el radar expone `lat`/`lon` (servidor)

**Ficheros:**
- Modificar: `server/radar.mjs` (`flyingResult`, línea ~158)
- Test: `tests/radar.test.js` (nuevo `describe('posición del avión en la respuesta')`)

**Interfaces:**
- Produce: las respuestas `state: 'volando'` llevan `lat: number` y `lon: number` (4 decimales) solo si
  `Number.isFinite(a.lat) && Number.isFinite(a.lon) && (a.seen_pos ?? a.seen ?? Infinity) <= POSITION_MAX_AGE_S`.
  `POSITION_MAX_AGE_S = 60` se exporta. Si no se cumple, las claves no existen (no `null`). Llega automáticamente a
  `identify.mjs` y `radar-adb.mjs`, que hacen *spread* de `flyingResult`.

- [ ] **Paso 1: tests que fallan.** En el `describe` nuevo:
  - `flyingResult({ alt_baro: 35000, gs: 450, lat: 39.123456, lon: 2.987654, seen: 3, seen_pos: 5 }, 'IBE1', [40.47, -3.56])`
    devuelve `lat: 39.1235` y `lon: 2.9877`;
  - con `seen_pos: 61`, no tiene la clave `'lat'` ni `'lon'` (`expect(r).not.toHaveProperty('lat')`);
  - sin `lat`/`lon`, sin las claves y con el resto igual que antes (`state`, `callsign`, `altFt`, `kmh`, `seenS`,
    `remainingKm`);
  - con `lat: NaN`, sin las claves;
  - sin `seen_pos` y con `seen: 10`, con las claves (se usa `seen`).
- [ ] **Paso 2:** `npx vitest run tests/radar.test.js`. Resultado esperado: FAIL en los casos con coordenadas.
- [ ] **Paso 3:** implementar en `flyingResult`, con un comentario que diga que solo es la posición medida (sin
  interpolar) y que el frontend la pinta tal cual.
- [ ] **Paso 4:** `npm test`. Resultado esperado: todo en verde (`identify`, `radar-adb` y `radar-states` siguen
  pasando).
- [ ] **Paso 5:** commit `feat(radar): posición del avión (lat/lon ≤ 60 s) en la respuesta «volando»`.

### Tarea 2: modelo de presentación (`js/card-model.js`)

**Ficheros:**
- Crear: `js/card-model.js`
- Modificar: `js/app.js`: `flightCard()` y `adbCard()` añaden campos al `card` (abajo)
- Test: `tests/card-model.test.js`

**Interfaces** (todas puras, con `nowMs` inyectable):
- Campos nuevos del `card` (los rellena `app.js`; los tests usan objetos literales):
  - `phase`: `legPhase(leg)` → `'pendiente' | 'en-curso' | 'terminado' | 'cancelado'`. En AeroDataBox:
    `Arrived` → `terminado`; `Canceled*` / `Diverted` → `cancelado`; con salida real (`leg.dep.runway` o
    `leg.dep.actual`) → `en-curso`; si no, `pendiente`.
  - `depFinal` y `arrFinal`: booleanos. En Aena, de `currentPunctuality(leg).dep/arr.final`; en AeroDataBox, si hay hora
    real o de pista.
  - `timeConfidence`: `eta?.confidence ?? null` (`'high' | 'medium' | 'low' | 'very-low'`). En AeroDataBox, siempre
    `null`. `paintRadar` lo actualiza con la ETA nueva (Tarea 8).
  - `punctuality`: `currentPunctuality(leg)` (solo Aena; `null` en AeroDataBox).
  - `source`: `'aena' | 'aerodatabox'`.
  - `cities`: `{ o, a }` (ciudad de `findAirport`; `null` si no se conoce).
  - `aircraftReg` y `aircraftHex`: solo en AeroDataBox (`leg.reg`, `leg.modeS`).
  - `radarReceivedAt`: ms en que se recibió la lectura del radar que lleva el `card` (lo pone `paintRadar`).
  - `depMs` / `arrMs` (UTC, de `buildFlight`), `km` (`profile.km`), `physicalKey` (`physicalFlightKey(leg)` o
    `adbKey`) y `aenaCodes` (`{ st, std, sta }`, solo Aena). Los usan las Tareas 4 y 7.
- `flightPhase(card) → 'programado' | 'en-curso' | 'finalizado' | 'cancelado'`. Orden: `phase === 'cancelado'` o el
  estado contiene «Desviado» → `'cancelado'`; `status.landing` o `phase === 'terminado'` → `'finalizado'`;
  `radar?.state` en (`volando`, `reciente`) o `phase === 'en-curso'` → `'en-curso'`; si no, `'programado'`.
- `mainTime(card, nowMs) → { time, label, plusDay, note, aside: { label, value } | null } | null`, según §5.3:
  - `programado`: la salida (`dep.est ?? dep.time`); la etiqueta es «Salida prevista» si hay `est`, y si no «Salida
    programada»; `aside` es «Sale en» con `formatCountdown` si es futura.
  - `en-curso`: la llegada visible; la etiqueta es «Llegada estimada» si es `estimated`, «Llegada prevista» si no;
    `note = arr.note`; `aside` es «Llega en».
  - `finalizado`: la llegada; la etiqueta es «Llegada final» si `arrFinal`, «Aterrizado · radar ADS-B» si
    `status.landing === 'confirmed-landed'`, y si no la de `en-curso`; `aside` es «Duración», solo con
    `depFinal && arrFinal`.
  - `cancelado`: `null`.
  - Los minutos hasta o desde una hora local salen de `card.depMs` / `card.arrMs`, ms UTC que añade `app.js` a partir de
    `buildFlight`: `departureMs` y la llegada visible.
- `formatCountdown(ms) → '42 min' | '2 h 15 min' | '1 h'`. Devuelve `null` si `ms <= 0`.
- `sourceLabel(card) → 'Aena' | 'AeroDataBox' | 'Radar + Aena' | 'Radar + AeroDataBox' | 'Estimación Turbi'`.
  «Radar + …» si `radar.state` es `volando` o `aterrizado`. Con Aena sin llegada publicada y `arr.estimated` en
  `en-curso`, «Radar + Aena» si hay radar; si no, «Estimación Turbi».
- `confidenceInfo(level) → { text: 'Alta' | 'Media' | 'Baja' | 'Muy baja', tone: 'ok' | 'warn' | 'bad', limited: boolean } | null`.
  `limited` es verdadero en `low` y `very-low`. Con `null` o `undefined`, devuelve `null`.
- `punctualityTile(p) → { text, band } | null`: «+N min» o «N min antes» con la banda; «En hora» si `sin-cambios`;
  «Cancelado» o «Desviado»; `null` si `p` es `null` o `sin-datos`.
- `summaryTiles(card) → Array<{ key: 'punctuality' | 'source' | 'confidence', label, value, tone }>` sin los que faltan.
- `milestones(card) → [{ key: 'dep-sched' | 'dep-real' | 'arr-sched' | 'arr-best', time: 'HH:MM' | '--:--', caption,
  kind: 'sched' | 'real' | 'aena-est' | 'turbi' | 'pending' }]` (4 elementos), según §5.6:
  - `dep-real`: `real` si `depFinal`, `aena-est` si hay `dep.est`, y si no `pending`;
  - `arr-best`: `real` con «Final» si `arrFinal`, `turbi` con «Estimada» si `arr.estimated`, `aena-est` con «Prevista»
    si hay `arr.est`, y si no `pending`;
  - con `dep` o `arr` nulos, los programados de ese lado son `pending`.
- `signalState(radar, receivedAtMs, nowMs) → { ageS, level: 'live' | 'old' | 'stale', text } | null`. `ageS` sale de
  `distanceReference(radar, receivedAtMs).ageAtReceiptS + (nowMs − receivedAtMs) / 1000`. `live` si `ageS < 300`
  (`MAX_EXTRAPOLATION_S`); `stale` si `ageS ≥ STALE_MIN * 60`; si no, `old`. `text` es «X s» por debajo de 60 s y
  «X min» por encima. Devuelve `null` si `radar.state !== 'volando'`.
- `planeOnMap(radar, receivedAtMs, nowMs) → { lat, lon, stale: boolean, ageMin } | null`. Devuelve `null` sin
  `lat`/`lon` finitos o si el estado no es `volando`. `stale` si la antigüedad (la misma cuenta que arriba) supera 60 s.
- `turbulenceBars(view, maxBars = 56) → [{ level: 0..3 | null, seg: number }]`: muestreo uniforme de `view.route`
  (un punto por paso de tiempo). `level = null` significa sin datos. `seg` es el índice del tramo de `view.segments`
  que contiene el minuto del punto (`i * durationMin / (n − 1)`). Con más puntos que `maxBars`, se coge uno de cada
  `ceil(n / maxBars)`.
- `roughestSpan(view) → { text } | null`: con `summary.maxLevel === 0`, `null`. Si `originTz === destinationTz`,
  «HH:MM – HH:MM» (`view.depMs + min`, en esa zona); si no, «min A–B». Usa `summary.moments[0]`.
- `weatherAlerts(aviation) → [{ kind: 'sigmet' | 'pirep', text, crosses }]`: «N avisos oficiales (SIGMET)» o «1 aviso
  oficial (SIGMET)» con la `label` del primero, y `crosses` si alguno cruza la ruta; «N informes de pilotos cerca de la
  ruta» con la `label` del primero. Lista vacía si son `null` o están vacíos.

- [ ] **Paso 1: tests que fallan**, uno por función y con estos casos como mínimo:
  - `flightPhase`: cancelado, desviado, aterrizado por ADS-B (`status.landing: 'confirmed-landed'`), terminado por
    Aena, en curso por radar `volando` con `phase: 'pendiente'` (estado de puerta retrasado) y programado.
  - `mainTime`:
    - programado con retraso → «Salida prevista» y `aside.value === '2 h 15 min'` (con `nowMs` fijo);
    - en curso con ETA Turbi → `note === arr.note` y «Llegada estimada»;
    - finalizado con `depFinal && arrFinal` → «Duración»;
    - aterrizado ADS-B sin `arrFinal` → «Aterrizado · radar ADS-B»;
    - cancelado → `null`.
  - `sourceLabel`: las cinco salidas.
  - `confidenceInfo`: los cuatro niveles, `null` → `null` y `limited` en `low` y `very-low`.
  - `summaryTiles`: AeroDataBox sin puntualidad ni confianza → solo `source`.
  - `milestones`:
    - salida real con llegada estimada por Turbi → `kinds ['sched', 'real', 'sched', 'turbi']`;
    - sin llegada (`arr: null`) → `'--:--'` y `'pending'`.
  - `signalState`:
    - `seenS: 5` recibido ahora → `live`;
    - 6 min después → `old`;
    - 13 min después → `stale`;
    - `checked` 50 s antes de recibir suma 50 s.
  - `planeOnMap`: sin `lat` → `null`; a los 61 s → `stale: true`.
  - `turbulenceBars`: 120 puntos → ≤ 56 barras con `seg` correcto en los extremos; punto con `level: null` →
    `level: null`.
  - `roughestSpan`: misma zona → «18:35 – 18:48» con un `view` construido en el test; zonas distintas → «min 35–48»;
    `maxLevel` 0 → `null`.
  - `weatherAlerts`: `null` → `[]`; 2 SIGMET, uno de ellos `crosses` → `crosses: true` y «2 avisos oficiales (SIGMET)».
- [ ] **Paso 2:** `npx vitest run tests/card-model.test.js`. Resultado esperado: FAIL (no existe el módulo).
- [ ] **Paso 3:** implementar `js/card-model.js` (importa `STALE_MIN` de `eta.js` y `distanceReference` y
  `MAX_EXTRAPOLATION_S` de `radar-distance.js`). Añadir los campos nuevos del `card` en `flightCard()`/`adbCard()` y
  `depMs`/`arrMs` en `buildFlight()`.
- [ ] **Paso 3b:** `npx vitest run tests/card-model.test.js`. Resultado esperado: PASS.
- [ ] **Paso 4:** `npm test`. Resultado esperado: todo en verde (los campos nuevos no cambian el HTML actual).
- [ ] **Paso 5:** commit `feat(app): modelo de presentación de la ficha (fase, hora principal, fuente, confianza, hitos, señal)`.

### Tarea 3: sistema visual claro, iconos y pantallas de consulta y carga

**Ficheros:**
- Crear: `js/icons.js`
- Modificar: `css/style.css` (reescritura: tokens, base, pantallas, formulario, botones, aviso de versión),
  `index.html` (metas y barra superior de la ficha), `manifest.json` y `sw.js` (`SHELL` sin `img/sky.jpg` y con
  `js/icons.js` y `js/card-model.js`)
- Test: `tests/layout.test.js`, `tests/icons.test.js`

**Interfaces:**
- `icon(name, { size = 20, label = null } = {}) → string`: un `<svg>` *inline* con
  `stroke="currentColor" stroke-width="1.75" fill="none" stroke-linecap="round" stroke-linejoin="round"`,
  `viewBox="0 0 24 24"`, `aria-hidden="true"` sin `label` o `role="img"` con `aria-label` con él. Nombres:
  `altitude`, `speed`, `distance`, `signal`, `clock`, `plane`, `route`, `turbulence`, `sources`, `shield`, `chevron`,
  `refresh`, `back`, `expand`, `close`, `gate`, `sound`, `alert`, `info`. Con un nombre desconocido, lanza `Error`.
- Tokens CSS en `:root`, que usan todas las tareas siguientes: `--bg`, `--card`, `--border`, `--shadow`,
  `--radius: 20px`, `--text` (azul marino, p. ej. `#0E2240`), `--muted`, `--faint`, `--accent` (azul Turbi),
  `--ok`, `--warn`, `--bad`, `--lvl0..3`, `--ease: 200ms cubic-bezier(.2,.7,.2,1)`. Clases base: `.card` (tarjeta),
  `.card-head` (título + chevron), `.kv` (etiqueta + valor), `.chip.tone-{ok,info,warn,bad,stale}` y
  `.dot.tone-{…}`.
  - Ojo: hoy existe `.card` para los tramos de turbulencia. Se renombra a `.seg-card` en la Tarea 5. Aquí ya se
    define la nueva `.card`.
- `index.html`:
  - `<meta name="theme-color" content="#F4F8FC">`;
  - `apple-mobile-web-app-status-bar-style` = `default`;
  - `.result-bar` con `#back` (icono `back` y `aria-label="Nueva consulta"`), el logotipo centrado y `#refresh` (icono
    `refresh` y `aria-label="Actualizar"`). Los iconos se insertan desde `app.js` al arrancar, para no duplicar los SVG
    en el HTML.
- `manifest.json`: `background_color` y `theme_color` = `#F4F8FC`.

- [ ] **Paso 1: tests.** En `tests/layout.test.js`, el `describe('fondo a pantalla completa')` se sustituye por
  `describe('fondo claro')`. Comprueba:
  - `html` y `body` tienen un `background` / `background-color` con `var(--bg)`, y `--bg` en `:root` es `#F4F8FC`;
  - no queda `sky.jpg` en `css/style.css`, `index.html` ni `sw.js`;
  - no hay ninguna regla `body::before`.

  El resto de `layout.test.js` no se toca. En `tests/icons.test.js`: cada nombre devuelve un `<svg` con
  `currentColor`; `label` añade `aria-label`; un nombre desconocido lanza `Error`.

  En `tests/pwa.test.js`: `theme-color`, `status-bar-style` = `default` y `manifest` con `#F4F8FC`.
- [ ] **Paso 2:** `npx vitest run tests/layout.test.js tests/icons.test.js tests/pwa.test.js`. Resultado esperado: FAIL.
- [ ] **Paso 3:** implementar (borrar `img/sky.jpg` con `git rm`). La consulta es una tarjeta blanca sobre `--bg`, con
  el logotipo, campos claros (`background: #F1F5FA`, borde `--border` y foco con `--accent`) y el botón azul. Carga:
  tarjeta blanca y *spinner* `--accent`. Antes de aplicar el logotipo actual (`img/turbi-logo.png`), mira si tiene
  buen contraste sobre blanco y anota el resultado en el commit.
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde, salvo los tests de `ui*.test.js` que dependen de clases
  que se rehacen en las Tareas 4 y 5. Si alguno falla aquí, es porque esta tarea ha tocado un selector de la ficha:
  corrígelo en el CSS, no en el test.
- [ ] **Paso 5:** commit `feat(estilo): estética clara, iconos lineales y pantallas de consulta y carga sin foto de fondo`.

### Tarea 4: tarjeta del vuelo (`.flight`)

**Ficheros:**
- Modificar: `js/ui.js` (`flightCardHtml` y el resto de ayudantes de la ficha; `radarHtml` pasa a `nowCardHtml`),
  `js/ui-punctuality.js` (el mismo contenido con el nuevo estilo: clases `.kv`, `.card`), `css/style.css`
- Test: `tests/ui.test.js`, `tests/ui-punctuality.test.js`

**Interfaces:**
- Consume el `card` con los campos de la Tarea 2, `card-model.js` y `icon()`.
- `flightCardHtml(card, { nowMs = Date.now(), open = new Set() } = {}) → string`: devuelve `<section class="flight">`
  con, en este orden:
  - `.hero`: foto, `figcaption` con la atribución (se conserva su lógica exacta), número, «Aerolínea · Modelo» y el
    chip de estado con su nota;
  - `.route-codes` (códigos y ciudades);
  - `.main-time` (`mainTime`);
  - `.tiles` (`summaryTiles`; si `limited`, la línea «La información puede ser limitada o proceder de fuentes no
    oficiales.»);
  - `<details class="card" data-card="now">` («Ahora»; se omite si la fase es `finalizado` o `cancelado`);
  - `<details class="card" data-card="schedule">` («Horario», con los hitos, los avisos `alt` / `beforeTakeoff`
    visibles en el `summary` y, en el cuerpo, `<section id="punctuality">`, vacío salvo lo que pinte `app.js`);
  - `<details class="card" data-card="aircraft">` solo en `programado`;
  - `.card[data-card="flight-summary"]` solo en `finalizado`: distancia directa (`card.km`, que añade `app.js` desde
    `profile.km`), duración real y tiempo en el aire solo con horas de pista.
  - `open` dice qué `data-card` llevan el atributo `open`.
- «Ahora» por estado de radar (§5.5):
  - `volando`: cuatro `.tm-cell` con `.tm-label` / `.tm-value`; «Velocidad» se conserva para `app-flow`; la distancia
    en `.tm-value.tm-remaining`; la altitud con `thousands(altFt)` y `<small>ft</small>`, y los metros en un `<small>`
    aparte. Cabecera con `.signal` (`data-signal-level` de `signalState`) y su texto: «Señal radar reciente» o «Sin
    señal reciente».
  - `reciente`: chip ámbar y «Última señal · hace X min» (de `radar.ageMin`).
  - `localizando`: «Buscando el avión en el radar…».
  - `sin-senal` / `sin-datos`: «Sin señal ADS-B reciente».
  - `no-disponible`: «El radar no responde ahora mismo».
  - Sin radar: el estado de Aena y la puerta. Se conserva exactamente la lógica de puerta y sus textos (zona de una
    letra, «Aún sin asignar», «Cambio de puerta»).
  - Al desplegar: indicativo, notas de `match === 'ruta'` y `aircraftChanged` (mismos textos), y fuente.
  - Datos antiguos (`card.stale`): chip `tone-stale` con «X hace Y» y la línea «Datos de Aena de hace X»; sin «Ahora»
    con telemetría.
- `legSwitchHtml` y `aliasOfferHtml` (en `app.js`): mismas clases y atributos de datos, con el estilo nuevo (chips y
  tarjetas).

- [ ] **Paso 1: tests.** Rehacer los `describe` de `tests/ui.test.js` que comprueban la estructura antigua, conservando
  lo que comprueban en esencia. Cada test que cambia o desaparece se justifica en el mensaje del commit. Casos:
  - Puerta: zona, sin asignar, cambio y escape (los mismos textos).
  - Logotipo: misma URL y respaldo.
  - Volando:
    - `.tm-cell` «Velocidad»;
    - `.tm-remaining`;
    - altitud «35.000» + «ft» con `altFt: 35000` (dato del test, no del código);
    - `[data-signal-level="live"]`;
    - sin `lat` no pasa nada.
  - Identificado por ruta: el texto actual.
  - Reciente, sin señal, no disponible y aterrizado: textos cortos y ningún panel.
  - Datos antiguos: chip `tone-stale` y ninguna `.tm-cell`.
  - Fila de resumen:
    - AeroDataBox → una sola `.tile`;
    - `timeConfidence: 'very-low'` → «Muy baja» y la línea de información limitada.
  - Fases:
    - `finalizado` → sin `data-card="now"` y con `data-card="flight-summary"`;
    - `programado` → `data-card="aircraft"` sin matrícula en Aena y con `EC-…` solo si `aircraftReg` existe (valor
      del test).
  - `open: new Set(['schedule'])` → `details[data-card="schedule"][open]`.
  - Sin emojis: `flightCardHtml(...)` no contiene `/\p{Extended_Pictographic}/u`.
- [ ] **Paso 2:** `npx vitest run tests/ui.test.js tests/ui-punctuality.test.js`. Resultado esperado: FAIL.
- [ ] **Paso 3:** implementar el HTML y el CSS (§4, §5.1–5.6, §5.9–5.10).
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde. Si `app-flow` falla por un *hook*, se conserva el *hook*.
- [ ] **Paso 5:** commit `feat(app): tarjeta del vuelo con hero, resumen, Ahora y Horario`.

### Tarea 5: tarjeta de Turbulencias

**Ficheros:**
- Modificar: `js/ui-forecast.js` (`forecastSectionHtml`, `summaryHtml`, `timelineHtml`, `explainHtml`, estados de
  carga, error y simplificado), `js/ui.js` (`renderResult` / `legacyBody`, el cálculo v1, a la misma tarjeta),
  `css/style.css`
- Test: `tests/ui-forecast.test.js`, `tests/ui.test.js` (bloque v1)

**Interfaces:**
- `forecastSectionHtml(view, nowMs, { preLanding = false, open = new Set() } = {}) → string`: devuelve
  `<details class="card turb" data-card="turbulence">` con:
  - un `<h3 class="section">Turbulencias</h3>` dentro del `summary` (`app-flow` lo busca);
  - con `preLanding`, el chip «Previsión mostrada antes del aterrizaje»;
  - «General» (`summary.headline` coloreado por `maxLevel`) y «Tramo más movido» (`roughestSpan`, solo si no es
    `null`);
  - `#timeline` con la gráfica: un `<button type="button" class="tbar lvl{n}" data-seg="{seg}">` por barra de
    `turbulenceBars`; `missing` si `level === null`; nula = barra mínima punteada; altura fija por nivel;
  - el eje con 3–4 marcas (horas con la regla de `roughestSpan`; si no, minutos) y `#seg-detail`;
  - `.wx-alerts` con `weatherAlerts(view.aviation)` y un enlace `data-open="adv-weather"`;
  - en el cuerpo: confianza del pronóstico con sus motivos, datos (máximo, duración, momentos), barra de reparto,
    cobertura incompleta, `#trend`, `#speak` (icono `sound` y «Escuchar previsión»), la lista `.seg-card` de tramos,
    `#altitudes` y «¿Qué significa?».
  - Sin emojis: el `HEAD.emoji` se sustituye por un punto de color de nivel.
- `timelineHtml(view)` devuelve solo el contenido de `#timeline`, porque `app.js` lo repinta tras `nameSegments`.
- `FORECAST_LOADING`, `forecastUnavailableHtml` y la nota (`.note`) se pintan dentro de una `.card` con el mismo
  `h3.section` «Turbulencias». La nota conserva su texto.
- Fuera de la tarjeta, al final de `#forecast-area`: `.disclaimer` (mismo texto).
- `#aviation`, `#fresh` y `#map` **dejan** de generarse aquí (Tareas 6 y 7).

- [ ] **Paso 1: tests** en `tests/ui-forecast.test.js`:
  - las barras tienen `data-seg` válido y su número es ≤ 56;
  - `preLanding` muestra exactamente «Previsión mostrada antes del aterrizaje»;
  - `weatherAlerts`: con 1 SIGMET que `crosses` → `.wx-alerts .tone-warn` con «1 aviso oficial (SIGMET)»; con
    `aviation` en `null` → ninguna `.wx-alerts`;
  - no aparecen `id="aviation"` ni `id="map"`;
  - `h3.section` es «Turbulencias»;
  - sin emojis;
  - la cobertura menor de 0,95 sigue diciendo el %;
  - v1 (`renderResult` con `sectionOnly`): misma tarjeta y barras.
- [ ] **Paso 2:** `npx vitest run tests/ui-forecast.test.js tests/ui.test.js`. Resultado esperado: FAIL.
- [ ] **Paso 3:** implementar (§5.7). En `app.js`, el selector del clic de tramo pasa a `button[data-seg]`, que ya es
  así; solo se comprueba.
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde.
- [ ] **Paso 5:** commit `feat(app): tarjeta de Turbulencias con gráfica de barras y avisos meteorológicos compactos`.

### Tarea 6: tarjeta del mapa con la posición del avión

**Ficheros:**
- Modificar: `js/map.js`, `css/style.css`
- Test: `tests/map.test.js` (nuevo; Leaflet simulado con un `L` falso en `globalThis`)

**Interfaces:**
- `mapCardHtml(phase) → string`: `<section class="card map-card" id="map-card">` con un título según la fase
  («Ruta prevista», «Radar» o «Ruta realizada»), `<div id="map" class="map">`, `#map-facts` (vacío) y el botón
  `data-map="expand"` (icono `expand`).
- `createRouteMap(el, { origin: { iata, lat, lon }, destination: {…}, route: [{ lat, lon }] }) → Promise<RouteMap>`.
  `RouteMap` tiene:
  - `setForecast(view)`: colorea la ruta por nivel (`routeLines`, ya existe) y añade SIGMET y PIREP como hoy;
  - `setPlane(plane)`: recibe `planeOnMap(...)` o `null`. Crea, mueve o quita un `L.marker` con `divIcon` (icono
    `plane`); clase `.plane-stale` y *tooltip* «Última posición · hace X min» si `stale`;
  - `invalidate()`: `invalidateSize` tras ampliar;
  - `destroy()`.
- La ruta inicial sale de `buildRoute(origin, destination, 0)` (sin meteorología); `app.js` se la pasa.
- Capa de teselas con `className: 'tiles-soft'`. En CSS: `.tiles-soft { filter: saturate(.55) brightness(1.06) contrast(.92); }`.
- Ampliar: `.map-card.expanded` a pantalla completa (`position: fixed; inset: 0` con zonas seguras) y botón `close`.
- `routeLines` no cambia.

- [ ] **Paso 1: tests:**
  - `setPlane(null)` no crea un marcador;
  - `setPlane({ lat, lon, stale: false })` crea uno; una segunda llamada lo mueve (`setLatLng`) sin crear otro;
  - `stale: true` añade `.plane-stale` y el *tooltip* con «hace»;
  - `setPlane(null)` después lo quita;
  - `mapCardHtml('en-curso')` contiene «Radar»;
  - `routeLines` sigue con sus casos.
- [ ] **Paso 2:** `npx vitest run tests/map.test.js`. Resultado esperado: FAIL.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde.
- [ ] **Paso 5:** commit `feat(mapa): tarjeta del mapa independiente del pronóstico, con la posición real del avión`.

### Tarea 7: Detalles avanzados

**Ficheros:**
- Crear: `js/ui-advanced.js`
- Modificar: `js/ui-forecast.js` (`aviationHtml` y `freshnessHtml` se exportan como hoy, con el estilo nuevo),
  `css/style.css`
- Test: `tests/ui-advanced.test.js`

**Interfaces:**
- `advancedShellHtml() → string`: `<details class="card adv" data-card="advanced">`, cerrado, con los huecos
  `#adv-flight`, `<details data-card="adv-weather"><div id="aviation"></div></details>`, `#adv-sources` (dentro está
  `#fresh`) y `#adv-history`.
- `advancedFlightHtml(card, { open = new Set() }) → string`: devuelve las categorías «Datos del avión», «Datos ADS-B»
  (indicativo, altitud en ft y m, `vRateFpm`, última señal, posición `lat`/`lon` y tipo de identificación),
  «Códigos compartidos» (solo `photo.shared` u `operator`), «Información técnica» (clave del vuelo físico, que
  `app.js` pone en `card.physicalKey`; `st`/`std`/`sta` en `card.aenaCodes`; `BUILD_ID`) y la parte de vuelo de
  «Fuentes utilizadas» (Aena hace X; AeroDataBox `sourceNote`; radar adsb.lol). Cada categoría es un
  `<details data-card="adv-…">` que solo aparece si tiene contenido.
- `advancedHistoryHtml({ queriedAt, aenaUpdatedAgo, trend }, nowMs) → string`: solo las marcas que existan.

- [ ] **Paso 1: tests:**
  - un vuelo de Aena sin radar no tiene «Datos ADS-B»;
  - con radar `volando` y `lat` sí la tiene, con la posición;
  - AeroDataBox con `aircraftReg` muestra la matrícula; Aena no;
  - sin `photo.shared` ni `operator` no hay «Códigos compartidos»;
  - el *shell* está cerrado por defecto (sin `open`);
  - `aviationHtml` sigue mostrando los partes oficiales desplegables (`details.raw`).
- [ ] **Paso 2:** `npx vitest run tests/ui-advanced.test.js`. Resultado esperado: FAIL.
- [ ] **Paso 3:** implementar (§5.11).
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde.
- [ ] **Paso 5:** commit `feat(app): Detalles avanzados con fuentes, ADS-B, tiempo en los aeropuertos y datos técnicos`.

### Tarea 8: integración en `app.js`

**Ficheros:**
- Modificar: `js/app.js`, `js/ui-forecast.js` (`flightShellHtml`, `flightNoteHtml` y `renderForecast` con el nuevo
  orden de bloques)
- Test: `tests/app-flow.test.js` (casos nuevos; los existentes deben seguir pasando)

**Interfaces y cambios** (solo presentación; ni cuándo se consulta ni qué se decide):
- **Orden de bloques** en `flightShellHtml` / `flightNoteHtml`: `legSwitchHtml`, `.flight`, `#forecast-area`,
  `mapCardHtml(phase)` y `advancedShellHtml()`.
- **`repaintFlight(card)`** sustituye a todos los `el.outerHTML = flightCardHtml(...)` (en `paintRadar` y
  `applyAenaLeg`):
  1. Lee los `data-card` abiertos en `#result` y su `scrollTop`.
  2. Desconecta el nodo `#punctuality`.
  3. Sustituye `.flight` por `flightCardHtml(card, { open })`.
  4. Vuelve a colocar el nodo `#punctuality` en su hueco.
  5. Repinta `#adv-flight` con `advancedFlightHtml`.
  6. Actualiza el título del mapa según `flightPhase(card)`.
  7. Llama a `routeMap?.setPlane(planeOnMap(card.radar, card.radarReceivedAt, Date.now()))`.
  8. Reinicia el contador de señal.
- **Mapa**: `routeMap = await createRouteMap(...)` en cuanto se pinta el *shell*. `forecastExtras` llama a
  `routeMap.setForecast(view)` en lugar de `renderMap`. `#aviation`, `#fresh` y `#trend` se escriben en sus nuevos
  huecos de Detalles avanzados. `routeMap.destroy()` en `stopRadarPoll`, otra búsqueda o `back`.
- **`data-open="adv-weather"`**: un clic abre `details[data-card="advanced"]` y `details[data-card="adv-weather"]` y
  hace *scroll* hasta él.
- **Contador de señal**: un temporizador encadenado de 1 s, mientras haya `volando` y la ficha esté visible. Hace tres
  cosas:
  - repinta `.signal` y la celda «Última señal» con `signalState`;
  - añade `.aged` a `.flight .now` si `stale`;
  - llama a `routeMap.setPlane(...)` cuando cambia `stale`.

  Se para como `stopDistance`. Ninguna petición.
- **Confianza en vuelo**: en `paintRadar`, el `base` con ETA nueva lleva `timeConfidence: eta.confidence`, y el `card`
  lleva `radarReceivedAt: Date.now()` en cada lectura.
- **Pronóstico tras el aterrizaje** (§10.2):
  - `applyAenaLeg` con `aenaFinal(leg)`, si `currentView` es de esta consulta (`currentView` no es `null`, es la misma
    `runId` y `#forecast-area` contiene `[data-card="turbulence"]`) y la llegada no es `CAN` ni `DES`: no sustituye
    `#forecast-area`, sino que repinta `forecastSectionHtml(currentView, now, { preLanding: true, open })`.
  - `paintRadar`: el reemplazo de `.note` con `LANDED_NOTE` sigue igual. Si hay pronóstico pintado y la lectura es
    `aterrizado`, se repinta igual con `preLanding: true`.
  - Cancelado o desviado: la nota, como hoy.
- **Barra superior**: los iconos de `#back` y `#refresh` se insertan con `icon()` al arrancar.

- [ ] **Paso 1: tests** nuevos en `tests/app-flow.test.js`, con los *fakes* que ya usa el fichero:
  - *repintado conserva desplegables*: abrir `details[data-card="schedule"]`, cargar el historial, llegar una lectura
    `volando` → sigue `open` y `#punctuality` conserva el historial;
  - *señal envejece*: lectura `volando` con `seenS: 5` y el reloj simulado que avanza 6 min → `[data-signal-level="old"]`;
    13 min → `stale` y `.now.aged`; ni una sola petición nueva por el contador (cuenta de `fetch`);
  - *aterriza con pronóstico*: pronóstico pintado y después Aena con `sta: 'LND'` → sigue `[data-card="turbulence"]`
    con «Previsión mostrada antes del aterrizaje», sin ninguna petición nueva a Open-Meteo;
  - *cancelado con pronóstico*: Aena con `CAN` → `.note` «Vuelo cancelado.» y ningún `[data-card="turbulence"]`;
  - *abre un vuelo ya terminado*: la nota corta actual y ningún pronóstico;
  - *mapa sin coordenadas*: el servidor responde sin `lat` → la tarjeta del mapa existe y `setPlane` se llamó con `null`.
- [ ] **Paso 2:** `npx vitest run tests/app-flow.test.js`. Resultado esperado: FAIL en los nuevos.
- [ ] **Paso 3:** implementar.
- [ ] **Paso 4:** `npm test`. Resultado esperado: todo en verde, también los casos antiguos de `app-flow`, alias,
  tramos, refresco y radar.
- [ ] **Paso 5:** commit `feat(app): integración del rediseño (repintado con estado, mapa con avión, señal en vivo, previsión tras aterrizar)`.

### Tarea 9: página de muestras y ajuste visual contra la referencia

**Ficheros:**
- Crear: `scripts/muestras.html` y `scripts/muestras.js` (no van al `SHELL` ni a producción; solo pintan objetos de
  prueba), `scripts/capturas.sh`
- Modificar: `css/style.css` (ajustes)

**Interfaces:**
- `muestras.html?estado=<id>` pinta `.flight` + `#forecast-area` + la tarjeta del mapa (sin teselas, con fondo
  `--bg`) + Detalles avanzados, con objetos `card` y `view` literales. Ids: `programado`, `en-curso`, `finalizado`,
  `sin-senal`, `localizando`, `turb-fuerte`, `conf-baja`, `incompleto`, `aena-antigua`, `solo-adb`, `retrasado`,
  `cancelado`, `desviado`, `tramos`, `alias`, `aterrizado-adsb`, `aterrizado-oficial`, `prev-no-disponible`,
  `simplificado`, `semana`, `consulta`, `carga` y `sin-conexion`.
- `scripts/capturas.sh` sirve con `python3 -m http.server` y captura cada estado con Chrome sin interfaz a 390×844 y
  2× (más `programado` y `en-curso` a 1280×900) en `$TMPDIR/turbi-capturas/`.

- [ ] **Paso 1:** crear las muestras y el script, y ejecutar `bash scripts/capturas.sh`. Resultado esperado: 25 PNG.
- [ ] **Paso 2:** comparar cada captura de `programado`, `en-curso`, `finalizado`, `sin-senal`, `turb-fuerte` y
  `conf-baja` con su panel de la referencia (`~/Downloads/Interfaz Turbi para seguimiento de vuelos.png`). Anotar las
  diferencias importantes de espaciado, jerarquía, densidad, tamaños, bordes, tarjetas, tipografía, colores y
  proporciones.
- [ ] **Paso 3:** corregir el CSS y volver a capturar hasta que las diferencias importantes desaparezcan. Revisar
  también los demás estados: nada roto, sin huecos y nada que desborde a 320 px de ancho.
- [ ] **Paso 4:** `npm test`. Resultado esperado: en verde.
- [ ] **Paso 5:** commit `chore(diseño): página de muestras y ajuste visual contra la referencia`.

### Tarea 10: versionado y verificación final

**Ficheros:**
- Modificar: `js/build.js` (`BUILD_ID = '2026-10-20.1'`, o la fecha del día del commit), `index.html` (`?v=` del CSS y
  de `app.js`), `sw.js` (`CACHE = 'turbi-v82'` y `?v=` de `SHELL`), `tests/pwa.test.js` (versión esperada),
  `docs/turbi-roadmap.md` (una entrada «Rediseño claro (20/10/2026)» con lo hecho y «pendiente: Manual Deploy de
  Render para lat/lon y verificación en iPhone»)

- [ ] **Paso 1:** actualizar las versiones y `tests/pwa.test.js`.
- [ ] **Paso 2:** `npm test`. Resultado esperado: todos los ficheros en verde, con más tests que los 1017 de partida.
  Comprueba específicamente que pasan:
  - `aena`, `aerodatabox`, `adb`, `flight`, `adsb-*`, `radar*` e `identify*`;
  - `eta`, `turbulence`, `summary`, `forecast` y `turbi-index`;
  - `multi-leg`, `aliases*`, `status-refresh` y `pwa`.
- [ ] **Paso 3:** `bash scripts/capturas.sh` una última vez. Revisar las capturas de `consulta`, `en-curso` y
  `finalizado`.
- [ ] **Paso 4:** commit `chore: BUILD_ID 2026-10-20.1 y caché turbi-v82 (rediseño claro)`. **No se hace push ni
  deploy.**
- [ ] **Paso 5:** informar a Jaime de lo pendiente: el *Manual Deploy* de Render (lat/lon) y la prueba en un iPhone
  real, en Safari y con la PWA instalada (zonas seguras con la barra de estado `default`, teclado en la consulta,
  *scroll* de la ficha y mapa ampliado).
