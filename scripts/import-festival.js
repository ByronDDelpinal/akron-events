/**
 * import-festival.js
 *
 * Generic importer for a festival with a PUBLISHED LINEUP AT REAL VENUES
 * (as opposed to import-porchrokr.js's minted-venue, brochure-schedule
 * shape, which stays frozen). Turns a checked-in data file
 * (scripts/data/<slug>.json) into per-set events under a dedicated
 * sub-source that no scraper writes (subOf the umbrella's own source in
 * src/lib/dataSources.ts; NO scripts/manifest.js entry, because this is not a
 * scraper, there is nothing to re-scrape; the importer itself is the
 * reproducible "re-scrape").
 *
 * Deliberately narrow, unlike import-porchrokr.js:
 *   - no geocoding, no --geocode mode, no Nominatim dependency;
 *   - no venue minting, no ensureVenue: venues are resolved BY ID from the
 *     data file and verified by NAME before use (resolveVenues below):
 *     every venue this script touches is a real, already-listed venue.
 *
 * What it writes (only ever with --write):
 *   • One event per set, slot-keyed source_ids (`2026-09-10-blu-jazz-1900`)
 *     so an act swap updates the title in place instead of churning
 *     source_ids into duplicates.
 *   • Umbrella enrichment: the existing umbrella row (named in the data
 *     file's festival.umbrella) gains a logistics block, hub tags, and a
 *     poster image_url, pinned via manual_overrides with FRESH `at` values
 *     (the live pin trigger reverts any un-re-stamped pinned key on every
 *     write; a re-stamp must accompany any changed pinned column).
 *   • Category lock: every per-set row upserts with the data file's
 *     festival.categories (order matters: the first is primary) and is
 *     then pinned via manual_overrides.categories + category_slugs. The
 *     umbrella's junction is verified festival-primary before its own,
 *     separate idempotent pin.
 *   • Tag-only rows ("existing" in the data file): a set already owned by
 *     another scraper (a ticketed show, say) is never upserted, only
 *     tagged into the festival and pinned, so the owning scraper keeps
 *     every other column (title, times, price, ticket_url, image).
 *
 * Hard gates (never write a bad row):
 *   • Venues are resolved by id and hard-abort every row for that venue
 *     when the id is missing or the DB name doesn't match the data file's
 *     expectName (case/whitespace-normalized), never minting a duplicate of
 *     a real venue.
 *   • classifySummitLocation(coords) must be 'in' AND the coords must pass
 *     both the Summit County bbox and the festival's own registry
 *     mapBounds (src/lib/festivals.ts). A venue with null coordinates is a
 *     per-venue abort, not a quiet skip.
 *   • featured is ALWAYS false. Human-only editorial flag.
 *
 * Usage:
 *   node scripts/import-festival.js --festival <slug>              # dry run: validate + print plan
 *   node scripts/import-festival.js --festival <slug> --write      # upsert events + umbrella enrichment
 *   node scripts/import-festival.js --festival <slug> --prune-missing            # report rows no longer in the file
 *   node scripts/import-festival.js --festival <slug> --prune-missing --write    # set those rows status='cancelled' (never delete)
 *   node scripts/import-festival.js --data <path> [--write] [--prune-missing]    # override the data file path (tests)
 *
 * Env (only for --write / --prune-missing --write):
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { easternToIso, sanitizeEventText } from './lib/normalize.js'
import { festivalBySlug } from '../src/lib/festivals.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = join(__dirname, 'data')

export function dataPathFor(slug) {
  return join(DATA_DIR, `${slug}.json`)
}

/**
 * The manual_overrides `by` stamp for one festival's pins, e.g.
 * 'rubber-city-jazz-2026-import'. PER FESTIVAL, matching
 * import-porchrokr.js's 'porchrokr-2026-import' precedent: manual_overrides
 * has to record WHICH festival pinned a column, both so the post-festival
 * tombstone runbook can tell one festival's pins from the next one's, and
 * so computeCategoryLockOverrides's "already stamped by us" short-circuit
 * cannot skip a row that a DIFFERENT festival's run through this same
 * script locked earlier.
 */
export function importStampFor(festival) {
  return `${festival.slug}-import`
}

// ── Deterministic Eastern date formatting ────────────────────────────────
//
// Anything this importer PERSISTS must format identically on every machine.
// src/lib/festivals.ts's festivalDateRangeLabel is deliberately ambient-
// locale (it renders the hub header for a viewer), which is right for the
// page and wrong for a description column: run the importer under a German
// locale and all 17 stored descriptions would read "Donnerstag, 10.
// September". So the importer formats its own range with an explicitly
// pinned 'en-US' locale AND an explicit America/New_York time zone, and
// anchors each endpoint at Eastern noon via easternToIso so no UTC offset
// can walk the date across a day boundary.

const EASTERN_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
})
const EASTERN_DAY_YEAR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
})

