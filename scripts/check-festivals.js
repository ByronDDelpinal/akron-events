/**
 * check-festivals.js
 *
 * Asserts the festival hub invariants against live data, for every entry in
 * the FESTIVALS registry (src/lib/festivals.ts):
 *
 *   a. Exactly ONE published row carries both the festival tag and
 *      'festival-umbrella'. Zero means the umbrella was lost (a scrape
 *      stripped unpinned tags); more than one means header hijack: the hub
 *      renders the EARLIEST-starting match as the page header
 *      (src/lib/festivalSchedule.ts buildFestivalSchedule takes the first
 *      umbrella of the start_at-ascending query in FestivalPage.tsx).
 *   b. The umbrella's Eastern calendar date equals the registry dateKey
 *      (easternDateKey, never toISOString).
 *   c. The umbrella's manual_overrides.tags pin exists (any by value);
 *      without it the owning scraper strips the hub tags on its next run.
 *   d. No published row tagged 'festival-umbrella' matches NO registry
 *      festival tag (orphan umbrellas left behind by retired entries).
 *   e. WARN (not fail) when a festival inside its 7-day homepage banner
 *      window has zero non-umbrella rows carrying its tag: the hub would
 *      show its empty state during peak interest.
 *
 * WHY THIS EXISTS AS A RUNTIME CHECK: the unit suites prove the hub logic
 * and the importer are correct, but tags reach events from paths they do
 * not cover: scrapers rewrite unpinned columns on every run, and the admin
 * UI can edit tags directly. On 2026-08-10 a second row (the Pride 5K) was
 * hand-tagged with 'festival-umbrella' plus the hub tag; because it started
 * before the festival, the hub rendered 5K copy and imagery as the festival
 * header. This check is what notices that drift, whatever the cause.
 *
 * READ-ONLY: this script never writes to the database.
 * Exits 1 when any FAIL is found, so it can gate a nightly job. WARNs
 * alone exit 0.
 *
 * Usage:
 *   node scripts/check-festivals.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Pure decision logic (evaluateFestivalInvariants) is exported and tested
 * offline in scripts/tests/test-check-festivals.js; the module is
 * import-safe (guarded main, lazy supabase-admin).
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { FESTIVALS } from '../src/lib/festivals.ts'
import { easternDateKey, easternTodayIso, easternDateKeyDiffDays } from '../src/lib/dayPlanDate.ts'

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m'
const DIM = '\x1b[2m', R = '\x1b[0m'

export const UMBRELLA_TAG = 'festival-umbrella'

/** Homepage banner window in days, [0, BANNER_WINDOW_DAYS] inclusive.
 *  Mirrors upcomingFestival in src/lib/festivals.ts. */
export const BANNER_WINDOW_DAYS = 7

function hasTag(row, tag) {
  return Array.isArray(row.tags) && row.tags.includes(tag)
}

/**
 * Pure invariant evaluation: given event rows, the festival registry, and an
 * injected Eastern today (yyyy-MM-dd), produce findings. No DB, no clock.
 *
 * rows: [{ id, title, status, start_at, tags, manual_overrides }] covering
 * at least every row that carries 'festival-umbrella' or any registry tag.
 * Non-published rows are ignored (the hub queries status='published').
 *
 * Returns [{ level: 'FAIL'|'WARN', check, festival, message, eventIds }].
 */
