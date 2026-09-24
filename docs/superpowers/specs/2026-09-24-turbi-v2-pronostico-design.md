# Turbi v2 — Diseño: calidad del pronóstico

Fecha: 2026-09-24 · Basado en la auditoría `2026-09-24-turbi-auditoria.md` y en el documento de requisitos de Jaime (15 fases).
Decisiones de Jaime: seguir el orden de fases; Aviation Weather vía GitHub Actions; implementar todo seguido y publicar al final.

Principios:
- Nada de precisión falsa: al usuario solo se le muestran categorías (nula / ligera / moderada / fuerte), rangos de minutos y niveles de vuelo redondeados.
- No se llama EDR a nada.
- Todo umbral es un punto de partida documentado, pendiente de calibrar con vuelos reales.

---

## 1. Perfil vertical (`js/altitude.js`)

### 1.1 Presión ↔ nivel de vuelo (atmósfera estándar ISA)
- Troposfera (p ≥ 226,32 hPa): `h(ft) = 145366,45 · (1 − (p/1013,25)^0,190284)`.
- Estratosfera baja: `h(ft) = 36089,24 + 20805,8 · ln(226,321/p)`.
- `FL = h/100`.

Correspondencias resultantes:

| hPa | 500 | 400 | 350 | 300 | 250 | 200 | 150 |
|---|---|---|---|---|---|---|---|
| FL | 183 | 236 | 266 | 301 | 340 | 387 | 446 |

Los niveles de vuelo se definen con la presión estándar (1013,25 hPa), así que esta correspondencia es la que usan los aviones. La altura geométrica real varía con la temperatura, pero no importa para asignar niveles.

### 1.2 Nivel de crucero estimado
Un reactor comercial sube de media ~2.000–2.500 ft/min a unos 10 km/min de velocidad sobre el suelo (≈ 0,45 km por cada 100 ft). Baja con una senda de ~3° (≈ 0,55 km por cada 100 ft). Subir a un FL y bajar de él consume por tanto ≈ 1 km de ruta por cada nivel de vuelo. En tramos cortos las compañías suben algo más rápido (aviones ligeros), por eso se usa un factor 1,2:

```
FL_crucero = clamp( redondeo_a_10( 1,2 · distancia_km ), 150, techo )
techo = 360 si distancia < 1.000 km · 370 si < 3.000 km · 380 en largo radio
```

| Ruta | Distancia | FL estimado | Referencia real habitual |
|---|---|---|---|
| PMI–BCN | 200 km | FL240 | FL200–FL250 |
| PMI–MAD | 550 km | FL360 | FL340–FL380 |
| MAD–LHR | 1.250 km | FL370 | FL350–FL390 |
| FRA–JFK | 6.200 km | FL380 | FL340–FL400 (sube durante el vuelo) |

### 1.3 Perfil en el tiempo
- Subida media: 2.000 ft/min. Bajada media: 1.500 ft/min. Con FL360 salen 18 min de subida y 24 min de bajada, coherente con la v1 (20 y 25).
- `FL(t) = min( FL_crucero, t·20, (duración − t)·15 )`, con t en minutos y FL en centenas de pies.
- En vuelos cortos las dos rampas se cruzan antes de llegar al crucero y el perfil queda triangular, como en la realidad.
- Fase de cada punto: `climb` si está en la rampa de subida, `descent` en la de bajada, `cruise` en la meseta.

## 2. Datos (`js/weather.js` + `js/models.js`)

### 2.1 Niveles y variables
- **Niveles comunes a ECMWF y GFS:** 400, 300, 250, 200 y 150 hPa. 350 hPa solo existe en GFS; se descarta para que los dos modelos sean comparables. Decisión documentada.
- **Capas:** A 400–300 (FL236–301) · B 300–250 (FL301–340) · C 250–200 (FL340–387) · D 200–150 (FL387–446).
- **Punto central:**
  - por nivel: `wind_speed`, `wind_direction`, `temperature` → 15 variables;
  - `vertical_velocity` en 400/300/250/200 → 4;
  - `cape`, `weather_code`, `wind_speed_700hPa` → 3;
  - total 22 variables (2,2 llamadas).
  - El grosor de cada capa se calcula con la ecuación hipsométrica (`Δz = R·T̄/g · ln(p1/p2)`), lo que ahorra pedir `geopotential_height`.
  - La altura del terreno ya viene en `elevation`.