/** 'Saturday, August 15, 2026' for a single day; 'Thursday, September 10 to
 *  Saturday, September 12, 2026' for a range. Locale- and TZ-pinned, safe to
 *  store. The word "to" between the endpoints, never an em dash. */
export function easternRangeLabel(startDate, endDate) {
  const easternNoon = (dateKey) => new Date(easternToIso(dateKey, '12:00 PM'))
  if (!endDate || endDate === startDate) return EASTERN_DAY_YEAR.format(easternNoon(startDate))
  return `${EASTERN_DAY.format(easternNoon(startDate))} to ${EASTERN_DAY_YEAR.format(easternNoon(endDate))}`
}

// ── Slot math ─────────────────────────────────────────────────────────────

/** '7:00 PM' -> '1900'; '11:00 AM' -> '1100'. Null for garbage. */
export function slotKey(time) {
  const m = String(time ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const isPm = /^p/i.test(m[3])
  if (isPm && h !== 12) h += 12
  if (!isPm && h === 12) h = 0
  return `${String(h).padStart(2, '0')}${m[2]}`
}

/** `${date}-${venueKey}-${slotKey}`, e.g. '2026-09-10-blu-jazz-1900'. Null
 *  when the time doesn't parse (never a half-built id). */
export function setSourceId(date, venueKey, time) {
  const key = slotKey(time)
  return key ? `${date}-${venueKey}-${key}` : null
}

/** start/end UTC instants for one set. easternToIso two-arg for BOTH ends
 *  (NEVER a local Date). `end` is null when no end time is given. */
export function slotInstants(date, start, end) {
  const start_at = easternToIso(date, start)
  const end_at = end ? easternToIso(date, end) : null
  return { start_at, end_at }
}

// ── Data file validation (pure) ──────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** http(s), no whitespace, no '&' (sanitizeEventText's htmlToText decodes
 *  entities, so an ampersand-free URL is what keeps the round-trip
 *  byte-identical). Returns a problem string, or null when clean. */
function urlProblem(where, url) {
  if (url == null) return null
  if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url) || url.includes('&') || /\s/.test(url)) {
    return `${where}: url must be http(s) with no whitespace and no '&' (got ${JSON.stringify(url)})`
  }
  return null
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/** Returns an array of human-readable problems; empty = valid. */
export function validateDataFile(data) {
  const problems = []
  const festival = data?.festival ?? {}
  const { startDate, endDate } = festival

  // ── The festival block itself ──────────────────────────────────────────
  // Every one of these is interpolated unguarded into a row that gets
  // written. A missing festival.tag used to sail through the validator and
  // produce `tags: [null, 'stage-...']`: a festival child that
  // browseVisibility cannot hide, check-festivals cannot see, and the hub
  // cannot render. Refuse the file instead.
  const registryFestival = isNonEmptyString(festival.slug) ? festivalBySlug(festival.slug) : null
  if (!isNonEmptyString(festival.slug)) {
    problems.push('festival.slug missing or not a string')
  } else if (!registryFestival) {
    problems.push(
      `festival.slug '${festival.slug}' matches no entry in the FESTIVALS registry ` +
      '(src/lib/festivalsData.js): add the registry entry first, or fix the slug. ' +
      'The registry entry is what supplies the mapBounds gate every venue is checked against.',
    )
  }

  if (!isNonEmptyString(festival.tag)) {
    problems.push('festival.tag missing or not a string')
  } else if (registryFestival && festival.tag !== registryFestival.tag) {
    problems.push(
      `festival.tag '${festival.tag}' does not equal the registry tag ` +
      `'${registryFestival.tag}' for slug '${festival.slug}': the hub, browseVisibility, ` +
      'the digest and check-festivals all discover rows by the REGISTRY tag.',
    )
  }

  if (!isNonEmptyString(festival.source)) problems.push('festival.source missing or not a string')

  if (!festival.umbrella || typeof festival.umbrella !== 'object') {
    problems.push('festival.umbrella missing')
  } else {
    if (!isNonEmptyString(festival.umbrella.source)) problems.push('festival.umbrella.source missing or not a string')
    if (!isNonEmptyString(festival.umbrella.source_id)) problems.push('festival.umbrella.source_id missing or not a string')
  }

  if (!isNonEmptyString(festival.name)) problems.push('festival.name missing or not a string')

  // Festival-specific copy lives in the data file, never in this module.
  if (festival.extraTags != null &&
      (!Array.isArray(festival.extraTags) || !festival.extraTags.every(isNonEmptyString))) {
    problems.push('festival.extraTags must be an array of non-empty strings when present')
  }
  if (festival.city != null && !isNonEmptyString(festival.city)) {
    problems.push('festival.city must be a non-empty string when present')
  }
  if (festival.presentedBy != null && !isNonEmptyString(festival.presentedBy)) {
    problems.push('festival.presentedBy must be a non-empty string when present')
  }

  if (!startDate || !endDate) problems.push('festival.startDate/endDate missing')
  else if (endDate < startDate) problems.push(`festival.endDate (${endDate}) is before festival.startDate (${startDate})`)

  if (!Array.isArray(festival.categories) || festival.categories.length < 1 || festival.categories.length > 2) {
    problems.push('festival.categories must be a 1-2 element array')
  }

  const websiteProblem = urlProblem('festival.website', festival.website)
  if (websiteProblem) problems.push(websiteProblem)

  const venues = data?.venues ?? []
  const venueKeys = new Set()
  for (const v of venues) {
    if (venueKeys.has(v.key)) problems.push(`duplicate venue key '${v.key}'`)
    venueKeys.add(v.key)
    if (typeof v.venueId !== 'string' || !UUID_RE.test(v.venueId)) {
      problems.push(`venue '${v.key}': venueId is not a uuid (${JSON.stringify(v.venueId)})`)
    }
    if (!v.expectName || typeof v.expectName !== 'string') {
      problems.push(`venue '${v.key}': missing expectName`)
    }
  }

  const days = data?.days ?? []
  const seenDates = new Set()
  const tripleSeen = new Set()
  const sourceIdSeen = new Map()

  for (const day of days) {
    if (seenDates.has(day.date)) problems.push(`duplicate day date '${day.date}'`)
    seenDates.add(day.date)
    if (startDate && endDate && (day.date < startDate || day.date > endDate)) {
      problems.push(`day '${day.date}' is outside the festival range [${startDate}, ${endDate}]`)
    }

    for (const set of day.sets ?? []) {
      const loc = `${day.date} ${set.venue} ${set.start} "${set.title}"`

      if (!venueKeys.has(set.venue)) problems.push(`unknown venue key '${set.venue}' (${loc})`)

      const tripleKey = `${set.venue}|${day.date}|${set.start}`
      if (tripleSeen.has(tripleKey)) problems.push(`duplicate (venue, date, start) triple: ${tripleKey}`)
      tripleSeen.add(tripleKey)

      if (!set.title || typeof set.title !== 'string') problems.push(`missing or blank title (${loc})`)

      const startKey = slotKey(set.start)
      if (!startKey) problems.push(`unparseable start '${set.start}' (${loc})`)

      if (set.end != null) {
        const endKey = slotKey(set.end)
        if (!endKey) problems.push(`unparseable end '${set.end}' (${loc})`)
        else if (startKey && endKey <= startKey) problems.push(`end '${set.end}' does not come after start '${set.start}' (${loc})`)
      }

      if (set.existing && set.price) {
        problems.push(`set carries both 'existing' and 'price' (${loc}): the owning scraper owns price for an existing row`)
      }

      const ticketProblem = urlProblem(`ticketUrl (${loc})`, set.ticketUrl)
      if (ticketProblem) problems.push(ticketProblem)

      if (!set.existing && venueKeys.has(set.venue) && startKey) {
        const sourceId = setSourceId(day.date, set.venue, set.start)
        if (sourceId) {
          if (sourceIdSeen.has(sourceId)) problems.push(`derived source_id collision: ${sourceId}`)
          sourceIdSeen.set(sourceId, loc)
        }
      }
    }
  }

  return problems
}

