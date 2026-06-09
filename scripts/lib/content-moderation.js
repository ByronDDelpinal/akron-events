/**
 * content-moderation.js
 *
 * Server-side content screening for incoming events. Scans event text against
 * the flagged-terms blocklist and decides whether an event should be held for
 * human review (or rejected) instead of published.
 *
 * ⚠️ SERVER ONLY. Never import this from client code under `src/`. The term
 * list must not ship to the browser — both to keep the bundle clean and so bad
 * actors can't read the list to route around it. Vite only bundles modules
 * reachable from the client entry, so keeping this in `scripts/lib` and out of
 * `src/` is what keeps it off the front end.
 *
 * Term source: the blocklist lives ONLY in the `MODERATION_TERMS_B64`
 * environment variable (base64-encoded JSON). It is never committed to the repo.
 * Set it locally in `.env` (gitignored) and in Vercel / Supabase secrets / CI.
 * Use `scripts/encode-moderation-terms.js` to (re)generate the value from a
 * local JSON file. If the variable is unset, screening is skipped (fail-open) so
 * ingestion never breaks — but a warning is logged so the misconfig is visible.
 *
 * Matching is normalization-aware (diacritics, leetspeak, repeated letters,
 * letter-spacing evasion) and uses word boundaries + an allowlist to avoid the
 * "Scunthorpe problem" (flagging legitimate words/names that merely contain a
 * banned substring — e.g. the Nutcracker, Negro Leagues, John Lee Hooker).
 */

// Severity → resulting event `status`. Both non-published values are hidden from
// the public site by RLS (only status='published' is publicly readable), so a
// flagged event is never exposed while it waits for a human.
export const STATUS_BY_SEVERITY = {
  extreme: 'cancelled',        // auto-reject + escalate; never published
  high: 'pending_review',      // hold for human review
  contextual: 'pending_review',
}

const SEVERITY_RANK = { contextual: 1, high: 2, extreme: 3 }

// Leetspeak → letter. Applied in a second matching pass so disguised words are
// caught without breaking purely-numeric terms (e.g. "1488") in the first pass.
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' }
const LEET_RE = /[013457@$!]/g

// Detects "spaced-out" letters used to dodge word matching: f.a.g, n i g g e r.
const LETTER_SPACING_RE = /(?:[a-z0-9][\s._*-]){2,}[a-z0-9]/

let _config = null

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build a matcher for a term. Sub-words are joined with an optional-separator
 * class so "blow job" also catches "blowjob"/"blow-job", and the whole thing is
 * bounded by non-alphanumeric lookarounds so "cracker" never fires inside
 * "Nutcracker" and "cunt" never fires inside "Scunthorpe".
 */
function buildTermRegex(term) {
  const parts = term.split(/[^a-z0-9]+/i).filter(Boolean).map(escapeRegExp)
  if (!parts.length) return null
  const body = parts.join('[\\s._*-]*')
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i')
}

/**
 * Lowercase, strip diacritics, optionally de-leet and/or collapse 3+ repeats,
 * and normalize whitespace. Repeat-collapse is opt-in because it must NOT be the
 * only variant we match against: collapsing turns "kkk" into "k". Callers match
 * against both the collapsed and non-collapsed forms (see scanText).
 */
export function normalizeText(text, { deLeet = false, collapseRepeats = false } = {}) {
  let s = String(text ?? '').toLowerCase()
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip diacritics
  if (deLeet) s = s.replace(LEET_RE, (c) => LEET[c] ?? c)
  if (collapseRepeats) s = s.replace(/(.)\1{2,}/g, '$1')   // fuuuuck -> fuck
  return s.replace(/\s+/g, ' ').trim()
}

/** Compile the raw JSON into matchers + lookup structures (cached). */
function compileConfig(json) {
  const byTerm = new Map() // term -> { term, category, severity }
  for (const cat of json.categories ?? []) {
    for (const raw of cat.terms ?? []) {
      const term = String(raw).toLowerCase().trim()
      if (!term) continue
      const existing = byTerm.get(term)
      // Keep the highest-severity classification if a term appears twice.
      if (!existing || SEVERITY_RANK[cat.severity] > SEVERITY_RANK[existing.severity]) {
        byTerm.set(term, { term, category: cat.id, severity: cat.severity })
      }
    }
  }

  const terms = []
  for (const t of byTerm.values()) {
    const regex = buildTermRegex(t.term)
    if (regex) terms.push({ ...t, regex })
  }

  // Evasion pass only runs on single-word, longer, high/extreme slurs — short
  // terms in a separator-stripped string are too false-positive-prone.
  const evasionTerms = terms.filter(
    (t) => (t.severity === 'high' || t.severity === 'extreme')
      && /^[a-z0-9]+$/.test(t.term)
      && t.term.length >= 5,
  )

  const allowlist = (json.allowlist?.phrases ?? [])
    .map((p) => normalizeText(p))
    .filter(Boolean)

  return { terms, evasionTerms, allowlist, version: json.version }
}

