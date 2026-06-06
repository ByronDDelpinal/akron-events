/**
 * sources.ts — shared source metadata
 *
 * Centralised here so FilterBar (active-filter chips) and the
 * SourceOverflowCard (per-day cap UI) reference the same labels.
 */

export const SOURCE_LABELS: Record<string, string> = {
  akron_library:      'Akron Library',
  summit_metro_parks: 'Metro Parks',
  eventbrite:         'Eventbrite',
  ticketmaster:       'Ticketmaster',
  akron_life:         'Akron Life',
}

/**
 * Returns a human-readable label for a source key.
 * Falls back to a title-cased version of the key itself.
 */
export function getSourceLabel(sourceKey: string | null | undefined): string {
  if (!sourceKey) return 'Unknown Source'
  return (
    SOURCE_LABELS[sourceKey] ??
    sourceKey
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}
