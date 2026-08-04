/**
 * test-family-safety-veto.js
 *
 * Tests for the family-facet safety veto (category-inference.js's
 * `familySafetyVeto` + `inferFacets`/`inferCategories`, and normalize.js's
 * `resolveFamilyFacet`). Design: docs/family-facet-safety-veto.md (gitignored
 * — not shipped with the repo; the load-bearing rationale lives in code
 * comments in category-inference.js and normalize.js instead).
 *
 * Incident (2026-08-03): "Baby Doe", a documentary at Nightlight Cinema about
 * a woman prosecuted over her newborn's death, was flagged `is_family = true`
 * by FAMILY_RE's bare `baby|babies` alternative and shown to families. This
 * suite is the regression guard.
 *
 * All cases run the REAL inference path (no reimplemented regex) against
 * realistic title/description text — see feedback_validate_before_proposing_code.
 *
 * A note on titles below that differ from the design doc's illustrative
 * examples: a few of the doc's §4a false-positive examples use a bare
 * "family" in the title (e.g. "Family Murder Mystery Night", "Family Film
 * Night"). FAMILY_RE has no bare "family" alternative (only "family[-
 * ]friendly", "family game night", "family day", "family fun") — that gap in
 * FAMILY_RE's own recall is real, pre-existing, and explicitly out of scope
 * for this veto (see the design's open question 4 / ruling: FAMILY_RE is
 * frozen here). Where a doc example wouldn't trip `positives` at all under
 * the current FAMILY_RE — so the veto would never get a chance to prove
 * anything either way — the test below swaps in an equivalent title that DOES
 * carry a real FAMILY_RE cue (typically by adding "Kids"/"Family Fun"/a
 * "<word> camp" shape) while keeping the exact harm-adjacent text from the
 * doc's scenario intact. This was verified against the live inference path,
 * not assumed.
 *
 * Run:  node --test scripts/tests/test-family-safety-veto.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { inferCategories, familySafetyVeto } from '../lib/category-inference.js'
import { resolveEventCategories, resolveFamilyFacet } from '../lib/normalize.js'
import { ORACLE } from './test-category-inference-v2.js'

// ── A. Regression fixture — the incident, verbatim ──────────────────────────

describe('family safety veto — "Baby Doe" incident regression', () => {
  const title = 'Baby Doe'
  const description =
    "At 22, Gail gave birth alone and left her newborn in the woods. Decades " +
    "later, she's arrested for murder, despite claiming the baby was stillborn."

  it('familySafetyVeto fires child-harm on the raw incident text', () => {
    const veto = familySafetyVeto(title, description)
    assert.ok(veto, 'expected the veto to fire')
    assert.equal(veto.rule, 'child-harm')
    assert.ok(veto.terms.length > 0 && veto.terms[0].length > 0)
  })

  it('inferCategories: family is false, veto reports suppression', () => {
    const got = inferCategories(title, description)
    // "Baby Doe" alone matches FAMILY_RE's bare baby|babies (the recall gap
    // this veto exists to guard, not fix — see the doc header above), so
    // positives would have fired. The veto strikes it down.
    assert.equal(got.family, false)
    assert.ok(got.familyVeto)
    assert.equal(got.familyVeto.rule, 'child-harm')
    assert.equal(got.familyVeto.suppressed, true)
  })

  it('content categories are untouched by the veto', () => {
    const got = inferCategories(title, description)
    // Via inferCategories alone (no source hint) the text carries no film
    // signal ("documentary", "screening", etc. never appear) and lands on
    // 'other' — exactly what the pipeline sees before the Nightlight
    // scraper's `category: 'film'` hint is applied downstream.
    assert.deepEqual(got.categories, ['other'])

    // End-to-end with the real Nightlight source hint: the veto must never
    // leak into content-category resolution. A crime documentary is still film.
    const resolved = resolveEventCategories({ category: 'film' }, got.categories)
    assert.deepEqual(resolved, ['film'])
  })
})

// ── B. Veto fires (family must be false) ────────────────────────────────────

describe('family safety veto — fires and suppresses an inferred family flag', () => {
  it('remembrance gathering for the loss of a child', () => {
    const got = inferCategories(
      'Family Storytime',
      'a remembrance gathering for families who have experienced the loss of a child',
    )
    assert.equal(got.family, false)
    assert.equal(got.familyVeto?.rule, 'child-harm')
    assert.equal(got.familyVeto?.suppressed, true)
  })

  it('a film that narrates killing an infant', () => {
    const got = inferCategories(
      'Baby & Me',
      'the film follows a mother convicted of killing her infant',
    )
    assert.equal(got.family, false)
    assert.equal(got.familyVeto?.rule, 'child-harm')
  })

  it('an unsolved child murder, framed as a "documentary night"', () => {
    const got = inferCategories(
      'Kids Documentary Night',
      'the unsolved murder of a 6-year-old; the case remains a cold case',
    )
    assert.equal(got.family, false)
    assert.ok(got.familyVeto, 'expected the veto to fire')
    // The object noun list for the A3/A4 "<verb/noun> of/+ <child noun>"
    // shapes does not include an age-described child ("a 6-year-old"), so
    // this specific phrasing falls through Group A and is caught instead by
    // Group B's generic serious-harm + real-case-cue pair ("murder" +
    // "unsolved"). Either rule vetoes the flag; asserting the actual rule
    // here (not the doc's illustrative label) per "run the real path".
    assert.equal(got.familyVeto.rule, 'serious-harm')
  })

  it('bare Group A shapes, tested directly against the detector', () => {
    const cases = [
      ['Support Circle', 'A support group discussing stillbirth and pregnancy loss.'],
      ['Parent Talk', 'A discussion of SIDS risk factors for new parents.'],
      ['Community Panel', 'The documentary examines a case of child abuse and its aftermath.'],
      ['Evening News Special', 'Coverage of a missing child in the area.'],
      ['Panel Discussion', 'A panel on the abduction of a child from a nearby town.'],
      ['Public Health Report', 'The report highlights rising infant mortality rates nationwide.'],
    ]
    for (const [t, d] of cases) {
      const veto = familySafetyVeto(t, d)
      assert.ok(veto, `expected veto for "${t}": "${d}"`)
      assert.equal(veto.rule, 'child-harm', `expected child-harm for "${d}"`)
    }
  })

  it('Group B pair — serious harm + a real-case cue', () => {
    const got = inferCategories(
      'Teen Film Series',
      'the true story of five teenagers wrongfully convicted of a rape',
    )
    assert.equal(got.family, false)
    assert.equal(got.familyVeto?.rule, 'serious-harm')
    assert.equal(got.familyVeto?.suppressed, true)
  })

  it('Group B needs BOTH halves — a dramatic word alone never strips a flag', () => {
    // "murder" with no real-case cue (arrested/convicted/true story/cold
    // case/…) must not veto anything. This is the test that proves it.
    const got = inferCategories('Kids Movie Night', 'a tense drama about a murder')
    assert.equal(got.family, true)
    assert.equal(got.familyVeto, null)
  })
})

// ── C. Structured-signal override — resolveFamilyFacet (the §3a decision) ──

describe('resolveFamilyFacet — a structured source signal does not survive the veto', () => {
  it('a structured true is overridden by a firing veto (library Ages "0-5" hypothetical)', () => {
    assert.equal(resolveFamilyFacet(true, false, { rule: 'child-harm', terms: ['x'] }), false)
  })

  it('a structured true survives when there is no veto (normal library program)', () => {
    assert.equal(resolveFamilyFacet(true, false, null), true)
  })

  it('no source signal: inference alone decides (already veto-safe)', () => {
    assert.equal(resolveFamilyFacet(undefined, true, null), true)
  })

  it('no source signal, inference already false: stays false regardless of veto', () => {
    assert.equal(resolveFamilyFacet(undefined, false, { rule: 'child-harm', terms: ['x'] }), false)
  })

  it('an explicit source false still wins over inference — unchanged behavior', () => {
    assert.equal(resolveFamilyFacet(false, true, null), false)
  })
})

// ── D. Must STAY family — one case per row of the design's §4a table ───────

describe('family safety veto — never fires on named false positives', () => {
  const stayFamily = (title, description = '') => {
    const got = inferCategories(title, description)
    assert.equal(got.familyVeto, null, `expected no veto for "${title}": "${description}"`)
    return got
  }

  it('murder-mystery dinners and Clue-style family game nights', () => {
    let got = stayFamily(
      'Family Game Night: Murder Mystery Edition',
      'a whodunit dinner; the culprit is arrested before dessert',
    )
    assert.equal(got.family, true)
    got = stayFamily('Clue: Family Game Night', 'who killed Mr. Boddy?')
    assert.equal(got.family, true)
    got = stayFamily("Kids' Escape Room: The Case of the Missing Cookies")
    assert.equal(got.family, true)
  })

  it('Halloween / haunted / spooky events', () => {
    for (const [t, d] of [
      ['Haunted Halloween Kids Trail', ''],
      ['Zombie Chase Family Fun Run', ''],
      ['Spooky Storytime', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('CJK / non-Latin text, including 死 ("death") in a film title', () => {
    const got = stayFamily(
      'Kids Film Club: 死神の物語',
      'A screening for children featuring 死 in the title.',
    )
    assert.equal(got.family, true)
  })

  it('true-crime book clubs for teens (genre label, not a depiction)', () => {
    const got = stayFamily(
      'Teen True Crime Book Club',
      'we discuss a different true-crime title each month',
    )
    assert.equal(got.family, true)
  })

  it('grief-support groups genuinely for children', () => {
    for (const [t, d] of [
      ["Kids' Grief Support Group", ''],
      ['Camp Erin: a weekend camp for grieving children', ''],
      ["Kids' Pet Loss Support Group", 'A support circle for children coping with the loss of a pet.'],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('drug/suicide/abuse prevention education aimed at kids', () => {
    for (const [t, d] of [
      ['Teen Vaping Prevention Workshop', ''],
      ['Youth Narcan Training', ''],
      ['Family Fun Night: Hidden in Plain Sight', 'parent education on drug awareness'],
      ['Teen Suicide Prevention Night', ''],
      ['Kids Family Fair: Child Abuse Prevention Month', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('"memorial park" / "Memorial Day" — not remembrance/harm vocabulary', () => {
    for (const [t, d] of [
      ['Family Fun Day: Memorial Day Parade', 'family-friendly celebration'],
      ['Storytime at Memorial Park', ''],
      ['Kids Family Picnic at the Veterans Memorial', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('"loss": weight loss, hearing loss, loss prevention', () => {
    for (const [t, d] of [
      ['Kids Family Weight Loss Challenge', ''],
      ['Loss Prevention Career Fair for Teens', ''],
      ['Hearing Loss Resources for Kids and Families', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('"beat"/figurative "kill" verbs excluded from the A4 verb list', () => {
    for (const [t, d] of [
      ['Beat the Kids at Chess Night', ''],
      ['Kids Bootcamp — we will kill it', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })

  it('prevention/safety programming shaped like the A4 verb pattern', () => {
    for (const [t, d] of [
      ['Drowning Prevention for Kids', ''],
      ['Family Fun Day: fire safety and first aid', ''],
    ]) {
      const got = stayFamily(t, d)
      assert.equal(got.family, true, `expected family for "${t}"`)
    }
  })
})

// ── D2. QA sweep regressions (2026-08-03) — three reproducible false
// positives from PASS-WITH-CONCERNS, plus the duplicate-mention class that
// caused the third one and was never exercised before now (the shipped
// "Child Abuse Prevention Month Family Fair" fixture only had its topic word
// ONCE, with an empty description — see the ordering-defect comment above
// `_HARM_EXCLUSIONS` in category-inference.js for the full mechanism). ─────

describe('family safety veto — QA sweep false positives (2026-08-03)', () => {
  const stayFamily = (title, description = '') => {
    const got = inferCategories(title, description)
    assert.equal(got.familyVeto, null, `expected no veto for "${title}": "${description}"`)
    assert.equal(got.family, true, `expected family=true for "${title}"`)
    return got
  }

  it('QA case 1 — child-abduction safety night (vocabulary gap: abduction)', () => {
    stayFamily(
      'Family Safety Night: Preventing Child Abduction',
      'Parents and kids learn safety tips to help prevent child abduction.',
    )
  })

  it('QA case 2 — missing children awareness fun run (vocabulary gap: missing)', () => {
    stayFamily(
      'Family Fun Run for Missing Children Awareness',
      'A 5K raising funds and awareness for missing children organizations; kids activities included.',
    )
  })

  it('QA case 3 — child abuse awareness walk (regex-ordering defect, topic word in both title and description)', () => {
    stayFamily(
      'Family Fun Day: Child Abuse Awareness Walk',
      'A family walk raising awareness to help prevent child abuse.',
    )
  })

  // The duplicate-mention class: same topic word once in the title and again
  // in the description, both under prevention/awareness framing. Before the
  // tempered-token fix, the exclusion regex's lazy `{0,60}?` bridge could
  // leap over the nearer, correctly-paired occurrence to a farther one,
  // consuming the framing word an orphaned nearer pair needed and leaving it
  // to re-match `_HARM_CHILD`/`_HARM_SERIOUS`. Covering several topics here
  // (not just "abuse") because the defect is in the shared bridging logic,
  // not any one topic word.
  it('duplicate topic mention across title AND description stays clean, per topic', () => {
    const cases = [
      ['Family Fun Day: Child Abuse Awareness Walk', 'A family walk raising awareness to help prevent child abuse.'],
      ['Family Fun Run: Drowning Prevention Awareness', 'Water safety demo to help prevent drowning; kids learn drowning prevention basics.'],
      ['Teen Suicide Prevention Family Fair', 'A family event raising suicide awareness and teaching prevention resources; suicide prevention hotline info provided.'],
      ['Family Fun Day: Missing Children Awareness', 'Fingerprinting and safety tips to help find missing children; a missing children awareness event for the whole family.'],
      ['Family Safety Fair: Child Abduction Awareness', 'Learn prevention tips; a child abduction awareness and prevention workshop for kids and parents.'],
    ]
    for (const [t, d] of cases) stayFamily(t, d)
  })

  // Sanity: duplication alone must not become a blanket amnesty. A REAL case
  // that happens to repeat the harm word twice, with no prevention/awareness
  // framing anywhere, must still veto.
  it('duplicate topic mention with NO framing on either mention still vetoes', () => {
    const got = inferCategories(
      'Kids Documentary Night',
      'The film revisits a case of child abuse; investigators later confirmed the child abuse spanned years.',
    )
    assert.ok(got.familyVeto, 'expected veto to fire')
    assert.equal(got.familyVeto.rule, 'child-harm')
  })
})

// ── E. Corpus regression — the veto is a proven no-op on today's corpus ────

describe('family safety veto — no-op across the existing category-inference corpus', () => {
  for (const [title, desc] of ORACLE) {
    it(`no veto for "${title}"`, () => {
      const got = inferCategories(title, desc)
      assert.equal(got.familyVeto, null, `unexpected veto for "${title}": ${JSON.stringify(got.familyVeto)}`)
    })
  }
})

// ── F. Detector unit tests ───────────────────────────────────────────────────

describe('familySafetyVeto — detector unit tests', () => {
  it('returns null for empty input', () => {
    assert.equal(familySafetyVeto('', ''), null)
    assert.equal(familySafetyVeto(), null)
  })

  it('returns a rule and non-empty terms when it fires', () => {
    const veto = familySafetyVeto('Support Group', 'a program about stillbirth')
    assert.ok(veto)
    assert.equal(typeof veto.rule, 'string')
    assert.ok(Array.isArray(veto.terms) && veto.terms.length > 0)
  })

  it('reporting and suppression are independent: fires with no family signal to suppress', () => {
    // An adults-only true-crime documentary: no family cue anywhere, so
    // inferFacets' `positives` is false and there is nothing to suppress —
    // but the detector still reports the harm text it found.
    const veto = familySafetyVeto('True Crime Documentary', 'the true story of a man convicted of murder')
    assert.ok(veto)

    const got = inferCategories('True Crime Documentary', 'the true story of a man convicted of murder')
    assert.equal(got.family, false)
    assert.ok(got.familyVeto)
    assert.equal(got.familyVeto.suppressed, false)
  })
})
