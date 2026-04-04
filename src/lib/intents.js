/**
 * intents.js
 *
 * Single source of truth for Turnout's curated intent presets.
 * Used by:
 *   • The hero search bar suggestion dropdown
 *   • The always-visible intent pill bar (replaces raw category chips)
 *
 * Each intent maps to one or more raw DB categories and/or a price filter.
 * Raw categories are only exposed in the FilterTray ("More" button).
 */

export const INTENTS = [
  {
    id:         'date-night',
    label:      'Date Night',
    emoji:      '🌙',
    tagline:    'Music, art & food — a great evening out',
    categories: ['music', 'art', 'food'],
    freeOnly:   false,
  },
  {
    id:         'give-back',
    label:      'Give Back',
    emoji:      '💛',
    tagline:    'Volunteer, fundraise & support Akron',
    categories: ['nonprofit', 'community'],
    freeOnly:   false,
  },
  {
    id:         'family-fun',
    label:      'Family Fun',
    emoji:      '👨‍👩‍👧',
    tagline:    'Kid-friendly things to do',
    categories: ['education', 'community'],
    freeOnly:   false,
  },
  {
    id:         'get-active',
    label:      'Get Active',
    emoji:      '🏃',
    tagline:    'Sports, fitness & outdoor events',
    categories: ['sports', 'fitness'],
    freeOnly:   false,
  },
  {
    id:         'free-fun',
    label:      'Free Fun',
    emoji:      '🎉',
    tagline:    'Great times, no wallet required',
    categories: [],
    freeOnly:   true,
  },
]

/**
 * Search bar intent suggestions.
 * Same intents as the pill bar; some include a datePreset combo.
 */
export const SEARCH_SUGGESTIONS = [
  { intentId: 'date-night',  label: 'Date Night ideas',               datePreset: null           },
  { intentId: 'free-fun',    label: 'Free things to do this weekend',  datePreset: 'this_weekend' },
  { intentId: 'family-fun',  label: 'Family friendly events',          datePreset: null           },
  { intentId: 'give-back',   label: 'Give back to Akron',              datePreset: null           },
  { intentId: 'get-active',  label: 'Get active this week',            datePreset: 'this_week'    },
  { intentId: 'date-night',  label: 'Music, art & food this weekend',  datePreset: 'this_weekend' },
  { intentId: 'free-fun',    label: 'Free events today',               datePreset: 'today'        },
]
