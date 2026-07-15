/**
 * sources.ts — shared source metadata for public UI.
 *
 * Labels are DERIVED from scripts/manifest.js (the registry SSOT that owns
 * every scraper key and label), not hand-maintained here. The previous
 * hardcoded 5-entry SOURCE_LABELS map covered a fraction of the ~142 sources
 * and silently title-cased the rest, so `downtown_akron` rendered as "Downtown
 * Akron" instead of "Downtown Akron Partnership".
 *
 * manifest.js is pure data with no imports, so this is safe for the browser
 * bundle. src/lib/dataSources.ts derives its labels from the same place, but
 * carries ~1600 lines of editorial prose for the /technical page — importing it
 * here would drag all of that into the main bundle for a one-line label.
 */
import { SCRAPER_LABEL } from '../../scripts/manifest.js'
import { isAggregatorSource } from './sourceTiers.js'

/**
 * Returns a human-readable label for a source key.
 * Falls back to a title-cased version of the key itself.
 */
export function getSourceLabel(sourceKey: string | null | undefined): string {
  if (!sourceKey) return 'Unknown Source'
  return (
    (SCRAPER_LABEL as Record<string, string>)[sourceKey] ??
    sourceKey
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

/**
 * Whether to show a "Listed on X" provenance credit for an event.
 *
 * Only for AGGREGATOR sources, and only when we have no organizer to name.
 *
 * Aggregators are the case where provenance is both non-obvious and missing by
 * design: they republish other people's events, they often expose no organizer
 * we can trust (downtownakron.com publishes none at all), and our policy is to
 * assert no presenter rather than a wrong one. The credit answers the question
 * that vacuum creates — "where did this come from?" — without implying the
 * aggregator hosts it.
 *
 * First-party sources are deliberately excluded. Their source IS the venue,
 * which is already displayed a line above, so "Listed on BLU Jazz+" under a
 * venue reading "BLU Jazz+" is noise, not provenance.
 *
 * @param source     the event's `source` key
 * @param hasOrganizer whether the event already names a presenter
 */
export function shouldShowSourceCredit(
  source: string | null | undefined,
  hasOrganizer: boolean
): boolean {
  if (!source || hasOrganizer) return false
  return isAggregatorSource(source)
}
