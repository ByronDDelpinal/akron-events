/**
 * test-attribution-guard.js
 *
 * Regression coverage for the 2026-07-15 misattribution fix.
 *
 * THE BUG: the site renders event_organizations as "Presented by X". Aggregator
 * scrapers hardcoded their OWN org onto every row they ingested, so Akron Pulse
 * publicly asserted that Downtown Akron Partnership and Visit Akron HOST events
 * they merely republish (80 published future events). Those orgs then fielded
 * phone calls about events they had nothing to do with.
 *
 * THE POLICY: an aggregator source carries either the REAL hosting org or NO
 * org at all. It may never name itself as presenter. See AGGREGATOR_SELF_ORG in
 * src/lib/sourceTiers.js.
 *
 * Three independent write paths reached event_organizations, so there are three
 * guards and this file covers all of them:
 *   1. scrapers          → linkEventOrganization()  (normalize.js)
 *   2. dedupe donation   → collectLinkDonations()   (dedupe-cross-source.js)
 *   3. the admin UI      → a human decision, deliberately not blocked
 *
 * Run:  node --test scripts/tests/test-attribution-guard.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  isSelfCredit,
  isAggregatorSelfOrgName,
  AGGREGATOR_SELF_ORG,
  TIER_3_SOURCES,
} from '../lib/source-tiers.js'
import { collectLinkDonations } from '../dedupe-cross-source.js'
import { isDapHostedTitle } from '../scrape-downtown-akron.js'
import { cvbOrganizerName } from '../scrape-visit-akron-cvb.js'

describe('attribution: isSelfCredit', () => {
  it('blocks each aggregator crediting its own identity', () => {
    assert.equal(isSelfCredit('downtown_akron', 'Downtown Akron Partnership'), true)
    assert.equal(isSelfCredit('visit_akron_cvb', 'Visit Akron / Summit County'), true)
    assert.equal(isSelfCredit('akron_life', 'Akron Life Magazine'), true)
  })

  it('is case- and whitespace-insensitive (org names are free text upstream)', () => {
    assert.equal(isSelfCredit('downtown_akron', '  downtown akron PARTNERSHIP  '), true)
  })

  it('allows an aggregator to credit a REAL organizer', () => {
    // The whole point of the fix: attribution is restored, not just removed.
    assert.equal(isSelfCredit('visit_akron_cvb', 'Porthouse Theatre'), false)
    assert.equal(isSelfCredit('visit_akron_cvb', 'City of Akron'), false)
    assert.equal(isSelfCredit('downtown_akron', 'Akron Soul Train'), false)
  })

  it('does not block first-party sources naming themselves', () => {
    // scrape-akron-civic.js hardcoding 'Akron Civic Theatre' is CORRECT and is
    // identical in shape to DAP's incorrect hardcode. Only the tier separates
    // them — if this ever returns true, every Tier-1 scraper loses its organizer.
    assert.equal(isSelfCredit('akron_civic', 'Akron Civic Theatre'), false)
    assert.equal(isSelfCredit('blu_jazz', 'BLU Jazz+'), false)
    assert.equal(isSelfCredit('city_of_akron_lock3', 'City of Akron'), false)
  })

  it('is keyed on the (source, org) PAIR, not "is this org an aggregator"', () => {
    // Visit Akron genuinely organizes some of its own events; only the
    // self-referential pair is forbidden.
    assert.equal(isSelfCredit('ohio_festivals', 'Visit Akron / Summit County'), false)
    assert.equal(isSelfCredit('downtown_akron', 'Visit Akron / Summit County'), false)
  })

  it('handles null/undefined without throwing', () => {
    assert.equal(isSelfCredit(null, 'Downtown Akron Partnership'), false)
    assert.equal(isSelfCredit('downtown_akron', null), false)
    assert.equal(isSelfCredit(undefined, undefined), false)
  })

  it('every self-org entry maps to a Tier-3 source', () => {
    // A self-org on a non-aggregator would silently strip a legitimate
    // first-party organizer.
    for (const source of Object.keys(AGGREGATOR_SELF_ORG)) {
      assert.ok(
        TIER_3_SOURCES.has(source),
        `${source} has a self-org entry but is not a Tier-3 aggregator`
      )
    }
  })
})

describe('attribution: isAggregatorSelfOrgName (guard pre-filter)', () => {
  it('recognises any aggregator self-identity', () => {
    assert.equal(isAggregatorSelfOrgName('Downtown Akron Partnership'), true)
    assert.equal(isAggregatorSelfOrgName('Visit Akron / Summit County'), true)
  })

  it('ignores ordinary organizations', () => {
    // This is the hot path: linkEventOrganization skips the source lookup
    // entirely when this returns false, which is ~99% of links.
    assert.equal(isAggregatorSelfOrgName('Akron Civic Theatre'), false)
    assert.equal(isAggregatorSelfOrgName('Porthouse Theatre'), false)
    assert.equal(isAggregatorSelfOrgName(null), false)
  })
})

describe('attribution: collectLinkDonations (dedupe merge path)', () => {
  const ORG_VISIT_AKRON = '11111111-1111-1111-1111-111111111111'
  const ORG_PORTHOUSE   = '22222222-2222-2222-2222-222222222222'

  it('does not launder an aggregator self-credit onto another source (Twins Days)', () => {
    // The actual production bug: the CVB copy self-credited, lost canonical to
    // the ohio_festivals copy, and donated its org link on the way out — so
    // "Twins Days Festival" (Twinsburg, run by Twins Days Inc.) read
    // "Presented by Visit Akron / Summit County" long after the CVB row was gone.
    const canonical = { source: 'ohio_festivals', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_VISIT_AKRON, organizations: { name: 'Visit Akron / Summit County' } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [])
  })

  it('still donates a REAL organizer across sources', () => {
    // The guard must be surgical. Once the CVB carries real organizers from its
    // `hostname` field, donating those to a surviving row is correct and wanted.
    const canonical = { source: 'ohio_festivals', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_PORTHOUSE, organizations: { name: 'Porthouse Theatre' } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [ORG_PORTHOUSE])
  })

  it('checks the DONOR source, not the canonical (the subtle one)', () => {
    // A canonical-side check would ask isSelfCredit('ohio_festivals', 'Visit
    // Akron / Summit County') → false → donate anyway, reproducing the bug.
    // What makes the link illegitimate is that it was a self-credit AT ITS ORIGIN.
    const canonical = { source: 'downtown_akron', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_VISIT_AKRON, organizations: { name: 'Visit Akron / Summit County' } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [])
  })

  it('drops only the self-credit when a donor carries both', () => {
    const canonical = { source: 'ohio_festivals', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [],
      event_organizations: [
        { organization_id: ORG_VISIT_AKRON, organizations: { name: 'Visit Akron / Summit County' } },
        { organization_id: ORG_PORTHOUSE,   organizations: { name: 'Porthouse Theatre' } },
      ],
    }]
    assert.deepEqual(collectLinkDonations(canonical, donors).orgIds, [ORG_PORTHOUSE])
  })

  it('leaves venue donation untouched', () => {
    const VENUE = '33333333-3333-3333-3333-333333333333'
    const canonical = { source: 'ohio_festivals', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [{ venue_id: VENUE }],
      event_organizations: [
        { organization_id: ORG_VISIT_AKRON, organizations: { name: 'Visit Akron / Summit County' } },
      ],
    }]
    const out = collectLinkDonations(canonical, donors)
    assert.deepEqual(out.venueIds, [VENUE])
    assert.deepEqual(out.orgIds, [])
  })

  it('tolerates a missing organizations join without throwing', () => {
    // Defensive: if the select ever drops organizations(name), the guard must
    // fail closed-ish rather than crash the dedupe run.
    const canonical = { source: 'ohio_festivals', event_venues: [], event_organizations: [] }
    const donors = [{
      source: 'visit_akron_cvb',
      event_venues: [],
      event_organizations: [{ organization_id: ORG_PORTHOUSE }],
    }]
    assert.doesNotThrow(() => collectLinkDonations(canonical, donors))
  })
})

describe('attribution: DAP host allowlist', () => {
  it('credits DAP for its own Summer on the Plaza / Midday on Main series', () => {
    assert.equal(isDapHostedTitle('Midday on Main Lunchtime Concerts'), true)
    assert.equal(isDapHostedTitle('Skate Night on the Plaza'), true)
    assert.equal(isDapHostedTitle('Dance Cardio on the Plaza'), true)
    assert.equal(isDapHostedTitle('Pilates on the Plaza'), true)
  })

  it('does NOT credit DAP for a third party renting Cascade Plaza', () => {
    // The reason the allowlist is title-based, not venue-based: this event is
    // AT Cascade Plaza but hosted by Summit Sports and Social. A rule like
    // "anything at Cascade Plaza is DAP's" would credit DAP for it.
    assert.equal(isDapHostedTitle('Summit Sports and Social Cornhole Leagues'), false)
  })

  it('does NOT credit DAP for other orgs events it merely re-lists', () => {
    assert.equal(isDapHostedTitle('Hower House Museum Tours'), false)
    assert.equal(isDapHostedTitle('Trivia Wednesdays at Akronym'), false)
    assert.equal(isDapHostedTitle('Comedian ZANE LAMPREY in Akron, OH'), false)
    assert.equal(isDapHostedTitle("Josh Maxwell's Working Woods: Altered But Not Erased"), false)
  })

  it('does NOT credit DAP for Lock 3 / Lock 4 programming', () => {
    // Lock 3 is a City of Akron park; scrape-city-of-akron-lock3.js already
    // credits "City of Akron". DAP promotes but does not host.
    assert.equal(isDapHostedTitle('Lock 4 Blues & Jazz: Twon & Galaxy'), false)
    assert.equal(isDapHostedTitle('Akron African American Cultural Festival'), false)
  })

  it('handles empty/null titles', () => {
    assert.equal(isDapHostedTitle(''), false)
    assert.equal(isDapHostedTitle(null), false)
    assert.equal(isDapHostedTitle(undefined), false)
  })
})

describe('attribution: CVB hostname → real organizer', () => {
  it('extracts a real organizer name', () => {
    assert.equal(cvbOrganizerName({ hostname: 'Porthouse Theatre' }), 'Porthouse Theatre')
    assert.equal(cvbOrganizerName({ hostname: 'City of Akron' }), 'City of Akron')
  })

  it('collapses the whitespace partners leave in the CRM field', () => {
    // Real value observed in the feed: "Akron Derbytown  Chorus" (double space).
    assert.equal(cvbOrganizerName({ hostname: 'Akron Derbytown  Chorus' }), 'Akron Derbytown Chorus')
    assert.equal(cvbOrganizerName({ hostname: '  Bluecoats \n' }), 'Bluecoats')
  })

  it('returns null when absent — no organizer beats a wrong one', () => {
    assert.equal(cvbOrganizerName({}), null)
    assert.equal(cvbOrganizerName({ hostname: '' }), null)
    assert.equal(cvbOrganizerName({ hostname: '   ' }), null)
    assert.equal(cvbOrganizerName({ hostname: null }), null)
    assert.equal(cvbOrganizerName(null), null)
  })

  it('rejects phone numbers and emails', () => {
    // The sibling `contact` field is full of these ("8332027626") and partners
    // sometimes paste the same into hostname. A phone number is not an org.
    assert.equal(cvbOrganizerName({ hostname: '8332027626' }), null)
    assert.equal(cvbOrganizerName({ hostname: '(330) 374-7676' }), null)
    assert.equal(cvbOrganizerName({ hostname: 'events@example.org' }), null)
  })

  it('rejects absurdly long free text', () => {
    assert.equal(cvbOrganizerName({ hostname: 'x'.repeat(200) }), null)
  })

  it('keeps messy-but-real multi-org values intact', () => {
    // Observed verbatim in the feed. Ugly, but it names a real promoter, and
    // silently rewriting partner-entered names risks minting duplicate orgs.
    const messy = 'Shagoki LLC    (music entertainment promoter) along with Submerged & the Musica venue'
    assert.equal(
      cvbOrganizerName({ hostname: messy }),
      'Shagoki LLC (music entertainment promoter) along with Submerged & the Musica venue'
    )
  })

  it('never yields the CVB itself', () => {
    // Belt and braces: audited over the full 180-day window on 2026-07-15 and
    // `hostname` was never the CVB. If that ever changes, linkEventOrganization's
    // guard is the backstop — but assert the intent here too.
    const name = cvbOrganizerName({ hostname: 'Visit Akron / Summit County' })
    assert.equal(isSelfCredit('visit_akron_cvb', name), true,
      'if the feed ever self-hosts, the linkEventOrganization guard must catch it')
  })
})
