/**
 * mapConfig.ts
 *
 * Shared MapLibre constants. Moved out of MapView.tsx (2026-08-08, plan-map
 * work) so PlanMap.tsx doesn't have to duplicate them: before this, the
 * OpenFreeMap style URL and the Akron center point existed only inside
 * MapView.tsx, and a second inline copy in PlanMap.tsx would have meant two
 * places to update -- and one of them getting missed -- the next time
 * OpenFreeMap changes a style path. One import each in MapView.tsx and
 * PlanMap.tsx now.
 *
 * Tiles: OpenFreeMap public instance (free, unlimited, no API key —
 * https://openfreemap.org). Attribution is added automatically by MapLibre.
 */

export const AKRON_CENTER = { longitude: -81.519, latitude: 41.081 }

export const MAP_STYLES = {
  dark:  'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
} as const

/** Legacy default (PlanMap, FestivalMap). Surfaces that render on themed
 *  pages should prefer resolveMapStyle() below. */
export const MAP_STYLE = MAP_STYLES.dark

export const DEFAULT_ZOOM = 13

/**
 * Pick the basemap that matches the page's actual background luminance.
 *
 * The hardcoded dark style read as a broken black rectangle inside
 * light-themed white-label embeds (Everyday Akron's `postcard` theme,
 * 2026-08-16) — several seconds of full-bleed near-black while pins loaded.
 * Deriving light/dark from the computed background instead of a per-theme
 * flag means new themes can't silently drift out of sync with this choice.
 * Falls back to dark when there's no DOM (prerender) or the color is
 * unparsable.
 */
export function resolveMapStyle(): string {
  try {
    let bg = getComputedStyle(document.body).backgroundColor
    // A transparent body defers to the root element (theme classes set
    // --bg-page on <html>).
    if (!bg || bg === 'transparent' || /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg)) {
      bg = getComputedStyle(document.documentElement).backgroundColor
    }
    const m = bg.match(/\d+(\.\d+)?/g)
    if (m && m.length >= 3) {
      const [r, g, b] = m.slice(0, 3).map(Number)
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
      return luminance > 128 ? MAP_STYLES.light : MAP_STYLES.dark
    }
  } catch { /* no DOM (prerender) — fall through */ }
  return MAP_STYLES.dark
}
