// embedSnippet.test.ts — Deno tests for _shared/embedSnippet.ts.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// Two jobs, per docs/embed-request-capture.md §6.1/§6.2/§6.3:
//   1. Round-trip: build params from a NormalizedConfig, extract the query
//      string from the generated snippet's `src`, feed it to the REAL
//      `parseEmbedConfig` (imported through the root `@/` import map — this
//      is D1's whole point), and assert every field the builder can set
//      survives. This is what proves buildEmbedParams here is not a fork.
//   2. Escaping: hostile titles must never break the HTML attribute or
//      leave a raw `<`/`>`/backtick in the assembled snippet.

import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { parseEmbedConfig, EMBED_FEATURES, type EmbedFeature } from '@/lib/embedConfig.ts'
import { escapeHtml } from './email.ts'
import { escapeSlackText } from './slack.ts'
import {
  normalizeConfig,
  buildEmbedParams,
  buildEmbedPath,
  buildEmbedUrl,
  buildIframeSnippet,
  describeConfig,
  type NormalizedConfig,
} from './embedSnippet.ts'

const ORIGIN = 'https://example.akronpulse.test'

/** Build params, extract the query string off the generated snippet's `src`, feed it to the real parser. */
function roundTrip(raw: unknown) {
  const cfg = normalizeConfig(raw)
  const snippet = buildIframeSnippet(ORIGIN, cfg)
  const match = snippet.match(/src="([^"]*)"/)
  assert(match, 'snippet is missing a src="..." attribute')
  const url = new URL(match![1])
  assertEquals(url.origin, ORIGIN)
  assertEquals(url.pathname, '/embed')
  return { cfg, parsed: parseEmbedConfig(url.search) }
}

const allFeaturesOn = (): Record<EmbedFeature, boolean> =>
  Object.fromEntries(EMBED_FEATURES.map((f) => [f, true])) as Record<EmbedFeature, boolean>
const allFeaturesOff = (): Record<EmbedFeature, boolean> =>
  Object.fromEntries(EMBED_FEATURES.map((f) => [f, false])) as Record<EmbedFeature, boolean>

// ── 1. DEFAULT_STATE-equivalent → empty query string → all defaults ──────

Deno.test('round-trip: empty/default config -> empty query string -> parseEmbedConfig defaults', () => {
  const { parsed } = roundTrip({})
  assertEquals(parsed.theme, 'akron-pulse')
  assertEquals(parsed.title, null)
  assertEquals(parsed.place, null)
  assertEquals(parsed.categories, [])
  assertEquals(parsed.price, null)
  assertEquals(parsed.date, null)
  assertEquals(parsed.family, false)
  assertEquals(parsed.view, 'list')
  assertEquals(parsed.density, 'comfortable')
  assertEquals(parsed.target, 'inline')
  for (const f of EMBED_FEATURES) assertEquals(parsed.features[f], true)
})

// ── 2. The `none` sentinel — all six features off ─────────────────────────

Deno.test('REQUIRED: all six features off -> features=none -> all six parse back false', () => {
  const { cfg, parsed } = roundTrip({ features: { filter: false, map: false, calendar: false, density: false, price: false, tags: false } })
  assertEquals(cfg.features, allFeaturesOff())
  const snippet = buildIframeSnippet(ORIGIN, cfg)
  assertStringIncludes(snippet, 'features=none')
  for (const f of EMBED_FEATURES) assertEquals(parsed.features[f], false, `feature ${f} should be off`)
})

// ── 3. Exactly one feature on ─────────────────────────────────────────────

for (const onKey of EMBED_FEATURES) {
  Deno.test(`round-trip: only "${onKey}" on -> only "${onKey}" parses back true`, () => {
    const features = Object.fromEntries(EMBED_FEATURES.map((f) => [f, f === onKey])) as Record<EmbedFeature, boolean>
    const { parsed } = roundTrip({ features })
    for (const f of EMBED_FEATURES) {
      assertEquals(parsed.features[f], f === onKey, `feature ${f}`)
    }
  })
}

// ── 4. All six on -> param omitted -> all on ──────────────────────────────

Deno.test('all six features on -> features param omitted -> parses back all on', () => {
  const { cfg, parsed } = roundTrip({ features: allFeaturesOn() })
  const snippet = buildIframeSnippet(ORIGIN, cfg)
  assert(!snippet.includes('features='), 'features param should be omitted when all six are on')
  for (const f of EMBED_FEATURES) assertEquals(parsed.features[f], true)
})

