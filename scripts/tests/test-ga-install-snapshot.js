/**
 * test-ga-install-snapshot.js - pure helpers behind the PWA-install snapshot.
 *
 * The script itself needs GA4 credentials and network; what actually needs
 * pinning is the shaping of the `installs` section, because every rule in it is
 * a decision that looks like a bug to someone reading the output cold:
 *
 *   - operatingSystem is bucketed off an ALLOWLIST, so a value Google invents
 *     later lands in Other instead of silently inflating Android or iOS.
 *   - platforms with no all-time users are omitted, never emitted as zero rows.
 *   - Other is pinned last no matter how large it is.
 *   - the two date ranges come back interleaved in one response, tagged by a
 *     synthetic `dateRange` dimension that must be found BY HEADER NAME.
 *   - the per-platform lines are allowed NOT to sum to the authoritative
 *     header total, and nothing may reconcile them.
 *
 * Run:  node --test scripts/tests/test-ga-install-snapshot.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { bucketOs, formatInstalls } from '../ga-install-snapshot.js'

/**
 * Build a by-operatingSystem report from [os, dateRangeName, totalUsers] rows.
 *
 * Options exist so every column-location assumption can be attacked:
 *   dateRangeFirst  emit GA4's synthetic dateRange column BEFORE the real
 *                   dimension, since the API decides that ordering
 *   decoyMetric     put a different metric ahead of totalUsers
 *   omitOsHeader / omitRangeHeader  drop a column the shaper depends on
 */
function osReport(
  rows,
  { dateRangeFirst = false, omitRangeHeader = false, omitOsHeader = false, decoyMetric = false } = {}
) {
  const dims = []
  if (dateRangeFirst && !omitRangeHeader) dims.push('dateRange')
  if (!omitOsHeader) dims.push('operatingSystem')
  if (!dateRangeFirst && !omitRangeHeader) dims.push('dateRange')
  return {
    dimensionHeaders: dims.map((name) => ({ name })),
    metricHeaders: decoyMetric
      ? [{ name: 'eventCount' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }]
      : [{ name: 'totalUsers', type: 'TYPE_INTEGER' }],
    rows: rows.map(([os, range, users]) => {
      const byName = { operatingSystem: os, dateRange: range }
      return {
        dimensionValues: dims.map((name) => ({ value: byName[name] })),
        // The decoy carries a value no assertion expects, so reading the
        // metric by position instead of by name fails loudly.
        metricValues: decoyMetric
          ? [{ value: '777' }, { value: String(users) }]
          : [{ value: String(users) }],
      }
    }),
  }
}

/** Un-dimensioned all-time total. A decoy metric guards against index guessing. */
function totalReport(users, { decoy = false } = {}) {
  return {
    metricHeaders: decoy
      ? [{ name: 'eventCount' }, { name: 'totalUsers', type: 'TYPE_INTEGER' }]
      : [{ name: 'totalUsers', type: 'TYPE_INTEGER' }],
    rows: [{ metricValues: decoy ? [{ value: '999' }, { value: String(users) }] : [{ value: String(users) }] }],
  }
}

describe('bucketOs', () => {
  it('maps the two first-class mobile platforms', () => {
    assert.equal(bucketOs('Android'), 'Android')
    assert.equal(bucketOs('iOS'), 'iOS')
    assert.equal(bucketOs('iPadOS'), 'iOS')
  })

  it('normalises case and surrounding whitespace', () => {
    assert.equal(bucketOs('  android '), 'Android')
    assert.equal(bucketOs('IOS'), 'iOS')
    assert.equal(bucketOs('ipados'), 'iOS')
  })

  it('does not mistake desktop Macintosh for iOS', () => {
    assert.equal(bucketOs('Macintosh'), 'Other')
  })

  it('sends every other known platform to Other', () => {
    for (const os of ['Windows', 'Linux', 'Chrome OS', 'Playstation', 'Tizen']) {
      assert.equal(bucketOs(os), 'Other', `${os} should bucket as Other`)
    }
  })

  it('keeps unattributed values instead of dropping them', () => {
    assert.equal(bucketOs('(not set)'), 'Other')
    assert.equal(bucketOs('<Other>'), 'Other')
    assert.equal(bucketOs(''), 'Other')
    assert.equal(bucketOs(undefined), 'Other')
    assert.equal(bucketOs(null), 'Other')
  })

  it('is an allowlist, so a future GA4 value cannot inflate a headline platform', () => {
    // The point of the allowlist: whatever Google ships next goes to Other.
    assert.equal(bucketOs('Android TV'), 'Other')
    assert.equal(bucketOs('iOS Simulator'), 'Other')
    assert.equal(bucketOs('visionOS'), 'Other')
  })
})

