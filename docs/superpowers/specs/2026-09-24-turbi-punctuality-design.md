# Turbi — Puntualidad del vuelo: diseño

Fecha: 2026-09-24 · Basado en la auditoría de los datos reales de Aena hecha ese día.

## 1. Auditoría: qué da Aena

Endpoint: `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=<IATA>&flightType=S|L[&dosDias=si]` (ya usado por Turbi).

### 1.1 Campos que se usan

| Campo | Uso |
|---|---|
| `iataCompania`, `oaciCompania`, `nombreCompania`, `numVuelo` | Identificar el vuelo |
| `iataAena` (aeropuerto consultado), `iataOtro` (el otro extremo) | Origen y destino según sea salida (`S`) o llegada (`L`) |
| `fecha`, `horaProgramada` | **Hora programada** (fecha completa, hora local del aeropuerto consultado) |
| `fechaEstimada`, `horaEstimada` | **Hora estimada**, o **hora final** cuando el estado es final (ver 1.3) |
| `estado` | Distingue estimación de dato final |

No se publica ningún otro campo de Aena: ni puertas, ni mostradores, ni logos en el histórico.

### 1.2 Significado oficial de `estado`
Leído de `window.literal` en la web de Infovuelos de Aena el 24/09/2026:

| Código | Texto Aena | Uso en Turbi |
|---|---|---|
| (vacío), `SCH`, `INI` | (sin texto) | Programado |
| `HOR` | En hora | Programado, sin retraso |
| `RET` | Retrasado | Estimación |
| `BTR` | Próx. embarque | Estimación |
| `EMB` | Embarcando | Estimación |
| `ULL` | Últ. llamada | Estimación |
| `CER` | Cerrado | Estimación |
| `FLY` | En vuelo | Estimación de llegada |
| `FNL` | Aproximándose | Estimación de llegada |
| `LND` | En tierra | **Final (llegada)** |
| `IBK`, `OPE`, `OPF` | Entrega equip. | **Final (llegada)** |
| `BOR` | **Finalizado** | **Final** (salida y llegada) |
| `CAN` | Cancelado | Cancelado |
| `DES` | **Desviado** | Desviado (no cuenta como llegada) |
| `NPT`, `NPR`, `NSH`, `NSR`, `INF`, `SCO`, `CON` | Cambios de puerta/sala, info | Sin efecto en la puntualidad |

> Corrección: la ficha del vuelo traducía `BOR` como "Embarcando" y `DES` como "Despegado". Son "Finalizado" y "Desviado". Se corrige.

### 1.3 Hora programada y hora final
- **Programada:** `fecha` + `horaProgramada`.
- **Final:**
  - de salida: `fechaEstimada` + `horaEstimada` de la fila de **salida** (`S`) cuando `estado = BOR` (Finalizado);
  - de llegada: `fechaEstimada` + `horaEstimada` de la fila de **llegada** (`L`) cuando `estado ∈ {LND, IBK, OPE, OPF, BOR}`.
- Aena no dice si esa hora es la de despegue o calzos, ni la de aterrizaje o llegada a puerta. Es **la última hora publicada por Aena con el vuelo en estado final**, y así se documenta y se muestra.
- Con cualquier otro estado, la hora estimada es **solo una estimación**. **Nunca se guarda en el histórico.**
- **Retrasos:** `hora final − hora programada`, en minutos y con **fechas completas**. Programada y final son del mismo aeropuerto, así que no hay problema de zona horaria, y el paso de día queda cubierto.

### 1.4 Retención en Aena
Un vuelo en estado final sigue publicado unas 2 h (medido: máximo 127 min en salidas y 152 en llegadas en MAD). La descarga cada hora lo ve al menos una vez. No hay histórico hacia atrás: **el histórico empieza el día que se activa**.

### 1.5 Cobertura
Solo vuelos que salen de un aeropuerto de Aena o llegan a uno.
- Salida y llegada en España: hay los dos datos.
- Hacia el extranjero: solo la salida. La puntualidad se da **de salida** y se indica.
- Desde el extranjero: solo la llegada.

