/**
 * test-no-utc-today.js — repo-wide guard against UTC-derived "today".
 *
 * The nightly scrape runs late in the evening Eastern. Between 8pm and midnight
 * ET (7pm–midnight EST) the UTC calendar date is ALREADY TOMORROW, so anything
 * that derives "today" from `new Date().toISOString()` silently drops or
 * mis-dates the rest of today's events. `easternTodayIso()` in
 * scripts/lib/normalize.js is the safe helper.
 *
 * Extended 2026-08-10 (the "When" date filter) to also scan `src/**` (every
 * .ts/.tsx/.js/.jsx file) after the scanner's own scripts-only scope let
 * `FilterTray.tsx`'s `const TODAY = new Date().toISOString().split('T')[0]`
 * (the exact banned shape below) ship undetected — between 8pm and midnight
 * ET it made the date picker refuse to let a visitor pick today, the same
 * bug class this file exists to catch, just on the frontend instead of a
 * scraper. `CategoryPage.tsx` had the identical line. Both are fixed now
 * (`easternTodayIso()`); this scanner is what keeps the fix from rotting.
 *
 * This scanner flags four shapes in scripts/*.js, scripts/lib/*.js, and every
 * file under src/:
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
 * NOTE: THREE allowlisted cases — and only those three — depend on the workflow
 * setting `TZ: America/New_York` on the runner (see
 * .github/workflows/nightly-scrape.yml). They are grouped together and labelled
 * in ALLOWLIST below: scrape-akron-art-museum.js `dateParam`,
 * scrape-downtown-akron.js `month`, and
 * scrape-visit-akron-cvb.js `easternMidnightUtcIso`. If that env var ever
 * disappears, the "local midnight == Eastern midnight" assumption behind them
 * breaks. Every other entry is TZ-independent for the reason given on its line.
 *
 * Run:  node --test scripts/tests/test-no-utc-today.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..')
const SRC_DIR = path.join(REPO_ROOT, 'src')
const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

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
  'scrape-woven-words.js',
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
  { file: 'ga-to-db.js',                      match: 'return new Date(t).toISOString()', reason: 'addDays: parses an explicit YYYY-MM-DD at UTC midnight and shifts whole days; the clock is never read (todayInProperty is the ET formatter)' },
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
  // scrape-city-of-cuyahoga-falls.js `const ym =` was here: monthUrls() built a
  // YYYYMM bucket from a LOCAL Date. The month grid it fed is retired (it
  // rendered every event one day early), and the replacement year/day-view path
  // is eastern-anchored through easternTodayIso(), so the entry is gone with it.
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

  // ── src/ (frontend) — added with the src scan, 2026-08-10. Every entry
  //    below is `root: 'src'`; paths are relative to src/.
  //
  // The project's OWN stated convention (dayPlanDate.ts's header, echoed in
  // eventGrouping.ts's groupEventsByDate) is that list/grid/calendar
  // surfaces group and DISPLAY dates in the VIEWER's local timezone — only
  // the day planner and this new "When" filter are pinned to Eastern. So a
  // local-getter or toLocaleDateString hit in a pure DISPLAY LABEL (never
  // compared, never sent to a query, never used as a dedupe/grouping key
  // that has to match a server-side Eastern boundary) is not this bug; it's
  // the documented default behavior. Every allowance below says which of
  // those it is.
  {
    root: 'src', file: 'components/CalendarView.tsx', match: '${pad(d.getMonth() + 1)}-${pad(d.getDate())}',
    reason: 'ymd(): viewer-local calendar-grid grouping key, explicitly documented one line above (JSDoc) as viewer-local by design — not a "today" read, and the Date it formats is always a caller-supplied event date, never a bare `new Date()`',
  },
  {
    root: 'src', file: 'components/CalendarView.tsx', match: "toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })",
    reason: 'display label for the calendar header/day view, built from `cursor` (calendar navigation state) or a resolved day key — not a clock read',
  },
  {
    root: 'src', file: 'components/CalendarView.tsx', match: "const left = ws.toLocaleDateString",
    reason: 'week-view header display label built from the already-resolved week start Date',
  },
  {
    root: 'src', file: 'components/CalendarView.tsx', match: 'const right = we.toLocaleDateString',
    reason: 'week-view header display label built from the already-resolved week end Date',
  },
  {
    root: 'src', file: 'components/CalendarView.tsx', match: '${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}',
    reason: 'month-view header display label ("August 2026") built from `cursor`, the calendar\'s own navigation state, not the clock',
  },
  {
    root: 'src', file: 'lib/ics.js', match: 'const fallback = new Date().toISOString().slice(0, 10)',
    reason: 'decorative filename fallback for a .ics export (planIcsFilename), not a filter/business-logic date — see the comment above this line',
  },
  {
    root: 'src', file: 'lib/festivals.ts', match: "toLocaleDateString('en-US', { weekday: 'long' })",
    reason: 'festivalDayLabel/weekdayLabel: display-only weekday name; the today/tomorrow decision itself is pure Eastern date-key math (easternDateKeyDiffDays) on the line above',
  },
  {
    root: 'src', file: 'lib/festivals.ts', match: 'new Date(`${dateKey}T12:00:00`).toLocaleDateString([], opts)',
    reason: 'festivalDateRangeLabel: display-only range label built from already-resolved registry date keys, not a clock read',
  },
  {
    root: 'src', file: 'pages/FestivalPage.tsx', match: 'new Date(`${dateKey}T12:00:00`).toLocaleDateString([], opts)',
    reason: 'dayLabel(): the multi-day jump-bar and section-heading day labels, built from an already-resolved Eastern day key (schedule.days), not a clock read',
  },
  {
    root: 'src', file: 'lib/eventTimes.js', match: "${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}",
    reason: 'formatLocal(): browser-side form-state formatter -- the datetime-local contract IS the viewer-local wall clock (see the module header), and the Date it formats is always derived from a caller-supplied form value, never a bare `new Date()`',
  },
]

// ── Scan ───────────────────────────────────────────────────────────────────

/** Recursively list files under `dir` with one of `SRC_EXTENSIONS`, as paths
 * relative to `dir` (POSIX-style, so allowlist entries are platform-stable). */
