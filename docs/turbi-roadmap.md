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
- **Límite de adsb.lol (~1 petición/s):** varias consultas seguidas desde Render devuelven `no-disponible`. La variante con ceros añade una consulta más en los números cortos. Con el uso normal (una búsqueda de vez en cuando, con 60 s de caché) no se nota. Revisarlo si crece el uso.

## Pendiente

### Radar: identificación operativa
- Indicativos alfanuméricos o distintos del número comercial (p. ej. Aer Lingus EI737 → `EIN7LM`, Ryanair, easyJet).
- Identificar qué aerolínea opera en los códigos compartidos (hoy Aena no lo indica).
- Sin deducir qué avión es: solo con datos verificables.

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