## 2. Métrica principal: OTP15
- Puntual si el retraso de **llegada** es ≤ 15 min (una llegada adelantada cuenta como puntual).
- `OTP15 = llegadas con retraso ≤ 15 / llegadas completadas con hora final`.
- **Cancelaciones y desvíos** se cuentan aparte (`% cancelados`). No entran en OTP15 ni en los percentiles.
- Sin datos de llegada (destino extranjero), se usa el retraso de salida y la interfaz lo dice ("puntualidad de salida").
- **Estadísticas:**
  - mediana, destacada como "retraso habitual";
  - media;
  - P75 y P90 por rango más cercano sobre los retrasos ordenados (los retrasos negativos se conservan).
- **Muestra:** < 10 → insuficiente (no se muestran porcentajes); 10–29 → orientativa; ≥ 30 → útil. Siempre se muestra `n`.
- **Etiqueta descriptiva**, solo con muestra útil: excelente ≥ 90 % · buena 80–89 % · normal 65–79 % · baja < 65 %. No hay notas del tipo "8,7/10" ni "probabilidad de puntualidad".

## 3. Persistencia
- **Rama `data` del mismo repositorio**, que nunca se publica ni se fusiona con `main`. Contiene `punctuality/days/AAAA-MM-DD.json`, un archivo por día de salida.
- **Por qué:**
  - es gratis y no necesita servicios externos;
  - sobrevive a cada despliegue;
  - los *artifacts* caducan y la caché de Actions se puede borrar.
- JSON sin comprimir para que git guarde solo diferencias entre versiones: un gzip cambiaría entero cada hora.
- **Cada ejecución horaria:**
  1. clona la rama con `--depth 1`;
  2. actualiza solo los días afectados (normalmente hoy y ayer);
  3. hace un commit pequeño si hay cambios.
- **Retención:** 100 días en la rama (las ventanas llegan a 90).
- **Crecimiento:** ~5.800 vuelos físicos/día → ~380 KB/día en la rama → ~35 MB con 100 días. Git comprime las diferencias en el historial de la rama.

### 3.1 Registro (sin datos personales)
`[d, o, a, sd, dd, sa, ad, x, [números]]`:
- `d`: fecha local de salida;
- `o`, `a`: origen y destino;
- `sd`, `sa`: horas programadas de salida y llegada;
- `dd`, `ad`: retrasos finales en minutos (o `null`);
- `x`: `0` normal · `1` cancelado · `2` desviado;
- números de vuelo de todos los códigos compartidos.

El día de la semana y la franja se calculan a partir de `d` y `sd`.

### 3.2 Duplicados
- **Clave:** `d | o | a | sd | sa` (vuelo físico).
- Así los códigos compartidos (IB1668 / I21668) son **un solo vuelo** y no inflan las estadísticas de ruta.
- Un número de vuelo se busca dentro de la lista `números`.
- Cada observación nueva sustituye a la anterior del mismo vuelo; se queda la última hora final publicada.

## 4. Agregados que llegan al navegador
Cada ejecución genera `data/punctuality/<AL>/<N>.json`, **uno por número de vuelo, solo si tiene historial**:

```json
{ "updated": "…", "routes": { "PMI-MAD": {
    "basis": "arr",
    "last7": { "sample": 7, "otp15": 0.86, "median": 4, "mean": 9, "p75": 12, "p90": 31, "cancelled": 0, "cancelRate": 0, "flights": [["2026-09-24", 12, 0], …] },
    "d30": { … }, "d90": { … },
    "route": { … }, "airlineRoute": { … },
    "dow": { "0": { … }, …, "6": { … } }, "slot": { "0": { … }, …, "3": { … } } } } }
```

- Ventanas: últimos 7 vuelos, 30 días y 90 días.
- Contexto de 90 días: ruta (todas las aerolíneas), aerolínea + ruta, día de la semana y franja horaria.
  - Día y franja se calculan sobre la **ruta**, para tener muestra suficiente, y se indica.
- Franjas: 00–06, 06–12, 12–18 y 18–24 h (hora local de salida).
- Tendencia: solo si 30 días y 90 días tienen muestra útil y difieren ≥ 10 puntos. Si no, "Sin cambios relevantes" o no se muestra. Nunca "está empeorando" con muestras pequeñas.
- Tamaño: unos pocos KB por vuelo. El navegador descarga solo el del vuelo consultado.

