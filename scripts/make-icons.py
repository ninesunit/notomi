"""
Generates the Notomi icon set.

The mark is a constellation: five nodes joined by edges tracing an "N", with
the diagonal in terracotta. It is the same shape as the program structure map
inside the app — a degree drawn as connected nodes — so the icon says what
Notomi is rather than just which letter it starts with.

Drawn from primitives rather than a typeface so it stays legible at 16px in a
browser tab, which is where an app icon is judged most often. The node radius
and edge weight are tuned so the letterform still reads when the dots merge at
small sizes.

Run: python3 scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
PUBLIC = ROOT / "public"

INK = (27, 26, 23, 255)  # #1B1A17
PAPER = (247, 245, 238, 255)  # #F7F5EE
ACCENT = (180, 85, 45, 255)  # #B4552D

# Draw oversized and downsample: PIL has no antialiased polygon fill.
SS = 4


def _line(draw: ImageDraw.ImageDraw, a, b, width: float, color) -> None:
    """A stroke with round caps, so joints at the nodes are seamless."""
    draw.line([a, b], fill=color, width=int(round(width)), joint="curve")
    for point in (a, b):
        r = width / 2
        draw.ellipse([point[0] - r, point[1] - r, point[0] + r, point[1] + r], fill=color)


def _node(draw: ImageDraw.ImageDraw, point, radius: float, color) -> None:
    x, y = point
    draw.ellipse([x - radius, y - radius, x + radius, y + radius], fill=color)


def draw_monogram(draw: ImageDraw.ImageDraw, size: int, inset: float) -> None:
    """Draws the constellation N centred in a `size` box, `inset` of its width."""
    span = size * inset
    left = (size - span) / 2
    top = (size - span) / 2
    right = left + span
    bottom = top + span

    # Five nodes: the two stems' ends plus the diagonal's midpoint. That is the
    # minimum that still reads as an N — more dots turn it into noise at 16px.
    top_left = (left, top)
    bottom_left = (left, bottom)
    top_right = (right, top)
    bottom_right = (right, bottom)
    middle = ((left + right) / 2, (top + bottom) / 2)

    # Weighted for the 32px favicon, not the 512px tile: at the thinner weight
    # that looked right large, the stems disappeared in a browser tab. Nodes
    # stay a little over the edge weight so they read as joints rather than as
    # a thick stroke, and they share the edge colour — a contrasting halo cut
    # visible gaps in the stems and made the mark look broken.
    edge = span * 0.135
    radius = span * 0.16

    # Stems first, then the diagonal on top so the accent crosses cleanly.
    _line(draw, top_left, bottom_left, edge, PAPER)
    _line(draw, top_right, bottom_right, edge, PAPER)
    _line(draw, top_left, middle, edge, ACCENT)
    _line(draw, middle, bottom_right, edge, ACCENT)

    for point in (top_left, bottom_left, top_right, bottom_right):
        _node(draw, point, radius, PAPER)
    # The centre node carries the accent, which is what fixes the reading order:
    # the eye follows the diagonal rather than seeing two separate bars.
    _node(draw, middle, radius * 1.05, ACCENT)


def tile(size: int, radius_ratio: float = 0.22, inset: float = 0.54) -> Image.Image:
    """Ink tile with a rounded corner and the monogram on top."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=INK
    )
    draw_monogram(draw, big, inset)
    return image.resize((size, size), Image.LANCZOS)


def square(size: int, inset: float = 0.54) -> Image.Image:
    """Full-bleed ink square — iOS masks its own corners."""
    big = size * SS
    image = Image.new("RGBA", (big, big), INK)
    draw_monogram(ImageDraw.Draw(image), big, inset)
    return image.resize((size, size), Image.LANCZOS)


def transparent_mark(size: int, inset: float) -> Image.Image:
    """Mark alone — for the Android adaptive foreground and the splash."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    # No halo on a transparent ground: a ring of ink would show as a dark disc
    # against whatever the launcher or splash paints behind it.
    draw_monogram(ImageDraw.Draw(image), big, inset)
    return image.resize((size, size), Image.LANCZOS)


def solid(size: int, color) -> Image.Image:
    return Image.new("RGBA", (size, size), color)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    PUBLIC.mkdir(exist_ok=True)

    written = []

    def save(image: Image.Image, path: Path) -> None:
        image.save(path, "PNG")
        written.append(f"{path.relative_to(ROOT)} ({image.size[0]}x{image.size[1]})")

    # iOS/app icon: full bleed, no rounding of our own.
    save(square(1024), ASSETS / "icon.png")

    # Browser tab + PWA. Rounded so it reads as an icon on a light tab strip.
    save(tile(512), ASSETS / "favicon.png")
    for px in (16, 32, 48, 180, 192, 512):
        save(tile(px), PUBLIC / f"icon-{px}.png")

    # Apple touch icon must be full-bleed: iOS applies its own mask and a
    # pre-rounded source leaves pale corners on the home screen.
    save(square(180), PUBLIC / "apple-touch-icon.png")

    # Splash: the mark alone on the paper background set in app.json.
    save(transparent_mark(1024, 0.5), ASSETS / "splash-icon.png")

    # Android adaptive icon: foreground must sit inside the 66% safe zone.
    save(transparent_mark(1024, 0.34), ASSETS / "android-icon-foreground.png")
    save(solid(1024, INK), ASSETS / "android-icon-background.png")
    save(transparent_mark(1024, 0.34), ASSETS / "android-icon-monochrome.png")

    # Multi-resolution .ico so the tab icon is sharp on every DPI.
    tile(256).save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    written.append("public/favicon.ico (multi-size)")

    print("\n".join(written))


if __name__ == "__main__":
    main()