// ── Plan builder (pure) ──────────────────────────────────────────────────

function isFreePrice(price) {
  return !!price && price.min === 0 && (price.max == null || price.max === 0)
}

/** Sanity cap on a DERIVED set length. A real set runs an hour or two; a
 *  span longer than this means the data file put a past-midnight set on the
 *  wrong day, not that somebody booked a six-hour act. */
const MAX_SET_HOURS = 6
const MAX_SET_MS = MAX_SET_HOURS * 3_600_000

/**
 * Build the full write plan from the data file. Pure: no DB, no clock.
 * Returns:
 *   planned:   [{ row, venue }] where venue is the data file's venue
 *              record (key, venueId, expectName, label, tags)
 *   existing:  [{ set, date, existing: {source, source_id}, tagsToAdd }]
 *              sets already owned by another scraper; tag-only, never
 *              upserted
 *   excluded:  sets carrying `"flag": true` (excluded from the plan,
 *              reported, never pruned: a human call, mirroring
 *              import-porchrokr.js's FLAG-confidence porches) plus any set
 *              whose venue key doesn't resolve
 *   problems:  validateDataFile output (callers must refuse to write on any)
 */
export function buildPlan(data) {
  const problems = validateDataFile(data)
  const festival = data.festival ?? {}
  const venueByKey = new Map((data.venues ?? []).map((v) => [v.key, v]))
  const rangeLabel = festival.startDate
    ? easternRangeLabel(festival.startDate, festival.endDate)
    : ''
  // Festival-specific copy comes from the DATA FILE, never from this module:
  // this script is the importer for every future festival at real venues, so
  // a genre tag or a presenter baked in here would follow the next festival
  // through. Each clause disappears when its key is absent.
  const cityClause = festival.city ? ` in ${festival.city}` : ''
  const presenterClause = festival.presentedBy ? `, presented by ${festival.presentedBy}` : ''
  const extraTags = festival.extraTags ?? []

  const planned = []
  const existing = []
  const excluded = []

  // Group every set by (venue, date) so end-derivation ("the next set at
  // the SAME venue on the SAME Eastern day") can see the whole bucket.
  const bucketed = new Map()
  for (const day of data.days ?? []) {
    for (const set of day.sets ?? []) {
      const key = `${set.venue}|${day.date}`
      if (!bucketed.has(key)) bucketed.set(key, [])
      bucketed.get(key).push({ set, date: day.date })
    }
  }

  for (const list of bucketed.values()) {
    list.sort((a, b) => (slotKey(a.set.start) ?? '').localeCompare(slotKey(b.set.start) ?? ''))

    for (let i = 0; i < list.length; i++) {
      const { set, date } = list[i]
      const venue = venueByKey.get(set.venue)

      if (set.flag === true) {
        excluded.push({ set, date, reason: 'flag: true, awaiting confirmation', source_id: setSourceId(date, set.venue, set.start) })
        continue
      }

      if (set.existing) {
        existing.push({
          set, date, venue,
          existing: set.existing,
          tagsToAdd: [festival.tag, `stage-${set.venue}`],
        })
        continue
      }

      if (!venue) {
        excluded.push({ set, date, reason: `unknown venue key '${set.venue}'`, source_id: setSourceId(date, set.venue, set.start) })
        continue
      }

      // End derivation, in priority order: the next set at the SAME venue
      // on the SAME Eastern day; else an explicit "end" on this set; else
      // null (never a guessed duration). Flagged sets are skipped when
      // walking for the next start: a set awaiting a human decision must
      // not silently set a confirmed set's end_at.
      let nextStart = null
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].set.flag === true) continue
        nextStart = list[j].set.start
        break
      }
      const endSource = set.end ?? nextStart
      const { start_at, end_at } = slotInstants(date, set.start, endSource)

      // Midnight-crossing guard. slotInstants binds BOTH ends to `date`, and
      // the bucket is sorted by wall-clock HHMM, so a past-midnight set filed
      // on the previous day's entry would sort to the front ('0030' < '2300'),
      // start 24 hours early, and take its end from the 11:00 PM set: a silent
      // 22.5-hour event. Catch it as a validation problem rather than write it.
      if (end_at != null) {
        const spanMs = Date.parse(end_at) - Date.parse(start_at)
        const loc = `${date} ${set.venue} ${set.start} "${set.title}"`
        if (spanMs <= 0) {
          problems.push(
            `derived end is not after start (${loc}): a set that runs past Eastern midnight ` +
            'belongs on the NEXT day\'s entry with its true Eastern date.',
          )
        } else if (spanMs > MAX_SET_MS) {
          problems.push(
            `derived duration ${(spanMs / 3_600_000).toFixed(1)}h exceeds the ${MAX_SET_HOURS}h ` +
            `sanity cap (${loc}): check for a past-midnight set filed on the wrong day.`,
          )
        }
      }

      const price0 = isFreePrice(set.price)
      const descriptionParts = [
        `${set.title} at ${venue.label} for ${festival.name}.`,
        set.note ?? null,
        `Part of the ${festival.name}, ${rangeLabel}${cityClause}${presenterClause}.`,
        price0 ? 'Free and open to all.' : null,
        `Full schedule: ${festival.website}`,
      ].filter(Boolean)

      const row = {
        title: set.title,
        description: descriptionParts.join(' '),
        start_at,
        end_at,
        // Explicit v2 list: resolveEventCategories passes it verbatim and
        // syncEventCategories inserts in order, so the first stays primary.
        categories: festival.categories,
        tags: [festival.tag, `stage-${set.venue}`, ...extraTags, ...(venue.tags ?? []), ...(price0 ? ['free'] : [])],
        price_min: set.price?.min ?? null,
        price_max: set.price?.max ?? null,
        age_restriction: 'not_specified', // never assume all_ages
        image_url: null,                  // digest image gate parity
        ticket_url: set.ticketUrl ?? festival.website,
        source: festival.source,
        source_id: setSourceId(date, set.venue, set.start),
        status: 'published',
        featured: false, // ALWAYS false, human-only editorial flag
      }
      planned.push({ row, venue })
    }
  }

  planned.sort((a, b) =>
    a.row.start_at === b.row.start_at
      ? a.row.source_id.localeCompare(b.row.source_id)
      : a.row.start_at.localeCompare(b.row.start_at))

  const ids = new Set()
  for (const { row } of planned) {
    if (row.source_id && ids.has(row.source_id)) problems.push(`duplicate source_id in plan: ${row.source_id}`)
    if (row.source_id) ids.add(row.source_id)
  }

  // Sanitizer round-trip guard, as a PROBLEM rather than a warning.
  // upsertEventSafe sanitizes internally, so a title the guard flags would be
  // stored in its rewritten form while the plan, the printed dry run and the
  // tests all describe the unrewritten one. Refusing the write is the only
  // way the printed plan is the thing that actually lands.
  for (const { row } of planned) {
    const clean = sanitizeEventText(row)
    if (clean.title !== row.title) {
      problems.push(
        `sanitizer would rewrite the title of ${row.source_id}: ` +
        `${JSON.stringify(row.title)} -> ${JSON.stringify(clean.title)}`,
      )
    }
    if (clean.description !== row.description) {
      problems.push(
        `sanitizer would rewrite the description of ${row.source_id}: ` +
        `${JSON.stringify(row.description)} -> ${JSON.stringify(clean.description)}`,
      )
    }
  }

  return { planned, existing, excluded, problems }
}

