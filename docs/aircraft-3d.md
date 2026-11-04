# Modo 3D del mapa: modelos, decoraciones, procedencia y límites

El modo 3D (botón «3D» del mapa del vuelo) es opcional. Su código (`js/map3d.js`, `js/aircraft3d.js`) y su catálogo
(`data/aircraft3d/`) solo se descargan al activarlo, y solo el índice, el modelo y la decoración del vuelo abierto.
No hace consultas de seguimiento nuevas: usa las posiciones, la altitud y la estela que ya tiene el mapa 2D.

## Procedencia y licencias

- **Geometría de los aviones**: creada para Turbi (código propio en `js/aircraft3d.js`, `buildAircraftGeometry`) a partir
  de las medidas generales publicadas por los fabricantes (largo, envergadura, diámetro del fuselaje, flecha, posición del
  ala, tipo de motor y de punta de ala). No procede de ningún modelo 3D de terceros, así que no hay licencias ni
  atribuciones que cumplir; se distribuye con la app como el resto de su código.
- **Decoraciones**: creadas para Turbi (`data/aircraft3d/liveries/*.json`): solo los colores generales de la flota
  (fuselaje, panza, deriva, puntas de ala) observados en fotografías públicas. **Sin logotipos, rótulos, tipografías ni
  dibujos** de ninguna aerolínea. Los nombres y colores de las aerolíneas pertenecen a sus dueños; se usan solo para
  identificar a la operadora del vuelo, como hace el texto de la ficha.
- **Búsqueda de recursos de terceros (27/10/2026)**: no se encontró ningún modelo de avión comercial concreto (A320,
  737…) con una licencia libre verificable (CC0, CC BY) y descarga directa: los de calidad son de pago (CGTrader, Fab,
  Superhive) o no indican la licencia. No se ha comprado ni descargado ninguno.
- **Motor 3D**: WebGL 2 propio dentro de una capa personalizada de MapLibre GL JS 6.11.2 (BSD-3, ya incluido en
  `js/vendor/maplibre`). Ninguna librería nueva.

Si en el futuro se incorporan modelos glTF de terceros, cada archivo debe ir con su autor, URL, licencia y atribución
en este documento y, si la licencia lo pide, en los créditos visibles del mapa.

## Catálogo (`data/aircraft3d/`)

- `index.json`: nombre de modelo de Turbi (los de `js/plain.js`) → modelo del catálogo; decoraciones con sus códigos
  de operadora (IATA y OACI) y la lista de modelos para los que están hechas.
- `models/<id>.json`: medidas del modelo. Para añadir uno: su JSON y su línea en `index.json` → `types`.
- `liveries/<id>.json`: colores. Para añadir una: su JSON y su entrada en `index.json` → `liveries`, con **solo** los
  modelos que esa aerolínea opera con esa decoración.

La textura se pinta en el navegador con zonas UV fijas (`UV` en `js/aircraft3d.js`): cualquier decoración vale para
cualquier modelo sin tocar la geometría, pero solo se aplica a los modelos de su lista.

### Cobertura inicial

Elegida con `data/airline-combos.json` (operadora × modelo de los vuelos de Aena que ve Turbi).

| Modelos (27 en el catálogo; el genérico va en el código) | Vuelos de `airline-combos.json` |
| --- | --- |
| 737-800, A320, 737 MAX 8, A321neo, A320neo, CRJ1000, ATR 72 (-500/-600), A319, A321 | 90,3 % |
| Además: E195-E2, A350-900/-1000, E190/E195, 787-8/-9/-10, A220-300, A330-200/-300/-900, 737-300/-700/-900, 777-300ER, CRJ900, E190-E2 | 99,3 % en total |

Con decoración de la operadora (modelo y operadora cubiertos): 64,1 % de esos vuelos.

Sin modelo 3D (salen como genérico): A220-100, A380, 757, 767-300, 777-200, 737-400, Embraer 175, Dash 8-400,
helicópteros y cualquier código que Turbi no conozca.

Decoraciones detalladas (3, ronda del 27/10/2026): Ryanair, Iberia y Vueling llevan nombre de la compañía en el
fuselaje (tipografía del sistema, no la suya), panza, deriva y winglets propios. Solo con rasgos contrastados en fuentes
públicas (el campo `basis` de cada JSON lo dice): Ryanair, parte inferior y deriva azules y «RYANAIR» en azul; Iberia,
deriva roja y amarilla (reparto simplificado, no su emblema) y «IBERIA» en rojo; Vueling, gris #4C4C4B y amarillo
#FCCC04 de su marca, «vueling» en minúsculas, deriva y winglets amarillos. Ningún logotipo. Lo no contrastado (góndolas,
panza de Vueling) queda en colores neutros.

Resto de decoraciones (8, solo colores): easyJet, Iberia Express, Air Nostrum (Iberia Regional), Jet2,
Eurowings, Wizz Air, Lufthansa y TUI. Sin decoración (salen con colores neutros): las demás; en particular Binter,
Volotea, Norwegian (colas con retratos distintos), Transavia y Air Europa (decoraciones en transición o que no se
pueden simplificar sin inventar).

