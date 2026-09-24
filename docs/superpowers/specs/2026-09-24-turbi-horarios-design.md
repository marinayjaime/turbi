# Turbi — Horarios automáticos y ficha del vuelo

Fecha: 2026-09-24 · Amplía `2026-09-24-turbi-design.md` · Decisiones tomadas por Claude a petición de Jaime ("haz lo más recomendado").

## 1. Objetivo

- Introducir **solo el número de vuelo** (y opcionalmente la fecha). Turbi obtiene sola la hora de salida y de llegada.
- Mostrar una **ficha del vuelo** al estilo de Google: logo de la aerolínea, nombre y número, ruta, pestañas de fechas, estado, horas programadas/estimadas, terminal, puerta y avión.
- Seguir con coste cero y sin registros nuevos.

## 2. Fuente de horarios: Aena Infovuelos

- Endpoint público usado por la web de Aena: `https://www.aena.es/sites/Satellite?pagename=AENA_ConsultarVuelos&airport=<IATA>&flightType=S|L[&dosDias=si]`.
  - `S` = salidas, `L` = llegadas. Sin `dosDias`: 14 días. Con `dosDias=si`: hoy y mañana.
  - Campos usados: `iataCompania`, `oaciCompania`, `nombreCompania`, `numVuelo`, `fecha` (DD/MM/YYYY), `horaProgramada`, `fechaEstimada`, `horaEstimada`, `iataOtro`, `estado`, `terminal`, `puertaPrimera`, `tipoAeronave`. Horas en hora local del aeropuerto consultado.
- No se puede llamar desde el navegador (CORS). Se descarga en **GitHub Actions** y se publica como archivos estáticos junto a la app.
- Cobertura: vuelos que salen o llegan a los 43 aeropuertos de la red Aena. El resto usa el flujo anterior (adsbdb + hora manual).

## 3. Pipeline (`.github/workflows/deploy.yml` + `scripts/build-flights.mjs`)

- GitHub Pages pasa a desplegarse **desde Actions** (no desde la rama), para que los datos no generen commits.
- Disparadores: push a `main`, cron cada hora (`minuto 7`), manual.
- Modo `full` (push, manual, o hora UTC múltiplo de 6): 14 días de salidas y llegadas de todos los aeropuertos.
- Modo `live` (resto de horas): solo `dosDias=si`; se fusiona con los tramos publicados anteriormente (`data/flights/_legs.json`), sustituyendo las fechas refrescadas.
- Si Aena falla, se conservan los datos anteriores; si no los hay, se publica la app sin horarios (nunca se rompe el despliegue).
- Salida:
  - `data/flights/<AL>/<N>.json` → `{ name, legs: Leg[] }` (un archivo por vuelo; `AL` = código IATA de aerolínea, `N` = número sin ceros a la izquierda).
  - `data/flights/airlines.json` → `{ <ICAO>: <IATA> }`.
  - `data/flights/_legs.json` → todos los tramos (para la fusión horaria).
- `Leg = { d, o, a, sd, ed, sa, ea, td, ta, g, st, ac }`:
  - `d` fecha local de salida `YYYY-MM-DD` (si solo hay dato de llegada: fecha de llegada).
  - `o`/`a` IATA origen/destino.
  - `sd`/`sa` salida/llegada programadas `HH:MM` (o `null`).
  - `ed`/`ea` estimadas `YYYY-MM-DDTHH:MM` (o `null`).
  - `td`/`ta` terminal salida/llegada, `g` puerta de salida, `st` estado Aena, `ac` tipo de avión.
- Unión salida↔llegada: misma aerolínea, número, origen y destino; la llegada cuya hora (ingenua, local) está entre 0 y 20 h después de la salida, la más cercana.
- Carga para Aena: ~31 MB/h en modo live y ~220 MB cada 6 h en modo full.

## 4. App

- **Entrada:** nº de vuelo + fecha (por defecto hoy). Se acepta IATA (`IB1668`) o ICAO (`IBE1668`, vía `airlines.json`).
- **Búsqueda:**
  1. `data/flights/<AL>/<N>.json`.
  2. Si existe: se elige el tramo de esa fecha (o el siguiente disponible) y se calcula la turbulencia con la salida estimada (o programada) y la **duración real** llegada−salida (si hay llegada).
  3. Si no existe: flujo anterior (adsbdb para la ruta + campo de hora visible con aviso "No tengo el horario de este vuelo; indica la hora de salida").
- **Ficha del vuelo** (encima de la turbulencia):
  - Logo `https://pics.avs.io/200/80/<AL>.png` (si falla, se oculta) + "Iberia IB 1668" + "Palma a Madrid".
  - Pestañas con las fechas disponibles del vuelo (máx. 7); tocar una recalcula.
  - Estado:
    - `CAN` Cancelado (rojo);
    - `RET` o estimada > programada + 15 min → "Retrasado" (naranja) con la hora estimada;
    - `BOR`/`EMB` Embarcando;
    - `ULL` Última llamada;
    - `CER` Puerta cerrada;
    - `DES` Despegado;
    - `ATE`/`LLE` Aterrizado;
    - resto → Programado (verde).
  - `PMI ✈ MAD` con la duración.
  - Salida: hora programada (y estimada si difiere), terminal, puerta.
  - Llegada: hora programada (o "—"), terminal.
  - Avión (`A21N`).
  - Pie: "Fuente: Aena".
- La entrada manual por aeropuertos se mantiene.

## 5. Pruebas

- Vitest para las funciones puras del pipeline (normalizar filas, unir salidas/llegadas, fusionar modo live, trocear en archivos) y de `js/schedule.js` (parseo del número, elección de tramo, horas, estado).
- Prueba de navegador (Playwright, WebKit iPhone) contra la web publicada con un vuelo real de Aena.
- Ejecución real del workflow en GitHub para confirmar que Aena responde desde los servidores de GitHub.