/** Every source_id the file accounts for as OUR source (planned only:
 *  existing/tag-only rows belong to another source entirely, and
 *  --prune-missing scopes to `source = festival.source`, so they can never
 *  collide with pruning). Flag-excluded sets also count, so a porch
 *  flipping HIGH-to-flag equivalent never gets cancelled out from under a
 *  pending human decision. */
export function allFileSourceIds(plan) {
  const ids = new Set()
  for (const { row } of plan.planned) if (row.source_id) ids.add(row.source_id)
  for (const ex of plan.excluded) if (ex.source_id) ids.add(ex.source_id)
  return ids
}

// ── Umbrella enrichment (pure) ───────────────────────────────────────────

/**
 * Compute the umbrella update: description (logistics block behind the data
 * file's idempotency marker), hub tags, and image_url. Returns null when
 * nothing would change, else { updates, overrides } where overrides is the
 * FULL manual_overrides object to write: existing pins preserved, and a
 * fresh {at, by} re-stamp for exactly the keys being changed (the live pin
 * trigger reverts any pinned key not re-stamped alongside its new value).
 */
export function computeUmbrellaEnrichment(existing, festival, nowIso = new Date().toISOString()) {
  const marker = festival.logisticsMarker
  const scraperProse = String(existing.description ?? '').split(marker)[0].trimEnd()
  const description = `${scraperProse}${scraperProse ? '\n\n' : ''}${marker}\n${festival.logistics}`

  const tags = [...(existing.tags ?? [])]
  for (const t of [festival.tag, 'festival-umbrella']) if (!tags.includes(t)) tags.push(t)

  const updates = {}
  if (description !== existing.description) updates.description = description
  if (tags.length !== (existing.tags ?? []).length) updates.tags = tags
  if (festival.umbrellaImageUrl && existing.image_url !== festival.umbrellaImageUrl) {
    updates.image_url = festival.umbrellaImageUrl
  }
  if (!Object.keys(updates).length) return null

  const by = importStampFor(festival)
  const overrides = { ...(existing.manual_overrides ?? {}) }
  for (const key of Object.keys(updates)) overrides[key] = { at: nowIso, by }
  return { updates, overrides }
}