## Qué avión se muestra

1. **Modelo**: el tipo que da el radar (FR24 `type`, el avión real del vuelo); sin él, el previsto en el horario (Aena
   `ac`, AeroDataBox).
2. **Operadora**: la confirmada por la ficha (Aena `op`, AeroDataBox «IsOperator», FR24 `operating_as`) y el prefijo
   OACI del indicativo de radio. Nunca la aerolínea del número en un código compartido. Si las dos fuentes existen y no
   señalan la misma decoración (p. ej. un avión fletado), la operadora queda sin confirmar.
3. **Resultado**: modelo + decoración de la operadora hecha para ese modelo; si no, el modelo con colores neutros y el
   motivo; si el modelo no se conoce o no tiene recurso, el avión genérico (gris, rotulado «Avión genérico»).

Nunca se presenta como exacta una decoración especial ni la configuración de una matrícula concreta. Encima del mapa no se
escribe nada: el modelo y la operadora están en la ficha; este texto solo llega a los lectores de pantalla (`.map3d-model`,
`aircraftLabel`), con «colores de X, simplificados» o el motivo de los colores neutros.

## Fidelidad de los datos

- **Posición**: la real recibida. Entre dos lecturas, el avión hace el mismo recorrido que en 2D (una lectura por
  detrás, nunca más allá de la última), con la altitud interpolada entre las dos. Solo cambia la suavidad: en 3D se
  calcula en cada fotograma de la pantalla (en 2D sigue a ~20 por segundo). Sin datos nuevos se queda quieto y, a partir
  de los 60–105 s, atenuado; pasados 180 s desaparece.
- **Altitud**: FR24 (`alt`) y adsb.lol (`alt_baro`) dan altitud barométrica estándar (1013,25 hPa) en pies. El mapa
  no tiene relieve: el avión se sitúa sobre un suelo plano a nivel del mar a esa altitud. La diferencia con la altitud
  geométrica real suele ser de cientos de metros: invisible a esta escala, pero no es una medida de altura sobre el
  terreno.
- **Orientación**: solo se recibe la dirección de desplazamiento (`track`), no el rumbo del morro; el avión se orienta
  según la trayectoria. Con viento cruzado el morro real puede desviarse unos grados. Un cambio de `track` se presenta
  poco a poco (~1 s) y por el camino corto; la dirección de destino es siempre la medida.
- **Actitud**: alas y morro siempre nivelados; no se recibe la inclinación y no se inventa.
- **Tamaño**: de cerca, a su escala real; al alejar la cámara se amplía para verse (unos 70 px de largo). Las
  posiciones y altitudes no se exageran.
- **Estela**: la misma estela real del 2D, a la altitud de cada punto (cinta con la escala de color de FR24 y una
  cortina tenue hasta el suelo). Un tramo sin altitud no se dibuja en 3D (en 2D sigue en el suelo, en neutro).

## Cámara y gestos

- Perspectivas Detrás (78°), Lado (90°: a la altura del avión), Diagonal (66°) y Arriba (0°). Cada una encuadra el avión
  entero con su largo, envergadura y alto reales y el hueco libre entre los botones de arriba y la barra de abajo; después
  se puede acercar más. «Restablecer vista» vuelve a ese encuadre.
- Gestos, en 2D y 3D, dentro de la ficha y ampliado: un dedo mueve el mapa (en 3D deja de seguir al avión y se queda donde
  se suelte); pellizcar acerca y aleja (en 3D, sobre el avión); dos dedos giran e inclinan en 3D sin dejar de seguir. La
  página se desplaza arrastrando fuera del mapa. Botones de zoom siempre visibles; giro e inclinación, plegados.
- A 80° o más (p. ej. «Lado»), MapLibre no puede arrastrar el mapa (arrastra sobre el plano de la altura del avión, que
  se ve de canto): ahí el arrastre de un dedo lo hace Turbi, a la escala del centro de la vista.

### Cómo se mueve (`loop` en `js/map3d.js`)

- **Un solo bucle por fotograma**: posición del avión (`advance`, de `js/map.js`), giro y cámara, en este orden. Con
  bucles separados la cámara iría a veces un fotograma por detrás: a escala real el avión recorre de 700 a 1 800 px/s en el
  plano del avión, decenas de píxeles por fotograma.
- **Cámara siguiendo**: el centro va pegado al avión. Un retraso de la cámara, aunque fuera de 0,3 s, sacaría el avión del
  encuadre a esa velocidad en pantalla; lo que se amortigua es la dirección (la cámara gira algo más despacio que el avión),
  que es lo que da la sensación de cámara siguiendo a un objeto. El suelo, a 11 km, se mueve unos 30 px/s.
- **Transiciones** (perspectivas, volver a seguir, botones): un solo mecanismo que mezcla el desvío respecto al destino vivo,
  con el zoom y la inclinación en línea recta, y el rumbo por el camino corto.
