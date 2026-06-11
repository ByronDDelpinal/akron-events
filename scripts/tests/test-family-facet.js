/**
 * Family-facet inference regressions — real production false positives from
 * 2026-06-11 (docs/tagging-audit-2026-06.md follow-up). Each negative case
 * below shipped to akronpulse.com with a wrong Family badge before the
 * exclusion contexts were added to category-inference.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inferFacets } from '../lib/category-inference.js'

const family = (title, desc) => inferFacets(title, desc).family

describe('family facet: production false positives stay fixed', () => {
  it('band tagline "for kids of all ages" in an artist bio does not flag (Dreadlock Dave)', () => {
    assert.equal(family(
      'Dreadlock Dave',
      'David is the bassist/vocalist for Big Ship, "Original Acoustifunk for kids of all ages", and other acts.',
    ), false)
  })

  it('counted possessive in a performer bio does not flag (Five for Fighting)', () => {
    assert.equal(family(
      'Five for Fighting and Edwin McCain',
      'His wife, Carla, had been a music publisher before leaving the business to devote her time to their two children, Johnny and Olivia.',
    ), false)
  })

  it('negated admission does not flag (Lakes Tour)', () => {
    assert.equal(family(
      'Lakes Tour 2026',
      'We regret that we cannot admit infants or children under age 12. All proceeds benefit the Akron Symphony Orchestra.',
    ), false)
  })
})

describe('family facet: legitimate signals keep matching', () => {
  it('uncounted possessive programming copy still flags', () => {
    assert.equal(family('Gone Fishin\'', 'Parents can bring their children to learn to fish at the pond.'), true)
  })

  it('"family-friendly" still flags by design', () => {
    assert.equal(family('Sunshine & Small Business Expo', 'A fun, family-friendly morning supporting local businesses.'), true)
  })

  it('storytime and explicit kid programming still flag', () => {
    assert.equal(family('Family Storytime', ''), true)
    assert.equal(family('Glow Party', 'A dance party for kids in grades K-5.'), true)
  })

  it('plain concerts do not flag', () => {
    assert.equal(family('Paula Cole', 'An evening of songs from her acclaimed catalog.'), false)
  })
})