## 5. Situación actual del vuelo (sin histórico)
- Retrasos de salida y llegada, con fechas completas, a partir de `sd/ed` y `sa/ea` del horario ya publicado.
- **Clasificación por la llegada:** ≤ 15 → puntual · > 15 → retrasado · cancelado · desviado.
- Si no hay hora estimada distinta de la programada: "Sin cambios sobre el horario programado". Nunca "puntual seguro".
- Si el estado es final: "Llegó…" / "Salió…". Si no: "prevista".
- **Colores:** verde ≤ 15 · amarillo 16–30 · naranja 31–60 · rojo > 60 o cancelado. La métrica oficial sigue siendo ≤ 15.

## 5.1 Fidelidad a la fuente (norma del proyecto)
- Turbi muestra **exactamente** las horas que publica Aena. Nunca las recalcula, corrige ni sustituye por estimaciones propias.
  - Se probó una corrección "programada + retraso de salida" el 24/09/2026 y se retiró: inventaba una hora.
- Cada hora indica su fuente ("según Aena en PMI" / "según Aena en MAD"). Salida y llegada las publican aeropuertos distintos, que actualizan por separado.
- Antes del despegue, la llegada se marca como estimación de Aena que puede cambiar. No se opina sobre si es correcta.
- Si los datos de Aena tienen más de 40 min, la ficha lo avisa de forma visible.
- **Filas duplicadas en Aena:** a veces Aena publica el mismo vuelo (número, fecha y hora programada) en dos filas con horas estimadas distintas; lo detectó la auditoría el 24/09/2026 (p. ej. FR1709 VLC 09:50 / 09:55).
  - Se muestra como principal la fila que trae estado (si no, la primera).
  - **La otra hora se muestra también**, con el aviso "Aena publica también otra hora…".
- **Auditoría en cada descarga:** cada hora que se publica se compara con la fila de Aena de la que procede. Las discrepancias se registran en el log del workflow y en `data/flights/_meta.json`. Primera ejecución real: 27.597 horas, 0 discrepancias.

## 6. Límites y cosas que no se hacen
- **Efecto en cadena del avión:** Aena da el **tipo** de avión (`A21N`), no la matrícula, así que no se pueden seguir sus rotaciones. Queda como mejora futura si aparece una fuente gratuita con matrícula.
- **Meteorología:** no se traduce a minutos de retraso. Como mucho se muestra contexto del METAR/TAF ya existente.
- **Sin histórico retroactivo:** Aena no publica el pasado.

## 7. Arquitectura
- `js/punctuality.js`: funciones puras (retrasos, OTP15, percentiles, ventanas, franjas, tendencia, clasificación). Se usa en el navegador y en Actions.
- `scripts/build-punctuality.mjs`: observaciones finales a partir de las filas de Aena, fusión con la rama `data`, poda y agregados por vuelo.
- `.github/workflows/deploy.yml`: clona o crea la rama `data`, ejecuta y hace commit y push si hay cambios. Necesita `contents: write`.

## 8. Estado en tiempo real (Render)
- El cron de GitHub no es fiable (a veces pasa horas sin ejecutarse), así que el estado del vuelo de hoy lo da un servicio aparte: `server/live.mjs` en Render gratis (`render.yaml`).
- **Cada 10 min** descarga Aena (hoy y mañana), audita cada hora publicada contra su fila de origen y sirve `/flights/AL/N.json`. **No guarda nada ni calcula el histórico.**
- El histórico de puntualidad sigue en GitHub Actions y GitHub Pages: cambia poco de una hora a otra.
- La app pide primero a Render (5 s como máximo) y, si no responde, usa GitHub Pages; en la ficha avisa si los datos tienen más de 40 min.
- **Una cuenta de Render propia para Turbi:** las 750 h gratis al mes son por cuenta, y Métricas ya las gasta casi todas. Si se superan, Render suspende todos los servicios gratuitos de la cuenta.
- Si el servicio se duerme, la primera petición lo despierta y lanza una descarga. Para que esté siempre despierto, UptimeRobot llama a `/health` cada 5 min.
- Memoria: unos 280 MB con `--max-old-space-size=256` (límite del plan gratis: 512 MB).