describe('formatInstalls', () => {
  // Shaped exactly like the live response on 2026-08-14.
  const live = osReport([
    ['Android', 'allTime', 21],
    ['Android', 'd28', 20],
    ['iOS', 'allTime', 19],
    ['iOS', 'd28', 18],
    ['Macintosh', 'allTime', 3],
    ['Macintosh', 'd28', 3],
    ['Windows', 'allTime', 1],
    ['Windows', 'd28', 1],
  ])

  it('splits the two date ranges and folds desktop into Other', () => {
    assert.deepEqual(formatInstalls(live, totalReport(44), 42), {
      totalAllTime: 44,
      active28d: 42,
      since: '2026-05-27',
      byPlatform: [
        { platform: 'Android', allTime: 21, active28d: 20 },
        { platform: 'iOS', allTime: 19, active28d: 18 },
        { platform: 'Other', allTime: 4, active28d: 4 },
      ],
    })
  })

  it('finds the dateRange column by header name, not by position', () => {
    // Asserted against a literal, not against formatInstalls(live): comparing
    // the implementation with itself would also pass if both returned [].
    const swapped = osReport(
      [
        ['Android', 'allTime', 21],
        ['Android', 'd28', 20],
        ['iOS', 'allTime', 19],
        ['iOS', 'd28', 18],
        ['Macintosh', 'allTime', 3],
        ['Macintosh', 'd28', 3],
        ['Windows', 'allTime', 1],
        ['Windows', 'd28', 1],
      ],
      { dateRangeFirst: true }
    )
    assert.deepEqual(formatInstalls(swapped, totalReport(44), 42), {
      totalAllTime: 44,
      active28d: 42,
      since: '2026-05-27',
      byPlatform: [
        { platform: 'Android', allTime: 21, active28d: 20 },
        { platform: 'iOS', allTime: 19, active28d: 18 },
        { platform: 'Other', allTime: 4, active28d: 4 },
      ],
    })
  })

  it('reads the all-time total by metric header name', () => {
    assert.equal(formatInstalls(live, totalReport(44, { decoy: true }), 42).totalAllTime, 44)
  })

  it('reads each platform row by metric header name', () => {
    // Guards against row.metricValues[0] creeping into the row loop, which is
    // dormant today but turns every platform number into an event count the
    // moment a second metric is added to the by-OS report.
    const withDecoy = osReport(
      [
        ['Android', 'allTime', 21],
        ['Android', 'd28', 20],
        ['iOS', 'allTime', 19],
        ['iOS', 'd28', 18],
      ],
      { decoyMetric: true }
    )
    assert.deepEqual(formatInstalls(withDecoy, totalReport(40), 38).byPlatform, [
      { platform: 'Android', allTime: 21, active28d: 20 },
      { platform: 'iOS', allTime: 19, active28d: 18 },
    ])
  })

  it('echoes the caller-supplied active28d rather than deriving its own', () => {
    // active28d duplicates installedUsers28d on purpose: same report, one call.
    assert.equal(formatInstalls(live, totalReport(44), 42).active28d, 42)
  })

  it('omits platforms with no all-time users instead of emitting a zero row', () => {
    const report = osReport([
      ['Android', 'allTime', 5],
      ['Android', 'd28', 5],
      // Present in the 28-day range only, so its all-time count reads zero.
      ['Windows', 'd28', 2],
    ])
    const out = formatInstalls(report, totalReport(5), 5)
    assert.deepEqual(out.byPlatform, [{ platform: 'Android', allTime: 5, active28d: 5 }])
    assert.ok(!out.byPlatform.some((p) => p.platform === 'Other'))
  })

  it('returns an empty byPlatform for an empty report', () => {
    const empty = { dimensionHeaders: [], metricHeaders: [], rows: [] }
    assert.deepEqual(formatInstalls(empty, totalReport(0), 0), {
      totalAllTime: 0,
      active28d: 0,
      since: '2026-05-27',
      byPlatform: [],
    })
    assert.deepEqual(formatInstalls(undefined, undefined, 0).byPlatform, [])
  })

  it('pins Other last even when it is the largest bucket', () => {
    const report = osReport([
      ['Macintosh', 'allTime', 90],
      ['Macintosh', 'd28', 80],
      ['Android', 'allTime', 3],
      ['Android', 'd28', 2],
      ['iOS', 'allTime', 1],
      ['iOS', 'd28', 1],
    ])
    assert.deepEqual(
      formatInstalls(report, totalReport(94), 83).byPlatform.map((p) => p.platform),
      ['Android', 'iOS', 'Other']
    )
  })

  it('sorts by all-time desc, breaking ties on platform name ascending', () => {
    const bigger = osReport([
      ['iOS', 'allTime', 9],
      ['Android', 'allTime', 4],
    ])
    assert.deepEqual(
      formatInstalls(bigger, totalReport(13), 0).byPlatform.map((p) => p.platform),
      ['iOS', 'Android']
    )
    const tied = osReport([
      ['iOS', 'allTime', 7],
      ['Android', 'allTime', 7],
    ])
    assert.deepEqual(
      formatInstalls(tied, totalReport(12), 0).byPlatform.map((p) => p.platform),
      ['Android', 'iOS']
    )
  })

  it('lets the lines exceed the authoritative total without reconciling', () => {
    // Distinct users are not additive: someone who installed on a phone AND a
    // laptop is counted on both lines but once in the un-dimensioned total.
    // Nothing may clamp, scale, or add a residual row to make these agree.
    const report = osReport([
      ['Android', 'allTime', 8],
      ['Android', 'd28', 8],
      ['iOS', 'allTime', 6],
      ['iOS', 'd28', 5],
    ])
    const out = formatInstalls(report, totalReport(10), 9)
    assert.equal(out.totalAllTime, 10)
    assert.equal(
      out.byPlatform.reduce((sum, p) => sum + p.allTime, 0),
      14
    )
    assert.deepEqual(out.byPlatform, [
      { platform: 'Android', allTime: 8, active28d: 8 },
      { platform: 'iOS', allTime: 6, active28d: 5 },
    ])
  })

  it('lets a SINGLE line exceed the authoritative total without clamping it', () => {
    // The case above is not enough on its own: there, no individual line is
    // bigger than the total, so a Math.min(line, totalAllTime) "fix" would be
    // invisible. Here Android alone is 12 against a total of 10 and active28d
    // is 11 against 9, so any per-line clamp, cap, or rescale changes the
    // asserted output. Both reports are honest; they count different things.
    const report = osReport([
      ['Android', 'allTime', 12],
      ['Android', 'd28', 11],
      ['iOS', 'allTime', 3],
      ['iOS', 'd28', 2],
    ])
    assert.deepEqual(formatInstalls(report, totalReport(10), 9), {
      totalAllTime: 10,
      active28d: 9,
      since: '2026-05-27',
      byPlatform: [
        { platform: 'Android', allTime: 12, active28d: 11 },
        { platform: 'iOS', allTime: 3, active28d: 2 },
      ],
    })
  })

  it('fails loudly when rows arrive with no dateRange column to attribute them', () => {
    const report = osReport([['Android', 'allTime', 5]], { omitRangeHeader: true })
    assert.throws(() => formatInstalls(report, totalReport(5), 5), /dateRange/)
  })

  it('fails loudly when rows arrive with no operatingSystem column to bucket them', () => {
    // Silently these would all bucket as Other and read as a real finding.
    const report = osReport([['Android', 'allTime', 5], ['Android', 'd28', 5]], {
      omitOsHeader: true,
    })
    assert.throws(() => formatInstalls(report, totalReport(5), 5), /operatingSystem/)
  })

  it('fails loudly when no row matches either named date range', () => {
    // What GA4 falls back to if the range `name` fields are ever dropped. Every
    // row would be skipped and an empty platform list printed under a real
    // header, so this must go red instead.
    const report = osReport([
      ['Android', 'date_range_0', 21],
      ['Android', 'date_range_1', 20],
      ['iOS', 'date_range_0', 19],
    ])
    assert.throws(() => formatInstalls(report, totalReport(44), 42), /cannot attribute/)
  })

  it('still tolerates a stray unrecognised row when others do attribute', () => {
    const report = osReport([
      ['Android', 'allTime', 5],
      ['Android', 'd28', 4],
      ['Android', 'someFutureRange', 999],
    ])
    assert.deepEqual(formatInstalls(report, totalReport(5), 4).byPlatform, [
      { platform: 'Android', allTime: 5, active28d: 4 },
    ])
  })
})
