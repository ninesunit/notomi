"""
Generates the Notomi icon set.

The mark is a two-tone monogram: an "N" whose stems are paper-coloured and
whose diagonal is the terracotta accent, set on an ink tile. It is built from
polygons rather than a typeface so it stays crisp at 16px in a browser tab,
which is where an app icon is judged most often.

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


def draw_monogram(draw: ImageDraw.ImageDraw, size: int, inset: float) -> None:
    """Draws the N centred in a `size` box, occupying `inset` of its width."""
    span = size * inset
    left = (size - span) / 2
    top = (size - span) / 2
    right = left + span
    bottom = top + span

    stem = span * 0.215  # stroke weight

    # Left and right stems.
    draw.rectangle([left, top, left + stem, bottom], fill=PAPER)
    draw.rectangle([right - stem, top, right, bottom], fill=PAPER)

    # The diagonal carries the accent colour, which is what makes the mark
    # readable as Notomi rather than a generic monogram.
    draw.polygon(
        [
            (left, top),
            (left + stem, top),
            (right, bottom),
            (right - stem, bottom),
        ],
        fill=ACCENT,
    )


def tile(size: int, radius_ratio: float = 0.22, inset: float = 0.46) -> Image.Image:
    """Ink tile with a rounded corner and the monogram on top."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=INK
    )
    draw_monogram(draw, big, inset)
    return image.resize((size, size), Image.LANCZOS)


def square(size: int, inset: float = 0.46) -> Image.Image:
    """Full-bleed ink square — iOS masks its own corners."""
    big = size * SS
    image = Image.new("RGBA", (big, big), INK)
    draw_monogram(ImageDraw.Draw(image), big, inset)
    return image.resize((size, size), Image.LANCZOS)


def transparent_mark(size: int, inset: float) -> Image.Image:
    """Monogram alone — for the Android adaptive foreground and the splash."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
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