- **Vecinos transversales:** solo `wind_speed` y `wind_direction` en los 5 niveles → 10 variables (1 llamada).

### 2.2 Puntos y vecinos (optimización)
- Un punto cada ~60 km, entre 8 y 30 puntos. Antes eran 50 km y entre 10 y 40.
- Derivadas horizontales en ejes locales **a lo largo** (s) y **a través** (n) de la ruta:
  - a lo largo: se reutilizan los puntos anterior y siguiente de la ruta, que ya se piden;
  - a través: 2 vecinos a ±50 km perpendiculares a la ruta. Antes eran 4 (N, S, E, O).
- Los vecinos solo se piden en puntos a FL200 o más, donde se evalúan las capas.
- **Distancias reales:** cada modelo se pide por separado y Open-Meteo devuelve la coordenada de su rejilla. Las derivadas usan la distancia real entre esas coordenadas (auditoría, problema 3).
- Los vecinos a lo largo de la ruta se muestrean a la **hora del punto central**.

### 2.3 Modelos y presupuesto
- Una petición por modelo (`ecmwf_ifs025` y `gfs_seamless`), por lotes de 100 ubicaciones.
- Coste para 30 puntos: centrales 30 × 2,2 × 2 modelos ≈ 132 + vecinos ≈ 56 × 1 × 2 ≈ 112 → **~245 llamadas** (el límite es 600/min). PMI–MAD ≈ 80.
- **Plan de respaldo:**
  1. Si un modelo falla o tiene menos del 50 % de datos válidos, se usa solo el otro y se indica.
  2. Si fallan los dos, se usa el cálculo v1 (`best_match`, capa 300–250), que sigue en el código precisamente como respaldo, y se indica "cálculo simplificado".
  3. El 429 (cupo) nunca se reintenta al momento.

## 3. Turbi Index (`js/turbi-index.js`)

### 3.1 Metodología
Sigue la estructura de la *Graphical Turbulence Guidance* (GTG, Sharman et al.) de NOAA, sin pretender reproducirla ni estimar EDR:
1. Cada diagnóstico se lleva a una **escala común de 0–100** mediante tramos lineales anclados en umbrales publicados o habituales. 25 = ligera, 50 = moderada, 75 = fuerte.
2. Dentro de cada **mecanismo**, los diagnósticos se **combinan con pesos**.
3. Entre mecanismos independientes (turbulencia en aire claro, convectiva y de montaña) se toma el **máximo**, igual que GTG4 hace con CAT, MWT y CIT.

### 3.2 Diagnósticos y anclajes (valor → componente)

| Diagnóstico | Unidad | 0 | 25 | 50 | 75 | 100 | Fuente del anclaje |
|---|---|---|---|---|---|---|---|
| Ellrod TI1 (VWS × DEF, capa) | 10⁻⁷ s⁻² | 0 | 4 | 8 | 12 | 16 | Ellrod & Knapp (1992): 4 / 8 / 12 |
| Cizalladura vertical | kt/1000 ft | 0 | 5 | 8 | 11 | 14 | Umbrales operativos habituales (≥ 6–8 kt/1000 ft = moderada) |
| Estabilidad: Richardson (Ri) | — | Ri ≥ 5 | 2 | 1 | 0,5 | — (tope 75) | Ri < 1 en modelos (cizalladura sub-resuelta) se asocia a CAT; Ri solo no implica fuerte |
| Velocidad vertical \|w\| | m/s | 0 | 0,5 | 1 | 2 | 3 | Movimiento vertical fuerte en troposfera alta = convección u ondas |
| CAPE | J/kg | 0 | 500 | 1000 | 2500 | 4000 | Umbrales v1 (500 / 1000) y clasificación habitual de inestabilidad |
| Tormenta (`weather_code`) | WMO | — | — | — | 95 → 75 | 96/99 (granizo) → 90 | |
| Onda de montaña (terreno ≥ 1500 m) | m/s viento 700 hPa | < 10 | 15 | 25 | 35 | — | Umbrales v1 (15 / 25) |

- **Deformación horizontal** entra a través de Ellrod (VWS × DEF), para no contarla dos veces. Se conserva por separado para explicar el resultado.
- **Intensidad del viento (corriente en chorro):** por sí sola no genera turbulencia. Solo cuenta como **causa** ("corriente en chorro") cuando el viento de la capa supera 40 m/s (~80 kt) y el mecanismo CAT es ≥ 25. No suma puntos.

