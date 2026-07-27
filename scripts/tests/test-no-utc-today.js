/**
 * test-no-utc-today.js — repo-wide guard against UTC-derived "today".
 *
 * The nightly scrape runs late in the evening Eastern. Between 8pm and midnight
 * ET (7pm–midnight EST) the UTC calendar date is ALREADY TOMORROW, so anything
 * that derives "today" from `new Date().toISOString()` silently drops or
 * mis-dates the rest of today's events. `easternTodayIso()` in
 * scripts/lib/normalize.js is the safe helper.
 *
 * This scanner flags four shapes in scripts/*.js and scripts/lib/*.js:
 *
 *   1. A UTC calendar date sliced out of an ISO string —
 *      `toISOString().split('T')[0]`, `.slice(0, 10)`, `.substring(0, 10)`,
 *      `.split('T').shift()`. Most dangerous when the result is a COMPARISON
 *      operand (a past-event filter, an API start floor, a year-rollover
 *      heuristic) — that is where the off-by-one becomes lost or wrong data.
 *      We flag every occurrence rather than only comparisons, because the
 *      dangerous cases were all written as `someVar.toISOString()...` and no
 *      cheap lexical rule can tell a live clock from a fixed date without
 *      dataflow analysis.
 *
 *   2. `setUTCHours(0, ...)` applied to a bare `new Date()` — the same
 *      "UTC midnight of today" bug wearing a different hat.
 *
 *   3. A LOCAL calendar date assembled from `getFullYear()` + `getMonth()` /
 *      `getDate()`. This is the shape that shipped the scrape-stan-hywet.js
 *      recurring-start bug: it reads the runner's wall clock, so it silently
 *      ignores an injected test clock AND is wrong on any runner whose TZ is
 *      not America/New_York. Two or more of those getters on one line is the
 *      signature.
 *
 *   4. `.toLocaleDateString(` — same class of problem: locale/TZ-dependent
 *      formatting standing in for a calendar date.
 *
 * Reviewed-benign cases live in ALLOWLIST below, each with a one-line reason.
 * Anything not listed is a failure: switch it to `easternTodayIso()`.
 *
 * NOTE: FOUR allowlisted cases — and only those four — depend on the workflow
 * setting `TZ: America/New_York` on the runner (see
 * .github/workflows/nightly-scrape.yml). They are grouped together and labelled
 * in ALLOWLIST below: scrape-akron-art-museum.js `dateParam`,
 * scrape-city-of-cuyahoga-falls.js `ym`, scrape-downtown-akron.js `month`, and
 * scrape-visit-akron-cvb.js `easternMidnightUtcIso`. If that env var ever
 * disappears, the "local midnight == Eastern midnight" assumption behind them
 * breaks. Every other entry is TZ-independent for the reason given on its line.
 *
 * Run:  node --test scripts/tests/test-no-utc-today.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── Banned shapes ──────────────────────────────────────────────────────────

// `toISOString()` followed by any of the four ways we have actually seen the
// date half sliced off. `.shift()` and `.substring(0, 10)` are here because the
// obvious `[0]` / `.slice(0, 10)` forms were the only ones caught, and swapping
// to a synonym is a one-character evasion of a guard that exists to stop
// exactly this bug.
//
// `toJSON()` is matched alongside `toISOString()` for the same reason: on Date
// it is an exact alias (Date.prototype.toJSON calls toISOString), so
// `new Date().toJSON().slice(0, 10)` is the identical bug and used to walk
// straight through this scanner.
const UTC_DATE_SHAPE = new RegExp(
  '(?:toISOString|toJSON)\\(\\)\\s*\\.\\s*(?:' +
    "split\\(\\s*['\"]T['\"]\\s*\\)\\s*(?:\\[\\s*0\\s*\\]|\\.\\s*shift\\(\\s*\\))" +
    '|slice\\(\\s*0\\s*,\\s*10\\s*\\)' +
    '|substring\\(\\s*0\\s*,\\s*10\\s*\\)' +
    '|substr\\(\\s*0\\s*,\\s*10\\s*\\)' +
  ')'
)
const BARE_NEW_DATE  = /new Date\(\s*\)/
const UTC_MIDNIGHT   = /setUTCHours\(\s*0/

// A LOCAL calendar date STRING assembled from the wall-clock getters — the
// exact shape that shipped the stan-hywet bug. Signature: two or more DISTINCT
// getters from {getFullYear, getMonth, getDate} on a line that is also building
// a string (template literal or padStart).
//
// Deliberately not caught: `new Date(now.getFullYear(), now.getMonth() + i, 1)`
// month-bucket arithmetic, and single-getter year inference
// (`month >= cm ? now.getFullYear() : now.getFullYear() + 1`). Both read the
// local clock and are therefore TZ-dependent, but neither is the date-string
// build this rule targets and flagging them turns the allowlist into noise.
// Known sites of the uncaught shapes, all TZ-dependent-but-benign under the
// job's TZ: scrape-akron-art-museum.js:502, scrape-hale-farm.js:113-114,
// scrape-house-three-thirty.js:99, scrape-akron-roller-derby.js:81,
// scrape-ohio-festivals.js:73, scrape-visit-akron-cvb.js:98.
const LOCAL_GETTERS = /\.get(?:FullYear|Month|Date)\(\s*\)/g
const STRING_BUILD  = /`|padStart\(/
function isLocalYmdBuild(line) {
  const distinct = new Set(line.match(LOCAL_GETTERS) || [])
  return distinct.size >= 2 && STRING_BUILD.test(line)
}

// Locale-dependent formatting used as a calendar date — UNLESS the call pins
// the zone to America/New_York on the same line, which is precisely what
// easternTodayIso() itself does (`Intl.DateTimeFormat('en-CA', { timeZone:
// 'America/New_York' })`). Flagging the ET-pinned form would mean allowlisting
// the correct answer in eight files.
const LOCALE_DATE_SHAPE = /\.toLocaleDateString\(/
const ET_PINNED         = /timeZone:\s*['"]America\/New_York['"]/

// ── Allowlist ──────────────────────────────────────────────────────────────
//
// Entries are matched by file + a substring/regex of the offending line, NOT by
// line number, so unrelated edits above them don't break this test. Every entry
// must still match something (the stale-entry test below), so the list cannot
// quietly rot.

// The Tribe / WordPress REST family all compute a FAR-HORIZON `endDate` from
// the current instant. The start of the window in each of these files is
// `easternTodayIso()` (asserted below), and a horizon that is one day generous
// costs nothing, so the UTC formatting here is harmless.
const TRIBE_END_DATE = 'far-horizon endDate only; the window START in this file is easternTodayIso()'
// The condition the allowance actually rests on: the window FLOOR is assigned
// from easternTodayIso(). A bare /easternTodayIso/ would be satisfied by the
// `import { …, easternTodayIso }` line alone, so swapping `startDate` back to a
// UTC-derived value while leaving the import intact would keep this green —
// i.e. exactly the regression this file exists to catch. Same strength as
// RUNSIGNUP_EASTERN_FLOOR below.
const TRIBE_EASTERN_START = /startDate\s*=\s*easternTodayIso\(/
const TRIBE_FILES = [
  'scrape-beaus-on-the-river.js',
  'scrape-village-of-clinton.js',
  'scrape-indivisible-akron.js',
  'scrape-raintree-golf.js',
  'scrape-players-guild.js',
  'scrape-summit-metro-parks.js',
  'scrape-portage-lakes-kiwanis.js',
  'scrape-torchbearers.js',
  'scrape-stewarts-caring-place.js',
  'scrape-summit-artspace.js',
  'scrape-summit-humane.js',
  'scrape-peninsula-coffee-house.js',
  'scrape-peninsula-foundation.js',
  'scrape-wine-mill.js',
  'scrape-northfield-park.js',
  'scrape-royal-palace.js',
  'scrape-missing-falls.js',
]

// RunSignup's /rest/races `startDate` is a SERVER-SIDE floor: races starting
// before it never come back, so no local filter can recover them. It must be
// Eastern "today".
const RUNSIGNUP_EASTERN_FLOOR = /startDate:\s*easternTodayIso\(/

const ALLOWLIST = [
  ...TRIBE_FILES.map((file) => ({ file, match: 'const endDate', reason: TRIBE_END_DATE, requires: TRIBE_EASTERN_START })),

  // Pure YMD arithmetic: the Date is built from an explicit 'YYYY-MM-DD' (or
  // Date.UTC) anchor, never from the current instant, so there is no clock to
  // be wrong about.
  { file: 'scrape-first-glance.js',           match: 'Date.UTC(y, m - 1, d + n, 12)', reason: 'addDaysYmd: noon-UTC anchor from an explicit YMD, not the clock' },
  { file: 'scrape-akron-childrens-museum.js', match: 'return d.toISOString()',        reason: 'addDaysToYmd: Date built from an explicit YMD string' },
  { file: 'scrape-heritage-farms.js',         match: 'dows.includes',                 reason: 'datesInRangeOnWeekdays: iterates explicit YMD bounds' },
  { file: 'scrape-barnes-noble-akron.js',     match: 'return dt.toISOString()',       reason: 'addDaysStr: noon-UTC anchor from an explicit YMD string' },
  { file: 'scrape-cvsr.js',                   match: 'return d.toISOString()',        reason: 'cutoff is derived from easternTodayYmd(), not from the clock' },
  { file: 'lib/weekly-occurrences.js',        match: 'out.push(new Date(todayUtcMs',  reason: 'todayUtcMs is passed in Eastern-anchored by the caller' },
  { file: 'scrape-akronym.js',                match: 'dateStr: d.toISOString()',      reason: 'baseMs comes from an already-resolved event date, not the clock' },
  { file: 'scrape-nightlight.js',             match: 'const horizonDate',             reason: 'horizon is todayEasternYmd() + N days; only the far end is UTC-formatted' },
  { file: 'scrape-visit-akron-cvb.js',        match: 'offsetHrs * 3600_000',          reason: 'etCalendarDate shifts an explicit ISO instant by the ET offset before formatting' },
  // Narrow on purpose: a bare 'console.log' key would hand every future log
  // line in this file a free pass.
  { file: 'scrape-visit-akron-cvb.js',        match: 'Querying Visit Akron CVB for events', reason: 'progress log line only; the real window is startIso/endIso from easternMidnightUtcIso()' },

  // ── TZ-dependent: correct ONLY because the job runs with
  //    TZ: America/New_York, which makes the runner's local date == the ET date.
  //    These are the entries that break if that env var ever disappears.
  { file: 'scrape-akron-art-museum.js',       match: 'const dateParam',               reason: 'month-bucket URL param from a LOCAL Date; local midnight == ET under the job TZ' },
  { file: 'scrape-city-of-cuyahoga-falls.js', match: 'const ym =',                    reason: 'monthUrls(): a YYYYMM bucket, so a one-day skew can only matter on a month boundary; local == ET under the job TZ' },
  { file: 'scrape-downtown-akron.js',         match: 'const month =',                 reason: 'getMonthUrls(): a YYYY-MM bucket, same month-boundary-only blast radius; local == ET under the job TZ' },
  { file: 'scrape-visit-akron-cvb.js',        match: 'pad(offsetHrs)',                reason: 'easternMidnightUtcIso() reads the LOCAL calendar date of the Date it is handed; callers pass a local-midnight Date and local == ET under the job TZ' },

  // Comparison operands that are deliberately slack.
  { file: 'scrape-highland-square-theatre.js', match: 'sevenDaysAgo',                 reason: 'a 7-day-slack past cutoff; a one-day UTC skew cannot drop a current showtime' },

  // Formatting helpers whose callers control the anchor. `ymd` is a bare
  // UTC formatter, so the allowance is only true while the FLOOR next to it
  // stays Eastern — `requires` asserts exactly that, and the dedicated test
  // below asserts it again with a readable failure. Without both, the original
  // bug could be reintroduced in this very file with zero test failures.
  { file: 'scrape-runsignup.js',              match: 'const ymd =',                   reason: 'far-horizon endDate only; the search FLOOR is startDate: easternTodayIso()', requires: RUNSIGNUP_EASTERN_FLOOR },
]

// ── Scan ───────────────────────────────────────────────────────────────────

function scannableFiles() {
  const out = []
  for (const f of readdirSync(SCRIPTS_DIR)) {
    if (f.endsWith('.js')) out.push(f)
  }
  for (const f of readdirSync(path.join(SCRIPTS_DIR, 'lib'))) {
    if (f.endsWith('.js')) out.push(`lib/${f}`)
  }
  return out.sort()
}

/** Comment lines are documentation (including normalize.js's own warning). */
function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function allowanceFor(file, line) {
  return ALLOWLIST.find((a) => a.file === file && (
    typeof a.match === 'string' ? line.includes(a.match) : a.match.test(line)
  ))
}

