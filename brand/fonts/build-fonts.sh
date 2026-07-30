#!/usr/bin/env bash
# build-fonts.sh — fetch the display fonts the theme logos are typeset in and
# convert them to TTFs that Pillow can render.
#
# The fonts are Google Fonts (all SIL Open Font License). We pull them from the
# @fontsource npm mirrors instead of vendoring binaries into the repo, so the
# licence stays with upstream and there is nothing to keep in sync by hand.
#
# Fraunces and Recursive are variable fonts; we instance them at exactly the
# axis values src/lib/themes.ts requests in each theme's googleFontsHref
# (Fraunces SOFT=100 for Stargazer, Recursive CASL=1 for Boardwalk), so the
# exported logo matches what the site actually renders.
#
# Usage:  bash brand/fonts/build-fonts.sh && python3 brand/render-theme-logos.py
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p ttf

# Own package.json first. Without one, npm walks up to the repo root and
# installs these into the app's node_modules, which is not where they belong.
# This file and the node_modules it creates are gitignored (see .gitignore).
[ -f package.json ] || npm init -y --scope=brand-fonts >/dev/null

npm install --silent \
  @fontsource/sora \
  @fontsource/playfair-display \
  @fontsource/fraunces \
  @fontsource/cormorant-garamond \
  @fontsource/domine \
  @fontsource/libre-caslon-text \
  @fontsource/dm-serif-display \
  @fontsource/recursive \
  @fontsource/libre-baskerville \
  @fontsource/unbounded \
  @fontsource/oswald \
  @fontsource-variable/fraunces \
  @fontsource-variable/recursive

python3 -m pip install --quiet --break-system-packages fonttools brotli

python3 - <<'PY'
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

NM = "node_modules"

def convert(src, dst, axes=None):
    f = TTFont(src)
    if axes:
        f = instancer.instantiateVariableFont(f, axes, inplace=True)
    f.flavor = None            # woff/woff2 -> plain TTF
    f.save(dst)
    print("->", dst)

STATIC = {
    "sora": "sora-latin-700-normal",
    "playfair-display": "playfair-display-latin-700-normal",
    "cormorant-garamond": "cormorant-garamond-latin-700-normal",
    "domine": "domine-latin-700-normal",
    "libre-caslon-text": "libre-caslon-text-latin-700-normal",
    "dm-serif-display": "dm-serif-display-latin-400-normal",  # single weight
    "libre-baskerville": "libre-baskerville-latin-700-normal",
    "unbounded": "unbounded-latin-700-normal",
    "oswald": "oswald-latin-700-normal",
}
for pkg, fname in STATIC.items():
    convert(f"{NM}/@fontsource/{pkg}/files/{fname}.woff", f"ttf/{pkg}.ttf")

FR = f"{NM}/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2"
convert(FR, "ttf/fraunces-700.ttf", {"wght": 700, "opsz": 144, "SOFT": 0})
convert(FR, "ttf/fraunces-700-soft100.ttf", {"wght": 700, "opsz": 144, "SOFT": 100})

RC = f"{NM}/@fontsource-variable/recursive/files/recursive-latin-full-normal.woff2"
convert(RC, "ttf/recursive-700-casl.ttf",
        {"wght": 700, "CASL": 1, "slnt": 0, "CRSV": 0, "MONO": 0})
PY

echo "Fonts built into brand/fonts/ttf/"