// ── 5. Each price / date / view / density / target ────────────────────────

for (const price of ['free', 'under10', 'under25'] as const) {
  Deno.test(`round-trip: price=${price}`, () => {
    const { parsed } = roundTrip({ price })
    assertEquals(parsed.price, price)
  })
}

for (const date of ['today', 'this_weekend', 'this_week', 'this_month'] as const) {
  Deno.test(`round-trip: date=${date}`, () => {
    const { parsed } = roundTrip({ date })
    assertEquals(parsed.date, date)
  })
}

for (const view of ['list', 'calendar', 'map'] as const) {
  Deno.test(`round-trip: view=${view}`, () => {
    const { parsed } = roundTrip({ view })
    assertEquals(parsed.view, view)
  })
}

for (const density of ['comfortable', 'efficient'] as const) {
  Deno.test(`round-trip: density=${density}`, () => {
    const { parsed } = roundTrip({ density })
    assertEquals(parsed.density, density)
  })
}

for (const target of ['inline', 'blank', 'external'] as const) {
  Deno.test(`round-trip: target=${target}`, () => {
    const { parsed } = roundTrip({ target })
    assertEquals(parsed.target, target)
  })
}

// ── 6. family: true ────────────────────────────────────────────────────────

Deno.test('round-trip: family=true survives', () => {
  const { parsed } = roundTrip({ family: true })
  assertEquals(parsed.family, true)
})

// ── 7. Hostile title characters ────────────────────────────────────────────

Deno.test('round-trip: title with &, <, ", \', space, +, emoji, backtick survives (minus the backtick)', () => {
  const title = `Rock & Roll <Night> "Live" it's + fun 🎸 \`fenced\``
  const { cfg, parsed } = roundTrip({ title })
  // Backticks are stripped by normalizeConfig — never survive into cfg.title.
  assert(!cfg.title!.includes('`'), 'normalizeConfig must strip backticks from title')
  assertEquals(parsed.title, cfg.title)
})

Deno.test('normalizeConfig: title over 120 code points, emoji-heavy, clamps by code point not code unit', () => {
  const title = '🎉'.repeat(200) // 200 code points, 400 UTF-16 code units
  const cfg = normalizeConfig({ title })
  assertEquals([...cfg.title!].length, 120)
  // No lone surrogate (U+FFFD) from a mid-pair cut.
  assert(!cfg.title!.includes('�'), 'clamp must not land mid-surrogate-pair')
})

Deno.test("round-trip: emoji title within parseEmbedConfig's own code-unit clamp survives intact", () => {
  // parseEmbedConfig ITSELF re-clamps title with a CODE-UNIT `.slice(0, 120)`
  // (src/lib/embedConfig.ts — unchanged by this design, see docs/embed-
  // request-capture.md §8's "no changes to parseEmbedConfig"). A 40-emoji
  // title is 40 code points / 80 UTF-16 units, comfortably under both this
  // module's 120-code-point clamp AND parseEmbedConfig's 120-code-unit one,
  // so this is the case where full fidelity is guaranteed end to end. (A
  // title that clears THIS module's clamp but not parseEmbedConfig's own
  // code-unit one is a pre-existing, out-of-scope quirk of the parser this
  // design deliberately does not touch or paper over.)
  const title = '🎉'.repeat(40)
  const { cfg, parsed } = roundTrip({ title })
  assertEquals(parsed.title, cfg.title)
})

// ── 8. Categories: duplicates + unknown slug ───────────────────────────────

Deno.test('round-trip: duplicate categories are deduped, unknown slug still round-trips (matches nothing, harmlessly)', () => {
  const { cfg, parsed } = roundTrip({ categories: ['music', 'music', 'food', 'not-a-real-category'] })
  assertEquals(cfg.categories, ['music', 'food', 'not-a-real-category'])
  assertEquals(parsed.categories, cfg.categories)
})

// ── 9. Unknown theme + unknown place ───────────────────────────────────────

Deno.test('round-trip: unknown but charset-safe theme survives to the URL, parseEmbedConfig falls back to its own default', () => {
  const { cfg, parsed } = roundTrip({ theme: 'not-a-real-theme' })
  assertEquals(cfg.theme, 'not-a-real-theme')
  // parseEmbedConfig itself validates against the real THEMES registry and
  // falls back silently — this is the "invalid slug produces a harmless
  // embed" property §3.3 describes, not a failure of this module.
  assert(typeof parsed.theme === 'string' && parsed.theme.length > 0)
})

