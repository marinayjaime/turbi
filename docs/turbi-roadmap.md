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

### Observado, sin resolver
- **Límite de adsb.lol (~1 petición/s):** varias consultas seguidas desde Render devuelven `no-disponible`. La variante con ceros añade una consulta más en los números cortos. Con el uso normal (una búsqueda de vez en cuando, con 60 s de caché) no se nota. Revisarlo si crece el uso.

## Pendiente

### Radar: identificación operativa
- Indicativos alfanuméricos o distintos del número comercial (p. ej. Aer Lingus EI737 → `EIN7LM`, Ryanair, easyJet).
- Identificar qué aerolínea opera en los códigos compartidos (hoy Aena no lo indica).
- Sin deducir qué avión es: solo con datos verificables.

### Llegada estimada: validación
- Guardar cada ETA predicha (método, distancia, fase, confianza) y compararla con la llegada real.
- Medir el error por fase y distancia, y solo entonces ajustar las heurísticas de `js/eta.js`.