function walkSrc(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walkSrc(full, base))
    } else if (SRC_EXTENSIONS.has(path.extname(entry))) {
      out.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return out
}

/** Every scannable file, tagged with which root it lives under so `scripts/`
 * and `src/` files with the same relative path (e.g. both have a `lib/`)
 * can't collide in the allowlist. */
function scannableFiles() {
  const out = []
  for (const f of readdirSync(SCRIPTS_DIR)) {
    if (f.endsWith('.js')) out.push({ root: 'scripts', file: f })
  }
  for (const f of readdirSync(path.join(SCRIPTS_DIR, 'lib'))) {
    if (f.endsWith('.js')) out.push({ root: 'scripts', file: `lib/${f}` })
  }
  for (const f of walkSrc(SRC_DIR)) {
    out.push({ root: 'src', file: f })
  }
  return out.sort((a, b) => (a.root + a.file).localeCompare(b.root + b.file))
}

function rootDir(root) {
  return root === 'src' ? SRC_DIR : SCRIPTS_DIR
}

/** Human-readable path for messages: bare for scripts/ (matches the
 * pre-extension output exactly), `src/...` for the new root. */
function displayPath(root, file) {
  return root === 'src' ? `src/${file}` : file
}

/** Comment lines are documentation (including normalize.js's own warning). */
function isComment(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function allowanceFor(root, file, line) {
  return ALLOWLIST.find((a) => (a.root ?? 'scripts') === root && a.file === file && (
    typeof a.match === 'string' ? line.includes(a.match) : a.match.test(line)
  ))
}

const findings = []          // unallowed hits
const usedAllowances = new Set()

for (const { root, file } of scannableFiles()) {
  const src   = readFileSync(path.join(rootDir(root), file), 'utf8')
  const lines = src.split('\n')
  const displayFile = displayPath(root, file)
  lines.forEach((line, i) => {
    if (isComment(line)) return
    const utcDate  = UTC_DATE_SHAPE.test(line)
    const utcNight = BARE_NEW_DATE.test(line) && UTC_MIDNIGHT.test(line)
    const localYmd = isLocalYmdBuild(line)
    const locale   = LOCALE_DATE_SHAPE.test(line) && !ET_PINNED.test(line)
    if (!utcDate && !utcNight && !localYmd && !locale) return

    const allowance = allowanceFor(root, file, line)
    if (allowance) {
      usedAllowances.add(allowance)
      // Allowances that are only safe because something ELSE in the file is
      // right must say so, or they rot into a licence for the very bug this
      // file exists to prevent.
      if (allowance.requires && !allowance.requires.test(src)) {
        findings.push({
          file: displayFile, lineNo: i + 1, text: line.trim(),
          why: `allowlisted on the condition ${allowance.requires} holds in this file — it no longer does`,
        })
      }
      return
    }
    findings.push({
      file: displayFile, lineNo: i + 1, text: line.trim(),
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
    const scriptsFiles = files.filter((f) => f.root === 'scripts').map((f) => f.file)
    for (const f of [
      'scrape-downtown-akron.js', 'scrape-ohio-shakespeare.js', 'scrape-painting-twist.js',
      'scrape-weathervane.js', 'scrape-stan-hywet.js', 'scrape-runsignup.js', 'lib/normalize.js',
    ]) {
      assert.ok(scriptsFiles.includes(f), `${f} should be in the scripts/ scan set`)
    }
    assert.ok(scriptsFiles.length > 100, `expected the full scripts/ tree, got ${scriptsFiles.length} files`)
  })

  it('scans src/, including the frontend files fixed for this bug', () => {
    // The whole reason this scanner was extended (2026-08-10): it must
    // actually cover the frontend, or the FilterTray.tsx / CategoryPage.tsx
    // class of bug (a UTC-derived TODAY used as a date-picker `min=`) can
    // ship again unnoticed. Assert the fixed files are IN the scan set and
    // no longer contain the banned shape (belt-and-suspenders — the main
    // "flags every unreviewed use" test already proves this by finding zero
    // findings overall, but a regression here would be silent if that test
    // ever got an accidental allowlist entry added for these files).
    const files = scannableFiles()
    const srcFiles = files.filter((f) => f.root === 'src').map((f) => f.file)
    for (const f of [
      'components/FilterTray.tsx', 'pages/CategoryPage.tsx',
      'lib/dateRange.js', 'lib/easternDate.ts', 'lib/whenFilter.ts',
      'components/WhenSection.tsx',
    ]) {
      assert.ok(srcFiles.includes(f), `${f} should be in the src/ scan set`)
    }
    assert.ok(srcFiles.length > 100, `expected the full src/ tree, got ${srcFiles.length} files`)

    for (const f of ['components/FilterTray.tsx', 'pages/CategoryPage.tsx']) {
      const content = readFileSync(path.join(SRC_DIR, f), 'utf8')
      assert.doesNotMatch(
        content, UTC_DATE_SHAPE,
        `${f} must not reintroduce a UTC-derived TODAY (use easternTodayIso()) — ` +
        'this was the exact bug that motivated extending this scanner to src/.'
      )
    }
  })
})