// ── Category lock (pure) ─────────────────────────────────────────────────

/**
 * Compute the manual_overrides object that pins categories + category_slugs
 * on a festival event, or null when THIS festival already stamped it
 * (categories?.by === stampBy). The stamp is per festival, so a row locked
 * by a different festival's run through this same script is re-stamped for
 * ours rather than silently skipped. Merge-not-clobber: every foreign key
 * in the existing overrides survives untouched; only the two category keys
 * are (re)stamped.
 */
export function computeCategoryLockOverrides(existing, stampBy, nowIso = new Date().toISOString()) {
  const overrides = { ...(existing ?? {}) }
  if (overrides.categories?.by === stampBy) return null
  const stamp = { at: nowIso, by: stampBy }
  overrides.categories = stamp
  overrides.category_slugs = stamp
  return overrides
}

// ── Tag-only pin for a scraper-owned "existing" row (pure) ───────────────

/**
 * Compute the tags + manual_overrides update for a set owned by another
 * scraper (the data file's "existing" key, the Lock 3 exception).
 * Unions `tagsToAdd` into the row's current tags without duplicating and
 * returns null when every tag is already present (nothing to write).
 * Preserves every foreign manual_overrides pin; only `tags` is re-stamped.
 */
export function computeChildTagPin(existingRow, tagsToAdd, stampBy, nowIso = new Date().toISOString()) {
  const before = existingRow.tags ?? []
  const tags = [...before]
  for (const t of tagsToAdd) if (!tags.includes(t)) tags.push(t)
  if (tags.length === before.length) return null

  const manual_overrides = { ...(existingRow.manual_overrides ?? {}) }
  manual_overrides.tags = { at: nowIso, by: stampBy }
  return { tags, manual_overrides }
}

// ── Reporting ─────────────────────────────────────────────────────────────

