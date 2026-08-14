"""Generate every Notomi launcher, PWA, splash and favicon asset.

The mark is an open academic workspace with one terracotta intelligence signal.
The book makes the product category immediate, its short page strokes suggest
schedules and structured notes, and the signal identifies Notomi's AI co-pilot.

Run: python scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
PUBLIC = ROOT / "public"

INK = (27, 26, 23, 255)  # #1B1A17
PAPER = (247, 245, 238, 255)  # #F7F5EE
ACCENT = (180, 85, 45, 255)  # #B4552D

# Oversampling keeps the custom curves crisp at favicon size.
SS = 4


def _cubic(start, control_a, control_b, end, steps: int = 24):
    points = []
    for index in range(1, steps + 1):
        t = index / steps
        inverse = 1 - t
        points.append(
            (
                inverse**3 * start[0]
                + 3 * inverse**2 * t * control_a[0]
                + 3 * inverse * t**2 * control_b[0]
                + t**3 * end[0],
                inverse**3 * start[1]
                + 3 * inverse**2 * t * control_a[1]
                + 3 * inverse * t**2 * control_b[1]
                + t**3 * end[1],
            )
        )
    return points


def _scaled(point, unit: float):
    return (point[0] * unit, point[1] * unit)


def _book_page(side: str):
    if side == "left":
        points = [(6.5, 11.6)]
        points += _cubic((6.5, 11.6), (9.6, 11.1), (12.8, 12), (16, 14.4))
        points.append((16, 24.8))
        points += _cubic((16, 24.8), (13.2, 22.7), (10.2, 22.3), (6.5, 22.7))
    else:
        points = [(25.5, 11.6)]
        points += _cubic((25.5, 11.6), (22.4, 11.1), (19.2, 12), (16, 14.4))
        points.append((16, 24.8))
        points += _cubic((16, 24.8), (18.8, 22.7), (21.8, 22.3), (25.5, 22.7))
    return points


def _signal():
    points = [(16, 4.6)]
    points += _cubic((16, 4.6), (16.3, 6.8), (17.4, 7.9), (19.6, 8.2), 16)
    points += _cubic((19.6, 8.2), (17.4, 8.5), (16.3, 9.6), (16, 11.8), 16)
    points += _cubic((16, 11.8), (15.7, 9.6), (14.6, 8.5), (12.4, 8.2), 16)
    points += _cubic((12.4, 8.2), (14.6, 7.9), (15.7, 6.8), (16, 4.6), 16)
    return points


def draw_mark(
    draw: ImageDraw.ImageDraw,
    size: int,
    page_color,
    detail_color,
    accent_color=ACCENT,
    show_details: bool = True,
) -> None:
    """Draw the same 32-unit mark used by the React Native SVG component."""
    unit = size / 32
    draw.polygon([_scaled(point, unit) for point in _book_page("left")], fill=page_color)
    draw.polygon([_scaled(point, unit) for point in _book_page("right")], fill=page_color)

    if show_details:
        detail_width = max(1, round(1.05 * unit))
        seam = [_scaled((16, 14.4), unit), _scaled((16, 24.8), unit)]
        draw.line(seam, fill=detail_color, width=detail_width)
        for start, end in (
            ((9.3, 15.6), (13.2, 15.9)),
            ((9.3, 18.6), (12.3, 18.8)),
            ((22.7, 15.6), (18.8, 15.9)),
            ((22.7, 18.6), (19.7, 18.8)),
        ):
            draw.line(
                [_scaled(start, unit), _scaled(end, unit)],
                fill=detail_color,
                width=detail_width,
            )

    draw.polygon([_scaled(point, unit) for point in _signal()], fill=accent_color)


def tile(size: int, radius_ratio: float = 0.265) -> Image.Image:
    """Ink tile with the complete full-colour mark."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * radius_ratio), fill=INK
    )
    draw_mark(draw, big, PAPER, INK)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def square(size: int) -> Image.Image:
    """Full-bleed launcher tile; iOS applies its own corner mask."""
    big = size * SS
    image = Image.new("RGBA", (big, big), INK)
    draw_mark(ImageDraw.Draw(image), big, PAPER, INK)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def transparent_splash(size: int) -> Image.Image:
    """Dark mark for the paper splash background configured in app.json."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(image), big, INK, PAPER)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def transparent_foreground(size: int, monochrome: bool = False) -> Image.Image:
    """Launcher-safe mark that sits on the adaptive icon's ink background."""
    big = size * SS
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    if monochrome:
        draw_mark(ImageDraw.Draw(image), big, PAPER, PAPER, PAPER, show_details=False)
    else:
        draw_mark(ImageDraw.Draw(image), big, PAPER, INK)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def solid(size: int, color) -> Image.Image:
    return Image.new("RGBA", (size, size), color)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    PUBLIC.mkdir(exist_ok=True)

    written = []

    def save(image: Image.Image, path: Path) -> None:
        image.save(path, "PNG")
        written.append(f"{path.relative_to(ROOT)} ({image.size[0]}x{image.size[1]})")

    save(square(1024), ASSETS / "icon.png")
    save(tile(512), ASSETS / "favicon.png")

    for pixels in (16, 32, 48, 180, 192, 512):
        save(tile(pixels), PUBLIC / f"icon-{pixels}.png")

    save(square(180), PUBLIC / "apple-touch-icon.png")
    save(transparent_splash(1024), ASSETS / "splash-icon.png")
    save(transparent_foreground(1024), ASSETS / "android-icon-foreground.png")
    save(solid(1024, INK), ASSETS / "android-icon-background.png")
    save(transparent_foreground(1024, monochrome=True), ASSETS / "android-icon-monochrome.png")

    tile(256).save(
        PUBLIC / "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    written.append("public/favicon.ico (multi-size)")

    print("\n".join(written))


if __name__ == "__main__":
    main()
