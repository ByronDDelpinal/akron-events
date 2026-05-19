/**
 * intents.js
 *
 * Curated, multi-category presets used alongside raw categories in the
 * unified Filter & Sort tray. Each intent maps to one or more raw DB
 * categories; selecting an intent activates that category combination.
 *
 * Retired intents (May 2026):
 *   • get-active → use the 'fitness' raw category directly
 *   • free-fun   → use the Price=Free filter directly
 */

export const INTENTS = [
  {
    id:         'date-night',
    label:      'Date Night',
    emoji:      '🌙',
    tagline:    'Music, art, food & sports — a great evening out',
    categories: ['music', 'art', 'food', 'sports'],
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
    id:         'give-back',
    label:      'Give Back',
    emoji:      '💛',
    tagline:    'Volunteer, fundraise & support Akron',
    categories: ['nonprofit', 'community'],
    freeOnly:   false,
  },
]

/**
 * Search bar intent suggestions.
 * Re-points the retired intent-driven suggestions to direct filter combos.
 */
export const SEARCH_SUGGESTIONS = [
  { intentId: 'date-night',  label: 'Date Night ideas',                datePreset: null           },
  { intentId: 'family-fun',  label: 'Family friendly events',          datePreset: null           },
  { intentId: 'give-back',   label: 'Give back to Akron',              datePreset: null           },
  { intentId: 'date-night',  label: 'Music, art & food this weekend',  datePreset: 'this_weekend' },
]
