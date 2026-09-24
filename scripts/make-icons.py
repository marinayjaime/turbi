# Genera los iconos de Turbi: fondo blanco y tres ondas azules.
# Uso: python3 scripts/make-icons.py
import math
from pathlib import Path
from PIL import Image, ImageDraw

BLUE = (0, 122, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)

def icon(size):
    scale = 4  # supermuestreo para bordes suaves
    s = size * scale
    img = Image.new("RGB", (s, s), "white")
    d = ImageDraw.Draw(img)
    width = int(s * 0.055)
    for row, amp in zip((0.36, 0.5, 0.64), (0.035, 0.06, 0.035)):
        # Trazo como círculos solapados: evita los dientes de d.line con segmentos cortos.
        r = width / 2
        steps = 1200
        for i in range(steps + 1):
            x = s * (0.2 + 0.6 * i / steps)
            y = s * row + s * amp * math.sin(i / steps * 4 * math.pi)
            d.ellipse((x - r, y - r, x + r, y + r), fill=BLUE)
    return img.resize((size, size), Image.LANCZOS)

for size in (180, 192, 512):
    icon(size).save(OUT / f"icon-{size}.png")
    print(f"icons/icon-{size}.png")
