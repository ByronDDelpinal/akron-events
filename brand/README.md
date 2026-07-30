# Akron Pulse — theme logo exports

Transparent PNG lockups of the Akron Pulse logo, one set per site theme. Each
one is typeset in that theme's display font and painted in that theme's colors,
so the logo matches whatever palette the site or an embed is running.

Everything lives in `theme-logos/`: the 52 individual exports, plus four
`contact-sheet_*.png` overviews. Open the contact sheets first to pick a theme.

## Which file do I want?

Every theme ships four files:

```
AkronPulse_<Theme>_<horizontal|stacked>_<on-light|on-dark>.png
```

| Choice | Use when |
| --- | --- |
| `on-light` | Placing the logo on white or any light background (documents, decks, light web pages). |
| `on-dark`  | Placing it on a dark background. "Akron" is white here, so it will disappear on light backgrounds. |
| `horizontal` | Wide, short spaces — site headers, email signatures, letterheads, banners. |
| `stacked` | Square-ish spaces — social avatars, posters, merch, app tiles. |

All files have a genuinely transparent background and about 5% clear space
already built in on every side. They are 2,000–3,500 px on the long edge, which
is enough for print at a reasonable size; scale down freely, avoid scaling up.

The 13 themes are the ones in the public theme picker: Civic Teal (the brand
default), Grand Piano, Pulse Red, Twilight Plum, Forest & Amber, Civic Classic,
Harbor Civic, Violet Hour, Boardwalk, Olive Grove, Arcade Night, Stargazer, and
Prime Time. `theme-logos/manifest.json` lists every file with the exact hex
values and font used, which is the fastest way to match surrounding design work.

**If in doubt, use `AkronPulse_Civic-Teal_horizontal_on-light.png`.** Civic Teal
is the default brand palette.

Two themes are close to monochrome by design and their two words will not read
as different colors: Grand Piano on light (near-black on near-black — that
palette is deliberately concert-hall monochrome) and, more subtly, Stargazer and
Twilight Plum on light. That is the palette behaving correctly, not a bad
export.

## Regenerating

Nothing here is hand-maintained. The exporter reads the themes straight from the
app, so adding or recoloring a theme and re-running is enough to refresh the set.

```bash
bash brand/fonts/build-fonts.sh      # fetch + instance the display fonts
python3 brand/render-theme-logos.py  # write brand/theme-logos/
```

Sources of truth:

- `src/lib/themes.ts` — theme ids, display names, and the display font per theme
- `src/styles/themes.css` — `--amber`, `--amber-on-dark`, `--text-primary`
- `public/theme-logos/AkronPulse_White.png` — the pulse mark itself

The mark ships as a raster from the designer, and every shipped per-theme
variant of it has a byte-identical alpha channel. So the alpha *is* the artwork,
including its left-hand fade, and the RGB is only paint. The exporter reuses
that alpha as a mask and re-tints it, which reproduces the shipped assets rather
than approximating them.

Lockup proportions (mark size, gaps, alignment) are measured off the designer's
own `AkronPulse_Logo_horizontal-*` and `AkronPulse_Logo_stacked-*` files so
these exports sit next to those without looking like a different logo.

Fonts are pulled from the @fontsource mirrors of Google Fonts at build time
rather than vendored, so the licence stays with upstream and there is nothing to
keep in sync. Fraunces and Recursive are variable fonts; the build instances
them at exactly the axis values each theme's `googleFontsHref` requests
(Fraunces `SOFT=100` for Stargazer, Recursive `CASL=1` for Boardwalk).

## Not in here

These are exports, not the source artwork. The original designer lockups and the
per-theme mark files live in `public/theme-logos/` because the app serves them.
Nothing in `brand/` is bundled or deployed.
