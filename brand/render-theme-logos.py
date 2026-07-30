#!/usr/bin/env python3
"""
render_logos.py — export the Akron Pulse lockup as transparent PNGs, one set
per theme, each typeset in that theme's display font and painted in that
theme's colors.

Sources of truth (nothing here is hand-copied):
  - src/lib/themes.ts     → theme ids, display names, display font family
  - src/styles/themes.css → --amber, --amber-on-dark, --text-primary
  - public/theme-logos/AkronPulse_White.png → the pulse mark's alpha channel

The pulse mark ships as a raster. Every shipped per-theme variant of it has a
byte-identical alpha channel, so the alpha IS the artwork (including the
left-hand fade) and the RGB is just paint. We reuse that mask and re-tint it,
which reproduces the shipped assets exactly rather than approximating them.

Variants, per theme:
  on-dark  → "Akron" white + "Pulse" in --amber-on-dark; mark is a white →
             --amber-on-dark gradient. Matches the site header on --bg-nav.
  on-light → "Akron" in --text-primary + "Pulse" in --amber; mark is flat
             --amber. Matches the shipped AkronPulse_Pulse-OnLight asset.
"""

import json
import os
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Repo-relative: this script lives at brand/render-theme-logos.py.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# TTFs are built by brand/fonts/build-fonts.sh (not committed — they are
# Google Fonts binaries, regenerate rather than vendor).
TTF = os.path.join(REPO, "brand", "fonts", "ttf")
MASK_SRC = os.path.join(REPO, "public", "theme-logos", "AkronPulse_White.png")
OUT = os.path.join(REPO, "brand", "theme-logos")

# Display-font family (from THEME_FONTS) → the TTF we converted for it.
# Fraunces and Recursive are variable; stargazer pins SOFT=100 and boardwalk
# pins CASL=1, exactly as their googleFontsHref axis tuples request.
FONT_FILE = {
    "Sora": "sora.ttf",
    "Playfair Display": "playfair-display.ttf",
    "Fraunces": "fraunces-700.ttf",
    "Cormorant Garamond": "cormorant-garamond.ttf",
    "Domine": "domine.ttf",
    "Libre Caslon Text": "libre-caslon-text.ttf",
    "DM Serif Display": "dm-serif-display.ttf",
    "Recursive": "recursive-700-casl.ttf",
    "Libre Baskerville": "libre-baskerville.ttf",
    "Unbounded": "unbounded.ttf",
    "Oswald": "oswald.ttf",
}
FONT_OVERRIDE = {"stargazer": "fraunces-700-soft100.ttf"}

# Lockup proportions are measured off the designer's shipped lockups
# (AkronPulse_Logo_horizontal-civictealblue.png and the stacked pair) so these
# exports sit beside those files without looking like a different logo.
FONT_SIZE = 340          # px em; final assets land ~2000-3000px wide
TRACKING = -0.02         # matches .nav-logo letter-spacing
MARK_TO_CAP = 1.88       # horizontal: mark height / cap height (230/122)
GAP_H = 0.26             # horizontal: mark-to-word gap, in cap heights
GAP_V = 0.55             # stacked: mark-to-word gap, in cap heights
STACK_MARK_TO_TEXT = 0.95  # stacked: mark width / wordmark width (550/575)
PAD = 0.055              # transparent margin, as a fraction of the long edge


# ── source-of-truth parsing ──────────────────────────────────────────────

def parse_themes():
    """Read theme ids/names/fonts from themes.ts and colors from themes.css."""
    ts = open(f"{REPO}/src/lib/themes.ts").read()

    # THEMES array: id / name / optional partner flag
    arr = ts.split("export const THEMES", 1)[1].split("\n]", 1)[0]
    entries = re.findall(
        r"\{\s*id:\s*'([^']+)',\s*name:\s*'([^']+)',(.*?)\}", arr, re.S
    )
    themes = [
        {"id": i, "name": n, "partner": "partner: true" in rest}
        for i, n, rest in entries
    ]

    # THEME_FONTS: display family per id
    fonts_blob = ts.split("export const THEME_FONTS", 1)[1]
    fonts = dict(
        re.findall(r"'([a-z-]+)':\s*\{[^}]*?display:\s*\"'([^']+)'", fonts_blob, re.S)
    )

    css = open(f"{REPO}/src/styles/themes.css").read()
    colors = {}
    for tid, body in re.findall(r"\.theme-([a-z-]+)\s*\{(.*?)\n\}", css, re.S):
        colors[tid] = {
            k: re.search(rf"--{k}:\s*(#[0-9A-Fa-f]{{6}})", body).group(1)
            for k in ("amber-on-dark", "amber", "text-primary")
        }

    for t in themes:
        t["font"] = fonts[t["id"]]
        t.update(colors[t["id"]])
    return themes


# ── the pulse mark ───────────────────────────────────────────────────────

def load_mask():
    """Alpha channel of the shipped mark, cropped to its ink."""
    a = np.array(Image.open(MASK_SRC).convert("RGBA"))[..., 3]
    ys, xs = np.where(a > 1)
    return a[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]


MASK = load_mask()
# Ink centroid of the mark (the artwork fades out to the left, so its bbox
# center and its optical center differ). Unused by the current lockups, which
# follow the designer's bbox alignment, but kept for anyone retuning them.
_col_weight = MASK.sum(axis=0).astype(float)
MASK_CENTROID_X = float((_col_weight * np.arange(MASK.shape[1])).sum() / _col_weight.sum())