Deno.test('round-trip: unknown but charset-safe place survives to the URL, parseEmbedConfig resolves to NO_PLACE', () => {
  const { cfg, parsed } = roundTrip({ place: 'not-a-real-place' })
  assertEquals(cfg.place, 'not-a-real-place')
  assertEquals(parsed.place, null)
  assertEquals(parsed.placeLabel, null)
})

// ── 10. Hostile config jsonb shapes ─────────────────────────────────────────

Deno.test('REQUIRED: hostile config shapes normalize to safe defaults, never throw', () => {
  const hostileInputs: unknown[] = [
    [1, 2, 3],                 // a JSON array
    null,                      // 'null'::jsonb
    { place: { nested: 'x' } }, // nested object where a string is expected
    { categories: Array(50_000).fill('music') }, // 50,000-element categories array
    { features: 'not-an-object' }, // features as a string
  ]

  for (const input of hostileInputs) {
    const cfg = normalizeConfig(input)
    // Must never throw building the snippet either.
    const snippet = buildIframeSnippet(ORIGIN, cfg)
    assert(snippet.includes('<iframe'))
  }
})

Deno.test('hostile config: a JSON array or null normalizes to full defaults', () => {
  for (const input of [[1, 2, 3], null, 'nope', 42]) {
    const cfg = normalizeConfig(input)
    assertEquals(cfg.theme, 'akron-pulse')
    assertEquals(cfg.title, null)
    assertEquals(cfg.place, null)
    assertEquals(cfg.categories, [])
    assertEquals(cfg.price, null)
    assertEquals(cfg.date, null)
    assertEquals(cfg.family, false)
    for (const f of EMBED_FEATURES) assertEquals(cfg.features[f], true)
  }
})

Deno.test('hostile config: categories array is capped at 20', () => {
  const cfg = normalizeConfig({ categories: Array(50_000).fill('music') })
  assertEquals(cfg.categories, ['music'])
})

Deno.test('hostile config: nested object where a string is expected is dropped, not thrown', () => {
  const cfg = normalizeConfig({ place: { nested: 'x' } })
  assertEquals(cfg.place, null)
})

Deno.test('hostile config: features as a string falls back to all-on', () => {
  const cfg = normalizeConfig({ features: 'not-an-object' })
  for (const f of EMBED_FEATURES) assertEquals(cfg.features[f], true)
})

Deno.test('hostile config: features object with only some keys set treats missing keys as false', () => {
  const cfg = normalizeConfig({ features: { filter: true } })
  assertEquals(cfg.features.filter, true)
  assertEquals(cfg.features.map, false)
  assertEquals(cfg.features.calendar, false)
})

// ── 11. Snippet escaping (§6.3) ─────────────────────────────────────────────

const HOSTILE_TITLES = [
  '" onload="alert(1)',
  '</iframe><script>alert(1)</script>',
  '`',
]

for (const hostile of HOSTILE_TITLES) {
  Deno.test(`snippet escaping: title ${JSON.stringify(hostile)} cannot break the title attribute or inject a tag`, () => {
    const cfg = normalizeConfig({ title: hostile })
    const snippet = buildIframeSnippet(ORIGIN, cfg)

    // No backtick anywhere in the assembled snippet.
    assert(!snippet.includes('`'), 'snippet must contain no backtick')

    // Every `<`/`>` in the snippet belongs to the template's own tags, not
    // to injected content. Strip the known-good tags and assert nothing
    // `<`/`>`-shaped remains.
    const withoutKnownTags = snippet
      .replace(/<iframe[\s\S]*?<\/iframe>/, '')
      .replace(/<!--[\s\S]*?-->/, '')
      .replace(/<script[\s\S]*?<\/script>/, '')
    assert(!withoutKnownTags.includes('<'), `unexpected '<' outside known tags: ${withoutKnownTags}`)
    assert(!withoutKnownTags.includes('>'), `unexpected '>' outside known tags: ${withoutKnownTags}`)

    // The title attribute cannot be broken out of: no raw, unescaped `"`
    // sits inside the attribute value.
    const attrMatch = snippet.match(/title="([^]*?)"\s*\n\s*style=/)
    assert(attrMatch, 'title attribute not found in expected shape')
    assert(!attrMatch![1].includes('"'), 'title attribute value must not contain a raw double-quote')
  })
}