const findings = []          // unallowed hits
const usedAllowances = new Set()

for (const file of scannableFiles()) {
  const src   = readFileSync(path.join(SCRIPTS_DIR, file), 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    if (isComment(line)) return
    const utcDate  = UTC_DATE_SHAPE.test(line)
    const utcNight = BARE_NEW_DATE.test(line) && UTC_MIDNIGHT.test(line)
    const localYmd = isLocalYmdBuild(line)
    const locale   = LOCALE_DATE_SHAPE.test(line) && !ET_PINNED.test(line)
    if (!utcDate && !utcNight && !localYmd && !locale) return

    const allowance = allowanceFor(file, line)
    if (allowance) {
      usedAllowances.add(allowance)
      // Allowances that are only safe because something ELSE in the file is
      // right must say so, or they rot into a licence for the very bug this
      // file exists to prevent.
      if (allowance.requires && !allowance.requires.test(src)) {
        findings.push({
          file, lineNo: i + 1, text: line.trim(),
          why: `allowlisted on the condition ${allowance.requires} holds in this file — it no longer does`,
        })
      }
      return
    }
    findings.push({
      file, lineNo: i + 1, text: line.trim(),
      why: utcNight
        ? 'UTC midnight of a bare `new Date()` — use easternTodayIso() instead'
        : localYmd
          ? 'LOCAL calendar date from getFullYear()/getMonth()/getDate() — reads the runner wall clock; use easternTodayIso(now)'
          : locale
            ? 'toLocaleDateString() as a calendar date — locale/TZ dependent; use easternTodayIso()'
            : 'UTC-derived calendar date — use easternTodayIso() instead',
    })
  })
}