### 3.3 Combinación por capa y punto
```
base = media ponderada de Ellrod (0,5) y Cizalladura (0,3), renormalizada a los disponibles
CAT  = max( 0,8·base + 0,2·Ri ,  máx(Ellrod, Cizalladura) − 15 )
       (el segundo término evita diluir una señal muy fuerte: Ellrod = 90 deja CAT ≥ 75;
        Ri solo refuerza: su peso es fijo y no entra en ese suelo, porque en capas casi neutras
        sale bajo aunque apenas haya cizalladura. Comprobado con datos reales el 24/09/2026)
CONV = CAPE_componente · alcance(FL) ; max con Tormenta · alcance(FL) ; max con |w| en la capa
       alcance = 1 por debajo de FL200; en crucero 1 si CAPE ≥ 2000, 0,6 si 1000–2000, 0,3 si < 1000
MTW  = Onda · (1 por debajo de FL200; 0,6 en crucero)
Turbi Index = max(CAT, CONV, MTW), entero de 0 a 100
Nivel = 0 (<25) · 1 (25–49) · 2 (50–74) · 3 (≥75)
```

- **Richardson:** `Ri = N²/S²`, con `N² = (g/θ̄)·Δθ/Δz`, `θ = T·(1000/p)^0,2857` (T en K) y `S` = cizalladura de la capa (s⁻¹). Entre anclajes se interpola linealmente en Ri. Ri < 0,5 (incluido Ri ≤ 0, capa inestable) → 75; S ≈ 0 → 0.
- **Pesos de CAT:** Ellrod es el diagnóstico con más validación para CAT en latitudes medias, por eso pesa más. La cizalladura sola es el segundo mejor predictor. Ri aporta la estabilidad, que Ellrod no ve.
- **Causas:** todos los componentes ≥ 25, ordenados de mayor a menor (máximo 3). Claves: `jet_stream`, `vertical_shear`, `deformation`, `instability`, `convection`, `thunderstorm`, `vertical_motion`, `mountain_wave`.

### 3.4 Altitud de un punto
- El avión está a FL(t).
- Si FL ≥ 200: se interpola el índice entre los **puntos medios de las capas** (A≈FL268, B≈FL320, C≈FL363, D≈FL417), con saturación en los extremos.
- Si FL < 200: solo se evalúan CONV y MTW (sin capas en altura), como en la v1.

## 4. Comparación de modelos (`js/models.js`)
- Se analiza la ruta con cada modelo por separado.
- **Pronóstico combinado:** media del Turbi Index de ambos en cada punto (media de conjunto). Nivel a partir de la media.
- **Acuerdo:**
  - por punto, |Δnivel|;
  - global: *alto* si coinciden los máximos y ≥ 80 % de los puntos con Δ = 0; *medio* si |Δmáx| ≤ 1 y ≥ 80 % de los puntos con Δ ≤ 1; *bajo* en otro caso.
  - Con un solo modelo: *no disponible*.

## 5. Confianza (`js/confidence.js`)

| Factor | Puntos | Motivo mostrado |
|---|---|---|
| Antelación < 24 h / 1–3 d / 3–7 d | +2 / +1 / 0 | "faltan menos de 24 h" / "faltan 2 días"… |
| Acuerdo alto / medio / bajo / un modelo | +2 / +1 / 0 / 0 | "ECMWF y GFS muestran un patrón parecido"… |
| Cobertura ≥ 95 % / 70–95 % / < 70 % | +1 / 0 / −1 | "cobertura meteorológica completa"… |
| Saltos entre puntos vecinos (≥ 2 niveles) > 20 % | −1 | "el pronóstico cambia mucho de un punto a otro" |
| Puntos ≥ moderada con un solo indicador alto > 50 % | −1 | "los indicadores no coinciden entre sí" |

- **Resultado:** Alta ≥ 4 · Media 2–3 · Baja ≤ 1.
- **Límite:** con más de 3 días de antelación, como mucho Media.
- Más de 7 días: sin cálculo (igual que ahora).
- Sin porcentajes.

## 6. Resumen, timeline y altitudes (`js/summary.js`, `js/ui.js`)
- **Resumen:**
  - titular (Mayormente tranquilo / Algo de movimiento / Turbulento, con la misma lógica de veredicto de la v1);
  - máximo previsto;
  - duración y momento de los tramos de nivel máximo;
  - confianza con sus motivos;
  - % del vuelo por nivel, calculado con los minutos de los tramos reales y redondeado a múltiplos de 5 por el método del mayor resto, para que sumen 100 sin fingir precisión.
