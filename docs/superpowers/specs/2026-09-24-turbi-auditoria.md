# Turbi — Auditoría del cálculo actual y viabilidad de la evolución

Fecha: 2026-09-24 · Paso 1 del plan de evolución (calidad del pronóstico).

## 1. Cómo calcula hoy Turbi

| Pieza | Implementación actual | Archivo |
|---|---|---|
| Ruta | Círculo máximo, 1 punto cada ~50 km, entre 10 y 40 puntos | `js/route.js` |
| Perfil vertical | **No existe.** Solo fases por tiempo: subida 20 min, bajada 25 min (40/20/40 % si dura < 60 min). No hay altitud por punto | `js/route.js` |
| Niveles consultados | Crucero: 300 y 250 hPa (≈ FL300–FL340). Subida/bajada: nada en altura, solo CAPE y 700 hPa | `js/weather.js` |
| Modelo | `best_match` de Open-Meteo (mezcla que elige Open-Meteo; no sabemos qué modelo es) | `js/weather.js` |
| Ellrod TI1 | VWS entre 300 y 250 hPa en el punto central × DEF a 250 hPa con 4 vecinos a 50 km | `js/turbulence.js` |
| Cizalladura | La misma VWS en kt/1000 ft, umbrales 5 / 8 | `js/turbulence.js` |
| Convección | CAPE en superficie + `weather_code` ≥ 95. En crucero solo cuenta si CAPE > 2000 | `js/turbulence.js` |
| Onda de montaña | Terreno ≥ 1500 m y viento a 700 hPa ≥ 15 / 25 m/s | `js/turbulence.js` |
| Nivel del punto | Máximo de los indicadores (0–3); causa = el indicador que da ese máximo | `js/turbulence.js` |
| Tramos | Puntos consecutivos con el mismo nivel; causa = la más frecuente | `js/turbulence.js` |
| Veredicto | Tranquilo / Algo de movimiento / Turbulento según minutos por nivel | `js/turbulence.js` |
| Fiabilidad | Solo horas hasta la salida (< 24 h alta, ≤ 72 media, ≤ 168 baja) | `js/turbulence.js` |

## 2. Problemas encontrados

1. **Altitud fija.** Todo el crucero se evalúa en la capa 300–250 hPa (≈ FL300–FL340). Un vuelo largo a FL380–FL400 se evalúa unos 2 km por debajo de donde vuela.
2. **Subida y bajada sin viento en altura.** En esas fases solo se mira CAPE y la onda de montaña, aunque el avión atraviesa 700–300 hPa, donde puede haber cizalladura.
3. **Ellrod con espaciado supuesto.** La deformación divide por 100 km fijos, pero Open-Meteo ajusta cada coordenada a su rejilla. En GFS/ECMWF (0,25°, unos 28 km) la distancia real entre vecinos puede diferir hasta un ~25 %, y DEF se sesga en la misma proporción. Open-Meteo devuelve la coordenada ajustada, así que se puede corregir.
4. **Vecinos caros y redundantes.** Se piden 4 vecinos por punto de crucero (N, S, E, O), pero los vecinos a lo largo de la ruta ya son los puntos anteriores y siguientes. Pidiendo solo los 2 vecinos transversales se cubre el eje perpendicular, y las derivadas se pueden calcular en ejes a lo largo y a través de la ruta.
5. **Una sola causa.** El nivel y la causa salen de un único indicador ganador. Si la cizalladura y la convección están ambas altas, solo se ve una.
6. **Modelo desconocido.** `best_match` no dice qué modelo se usa, así que no se puede comparar ni indicar la hora de ejecución.
7. **Fiabilidad simplista.** Depende solo de la antelación.
8. **Velocidad vertical, intensidad del viento (jet) y estabilidad no se usan**, aunque Open-Meteo las ofrece.
9. **Resolución temporal de ECMWF.** `ecmwf_ifs025` tiene resolución de 3 h (`temporal_resolution_seconds: 10800`); los valores horarios son interpolados. A tener en cuenta para no presentar precisión horaria falsa.

## 3. Viabilidad comprobada (24/09/2026)

### Open-Meteo
- **Niveles:** 450, 400, 350, 300, 275, 250, 225, 200, 175 y 150 hPa responden.
- **Variables por nivel:** `temperature`, `relative_humidity`, `geopotential_height`, `wind_speed`, `wind_direction`, `vertical_velocity` y `cloud_cover` existen.
- **Por modelo:**

  | Modelo (`models=`) | 400 | 350 | 300 | 275 | 250 | 225 | 200 | `vertical_velocity` |
  |---|---|---|---|---|---|---|---|---|
  | `ecmwf_ifs025` | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✓ |
  | `gfs_seamless` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

  → **Niveles comunes ECMWF/GFS: 400, 300, 250, 200 (y 150) hPa.** Los niveles intermedios solo existen en GFS.
- **Dos modelos en una petición:** sí (`models=ecmwf_ifs025,gfs_seamless`). Las claves vuelven con sufijo (`wind_speed_300hPa_ecmwf_ifs025`).
- **Hora de ejecución del modelo:** `https://api.open-meteo.com/data/<modelo>/static/meta.json` (con CORS). Da `last_run_initialisation_time` y `last_run_availability_time`. Nombres: `ecmwf_ifs025` y `ncep_gfs025`.
- **Cupo gratuito:** 600/min, 5.000/h, 10.000/día. Cada ubicación cuenta como una llamada, y cada 10 variables extra suman una llamada más (15 variables = 1,5).

### Aviation Weather (NOAA)
- METAR, TAF, SIGMET internacional y PIREP en JSON, sin clave, 100 peticiones/min, máx. 400 registros por respuesta.
- **Sin CORS:** el navegador no puede llamarla desde GitHub Pages (probado: no envía `Access-Control-Allow-Origin`).
- Alternativa viable: descargarlo en **GitHub Actions** cada hora, como ya se hace con Aena, y publicar un JSON estático.
- Cobertura PIREP: "Primarily US and North Atlantic". En la península hay informes, pero pocos. Nunca interpretar 0 PIREPs como ausencia de turbulencia.

## 4. Presupuesto de peticiones

Coste por consulta para una ruta de 25 puntos:

| Versión | Ubicaciones | Variables | Llamadas aprox. |
|---|---|---|---|
| Actual (1 modelo, 4 vecinos) | 25 + ~80 | 9 | ~105 |
| Ingenua (5 niveles, 2 modelos, 4 vecinos) | 105 | ~30 × 2 modelos | ~630 → **supera el límite por minuto** |
| **Propuesta** | 25 centrales + 50 transversales | centrales ~24 var; vecinos 8 var (viento en 4 niveles) | centrales 25 × 2,4 × 2 + vecinos 50 × 1 × 2 ≈ **220** |

La propuesta reduce el coste con cinco medidas:
- solo 2 vecinos transversales;
- los vecinos solo piden viento;
- se deduplican los puntos que caen en la misma celda de la rejilla;
- `geopotential_height` solo en el punto central;
- los niveles exclusivos de GFS solo cuando aportan.
