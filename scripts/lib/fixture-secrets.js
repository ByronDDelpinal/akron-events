/**
 * fixture-secrets.js — provider-shaped credential detection for test fixtures.
 *
 * WHY THIS EXISTS: on 2026-09-12, commit 23e60fe8 added
 * scripts/tests/fixtures/habitat-summit-events-2026-09.html — a page saved
 * verbatim off hfhsummitcounty.org. Their WordPress ECWD plugin loads the
 * Google Maps JS API with a browser key sitting in the query string, so that
 * key rode into a public repo and GitHub secret scanning opened an alert.
 *
 * It was a THIRD PARTY'S public key, not one of ours — nothing of Akron Pulse's
 * was ever exposed — but republishing someone else's credential under our name
 * is not ours to do, and the next fixture might not be so harmless.
 *
 * THE STRUCTURAL PROBLEM: fixtures are raw third-party responses, captured with
 * curl and committed byte for byte. Whatever the origin embeds in its own
 * markup — map keys, signed URLs, analytics tokens — lands in our tree unless
 * something looks first. There is no shared capture helper to hook, and there
 * never will be while agents save fixtures ad hoc, so the check has to live
 * where it cannot be skipped: a test, run by `npm test`, run by CI.
 *
 * scanText() is that check (see scripts/tests/test-fixture-secrets.js).
 * scrubText() is the fix to apply BEFORE saving a new fixture.
 *
 * Scope note: the patterns below are deliberately provider-shaped and
 * high-confidence. A fixture is allowed to contain long opaque strings — cache
 * busters, nonces, WordPress version hashes — and flagging those would train
 * everyone to ignore this test. Add a pattern when a real provider format is
 * missing, not to widen the net for its own sake.
 */

/**
 * Each pattern is anchored on a vendor's documented key prefix and length, so a
 * match is a credential rather than a coincidence. `global` is required —
 * scanText and scrubText both rely on repeated exec/replace.
 */
export const SECRET_PATTERNS = [
  { name: 'GOOGLE_API_KEY', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'GOOGLE_OAUTH_CLIENT_SECRET', re: /GOCSPX-[0-9A-Za-z_-]{28}/g },
  { name: 'AWS_ACCESS_KEY_ID', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: 'GITHUB_TOKEN', re: /gh[pousr]_[0-9A-Za-z]{36,}/g },
  { name: 'SLACK_TOKEN', re: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: 'STRIPE_SECRET_KEY', re: /[rs]k_live_[0-9A-Za-z]{20,}/g },
  { name: 'STRIPE_PUBLISHABLE_KEY', re: /pk_live_[0-9A-Za-z]{20,}/g },
  { name: 'SENDGRID_API_KEY', re: /SG\.[0-9A-Za-z_-]{16,}\.[0-9A-Za-z_-]{16,}/g },
  { name: 'OPENAI_API_KEY', re: /sk-(?:proj-)?[0-9A-Za-z_-]{32,}/g },
  { name: 'ANTHROPIC_API_KEY', re: /sk-ant-[0-9A-Za-z_-]{32,}/g },
  { name: 'SUPABASE_OR_JWT', re: /eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g },
  { name: 'MAPBOX_TOKEN', re: /pk\.eyJ[0-9A-Za-z_-]{20,}/g },
  { name: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
]

/**
 * Never echo a live credential into a CI log or an assertion message — that
 * just moves the leak somewhere with a longer retention policy. Four characters
 * at each end is enough for a human to find the string in the file.
 */
export function maskSecret(value) {
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * @returns {Array<{ name: string, line: number, masked: string }>} one entry per
 * occurrence, in file order. Empty array means clean.
 */
export function scanText(text) {
  const findings = []
  for (const { name, re } of SECRET_PATTERNS) {
    // Fresh lastIndex per call: the exported regexes are shared and /g is stateful.
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      findings.push({
        name,
        line: text.slice(0, m.index).split('\n').length,
        masked: maskSecret(m[0]),
      })
      if (m[0].length === 0) re.lastIndex++
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

/**
 * Replace every detected credential with a stable, inert placeholder. The
 * placeholder deliberately does NOT match any pattern above, so a scrubbed
 * fixture stays clean and the shape of the surrounding markup is preserved.
 */
export function scrubText(text) {
  let out = text
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, `REDACTED-THIRD-PARTY-${name.replace(/_/g, '-')}`)
  }
  return out
}