- **Timeline:**
  - cada tramo es un botón;
  - al tocarlo muestra minutos, nivel, causas (todas las relevantes), altitud aproximada (rango de FL del tramo, redondeado a 10) y ubicación.
- **Condiciones por altitud:**
  - FL300, FL320, FL340, FL360, FL380 y FL400 durante la parte de crucero de la ruta;
  - por nivel se muestra el peor tramo y el % de ruta con turbulencia;
  - se destaca la capa más tranquila;
  - aviso fijo: "La altitud real del vuelo depende del plan de vuelo, tráfico, control aéreo, peso y condiciones operativas."

## 7. Frescura
- "Consulta realizada hace X min" (hora local de la consulta).
- "Ejecución del modelo: ECMWF 00 UTC · GFS 06 UTC", de `meta.json` → `last_run_initialisation_time`. Si falla, no se muestra.

## 8. Historial de pronósticos (`js/storage.js`)
- `localStorage['turbi.forecasts']`: hasta 5 vuelos × 6 instantáneas `{t, maxLevel, verdict, score, confidence}`. Se guarda una instantánea si han pasado ≥ 10 min desde la anterior.
- Mensajes, comparando con la instantánea anterior:
  - mejor nivel máximo o veredicto → "La previsión ha mejorado desde la consulta de las 09:00";
  - peor → "ha empeorado";
  - igual → "Sin cambios relevantes desde hace 3 h".
- Se elimina el borrado de `turbi.history` (clave antigua), porque ya no se usa.

## 9. Offline del último pronóstico
- `localStorage['turbi.last']`: el modelo de vista completo ya procesado y la hora de consulta.
- Sin conexión, o si la consulta falla por red, se ofrece y se muestra con la franja "Pronóstico guardado · consultado hace 2 h". Nunca se presenta como actualizado.

## 10. Aviation Weather (`scripts/build-aviation.mjs` + `js/aviation-weather.js`)
- **En Actions, cada hora** (User-Agent propio, < 10 peticiones por ejecución):
  - METAR y TAF de los aeropuertos que aparecen en los horarios, por lotes;
  - SIGMET internacionales;
  - PIREP/AIREP en el rectángulo Europa + Atlántico Norte (últimas 6 h).
  - Se publica en `data/aviation/*.json` con la hora de descarga.
- **En la app:**
  - METAR y TAF de origen y destino, con un resumen en español y el texto original desplegable;
  - SIGMET de turbulencia, tormentas u onda de montaña vigentes durante el vuelo y a menos de 100 km de la ruta;
  - PIREP con turbulencia a menos de 150 km de la ruta.
  - Si no hay ninguno: "No hay informes recientes disponibles en esta zona", nunca "no hay turbulencia".
- Para buscar METAR se necesita el código OACI, así que `data/airports.json` añade el ICAO como 5.º campo (compatible con el formato actual).

## 11. Mapa (`js/map.js`)
- Leaflet 1.9 desde cdnjs y teselas de OpenStreetMap, con atribución.
- Se carga **después** de pintar el resultado, con import dinámico. Si falla, no pasa nada.
- Muestra la ruta coloreada por nivel, origen y destino, y los SIGMET/PIREP cercanos.

## 12. Audio (`js/speech.js`)
- Botón "Escuchar previsión" con `speechSynthesis` (es-ES), solo si el navegador lo admite. Nunca automático.
- Texto construido a partir del resumen (función pura y testeada).

## 13. Rigor de los textos
- Se sustituye "no pone en peligro el avión. Con el cinturón abrochado no pasa nada" por: "La turbulencia es habitual en la aviación comercial. Llevar el cinturón abrochado mientras estás sentado reduce mucho el riesgo de lesiones."
- Pie fijo: "Estimación orientativa para pasajeros a partir de modelos meteorológicos públicos. No es información operacional ni de seguridad."

## 14. Arquitectura
Módulos nuevos, pequeños y con tests:
- `altitude.js` (ISA, crucero, perfil)
- `turbi-index.js` (diagnósticos por capa, índice, causas)
- `models.js` (petición por modelo, combinación, acuerdo)
- `confidence.js`
- `summary.js` (resumen, porcentajes, altitudes)
- `storage.js` (historial y último pronóstico)
- `aviation-weather.js`
- `map.js`
- `speech.js`

`turbulence.js` conserva la v1 (tests intactos), que se usa como respaldo. `app.js` solo orquesta.