function printPlan(data, plan) {
  const { planned, existing, excluded } = plan
  const festival = data.festival

  console.log(`\n📋  ${festival.name} import plan: ${festival.startDate} to ${festival.endDate} (${festival.tag})`)
  console.log(`    planned events:      ${planned.length}`)
  console.log(`    existing (tag-only): ${existing.length}`)
  console.log(`    excluded (flagged/unresolved): ${excluded.length}`)
  console.log(`    categories: every planned row ${JSON.stringify(festival.categories)} (first primary); pinned post-upsert via manual_overrides.categories/category_slugs (by '${importStampFor(festival)}')\n`)

  const venues = new Map()
  for (const { venue } of planned) {
    if (!venues.has(venue.key)) venues.set(venue.key, { venue, count: 0 })
    venues.get(venue.key).count++
  }
  console.log(`    venue plan (${venues.size} venues):`)
  for (const { venue, count } of venues.values()) {
    console.log(`      - ${venue.label} (${venue.key}) - ${count} set(s), resolved by id ${venue.venueId}`)
  }

  console.log('\n    events:')
  for (const { row } of planned) {
    console.log(`      ${row.source_id}  ${row.start_at} -> ${row.end_at}  ${row.title}`)
  }

  if (existing.length) {
    console.log('\n    existing rows (tag-only, never upserted):')
    for (const ex of existing) {
      console.log(`      ${ex.existing.source}/${ex.existing.source_id}  tags += ${JSON.stringify(ex.tagsToAdd)}  "${ex.set.title}"`)
    }
  }

  if (excluded.length) {
    console.log('\n    excluded (NOT written, NOT pruned):')
    for (const ex of excluded) {
      console.log(`      ${ex.date} ${ex.set.venue} ${ex.set.start} "${ex.set.title}": ${ex.reason}`)
    }
  }

  console.log('\n    umbrella enrichment:')
  console.log(`      ${festival.umbrella.source}/${festival.umbrella.source_id}`)
  console.log(`      tags += ['${festival.tag}', 'festival-umbrella']`)
  console.log(`      description += logistics block (idempotent via marker "${festival.logisticsMarker}")`)
  if (festival.umbrellaImageUrl) console.log(`      image_url -> ${festival.umbrellaImageUrl}`)
  console.log(`      pins: manual_overrides.description/tags/image_url re-stamped {at: <now>, by: '${importStampFor(festival)}'}`)
  console.log('      category lock: verify junction is festival-primary, then pin categories+category_slugs (own idempotent update)')
}

// ── Venue resolution (impure; DB read-only) ──────────────────────────────

/** FAIL CLOSED. A gate that can silently become a no-op is not a gate: an
 *  absent or malformed bbox means we cannot check what we promised to check,
 *  so the answer is "no", not "sure". resolveVenues throws before it ever
 *  gets here, so reaching the false branch means a bug, not bad data. */
function inBbox(lat, lng, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false
  const [west, south, east, north] = bbox
  return lat >= south && lat <= north && lng >= west && lng <= east
}

/**
 * Resolve every data-file venue BY ID, verified by NAME (case/whitespace
 * normalized), never minted. Every venue is gated on classifySummitLocation
 * plus the Summit bbox plus the festival's OWN registry mapBounds
 * (src/lib/festivals.ts). A missing id, a name mismatch, missing
 * coordinates, or a gate failure is a loud per-venue abort, never a quiet
 * skip. Returns { resolved: Map<key, {id, lat, lng}>, aborted: Set<key> }.
 */
export async function resolveVenues(supabaseAdmin, data) {
  const { classifySummitLocation } = await import('./lib/summit-county.js')
  const { inSummitBbox } = await import('./geocode-venues.js')

  // Hard abort, never a silent fail-open. validateDataFile already refuses a
  // slug that resolves to no registry entry, so these two throws are the
  // belt to that braces: whatever happens, the run cannot proceed with one of
  // its two advertised geo gates quietly switched off.
  const registryFestival = festivalBySlug(data.festival.slug)
  if (!registryFestival) {
    throw new Error(
      `festival.slug '${data.festival.slug}' resolves to no FESTIVALS registry entry, so the ` +
      'registry mapBounds gate cannot run. Refusing to resolve venues.',
    )
  }
  const bbox = registryFestival.mapBounds
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error(
      `registry entry '${registryFestival.slug}' has no usable mapBounds bbox ` +
      `(got ${JSON.stringify(bbox)}), so the festival geo gate cannot run. Refusing to resolve venues.`,
    )
  }

  const resolved = new Map()
  const aborted = new Set()
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

  for (const v of data.venues ?? []) {
    const { data: row, error } = await supabaseAdmin
      .from('venues')
      .select('id, name, lat, lng')
      .eq('id', v.venueId)
      .maybeSingle()
    if (error || !row) {
      console.error(`  ABORT rows for venue '${v.key}': id ${v.venueId} not found`)
      aborted.add(v.key)
      continue
    }
    if (norm(row.name) !== norm(v.expectName)) {
      console.error(`  ABORT rows for venue '${v.key}': name mismatch (expected "${v.expectName}", found "${row.name}") - never mint a duplicate of a real venue`)
      aborted.add(v.key)
      continue
    }
    if (row.lat == null || row.lng == null) {
      console.error(`  ABORT rows for venue '${v.key}': no coordinates on file`)
      aborted.add(v.key)
      continue
    }
    if (classifySummitLocation({ lat: row.lat, lng: row.lng }) !== 'in' ||
        !inSummitBbox(row.lng, row.lat) ||
        !inBbox(row.lat, row.lng, bbox)) {
      console.error(`  ABORT rows for venue '${v.key}': coords (${row.lat}, ${row.lng}) failed the Summit/festival gate`)
      aborted.add(v.key)
      continue
    }
    resolved.set(v.key, { id: row.id, lat: row.lat, lng: row.lng })
  }
  return { resolved, aborted }
}