- **Gestos**: mientras haya un dedo en el mapa o dure la inercia no se llama a `map.jumpTo`, porque llama a `stop()` y reinicia
  los manejadores de gestos de MapLibre (con el seguimiento activo el dedo no llegaba a mover el mapa). El gesto se aplica sin
  suavizado y, si se sigue al avión, solo el centro lo acompaña, directo sobre `map._camera.transform` (privado: comprobarlo al
  actualizar MapLibre). Al terminar, el encuadre del gesto pasa a ser el elegido y cualquier diferencia se recorre con transición.
- `prefers-reduced-motion`: sin recorrido, sin giro suavizado y sin transiciones.

### Contexto geográfico

Con la cámara a unos 100 m del avión y el suelo a ~11 km, MapLibre mide todo en la escala del plano del avión:

- **Etiquetas**: no desaparecían por `maxzoom` (`label_city` y `label_town` no lo tienen; `label_state` y `label_country_*`
  sí, 8 y 9). `CollisionIndex` descarta toda etiqueta con factor de perspectiva `0,5 + 0,5 · (cámara-centro / cámara-etiqueta)`
  menor que 0,6, y aquí vale ~0,504. Mientras dure el 3D ese corte queda en 0 (`keepDistantLabels`; propiedad privada de la
  copia fija de MapLibre 6.11.2: **al actualizar MapLibre, comprobarla**. Si falta, las ciudades se fuerzan con
  `text-allow-overlap`). Esa escala también las pinta a la mitad: de ahí el doble de tamaño de cerca. Un filtro por nivel de
  tesela evita que París u Oslo se amontonen en el horizonte desde Valencia.
- **Líneas**: un ancho de N px en el plano del avión se ve ~100 veces más fino en el suelo. Las capas `map3d-*` compensan esa
  escala con una función exponencial del zoom (`groundWidthStops`), recalculada solo si cambia la altitud un 15 %.
- **Capas del 3D** (`contextLayers`, de la misma fuente `openmaptiles`): agua y costa con más contraste, vegetación y zonas
  urbanas muy tenues; ríos, pistas, autopistas, carreteras principales y fronteras; capitales, ciudades, poblaciones,
  aeropuertos, mares y países. Sin calles, comercios ni puntos de interés. Las demás líneas y etiquetas del estilo se apagan y
  al salir todo vuelve a su estado (ninguna fuente, API ni coste nuevo).
- **Edificios y relieve**: probados sobre Valencia a 36 000 ft y descartados (04/11/2026). Los edificios solo vienen en las
  teselas de nivel 14 (23 geometrías cargadas en esa vista) y no cambiaban la imagen; el relieve de OpenFreeMap (`ne2_shaded`,
  nivel 6) era un tinte uniforme, sin relieve que leer. Ninguno bajaba de 60 fps; simplemente no aportan. Las manchas urbanas
  (`landuse`) sí se ven.
- **Horizonte**: la niebla de MapLibre no tiñe un suelo plano, así que la capa pinta una banda de neblina (`drawHaze`) encima
  del suelo y debajo del avión; sin ella el terreno acaba en una línea dura contra el cielo.
- **Cortina de la estela**: más tenue que antes (0,09 arriba) porque pasa a pocos metros de la cámara y cubría media vista con
  un velo de un solo color; la cinta, a su altura, no cambia.

### Límites reales del motor (MapLibre GL JS 6.11.2), medidos

- La inclinación llega a 180° en MapLibre 6, pero Turbi la limita a 90° (cámara a la altura del avión): por encima se
  mira el avión desde abajo. No hay relieve ni nubes; el cielo es un degradado (`setSky`) y la niebla funde el borde
  lejano del suelo, donde MapLibre deja de dibujar teselas.
- Sin cielo, a partir de ~85° queda una franja vacía sobre el suelo: por eso el 3D activa el cielo y lo quita al salir.
- Con la cámara centrada en el avión (6–11 km sobre el suelo) y zoom alto, MapLibre pedía miles de teselas del suelo
  (16 647 a 45°, 1 fps en el banco) y llegaba a pedir teselas de nivel 26 (error «outside of bounds» y desbordamiento
  de pila en la capa `background`). Correcciones: el mapa base no se trocea por encima de su nivel 14
  (`zoomLevelsToOverscale`), la ruta y la estela GeoJSON llegan a nivel 12, el detalle de las fuentes se acota en 3D y,
  en 3D, la capa `background` se sustituye por un polígono del mismo color. Resultado medido: 15–43 teselas en
  cualquier inclinación y sin errores.
- El rendimiento en un teléfono real sigue sin validar: las medidas son de Chrome en el Mac (GPU real con la CPU frenada y
  pantalla de móvil emulada, y WebGL por software como caso peor).

## Rendimiento y alternativa 2D

- Al abrir la app solo se carga `js/aircraft-id.js` (≈ 1,5 KB: qué avión es). Al activar el 3D: unos 43 KB de código
  sin comprimir (`js/map3d.js`, `js/aircraft3d.js`) y unos 4 KB de catálogo (índice, un modelo y una decoración).
- Al volver a 2D se eliminan la capa, los búferes, la textura y los programas de WebGL, y se restaura la vista 2D.
- Sin WebGL 2, o si la capa no se puede crear, el botón «3D» queda desactivado y el mapa sigue en 2D.