describe('no UTC-derived "today" in scrapers', () => {
  it('flags every unreviewed toISOString()-date / setUTCHours(0) use', () => {
    const msg = findings
      .map((f) => `  ${f.file}:${f.lineNo}  ${f.why}\n      ${f.text}`)
      .join('\n')
    assert.equal(
      findings.length, 0,
      `Found ${findings.length} UTC-derived "today" use(s). The nightly scrape runs after 8pm ET, ` +
      `when the UTC date is already tomorrow — these silently drop or mis-date today's events.\n` +
      `Use easternTodayIso() from scripts/lib/normalize.js, or add a reviewed entry to ALLOWLIST ` +
      `in this file with a one-line reason.\n${msg}`
    )
  })

  // The scanner is only worth its runtime if the shapes it bans are the shapes
  // people actually write. These lock in the widening: every case below was a
  // real evasion of the original two-pattern version.
  it('detects each banned shape (and not the correct Eastern idiom)', () => {
    const banned = [
      "const t = new Date().toISOString().split('T')[0]",
      'const t = new Date().toISOString().slice(0, 10)',
      'const t = new Date().toISOString().substring(0, 10)',
      "const t = new Date().toISOString().split('T').shift()",
      // toJSON() is an exact alias of toISOString() on Date — same bug, one
      // rename away from the scanner.
      'const t = new Date().toJSON().slice(0, 10)',
      "const t = new Date().toJSON().split('T')[0]",
      'const t = new Date().toLocaleDateString()',
      "const t = new Date().toLocaleDateString('en-CA')",
      // The stan-hywet blocker, verbatim in shape.
      'const dateStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`',
      'return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`',
    ]
    for (const line of banned) {
      const hit = UTC_DATE_SHAPE.test(line)
        || (BARE_NEW_DATE.test(line) && UTC_MIDNIGHT.test(line))
        || isLocalYmdBuild(line)
        || (LOCALE_DATE_SHAPE.test(line) && !ET_PINNED.test(line))
      assert.ok(hit, `scanner must flag: ${line}`)
    }

    const allowed = [
      // easternTodayIso()'s own implementation shape — the right answer.
      "return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })",
      // Incidental single-getter reads are not date-string assembly.
      'const cm = now.getMonth() + 1',
      'const year = month >= cm ? now.getFullYear() : now.getFullYear() + 1',
      "const iso = easternTodayIso(now)",
    ]
    for (const line of allowed) {
      const hit = UTC_DATE_SHAPE.test(line)
        || (BARE_NEW_DATE.test(line) && UTC_MIDNIGHT.test(line))
        || isLocalYmdBuild(line)
        || (LOCALE_DATE_SHAPE.test(line) && !ET_PINNED.test(line))
      assert.equal(hit, false, `scanner must NOT flag: ${line}`)
    }
  })

  it('has no stale allowlist entries', () => {
    const stale = ALLOWLIST.filter((a) => !usedAllowances.has(a))
      .map((a) => `  ${a.file}  match=${a.match}`)
    assert.equal(
      stale.length, 0,
      `These ALLOWLIST entries no longer match anything and should be deleted:\n${stale.join('\n')}`
    )
  })

  it('scrape-runsignup.js derives its search FLOOR from easternTodayIso()', () => {
    // The `const ymd =` allowance above exists only because this holds. Assert
    // it positively rather than trusting the allowlist comment: the scanner
    // cannot see through `ymd(now)`, so without this the exact regression this
    // file was written to prevent could be reintroduced here and go green.
    const src = readFileSync(path.join(SCRIPTS_DIR, 'scrape-runsignup.js'), 'utf8')
    assert.match(
      src, RUNSIGNUP_EASTERN_FLOOR,
      'scrape-runsignup.js must build the /rest/races search window with ' +
      '`startDate: easternTodayIso(now)`. That floor is enforced server-side — ' +
      'a UTC "today" at 11pm ET asks for races starting TOMORROW and silently ' +
      'loses every race happening today.'
    )
  })

  it('scans the scrapers that were fixed for this bug', () => {
    // Cheap sanity check that the scan is actually looking at real files, so a
    // broken glob can't turn this suite into a no-op.
    const files = scannableFiles()
    for (const f of [
      'scrape-downtown-akron.js', 'scrape-ohio-shakespeare.js', 'scrape-painting-twist.js',
      'scrape-weathervane.js', 'scrape-stan-hywet.js', 'scrape-runsignup.js', 'lib/normalize.js',
    ]) {
      assert.ok(files.includes(f), `${f} should be in the scan set`)
    }
    assert.ok(files.length > 100, `expected the full scripts/ tree, got ${files.length} files`)
  })
})
