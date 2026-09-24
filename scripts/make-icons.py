# Genera los iconos de Turbi a partir de img/plane.png (avión sobre fondo blanco).
# Uso: python3 scripts/make-icons.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)
SRC = Image.open(ROOT / "img" / "plane.png").convert("RGBA")
MARGIN = 0.14  # iOS recorta las esquinas: el avión no debe tocarlas

def icon(size):
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    inner = round(size * (1 - 2 * MARGIN))
    plane = SRC.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.alpha_composite(plane, (off, off))
    return canvas.convert("RGB")

for size in (32, 180, 192, 512):
    icon(size).save(OUT / f"icon-{size}.png")
    print(f"icons/icon-{size}.png")