/** Error thrown when the term list env var is missing or unparseable. */
export class ModerationConfigError extends Error {}

/**
 * Load + compile the moderation config from MODERATION_TERMS_B64. Cached after
 * first successful call. Throws ModerationConfigError if the variable is unset
 * or invalid — callers (screenEvent via upsertEventSafe) catch this and fail
 * open so a misconfiguration never blocks ingestion.
 * @param {{force?: boolean}} [opts] - force a reload (e.g. after rotating terms).
 */
export function loadModerationConfig({ force = false } = {}) {
  if (_config && !force) return _config
  const b64 = process.env.MODERATION_TERMS_B64
  if (!b64) {
    throw new ModerationConfigError(
      'MODERATION_TERMS_B64 is not set — content moderation cannot run. ' +
      'Generate it with `node scripts/encode-moderation-terms.js` and set it in your environment.',
    )
  }
  let json
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
  } catch (err) {
    throw new ModerationConfigError(`MODERATION_TERMS_B64 is not valid base64 JSON: ${err.message}`)
  }
  _config = compileConfig(json)
  return _config
}

/** True if `term` only appears inside an allowlisted phrase present in `text`. */
function isAllowed(term, normText, allowlist) {
  for (const phrase of allowlist) {
    if (phrase.includes(term) && normText.includes(phrase)) return true
  }
  return false
}

/**
 * Scan a block of text. Returns an array of { term, category, severity, evasion }.
 * Empty array means clean.
 */
export function scanText(text) {
  const cfg = loadModerationConfig()
  const base = normalizeText(text)
  if (!base) return []
  // Match against four variants so we catch leetspeak ("n1gg3r") AND
  // repeat-padding ("fuuuuck") without losing legitimately-tripled terms ("kkk").
  const variants = [
    base,
    normalizeText(text, { collapseRepeats: true }),
    normalizeText(text, { deLeet: true }),
    normalizeText(text, { deLeet: true, collapseRepeats: true }),
  ]

  const hits = new Map()
  for (const t of cfg.terms) {
    if (variants.some((v) => t.regex.test(v)) && !isAllowed(t.term, base, cfg.allowlist)) {
      if (!hits.has(t.term)) hits.set(t.term, { term: t.term, category: t.category, severity: t.severity, evasion: false })
    }
  }

  // Letter-spacing evasion: only when the text actually looks spaced-out.
  if (LETTER_SPACING_RE.test(base)) {
    const condensed = normalizeText(text, { deLeet: true }).replace(/[^a-z0-9]/g, '')
    for (const t of cfg.evasionTerms) {
      if (condensed.includes(t.term) && !hits.has(t.term)) {
        hits.set(t.term, { term: t.term, category: t.category, severity: t.severity, evasion: true })
      }
    }
  }

  return [...hits.values()]
}

/**
 * Screen an event row. Scans title, description, tags, organizer and venue
 * names. Returns:
 *   { flagged, matches, severity, status }
 * where `status` is the recommended event status ('pending_review' | 'cancelled')
 * or null when clean.
 */
let _warnedNoConfig = false

export function screenEvent(row = {}) {
  const tags = Array.isArray(row.tags) ? row.tags.join(' ') : row.tags
  const text = [row.title, row.description, tags, row.organizer_name, row.venue_name]
    .filter(Boolean)
    .join('\n')

  let matches
  try {
    matches = scanText(text)
  } catch (err) {
    // Missing/invalid term list: fail open (don't block ingestion), warn once.
    if (err instanceof ModerationConfigError) {
      if (!_warnedNoConfig) {
        console.warn(`  ⚠ content moderation disabled: ${err.message}`)
        _warnedNoConfig = true
      }
      return { flagged: false, matches: [], severity: null, status: null }
    }
    throw err
  }
  if (!matches.length) return { flagged: false, matches: [], severity: null, status: null }

  let severity = 'contextual'
  for (const m of matches) {
    if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[severity]) severity = m.severity
  }
  return { flagged: true, matches, severity, status: STATUS_BY_SEVERITY[severity] }
}
