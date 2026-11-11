#!/usr/bin/env python3
"""Label the Omniscience window: which region owns which part of the screen.

A header band is added above the screenshot so the title and region 1's own number never sit on
top of the toolbar they describe. A quarter grid lets a region be named in one breath.
"""

from __future__ import annotations

import sys
from PIL import Image, ImageDraw, ImageFont

SRC = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
DST = sys.argv[2] if len(sys.argv) > 2 else "window-map.png"

BAND = 46  # header band added above the screenshot

# Measured from the live page at 1440x900: (x, y, w, h)
REGIONS = [
    ("1", (0, 0, 1440, 54), "TOOLBAR", "views · mini panel · settings · version chip"),
    ("2", (0, 54, 270, 748), "SESSIONS RAIL", "chats, grouped by day"),
    ("3", (270, 54, 870, 748), "THE MAP", "whatever view you picked"),
    ("4", (1140, 54, 300, 748), "MINI PANEL", "context strip at its top"),
    ("5", (0, 802, 1440, 58), "FOOTER", "how current the facts are"),
]

COLORS = ["#22d3ee", "#a3e635", "#f472b6", "#fbbf24", "#94a3b8"]


def font(size: int, bold: bool = False):
    names = (
        ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]
        if bold
        else ["DejaVuSans.ttf", "LiberationSans-Regular.ttf"]
    )
    for name in names:
        for root in (
            "/usr/share/fonts/truetype/dejavu/",
            "/usr/share/fonts/truetype/liberation/",
        ):
            try:
                return ImageFont.truetype(root + name, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main() -> int:
    base = Image.open(SRC).convert("RGBA")
    width, height = base.size

    dim = Image.new("RGBA", base.size, (8, 10, 14, 120))
    page = Image.alpha_composite(base, dim)

    legend_height = 30 * len(REGIONS) + 16
    canvas = Image.new("RGBA", (width, height + BAND + legend_height), (10, 12, 16, 255))
    canvas.paste(page, (0, BAND))
    draw = ImageDraw.Draw(canvas, "RGBA")

    title_font, small, badge_font = font(15, True), font(12), font(19, True)

    draw.text((14, 6), "Omniscience window map", font=title_font, fill=(255, 255, 255, 255))
    hint = "Q1 top-left · Q2 top-right · Q3 bottom-left · Q4 bottom-right"
    draw.text(
        (width - draw.textlength(hint, font=small) - 14, 8),
        hint,
        font=small,
        fill=(180, 190, 200, 255),
    )
    draw.text(
        (14, 25),
        "each coloured box is one region; the list below names them",
        font=small,
        fill=(140, 150, 160, 255),
    )

    for step in (1, 2, 3):
        x = width * step // 4
        draw.line([(x, BAND), (x, BAND + height)], fill=(255, 255, 255, 40), width=1)
    draw.line([(0, BAND + height // 2), (width, BAND + height // 2)], fill=(255, 255, 255, 40), width=1)

    for index, (_, (x, y, w, h), name, detail) in enumerate(REGIONS):
        color = COLORS[index % len(COLORS)]
        rgb = tuple(int(color[i : i + 2], 16) for i in (1, 3, 5))
        ty = BAND + y

        canvas.paste(base.crop((x, y, x + w, y + h)), (x, ty))
        draw.rectangle([x + 1, ty + 1, x + w - 2, ty + h - 2], outline=rgb + (255,), width=2)

        bx, by = x + 10, ty + 10
        draw.rounded_rectangle([bx, by, bx + 28, by + 28], radius=7, fill=rgb + (240,))
        draw.text((bx + 9, by + 4), str(index + 1), font=badge_font, fill=(10, 12, 16, 255))

        row_y = BAND + height + 8 + index * 30
        draw.rounded_rectangle([14, row_y + 4, 36, row_y + 26], radius=6, fill=rgb + (240,))
        draw.text((21, row_y + 7), str(index + 1), font=small, fill=(10, 12, 16, 255))
        draw.text((46, row_y + 4), name, font=title_font, fill=rgb + (255,))
        draw.text(
            (46 + draw.textlength(name, font=title_font) + 10, row_y + 7),
            f"— {detail}",
            font=small,
            fill=(185, 195, 205, 255),
        )

    canvas.convert("RGB").save(DST, quality=92)
    print(DST)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