// ── Write path (DB; lazy-loaded so dry runs need no env) ────────────────

/** Idempotent category-lock stamp: read the event's manual_overrides, skip
 *  when already stamped by us, else pin categories + category_slugs. NEVER
 *  touches the category columns/junction themselves. */
async function stampEventCategoryLock(supabaseAdmin, eventId, stampBy) {
  const { data: ev, error } = await supabaseAdmin
    .from('events')
    .select('id, manual_overrides')
    .eq('id', eventId)
    .maybeSingle()
  if (error || !ev) { console.warn(`  category-lock lookup failed for ${eventId}`); return }
  const manual_overrides = computeCategoryLockOverrides(ev.manual_overrides, stampBy)
  if (!manual_overrides) return
  const { error: upErr } = await supabaseAdmin.from('events').update({ manual_overrides }).eq('id', eventId)
  if (upErr) console.warn(`  category-lock stamp failed for ${eventId}: ${upErr.message}`)
}

async function runWrite(data, plan) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const { upsertEventSafe, setEventVenue } = await import('./lib/normalize.js')
  const { preloadSummitCountyBoundary } = await import('./lib/summit-county.js')
  await preloadSummitCountyBoundary()

  const festival = data.festival
  const stampBy = importStampFor(festival)
  console.log(`\nWRITE mode - upserting events + umbrella enrichment for ${festival.slug} (pins by '${stampBy}')...`)

  // ── Umbrella enrichment (direct update, NOT upsertEventSafe) ───────────
  const { source, source_id } = festival.umbrella
  const { data: umbrella, error: umbErr } = await supabaseAdmin
    .from('events')
    .select('id, description, tags, manual_overrides, image_url')
    .eq('source', source)
    .eq('source_id', source_id)
    .maybeSingle()
  if (umbErr || !umbrella) {
    console.warn(`  umbrella ${source}/${source_id} not found - skipping enrichment`)
  } else {
    const enrichment = computeUmbrellaEnrichment(umbrella, festival)
    if (!enrichment) {
      console.log('  umbrella already enriched - no write')
    } else {
      const { error } = await supabaseAdmin
        .from('events')
        .update({ ...enrichment.updates, manual_overrides: enrichment.overrides })
        .eq('id', umbrella.id)
      if (error) console.warn(`  umbrella enrichment failed: ${error.message}`)
      else console.log(`  umbrella enriched + pinned (${Object.keys(enrichment.updates).join(', ')})`)
    }

    const { data: umbCats, error: umbCatErr } = await supabaseAdmin
      .from('event_categories')
      .select('category')
      .eq('event_id', umbrella.id)
    const umbList = (umbCats ?? []).map((c) => c.category)
    if (umbCatErr) {
      console.warn(`  umbrella junction lookup failed: ${umbCatErr.message} (category lock skipped)`)
    } else if (umbList[0] === festival.umbrellaCategories?.[0]) {
      await stampEventCategoryLock(supabaseAdmin, umbrella.id, stampBy)
      console.log('  umbrella junction verified festival-primary; categories pinned')
    } else {
      console.warn(`  umbrella junction is NOT festival-primary (${JSON.stringify(umbList)}) - NOT pinning`)
    }
  }

  // ── Venues ────────────────────────────────────────────────────────────
  const { resolved, aborted } = await resolveVenues(supabaseAdmin, data)

  // ── Planned events ───────────────────────────────────────────────────
  let upserted = 0, skipped = 0, venueAborted = 0
  for (const { row, venue } of plan.planned) {
    if (aborted.has(venue.key)) { venueAborted++; continue }
    const venueRow = resolved.get(venue.key)
    const { data: ev, error } = await upsertEventSafe(row)
    if (error) { console.warn(`  upsert failed "${row.title}": ${error.message}`); skipped++; continue }
    await stampEventCategoryLock(supabaseAdmin, ev.id, stampBy)
    if (venueRow) await setEventVenue(ev.id, venueRow.id)
    upserted++
  }
  console.log(`\n  ${upserted} upserted, ${skipped} skipped, ${venueAborted} aborted (venue gate)`)

  // ── Existing (tag-only) rows ─────────────────────────────────────────
  let tagged = 0, missing = 0
  for (const ex of plan.existing) {
    const { source: exSource, source_id: exSourceId } = ex.existing
    const { data: row, error } = await supabaseAdmin
      .from('events')
      .select('id, tags, manual_overrides')
      .eq('source', exSource)
      .eq('source_id', exSourceId)
      .maybeSingle()
    if (error || !row) {
      console.warn(`  existing row ${exSource}/${exSourceId} not found - NOT minted, tag pin skipped`)
      missing++
      continue
    }
    const pin = computeChildTagPin(row, ex.tagsToAdd, stampBy)
    if (!pin) { console.log(`  ${exSource}/${exSourceId} already tagged - no write`); continue }
    const { error: upErr } = await supabaseAdmin.from('events').update(pin).eq('id', row.id)
    if (upErr) console.warn(`  tag pin failed for ${exSourceId}: ${upErr.message}`)
    else { tagged++; console.log(`  ${exSourceId} tagged + pinned (${ex.tagsToAdd.join(', ')})`) }
  }
  console.log(`  ${tagged} existing row(s) tagged, ${missing} missing`)
}

