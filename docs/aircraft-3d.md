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

Decoraciones (11): Ryanair, easyJet, Vueling, Iberia, Iberia Express, Air Nostrum (Iberia Regional), Jet2,
Eurowings, Wizz Air, Lufthansa y TUI. Sin decoración (salen con colores neutros): las demás; en particular Binter,
Volotea, Norwegian (colas con retratos distintos), Transavia y Air Europa (decoraciones en transición o que no se
pueden simplificar sin inventar).

## Qué avión se muestra

1. **Modelo**: el tipo que da el radar (FR24 `type`, el avión real del vuelo); sin él, el previsto en el horario (Aena
   `ac`, AeroDataBox). Si viene del horario, la etiqueta lo dice («previsto en el horario»).
2. **Operadora**: la confirmada por la ficha (Aena `op`, AeroDataBox «IsOperator», FR24 `operating_as`) y el prefijo
   OACI del indicativo de radio. Nunca la aerolínea del número en un código compartido. Si las dos fuentes existen y no
   señalan la misma decoración (p. ej. un avión fletado), la operadora queda sin confirmar.
3. **Resultado**: modelo + decoración de la operadora hecha para ese modelo; si no, el modelo con colores neutros y el
   motivo; si el modelo no se conoce o no tiene recurso, el avión genérico (gris, rotulado «Avión genérico»).

Nunca se presenta como exacta una decoración especial ni la configuración de una matrícula concreta: la etiqueta dice
«colores de X, simplificados».

## Fidelidad de los datos

- **Posición**: la real recibida. Entre dos lecturas, el avión hace el mismo recorrido que en 2D (una lectura por
  detrás, nunca más allá de la última), con la altitud interpolada entre las dos. Sin datos nuevos se queda quieto y,
  a partir de los 60–105 s, atenuado; pasados 180 s desaparece. La etiqueta muestra siempre la antigüedad de la
  última posición real.
- **Altitud**: FR24 (`alt`) y adsb.lol (`alt_baro`) dan altitud barométrica estándar (1013,25 hPa) en pies. El mapa
  no tiene relieve: el avión se sitúa sobre un suelo plano a nivel del mar a esa altitud. La diferencia con la altitud
  geométrica real suele ser de cientos de metros: invisible a esta escala, pero no es una medida de altura sobre el
  terreno.
- **Orientación**: solo se recibe la dirección de desplazamiento (`track`), no el rumbo del morro; el avión se orienta
  según la trayectoria y la etiqueta lo dice. Con viento cruzado el morro real puede desviarse unos grados.
- **Actitud**: alas y morro siempre nivelados; no se recibe la inclinación y no se inventa.
- **Tamaño**: el avión se amplía para verse (unos 70 px de largo); la etiqueta dice «tamaño ×N». Las
  posiciones y altitudes no se exageran.
- **Estela**: la misma estela real del 2D, a la altitud de cada punto (cinta con la escala de color de FR24 y una
  cortina tenue hasta el suelo). Un tramo sin altitud no se dibuja en 3D (en 2D sigue en el suelo, en neutro).

## Rendimiento y alternativa 2D

- Al abrir la app solo se carga `js/aircraft-id.js` (≈ 1,5 KB: qué avión es). Al activar el 3D: unos 43 KB de código
  sin comprimir (`js/map3d.js`, `js/aircraft3d.js`) y unos 4 KB de catálogo (índice, un modelo y una decoración).
- Al volver a 2D se eliminan la capa, los búferes, la textura y los programas de WebGL, y se restaura la vista 2D.
- Sin WebGL 2, o si la capa no se puede crear, el botón «3D» queda desactivado y el mapa sigue en 2D.
