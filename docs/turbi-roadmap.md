# Turbi — Roadmap

## Radar: identificación del vuelo
- **Hecho (25/09/2026):** números de 1 o 2 cifras se buscan también rellenados con ceros (UX15 → `AEA15` y, si no aparece, `AEA015`). **Solo resuelve el relleno con ceros.**
- **Pendiente:** indicativos operativos alfanuméricos o distintos del número comercial (p. ej. Aer Lingus EI737 → `EIN7LM`, Ryanair, easyJet), y mejor identificación de la aerolínea que opera en los códigos compartidos. Sin deducir qué avión es: solo con datos verificables.

## Llegada estimada (vuelos internacionales)
- **Pendiente:** guardar cada ETA predicha (método, distancia, fase) y compararla con la llegada real para validar y ajustar las heurísticas de `js/eta.js` (ver `docs/superpowers/specs/2026-09-25-turbi-eta-design.md`). No tocar el algoritmo hasta tener ese histórico.