export function evaluateFestivalInvariants(rows, registry, todayIso) {
  const findings = []
  const published = (rows ?? []).filter((r) => r.status === 'published')
  const registryTags = new Set(registry.map((f) => f.tag))

  for (const f of registry) {
    const tagged = published.filter((r) => hasTag(r, f.tag))
    const umbrellas = tagged
      .filter((r) => hasTag(r, UMBRELLA_TAG))
      .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)))

    // a. exactly one umbrella per festival tag
    if (umbrellas.length === 0) {
      findings.push({
        level: 'FAIL', check: 'one-umbrella', festival: f.slug, eventIds: [],
        message: `no published row carries both '${f.tag}' and '${UMBRELLA_TAG}'. ` +
          `The hub has no header. Umbrella lost, most likely a scrape rewrote unpinned tags; ` +
          `re-tag the festival event and pin manual_overrides.tags.`,
      })
    } else if (umbrellas.length > 1) {
      const hijacker = umbrellas[0]
      findings.push({
        level: 'FAIL', check: 'one-umbrella', festival: f.slug,
        eventIds: umbrellas.map((u) => u.id),
        message: `${umbrellas.length} published rows carry both '${f.tag}' and '${UMBRELLA_TAG}'. ` +
          `The hub renders the earliest start as the header, so "${hijacker.title}" ` +
          `(${hijacker.start_at}) hijacks the festival header (the 2026-08-10 Pride 5K incident). ` +
          `Remove '${UMBRELLA_TAG}' from every row except the festival event itself.`,
      })
    }

    if (umbrellas.length >= 1) {
      // b and c run against the row the hub would actually pick (earliest).
      const u = umbrellas[0]

      const dk = easternDateKey(u.start_at)
      if (dk !== f.dateKey) {
        findings.push({
          level: 'FAIL', check: 'umbrella-date', festival: f.slug, eventIds: [u.id],
          message: `umbrella "${u.title}" falls on Eastern date ${dk}, but the registry ` +
            `dateKey is ${f.dateKey}. Either the wrong row is tagged as the umbrella ` +
            `or the registry entry is stale.`,
        })
      }

      const pin = u.manual_overrides?.tags
      if (!pin || typeof pin !== 'object') {
        findings.push({
          level: 'FAIL', check: 'umbrella-pin', festival: f.slug, eventIds: [u.id],
          message: `umbrella "${u.title}" has no manual_overrides.tags pin: the owning ` +
            `scraper will strip '${f.tag}' and '${UMBRELLA_TAG}' on its next run. ` +
            `Re-stamp {at, by} on the tags key.`,
        })
      }
    }

    // e. banner-window emptiness (WARN only)
    const diff = easternDateKeyDiffDays(todayIso, f.dateKey)
    if (diff >= 0 && diff <= BANNER_WINDOW_DAYS) {
      const nonUmbrella = tagged.filter((r) => !hasTag(r, UMBRELLA_TAG))
      if (nonUmbrella.length === 0) {
        findings.push({
          level: 'WARN', check: 'empty-window', festival: f.slug, eventIds: [],
          message: `festival is ${diff} day(s) out (inside the [0, ${BANNER_WINDOW_DAYS}] homepage ` +
            `banner window) but zero non-umbrella rows carry '${f.tag}': the hub shows ` +
            `its empty state during peak interest. Import the lineup.`,
        })
      }
    }
  }

  // d. orphan umbrellas: tagged 'festival-umbrella' but matching no registry tag
  for (const r of published) {
    if (!hasTag(r, UMBRELLA_TAG)) continue
    const matchesRegistry = (r.tags ?? []).some((t) => registryTags.has(t))
    if (!matchesRegistry) {
      findings.push({
        level: 'FAIL', check: 'orphan-umbrella', festival: null, eventIds: [r.id],
        message: `"${r.title}" (${r.id}) carries '${UMBRELLA_TAG}' but matches no registry ` +
          `festival tag. Retired registry entry or stray tagging; remove the tag or ` +
          `restore the registry entry.`,
      })
    }
  }

  return findings
}

/**
 * Every row that could participate in any invariant: tags overlap the
 * umbrella marker or any registry tag. Paginated with a total, stable
 * ordering (the check-attribution.js trap: PostgREST caps at 1000 rows and
 * does not say it truncated).
 */
async function fetchFestivalRows(supabaseAdmin, registry) {
  const interest = [UMBRELLA_TAG, ...registry.map((f) => f.tag)]
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, status, start_at, tags, manual_overrides')
      .overlaps('tags', interest)
      .eq('status', 'published')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Query failed: ${error.message}`)
    if (!data?.length) break
    all.push(...data)
    if (data.length < PAGE) break
  }
  return all
}

async function main() {
  console.log('🔍  Checking festival hub invariants (one pinned umbrella per registry tag)\n')

  // Lazy import: the module stays import-safe for the offline unit tests.
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const rows = await fetchFestivalRows(supabaseAdmin, FESTIVALS)
  const todayIso = easternTodayIso()
  const findings = evaluateFestivalInvariants(rows, FESTIVALS, todayIso)

  const fails = findings.filter((f) => f.level === 'FAIL')
  const warns = findings.filter((f) => f.level === 'WARN')

  for (const f of FESTIVALS) {
    const mine = findings.filter((x) => x.festival === f.slug)
    if (mine.length === 0) {
      console.log(`  ${GREEN}✓${R} ${f.slug} ${DIM}(tag '${f.tag}', dateKey ${f.dateKey})${R}`)
      continue
    }
    console.log(`  ${mine.some((x) => x.level === 'FAIL') ? RED + '✖' : YELLOW + '⚠'}${R} ${f.slug}`)
    for (const x of mine) {
      const color = x.level === 'FAIL' ? RED : YELLOW
      console.log(`      ${color}${x.level}${R} [${x.check}] ${x.message}`)
      for (const id of x.eventIds) console.log(`        ${DIM}event ${id}${R}`)
    }
  }

  const orphans = findings.filter((x) => x.check === 'orphan-umbrella')
  for (const x of orphans) {
    console.log(`  ${RED}✖${R} (no registry entry)`)
    console.log(`      ${RED}FAIL${R} [${x.check}] ${x.message}`)
  }

  console.log(`\n${DIM}    Checked ${rows.length} published row(s) against ${FESTIVALS.length} ` +
              `registry entr${FESTIVALS.length === 1 ? 'y' : 'ies'} (Eastern today ${todayIso}).${R}`)

  if (fails.length === 0) {
    console.log(`${GREEN}✅  Festival invariants hold${R}` +
      (warns.length ? ` ${YELLOW}(${warns.length} warning(s) above)${R}` : '') + '\n')
    process.exit(0)
  }
  console.log(`${RED}❌  ${fails.length} invariant violation(s) found.${R} See docs/festival-playbook.md.\n`)
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`${RED}Fatal:${R}`, err.message)
    process.exit(1)
  })
}
