/**
 * eventGrouping.js
 *
 * Shared event-list helpers used by both HomePage and CategoryPage so
 * neighborhood / category hub pages can render the same date-grouped,
 * source-capped grid the homepage does without duplicating the logic.
 *
 * Both helpers are pure functions of their arguments — no React, no
 * side effects — so they live in /lib rather than /components. The
 * date-heading JSX lives next to its CSS over in
 * /components/DateHeading.jsx.
 */

import { format } from 'date-fns'

/**
 * Per-source limit before an overflow card is injected. Events beyond
 * this count are hidden until the user clicks the overflow card to
 * expand them. This is the knob that keeps a single high-volume source
 * (e.g. the library calendar) from drowning out other neighborhood
 * events on a busy day.
 */
export const SOURCE_CAP = 3

/**
 * Sources subject to the per-day cap. The "+N more from …" overflow
 * affordance only exists to keep the Akron-Summit County Public
 * Library's ~400-program calendar from drowning out everything else;
 * no other source is high-volume enough to warrant hiding events.
 * Anything not listed here renders every event uncapped (e.g. Akron
 * Life can surface as many events as it has).
 */
export const CAPPED_SOURCES = new Set(['akron_library'])

/**
 * applySourceCap(dayEvents, expandedSources, dateKey)
 *
 * Takes a flat, time-sorted array of events for one day and returns a
 * mixed array of items the grid should render:
 *
 *   { type: 'event',    event, isRevealed }
 *   { type: 'overflow', source, dateKey, hiddenCount, isExpanded }
 *
 * Algorithm:
 *  - Count events per source as we walk the list.
 *  - When a source hits SOURCE_CAP+1, inject an overflow card *at
 *    that position* (the card stays here forever — its grid slot never
 *    shifts).
 *  - Subsequent events from that source are hidden unless expanded.
 *  - Expanded sources show their hidden events immediately after the
 *    overflow card, interleaved in correct time order.
 */
export function applySourceCap(dayEvents, expandedSources, dateKey) {
  // sourceCounts: how many events we've emitted (not including
  // overflow card) per source.
  const sourceCounts    = {}
  // overflowEmitted: have we already emitted the overflow card for
  // this source?
  const overflowEmitted = {}
  // hiddenCounts: buffer of events suppressed per source (needed for
  // accurate counts on the overflow card).
  const hiddenCounts    = {}

  // First pass — collect how many events each source has beyond the
  // cap so we know the overflow card's label before we emit it.
  const sourceTotal = {}
  for (const ev of dayEvents) {
    const src = ev.source ?? 'unknown'
    sourceTotal[src] = (sourceTotal[src] ?? 0) + 1
  }

  const items = []

  for (const ev of dayEvents) {
    const src        = ev.source ?? 'unknown'
    const count      = sourceCounts[src] ?? 0
    const isExpanded = expandedSources.has(`${dateKey}-${src}`)
    const total      = sourceTotal[src]

    if (!CAPPED_SOURCES.has(src)) {
      // Uncapped source — always show every event, never inject an
      // overflow card.
      items.push({ type: 'event', event: ev, isRevealed: false })
      sourceCounts[src] = count + 1
    } else if (count < SOURCE_CAP) {
      // Always show events within the cap.
      items.push({ type: 'event', event: ev, isRevealed: false })
      sourceCounts[src] = count + 1
    } else {
      // This source has hit the cap.
      if (!overflowEmitted[src]) {
        // Emit the overflow card at this exact position (will never
        // move).
        const hiddenCount = total - SOURCE_CAP
        items.push({
          type: 'overflow',
          source: src,
          dateKey,
          hiddenCount,
          isExpanded,
        })
        overflowEmitted[src] = true
        hiddenCounts[src]    = hiddenCount
      }

      // Only show the event if this source is expanded.
      if (isExpanded) {
        items.push({ type: 'event', event: ev, isRevealed: true })
      }
      // (if not expanded, event is simply omitted from the item list)
    }
  }

  return items
}

/**
 * groupEventsByDate(events)
 *
 * Group a flat events array into [dateKey, events[]] pairs sorted
 * ascending by date. The key is the event's start_at formatted as
 * yyyy-MM-dd in the local timezone — the same format DateHeading
 * accepts and that the URL filter machinery understands.
 */
export function groupEventsByDate(events) {
  const groups = {}
  events.forEach((event) => {
    const key = format(new Date(event.start_at), 'yyyy-MM-dd')
    if (!groups[key]) groups[key] = []
    groups[key].push(event)
  })
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))
}
