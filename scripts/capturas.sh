#!/usr/bin/env bash
# Capturas de la página de muestras (scripts/muestras.html) con Chrome sin interfaz, para comparar el rediseño con la
# referencia (spec 2026-10-20 §11). Sirve la raíz con python3 -m http.server en un puerto libre y deja un PNG por
# estado en $TMPDIR/turbi-capturas/: iPhone (390×844, 2×, página entera), más programado y en-curso en desktop
# (1280×900). La emulación del dispositivo la hace scripts/capturas.mjs (Chrome no baja de 500 px con --window-size).
# No sustituye la prueba en un iPhone real (Safari y PWA): zonas seguras, barra de estado, teclado y barras de Safari.
# Sin argumentos, además, todos los estados a 345 y 320 px (*-345.png, *-320.png): la fila de resumen debe caber en
# una línea desde 340 px y nada debe desbordar a 320. capturas.mjs avisa de cualquier texto cortado o desbordado.
# Uso: bash scripts/capturas.sh [estado…]   (sin argumentos, todos). ANCHO=320 bash scripts/capturas.sh → solo a 320 px.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="${TMPDIR:-/tmp}/turbi-capturas"
ANCHO="${ANCHO:-390}"
ALTO="${ALTO:-844}"
SUFIJO=$([ "$ANCHO" = 390 ] || echo "-$ANCHO")
mkdir -p "$OUT"

ESTADOS=(programado en-curso finalizado sin-senal localizando turb-fuerte conf-baja incompleto aena-antigua solo-adb
  retrasado cancelado desviado tramos alias aterrizado-adsb aterrizado-oficial prev-no-disponible simplificado semana
  consulta carga sin-conexion)
[ $# -gt 0 ] && ESTADOS=("$@")

# Puerto libre: el que asigne el sistema.
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
# Al salir, se para el servidor (sin el aviso «Terminated» ni su código de salida).
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.1; done

JOBS=()
for e in "${ESTADOS[@]}"; do
  q="estado=$e"
  # en-curso con Detalles avanzados abierto: el panel «Detalles avanzados (abierto)» de la referencia.
  [ "$e" = en-curso ] && q="$q&abrir=advanced"
  JOBS+=("$e$SUFIJO|$ANCHO|$ALTO|$q")
done
if [ $# -eq 0 ] && [ "$ANCHO" = 390 ]; then
  JOBS+=("programado-desktop|1280|900|estado=programado" "en-curso-desktop|1280|900|estado=en-curso")
  for w in 345 320; do
    for e in "${ESTADOS[@]}"; do JOBS+=("$e-$w|$w|$ALTO|estado=$e"); done
  done
fi
node scripts/capturas.mjs "$CHROME" "http://127.0.0.1:$PORT" "$OUT" "${JOBS[@]}"
