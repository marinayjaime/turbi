# Genera los iconos de Turbi a partir de la T aislada del logotipo.
# Uso: python3 scripts/make-icons.py
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)
SRC = Image.open(ROOT / "img" / "turbi-mark.png").convert("RGBA")
MARGIN = 0.05

def icon(size):
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = round(size * (1 - 2 * MARGIN))
    scale = min(inner / SRC.width, inner / SRC.height)
    mark_size = (round(SRC.width * scale), round(SRC.height * scale))
    mark = SRC.resize(mark_size, Image.Resampling.LANCZOS)
    offset = ((size - mark.width) // 2, (size - mark.height) // 2)
    canvas.alpha_composite(mark, offset)
    return canvas

for size in (32, 180, 192, 512):
    icon(size).save(OUT / f"icon-{size}.png", optimize=True)
    print(f"icons/icon-{size}.png")
