/**
 * categoryGlyphs.ts — category → SVG glyph asset (served from public/).
 *
 * Single source for the per-category icon used as a CSS mask: the badge glyph
 * (CategoryBadge) and the calendar day-row background motif both read from here,
 * so a category always shows the same icon. These mirror the per-category
 * mask-image URLs on the .gradient-*::after rules in globals.css — keep the two
 * in sync. Only 'other' has no glyph; it returns null and callers omit the icon.
 */
export const CATEGORY_GLYPHS: Record<string, string> = {
  music:        '/music-note.svg',
  theater:      '/theater.svg',
  film:         '/film.svg',
  comedy:       '/laugh.svg',
  'visual-art': '/paint-brush.svg',
  food:         '/apple.svg',
  sports:       '/baseball.svg',
  fitness:      '/weight.svg',
  outdoors:     '/leaf.svg',
  learning:     '/pencil.svg',
  festival:     '/sportlights.svg',
  market:       '/market-store.svg',
  civic:        '/city-block.svg',
  games:        '/dice.svg',
}

/** Resolve a category's glyph asset path, or null when it has none. */
export function categoryGlyph(category: string): string | null {
  return CATEGORY_GLYPHS[category] ?? null
}
