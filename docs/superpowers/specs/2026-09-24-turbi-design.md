# Turbi — Diseño

Fecha: 2026-09-24 · Estado: pendiente de revisión

## 1. Objetivo

PWA personal para iPhone que, dado un vuelo concreto, estima si tendrá turbulencias, **cuándo** y **de qué intensidad**.

- **Usuario:** solo Jaime, uso personal.
- **Éxito:** antes de volar, en menos de 30 s, ver un veredicto claro y una línea de tiempo del vuelo con los tramos de movimiento.
- **Restricción dura:** coste cero. Ningún servicio de pago, ni registro, ni API key.

## 2. Arquitectura

- PWA sin framework: HTML + CSS + JS con módulos ES.
- Alojada en GitHub Pages: repo `marinayjaime/turbi` → `https://marinayjaime.github.io/turbi/`.
- Todo se ejecuta en el navegador. Sin servidor.
- Service worker para abrir la app sin conexión; consultar sí requiere red.

### Servicios externos (todos gratis, sin key)

| Servicio | Uso |
|---|---|
| `api.adsbdb.com/v0/callsign/{nº}` | Nº de vuelo → aerolínea, aeropuerto origen y destino con coordenadas. No da horarios. CORS abierto (verificado). |
| Open-Meteo Forecast API | Viento, temperatura, CAPE y código de tiempo por niveles de presión, para muchas coordenadas en una petición. |
| Open-Meteo Elevation API | Altura del terreno bajo cada punto (onda de montaña). |
| Nominatim (OpenStreetMap) | Geocodificación inversa para nombrar los tramos con turbulencia. Máx. 1 petición/s. |

### Módulos

| Archivo | Responsabilidad | Depende de |
|---|---|---|
| `js/flight.js` | Nº de vuelo → `{airline, origin, destination}` | adsbdb |
| `js/airports.js` | Código IATA → `{name, lat, lon}` para la entrada manual | `data/airports.json` (incluido, de OurAirports, solo aeropuertos con código IATA y servicio regular) |
| `js/route.js` | Ruta por círculo máximo, puntos cada ~50 km, perfil de vuelo, hora y nivel de cada punto | — |
| `js/weather.js` | Descarga los datos de Open-Meteo (pronóstico y elevación) de todos los puntos y sus vecinos | Open-Meteo |
| `js/turbulence.js` | Índices, intensidad por punto, agrupación en tramos, veredicto | — (funciones puras) |
| `js/places.js` | Nombre del lugar de cada tramo | Nominatim |
| `js/history.js` | Últimos 5 vuelos en `localStorage` | — |
| `js/ui.js` | Pantallas y renderizado | — |
| `js/app.js` | Orquesta el flujo | todos |

### Flujo

```
nº vuelo + fecha + hora salida ──► flight.js ──► origen/destino
          (o entrada manual) ──► airports.js ─┘
                                    │
                                 route.js ──► puntos {lat, lon, t, fase, nivel}
                                    │
                                weather.js ──► datos por punto y sus 4 vecinos
                                    │
                              turbulence.js ──► intensidad por punto ──► tramos ──► veredicto
                                    │
                                 places.js ──► nombres de los tramos con turbulencia
                                    │
                                   ui.js
```

## 3. Entrada del vuelo

- **Campos:** nº de vuelo (IATA, p. ej. `VY3902`, o ICAO, p. ej. `VLG3902`), fecha (por defecto hoy) y hora local de salida.
- **Consulta:** se llama a adsbdb con el nº de vuelo.
  - Si responde con la ruta, se muestra "Vueling · Barcelona → Palma" para confirmar.
  - Si responde 404 o hay error de red, se muestra "No encuentro ese vuelo, introdúcelo a mano" y se abre la entrada manual.
- **Entrada manual:** origen y destino por código IATA (con autocompletado desde `airports.json`), fecha y hora de salida.
- **Hora:**
  - La hora de salida se interpreta en la zona horaria del aeropuerto de origen. La zona se deriva de las coordenadas: Open-Meteo con `timezone=auto` la devuelve para el punto de origen.
  - La hora de llegada se estima con la duración.
- **Duración estimada:** `distancia_km / 800 km/h + 30 min` (rodaje, subida y bajada). Botón "Cambiar hora" para ajustar la salida.

## 4. Ruta y perfil de vuelo

- Círculo máximo origen → destino, un punto cada ~50 km (mínimo 10 puntos).
- Cada punto tiene su hora estimada, interpolada linealmente entre salida y llegada.
- **Fases por tiempo:**
  - Subida: primeros 20 min.
  - Bajada: últimos 25 min.
  - Crucero: el resto.
  - Si el vuelo dura menos de 45 min, se reparte 45 % subida, 10 % crucero y 45 % bajada.
