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
  music:        '/music_pulse.svg',
  theater:      '/theater_pulse.svg',
  film:         '/film_pulse.svg',
  comedy:       '/comedy_pulse.svg',
  'visual-art': '/art_pulse.svg',
  food:         '/food_pulse.svg',
  sports:       '/sports_pulse.svg',
  fitness:      '/fitness_pulse.svg',
  outdoors:     '/outdoors_pulse.svg',
  learning:     '/learning_pulse.svg',
  festival:     '/festival_pulse.svg',
  market:       '/market_pulse.svg',
  civic:        '/civic_pulse.svg',
  games:        '/games_pulse.svg',
}

/** Resolve a category's glyph asset path, or null when it has none. */
export function categoryGlyph(category: string): string | null {
  return CATEGORY_GLYPHS[category] ?? null
}