// ── Prune (status='cancelled', NEVER delete; scoped to source=festival.source) ──

async function runPrune(data, plan, write) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const keep = allFileSourceIds(plan)
  // Single page. Ample for a festival-sized source (this one has 17 rows,
  // PorchRokr's ~160), but it is a CAP, not a stream: a source that ever
  // exceeds 1000 rows needs a .range() loop here, or prune would silently
  // consider only the first page and leave real strays uncancelled.
  const PRUNE_PAGE = 1000
  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status')
    .eq('source', data.festival.source)
    .limit(PRUNE_PAGE)
  if (error) throw new Error(`prune lookup failed: ${error.message}`)
  if ((rows?.length ?? 0) >= PRUNE_PAGE) {
    throw new Error(
      `prune read hit the ${PRUNE_PAGE}-row page cap for source '${data.festival.source}': ` +
      'paginate before pruning, or rows beyond the first page would be treated as absent.',
    )
  }

  const missing = (rows ?? []).filter((r) => !keep.has(r.source_id) && r.status !== 'cancelled')
  console.log(`\n--prune-missing ${write ? '(WRITE)' : '(dry run)'} - ${rows?.length ?? 0} DB row(s), ${missing.length} not in the file`)
  for (const r of missing) console.log(`    - ${r.source_id}  [${r.status}]  ${r.title}`)
  if (!write || !missing.length) return
  const { error: upErr } = await supabaseAdmin
    .from('events')
    .update({ status: 'cancelled' })
    .in('id', missing.map((r) => r.id))
  if (upErr) throw new Error(`prune update failed: ${upErr.message}`)
  console.log(`    ${missing.length} row(s) set status='cancelled' (never deleted)`)
}

// ── Main ──────────────────────────────────────────────────────────────────

/** The value following `flag`, or null when it is missing or is itself
 *  another flag (`--festival --write` must not resolve to
 *  scripts/data/--write.json). */
function flagValue(args, flag) {
  const i = args.indexOf(flag)
  if (i === -1) return null
  const value = args[i + 1]
  if (!value || value.startsWith('--')) return null
  return value
}

function resolveDataPath(args) {
  const dataPath = flagValue(args, '--data')
  if (dataPath) return dataPath
  const slug = flagValue(args, '--festival')
  if (slug) return dataPathFor(slug)
  return null
}

async function main() {
  const args = process.argv.slice(2)
  const WRITE = args.includes('--write')
  const PRUNE = args.includes('--prune-missing')

  const dataPath = resolveDataPath(args)
  if (!dataPath) {
    console.error('Usage: node scripts/import-festival.js --festival <slug> [--write] [--prune-missing]')
    console.error('       node scripts/import-festival.js --data <path> [--write] [--prune-missing]')
    process.exit(1)
  }

  const data = JSON.parse(readFileSync(dataPath, 'utf8'))
  const plan = buildPlan(data)

  if (plan.problems.length) {
    console.error('data file failed validation:')
    for (const p of plan.problems) console.error(`   - ${p}`)
    process.exit(1)
  }

  // Sanitizer round-trip guard: every planned title/description must survive
  // sanitizeEventText unchanged (apostrophes, ampersands, stray whitespace:
  // if the sanitizer would rewrite it, we want to know at plan time).
  for (const { row } of plan.planned) {
    const clean = sanitizeEventText(row)
    if (clean.title !== row.title) {
      console.warn(`  sanitizer would rewrite title: ${JSON.stringify(row.title)} -> ${JSON.stringify(clean.title)}`)
    }
    if (clean.description !== row.description) {
      console.warn(`  sanitizer would rewrite description for ${row.source_id}: ${JSON.stringify(row.description)} -> ${JSON.stringify(clean.description)}`)
    }
  }

  printPlan(data, plan)

  if (PRUNE) {
    await runPrune(data, plan, WRITE)
    return
  }

  if (!WRITE) {
    console.log('\n(dry run - nothing written. Pass --write to upsert, --prune-missing to check for stale rows.)')
    return
  }

  await runWrite(data, plan)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`import-festival failed: ${err.message}`)
    process.exit(1)
  })
}