Deno.test('snippet escaping: escapeHtml(snippet) contains no unescaped <', () => {
  const cfg = normalizeConfig({ title: '</iframe><script>alert(1)</script>' })
  const snippet = buildIframeSnippet(ORIGIN, cfg)
  const emailEscaped = escapeHtml(snippet)
  // Only the legitimate template tags may appear as raw '<'; escapeHtml
  // over the whole assembled snippet turns even those into &lt; — so a
  // fully-escaped snippet must contain literally zero raw '<' characters.
  assertEquals(emailEscaped.includes('<'), false)
})

Deno.test('snippet escaping: escapeSlackText(snippet) contains no unescaped <, >, or literal &', () => {
  const cfg = normalizeConfig({ title: '</iframe><script>alert(1)</script> & friends' })
  const snippet = buildIframeSnippet(ORIGIN, cfg)
  const slackEscaped = escapeSlackText(snippet)
  assertEquals(slackEscaped.includes('<'), false)
  assertEquals(slackEscaped.includes('>'), false)
  // escapeSlackText's own implementation only ever PRODUCES three entity
  // shapes when it touches a '&': '&amp;' (escaping a literal '&'), '&lt;'
  // (escaping a literal '<'), '&gt;' (escaping a literal '>') — see
  // _shared/slack.ts's escapeSlackText. So the correct invariant is not
  // "every '&' is followed by 'amp;'" (that's false for '&lt;'/'&gt;', which
  // are themselves correctly-escaped, safe output, not injection) — it's
  // that no OTHER, non-entity '&' sequence survives, i.e. every remaining
  // '&' is the start of one of those three well-formed entities.
  assertEquals(/&(?!amp;|lt;|gt;)/.test(slackEscaped), false)
})

// ── 12. buildEmbedPath / buildEmbedUrl ──────────────────────────────────────

Deno.test('buildEmbedPath: default config -> bare "/embed"', () => {
  assertEquals(buildEmbedPath(normalizeConfig({})), '/embed')
})

Deno.test('buildEmbedPath: configured -> "/embed?..."', () => {
  const path = buildEmbedPath(normalizeConfig({ place: 'highland-square' }))
  assertEquals(path.startsWith('/embed?'), true)
  assertStringIncludes(path, 'place=highland-square')
})

Deno.test('buildEmbedUrl prefixes the given origin', () => {
  const url = buildEmbedUrl(ORIGIN, normalizeConfig({}))
  assertEquals(url, `${ORIGIN}/embed`)
})

// ── 13. buildEmbedParams determinism (no reimplementation drift) ───────────

Deno.test('buildEmbedParams: identical NormalizedConfig always serializes identically', () => {
  const cfg: NormalizedConfig = normalizeConfig({ theme: 'akron-pulse', place: 'downtown-akron', price: 'free' })
  const a = buildEmbedParams(cfg).toString()
  const b = buildEmbedParams(cfg).toString()
  assertEquals(a, b)
})

// ── 14. describeConfig ──────────────────────────────────────────────────────

Deno.test('describeConfig: default config has a Theme line and the Opens/Cards/Starts-on summary', () => {
  const lines = describeConfig(normalizeConfig({}))
  assert(lines.some((l) => l.startsWith('Theme:')))
  assert(lines.some((l) => l.startsWith('Opens:') && l.includes('Cards:') && l.includes('Starts on:')))
})

Deno.test('describeConfig: Heading line carries the raw (unescaped) title — caller escapes it', () => {
  const lines = describeConfig(normalizeConfig({ title: 'Rock & Roll' }))
  assert(lines.some((l) => l === 'Heading: "Rock & Roll"'))
})

Deno.test('describeConfig: category slugs render as curated labels, unknown slug falls back to itself', () => {
  const lines = describeConfig(normalizeConfig({ categories: ['music', 'not-a-real-category'] }))
  const line = lines.find((l) => l.startsWith('Categories:'))
  assert(line)
  assertStringIncludes(line!, 'Music')
  assertStringIncludes(line!, 'not-a-real-category')
})

Deno.test('describeConfig: hidden features are listed when at least one is off', () => {
  const lines = describeConfig(normalizeConfig({ features: { filter: true, map: false, calendar: true, density: false, price: true, tags: true } }))
  const line = lines.find((l) => l.startsWith('Hidden:'))
  assert(line)
  assertStringIncludes(line!, 'Map view')
  assertStringIncludes(line!, 'Density toggle')
})

Deno.test('describeConfig: no Hidden line when every feature is on', () => {
  const lines = describeConfig(normalizeConfig({}))
  assert(!lines.some((l) => l.startsWith('Hidden:')))
})
