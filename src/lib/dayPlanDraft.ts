/**
 * dayPlanDraft.ts
 *
 * Pure, DOM-free localStorage read/write for the day planner's LOCAL draft
 * (/day, before any "Share" action creates a DB row). The draft NEVER
 * touches the network -- adding an event to a plan must work with the DB
 * down, and must not create a database row for the many visitors who add one
 * event and leave. Sharing (src/lib/dayPlanApi.ts's createDayPlan) is the one
 * action that creates a row.
 *
 * Storage keys use the underscore convention -- the three newest keys in
 * this codebase (akronpulse_card_view_mode, akronpulse_embed_request_cooldown_until,
 * akronpulse_feedback_cooldown_until) use underscore; older keys use a dot.
 * New keys follow the newer underscore form.
 *
 * All reads/writes are wrapped in try/catch and degrade to an empty/
 * in-memory draft on failure (private browsing, storage disabled, corrupt
 * JSON) -- matching feedback.ts / InstallPrompt.tsx.
 */

export const DRAFT_KEY = 'akronpulse_day_plan_draft'
export const ACTIVE_CODE_KEY = 'akronpulse_day_plan_code'

/** Mirrors D3 (server-side cap of 30, enforced by migration 052's item_count
 * CHECK). Enforced here too so the UI never lets a visitor build a plan the
 * server would reject wholesale at share time. */
export const MAX_ITEMS = 30

export interface DraftItem {
  event_id: string
  snap_title: string
  snap_start_at: string
  snap_end_at: string | null
  snap_venue: string | null
  /**
   * Add-time venue coordinates (2026-08-08, plan-map work). Optional on
   * purpose: drafts written before this shipped have neither field, and
   * must keep parsing -- see isValidDraft below, which only checks `v` and
   * `items`, not these two keys. Every consumer that reads them (PlanMap
   * via dayPlanDraft -> DayPlanPage.tsx -> planMapPoints.ts) treats a
   * missing/null pair as "unmapped", the same degradation a real event
   * with no venue coordinates gets. `v` stays 1 -- isValidDraft requires
   * `d.v === 1`, so bumping to v2 would wipe every existing draft on every
   * device the moment this ships, including plans built minutes earlier.
   */
  snap_venue_lat?: number | null
  snap_venue_lng?: number | null
  added_at: string
}

export interface DayPlanDraft {
  v: 1
  title: string | null
  items: DraftItem[]
  updated_at: string
}

export function emptyDraft(): DayPlanDraft {
  return { v: 1, title: null, items: [], updated_at: new Date().toISOString() }
}

/** Loose runtime validation -- corrupt/foreign JSON degrades to an empty draft rather than throwing. */
function isValidDraft(value: unknown): value is DayPlanDraft {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  return d.v === 1 && Array.isArray(d.items)
}

export function readDraft(): DayPlanDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return emptyDraft()
    const parsed = JSON.parse(raw)
    return isValidDraft(parsed) ? parsed : emptyDraft()
  } catch {
    return emptyDraft()
  }
}

export function writeDraft(draft: DayPlanDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch { /* private mode / storage disabled -- draft simply doesn't persist */ }
}

/** The code of the plan this device last created or shared. Kept for 7 days
 * after sharing (never cleared automatically) -- cheap insurance if the
 * share round-trips badly, and it costs a few hundred bytes. */
export function readActivePlanCode(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CODE_KEY)
  } catch {
    return null
  }
}

export function writeActivePlanCode(code: string): void {
  try {
    localStorage.setItem(ACTIVE_CODE_KEY, code)
  } catch { /* ignore */ }
}

/**
 * Minimal event shape draft snapshotting depends on. `venue.lat`/`lng` are
 * already selected at every call site that constructs one of these --
 * useEvents.ts's list query, firstPageQuery.js's EVENT_LIST_COLUMNS join,
 * and useEvent()'s detail-page select all include `lat, lng` on the venue
 * join today -- so reading them here needs no new query and nothing new to
 * plumb through EventCard/EventPage.
 */
export interface SnapshotSource {
  id: string
  title: string
  start_at: string
  end_at?: string | null
  venue?: { name?: string | null; lat?: number | null; lng?: number | null } | null
}

export function snapshotItem(event: SnapshotSource, existingAddedAt?: string): DraftItem {
  return {
    event_id: event.id,
    snap_title: event.title,
    snap_start_at: event.start_at,
    snap_end_at: event.end_at ?? null,
    snap_venue: event.venue?.name ?? null,
    snap_venue_lat: event.venue?.lat ?? null,
    snap_venue_lng: event.venue?.lng ?? null,
    added_at: existingAddedAt ?? new Date().toISOString(),
  }
}

/**
 * Add (or refresh, if already present) an item. Preserves the original
 * added_at on re-add/refresh -- mirrors day_plan_insert_item's ON CONFLICT
 * behavior server-side (052). Returns null (no-op) once MAX_ITEMS is reached
 * and the event isn't already in the draft.
 */
export function addItemToDraft(draft: DayPlanDraft, event: SnapshotSource): DayPlanDraft | null {
  const existing = draft.items.find((i) => i.event_id === event.id)
  if (!existing && draft.items.length >= MAX_ITEMS) return null
  const item = snapshotItem(event, existing?.added_at)
  const items = existing
    ? draft.items.map((i) => (i.event_id === event.id ? item : i))
    : [...draft.items, item]
  return { ...draft, items, updated_at: new Date().toISOString() }
}

/**
 * Local draft removal is a hard splice, not a tombstone. There is no
 * shared/collaborative recovery story for a single-device draft the way
 * there is for the DB-backed plan (day_plan_items.removed_at) -- nobody else
 * can wipe this, so nothing needs to be recoverable.
 */
export function removeItemFromDraft(draft: DayPlanDraft, eventId: string): DayPlanDraft {
  return {
    ...draft,
    items: draft.items.filter((i) => i.event_id !== eventId),
    updated_at: new Date().toISOString(),
  }
}

export function isItemInDraft(draft: DayPlanDraft, eventId: string): boolean {
  return draft.items.some((i) => i.event_id === eventId)
}

export function setDraftTitle(draft: DayPlanDraft, title: string | null): DayPlanDraft {
  const trimmed = title && title.trim() ? title.trim().slice(0, 80) : null
  return { ...draft, title: trimmed, updated_at: new Date().toISOString() }
}
