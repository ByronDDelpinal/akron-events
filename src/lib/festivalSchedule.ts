/**
 * festivalSchedule.ts
 *
 * Pure, DOM-free schedule derivation for festival hub pages
 * (src/pages/FestivalPage.tsx). Follows the planMapPoints.ts precedent:
 * node-testable (scripts/tests/test-festival-schedule.js imports this file
 * directly into `node --test`), no imports from component land, and no
 * internal clock — "now" is always an injected epoch-ms instant so the
 * happening-now/up-next logic is deterministic under test.
 *
 * Column identity comes from the ingest-side tag convention
 * (scripts/import-porchrokr.js): every per-set event carries exactly one
 * 'porch-NN' or 'stage-<key>' tag; the festival umbrella event carries
 * 'festival-umbrella' instead. Garbage tags are ignored, never guessed at.
 */

export interface FestivalVenueRef {
  id: string
  name: string | null
  lat: number | null
  lng: number | null
}

/** Row shape of the hub's one PostgREST query (see FestivalPage.tsx). */
export interface FestivalEventRow {
  id: string
  title: string
  start_at: string
  end_at: string | null
  tags: string[] | null
  status: string
  image_url?: string | null
  description?: string | null
  event_venues?: { venues: FestivalVenueRef | null }[] | null
  /** Optional extras the hub's extended select pulls for card rendering
   *  (categories → badges/gradient, price → "Free" pill). Type-only here;
   *  the schedule derivation never reads them. */
  event_categories?: { category: string }[] | null
  price_min?: number | null
  price_max?: number | null
}

export type FestivalColumnKind = 'porch' | 'stage'

export interface FestivalColumn {
  /** Stable key: 'porch-7' | 'stage-main'. */
  key: string
  kind: FestivalColumnKind
  /** Porch number for kind 'porch'. */
  porch?: number
  /** Stage key for kind 'stage', e.g. 'main', 'beer-garden'. */
  stage?: string
  label: string
}

export interface FestivalScheduleItem {
  event: FestivalEventRow
  column: FestivalColumn
  startMs: number
  endMs: number | null
}

export interface FestivalSlot {
  /** The slot's shared start instant (ISO, straight off start_at). */
  startAt: string
  startMs: number
  items: FestivalScheduleItem[]
}

export interface FestivalSchedule {
  umbrella: FestivalEventRow | null
  columns: FestivalColumn[]
  slots: FestivalSlot[]
}

/** Fixed display order for known stages; unknown stage keys sort after,
 *  alphabetically, rather than being dropped. */
const STAGE_ORDER = ['main', 'yellow-brick-road', 'beer-garden', 'kid-zone', 'karaoke', 'silent-disco']

const PORCH_TAG_RE = /^porch-(\d{1,2})$/
const STAGE_TAG_RE = /^stage-([a-z0-9-]+)$/

/**
 * Parse an event's column from its tags. Exactly one porch-NN / stage-*
 * tag is expected; the first match wins and anything unparseable is
 * ignored (a garbage 'porch-x' or 'stage-' never fabricates a column).
 * Returns null when no column tag is present (e.g. the umbrella).
 */
export function parseColumnTag(tags: string[] | null | undefined): FestivalColumn | null {
  for (const tag of tags ?? []) {
    const porchMatch = PORCH_TAG_RE.exec(tag)
    if (porchMatch) {
      const porch = parseInt(porchMatch[1], 10)
      if (Number.isInteger(porch) && porch >= 1) {
        return { key: tag, kind: 'porch', porch, label: `Porch ${porch}` }
      }
      continue
    }
    const stageMatch = STAGE_TAG_RE.exec(tag)
    if (stageMatch && stageMatch[1]) {
      const stage = stageMatch[1]
      const label = stage
        .split('-')
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ')
      return { key: tag, kind: 'stage', stage, label: `${label} Stage` }
    }
  }
  return null
}

export function isUmbrella(row: FestivalEventRow): boolean {
  return (row.tags ?? []).includes('festival-umbrella')
}

function compareColumns(a: FestivalColumn, b: FestivalColumn): number {
  // Porches first, numerically; stages after, in fixed order then A→Z.
  if (a.kind !== b.kind) return a.kind === 'porch' ? -1 : 1
  if (a.kind === 'porch') return (a.porch ?? 0) - (b.porch ?? 0)
  const ai = STAGE_ORDER.indexOf(a.stage ?? '')
  const bi = STAGE_ORDER.indexOf(b.stage ?? '')
  if (ai !== -1 && bi !== -1) return ai - bi
  if (ai !== bi) return ai !== -1 ? -1 : 1
  return (a.stage ?? '').localeCompare(b.stage ?? '')
}

/** First linked venue with usable fields, or null. */
export function firstVenue(row: FestivalEventRow): FestivalVenueRef | null {
  for (const link of row.event_venues ?? []) {
    if (link?.venues) return link.venues
  }
  return null
}

/**
 * Build the time-major schedule: rows grouped by shared start instant
 * (ascending), items within a slot ordered by column (porches numeric,
 * then stages). Rows without a parseable column tag are dropped from the
 * grid — except the umbrella, which is surfaced separately for the header
 * card. Rows with an unparseable start_at are dropped (never NaN-sorted).
 */
export function buildFestivalSchedule(rows: FestivalEventRow[]): FestivalSchedule {
  let umbrella: FestivalEventRow | null = null
  const items: FestivalScheduleItem[] = []
  const columnsByKey = new Map<string, FestivalColumn>()

  for (const row of rows) {
    if (isUmbrella(row)) {
      if (!umbrella) umbrella = row
      continue
    }
    const column = parseColumnTag(row.tags)
    if (!column) continue
    const startMs = Date.parse(row.start_at)
    if (!Number.isFinite(startMs)) continue
    const endMs = row.end_at ? Date.parse(row.end_at) : NaN
    items.push({ event: row, column, startMs, endMs: Number.isFinite(endMs) ? endMs : null })
    if (!columnsByKey.has(column.key)) columnsByKey.set(column.key, column)
  }

  const slotsByMs = new Map<number, FestivalSlot>()
  for (const item of items) {
    let slot = slotsByMs.get(item.startMs)
    if (!slot) {
      slot = { startAt: item.event.start_at, startMs: item.startMs, items: [] }
      slotsByMs.set(item.startMs, slot)
    }
    slot.items.push(item)
  }
  const slots = [...slotsByMs.values()].sort((a, b) => a.startMs - b.startMs)
  for (const slot of slots) slot.items.sort((a, b) => compareColumns(a.column, b.column))

  const columns = [...columnsByKey.values()].sort(compareColumns)
  return { umbrella, columns, slots }
}

/** True while a set is live: now >= start AND now < end. Items with no end
 *  are never "happening now" (a 30-minute set always has one; being honest
 *  beats guessing a duration). */
export function isHappeningNow(item: FestivalScheduleItem, nowMs: number): boolean {
  return item.endMs != null && nowMs >= item.startMs && nowMs < item.endMs
}

/** The first slot strictly in the future, or null once the day is over. */
export function upNextSlot(schedule: FestivalSchedule, nowMs: number): FestivalSlot | null {
  for (const slot of schedule.slots) {
    if (slot.startMs > nowMs) return slot
  }
  return null
}

/** Slots with at least one live item right now (usually 0 or 1 — porch
 *  slots share instants — but headliner overlap-safe by construction). */
export function happeningNowSlots(schedule: FestivalSchedule, nowMs: number): FestivalSlot[] {
  return schedule.slots.filter((slot) => slot.items.some((i) => isHappeningNow(i, nowMs)))
}