def hex_rgb(h):
    return tuple(int(h[i: i + 2], 16) for i in (1, 3, 5))


def render_mark(height, left, right):
    """Re-tint the mark to a horizontal `left`→`right` gradient at `height` px."""
    w = max(1, round(height * MASK.shape[1] / MASK.shape[0]))
    alpha = Image.fromarray(MASK, "L").resize((w, height), Image.LANCZOS)

    t = np.linspace(0.0, 1.0, w)[None, :, None]
    lo, hi = np.array(hex_rgb(left), float), np.array(hex_rgb(right), float)
    rgb = np.repeat(lo * (1 - t) + hi * t, height, axis=0).round().astype(np.uint8)

    out = np.dstack([rgb, np.array(alpha)[..., None]])
    return Image.fromarray(out, "RGBA")


# ── typesetting ──────────────────────────────────────────────────────────

def cap_height(font):
    """Measured, not assumed — cap height varies wildly across these families."""
    box = font.getbbox("H")
    return box[3] - box[1]


def draw_wordmark(font, runs, tracking_px):
    """
    Draw styled runs [(text, color), ...] on a transparent canvas.

    Glyphs are positioned from cumulative getlength() of the full string, so
    HarfBuzz kerning is preserved; tracking is then subtracted per glyph. PIL
    has no letter-spacing, and drawing runs separately would drop the kern
    pairs that display serifs depend on.
    """
    text = "".join(t for t, _ in runs)
    colors = []
    for run_text, color in runs:
        colors += [color] * len(run_text)

    xs = []
    for i in range(len(text)):
        xs.append(font.getlength(text[:i]) + i * tracking_px)
    total = font.getlength(text) + (len(text) - 1) * tracking_px

    pad = FONT_SIZE  # generous scratch space; cropped at the end
    canvas = Image.new("RGBA", (int(total) + 2 * pad, FONT_SIZE * 3), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    for ch, x, color in zip(text, xs, colors):
        if ch != " ":
            d.text((pad + x, FONT_SIZE), ch, font=font, fill=hex_rgb(color) + (255,))
    return canvas.crop(canvas.getbbox())


# ── lockups ──────────────────────────────────────────────────────────────

def compose(mark, word, layout, cap):
    if layout == "horizontal":
        gap = round(GAP_H * cap)
        h = max(mark.height, word.height)
        out = Image.new("RGBA", (mark.width + gap + word.width, h), (0, 0, 0, 0))
        out.alpha_composite(mark, (0, (h - mark.height) // 2))
        out.alpha_composite(word, (mark.width + gap, (h - word.height) // 2))
        return out

    # Stacked: both elements centered on their bounding boxes, which is how
    # the designer's stacked lockup aligns them.
    gap = round(GAP_V * cap)
    width = max(word.width, mark.width)
    out = Image.new("RGBA", (width, mark.height + gap + word.height), (0, 0, 0, 0))
    out.alpha_composite(mark, ((width - mark.width) // 2, 0))
    out.alpha_composite(word, ((width - word.width) // 2, mark.height + gap))
    return out


def pad_out(img):
    p = round(PAD * max(img.size))
    out = Image.new("RGBA", (img.width + 2 * p, img.height + 2 * p), (0, 0, 0, 0))
    out.alpha_composite(img, (p, p))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    themes = [t for t in parse_themes() if not t["partner"]]
    manifest = []

    for t in themes:
        path = os.path.join(TTF, FONT_OVERRIDE.get(t["id"], FONT_FILE[t["font"]]))
        font = ImageFont.truetype(path, FONT_SIZE)
        cap = cap_height(font)
        mark_h = round(MARK_TO_CAP * cap)
        tracking_px = TRACKING * FONT_SIZE

        variants = {
            "on-dark": {
                "akron": "#FFFFFF",
                "pulse": t["amber-on-dark"],
                "mark": ("#FFFFFF", t["amber-on-dark"]),
            },
            "on-light": {
                "akron": t["text-primary"],
                "pulse": t["amber"],
                "mark": (t["amber"], t["amber"]),
            },
        }

        for vname, v in variants.items():
            word = draw_wordmark(
                font, [("Akron ", v["akron"]), ("Pulse", v["pulse"])], tracking_px
            )
            for layout in ("horizontal", "stacked"):
                h = mark_h
                if layout == "stacked":
                    target_w = STACK_MARK_TO_TEXT * word.width
                    h = round(target_w * MASK.shape[0] / MASK.shape[1])
                mark = render_mark(h, *v["mark"])
                img = pad_out(compose(mark, word, layout, cap))
                slug = t["name"].replace(" & ", "-").replace(" ", "-")
                name = f"AkronPulse_{slug}_{layout}_{vname}.png"
                img.save(os.path.join(OUT, name))
                manifest.append(
                    {
                        "theme": t["id"],
                        "name": t["name"],
                        "font": t["font"],
                        "layout": layout,
                        "variant": vname,
                        "file": name,
                        "size": list(img.size),
                        "colors": {
                            "akron": v["akron"],
                            "pulse": v["pulse"],
                            "mark": list(v["mark"]),
                        },
                    }
                )
        print(f"{t['name']:<16} {t['font']:<20} cap={cap}")

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\n{len(manifest)} files → {OUT}")


if __name__ == "__main__":
    main()