- **Nivel de crucero:** FL360 si la duración es de 1 h o más; FL300 si es menor.
- **Niveles de presión que se consultan:**
  - Crucero: 300 / 250 / 200 hPa.
  - Subida y bajada: 850 / 700 / 500 hPa.
- Open-Meteo es horario: cada punto usa la hora más cercana a su paso.

## 5. Cálculo de turbulencia

Cada punto recibe una intensidad por indicador: `0 nula · 1 ligera · 2 moderada · 3 fuerte`. La del punto es el **máximo** de todas.

### 5.1 Aire claro: índice de Ellrod TI1 (solo crucero)

- `TI1 = VWS × DEF`
  - VWS: cizalladura vertical entre 300 y 250 hPa (usando la altura geopotencial de Open-Meteo).
  - DEF: deformación horizontal, calculada por diferencias finitas con 4 vecinos a ±50 km (N, S, E, O) en el nivel de 250 hPa.
- Unidades: 10⁻⁷ s⁻².

| TI1 | Intensidad |
|---|---|
| < 4 | 0 |
| 4–8 | 1 |
| 8–12 | 2 |
| > 12 | 3 |

### 5.2 Cizalladura vertical (solo crucero)

- La misma VWS, expresada en m/s por 1.000 ft.
- ≥ 6 → 1; ≥ 9 → 2.

### 5.3 Convección (todas las fases)

| Fase | Condición | Intensidad |
|---|---|---|
| Subida / bajada | CAPE > 500 J/kg | 1 |
| Subida / bajada | CAPE > 1000 J/kg | 2 |
| Subida / bajada | código de tiempo 95–99 (tormenta) | 3 |
| Crucero | CAPE > 2000 J/kg | 2 |
| Crucero | CAPE > 2000 J/kg y tormenta | 3 |

### 5.4 Onda de montaña (todas las fases)

- Requiere terreno ≥ 1.500 m.
- Viento a 700 hPa > 15 m/s → 1; > 25 m/s → 2.

### 5.5 Tramos y veredicto

- **Tramos:** puntos consecutivos con la misma intensidad forman un tramo `{min_inicio, min_fin, intensidad, causa principal}`.
- **Veredicto:**
  - 🟢 **Tranquilo**: sin intensidad ≥ 2, y la ligera ocupa < 10 % del vuelo.
  - 🔴 **Turbulento**: moderada acumulada > 15 min, o algún punto fuerte.
  - 🟡 **Algo de movimiento**: el resto.
- **Fiabilidad**, según el tiempo hasta la salida:
  - < 24 h: alta.
  - 1–3 días: media.
  - 3–7 días: baja.
  - > 7 días: no se calcula; se muestra "Vuelve a consultar más cerca de la fecha".

Los umbrales son un punto de partida. Se afinarán tras usar la app en vuelos reales.

## 6. Interfaz

- **Estilo:** blanco, SF Pro (`-apple-system`), acento azul, minimalista, vertical para iPhone. Los colores de intensidad solo aparecen en la barra y los puntos:
  - nula: gris claro;
  - ligera: amarillo suave;
  - moderada: naranja;
  - fuerte: rojo.
- **Pantalla de consulta:**
  - Nº de vuelo, fecha, hora de salida y botón "Consultar".
  - Enlace "Introducir a mano".
  - Lista de últimos vuelos (5).
- **Pantalla de resultado:**
  - Cabecera: ruta, horas, veredicto grande y etiqueta de fiabilidad.
  - Línea de tiempo: barra horizontal de despegue a aterrizaje, coloreada por intensidad, con marcas de minutos.
  - Tarjetas de tramos con turbulencia: "Min 25–40 · Moderada · Aire claro · sobre el Golfo de León". Si Nominatim falla, "a 180 km de BCN".
  - Botones "Cambiar hora" y "Actualizar".
- **Estado de carga:** indicador sencillo mientras se consultan las APIs.
- **Errores:** mensaje claro y botón "Reintentar" si falla Open-Meteo.

## 7. Pruebas

- **Vitest**, solo para desarrollo; no se publica.
  - `route.js`: distancia PMI–BCN ≈ 200 km, número de puntos, horas y fases, caso de vuelo corto.
  - `turbulence.js`:
    - TI1 con un campo de viento sintético de valor conocido;
    - cada umbral en su límite;
    - agrupación en tramos;
    - las tres reglas del veredicto;
    - la fiabilidad.
  - `flight.js`: respuesta de adsbdb simulada (con ruta, 404 y error de red).
- **Prueba real:** PMI–BCN, PMI–MAD y un vuelo que cruce los Pirineos o los Alpes. Comprobar que el resultado es coherente y compararlo con Turbli.

## 8. Fuera de alcance (v1)

Mapa, notificaciones, pronósticos oficiales WAFS, ajuste fino de umbrales, horarios automáticos de vuelos, cualquier servicio de pago.
