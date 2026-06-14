/**
 * Lightweight, device-local engagement signals used to time the PWA
 * install promotion.
 *
 * Rationale: a pure "second visit" gate prompts people who may have just
 * bounced. Someone who has set a neighborhood or read a few event pages
 * has shown real intent, so we surface the install pill to them sooner.
 * All signals are best-effort and degrade to "no intent" if storage is
 * unavailable — the prompt simply falls back to visit-count gating.
 */
import { getMyHubSlug } from '@/lib/myHub'

const EVENT_VIEWS_KEY = 'akronpulse.event_view_count'
const COUNTED_IDS_KEY = 'akronpulse.counted_event_ids'

/** Event-detail views that signal enough interest to suggest installing. */
const INTENT_VIEW_THRESHOLD = 3

/**
 * Record an engaged view of an event detail page. Deduped per browser
 * session so refreshes and the slug-canonicalizing redirect don't inflate
 * the count — only distinct events seen this session move the needle.
 */
export function recordEventView(eventId: string): void {
  try {
    const seen: string[] = JSON.parse(sessionStorage.getItem(COUNTED_IDS_KEY) ?? '[]')
    if (seen.includes(eventId)) return
    seen.push(eventId)
    sessionStorage.setItem(COUNTED_IDS_KEY, JSON.stringify(seen))
    const next = (parseInt(localStorage.getItem(EVENT_VIEWS_KEY) ?? '0', 10) || 0) + 1
    localStorage.setItem(EVENT_VIEWS_KEY, String(next))
  } catch { /* storage unavailable: intent simply never trips */ }
}

function eventViewCount(): number {
  try {
    return parseInt(localStorage.getItem(EVENT_VIEWS_KEY) ?? '0', 10) || 0
  } catch {
    return 0
  }
}

/**
 * True once the visitor has shown install intent: they've picked a
 * neighborhood, or read enough event pages to be a regular. Lets the
 * install pill appear ahead of the plain visit-count threshold.
 */
export function hasInstallIntent(): boolean {
  return getMyHubSlug() !== null || eventViewCount() >= INTENT_VIEW_THRESHOLD
}
