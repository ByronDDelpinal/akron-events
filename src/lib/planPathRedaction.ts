/**
 * planPathRedaction.ts
 *
 * The day-plan-code-in-analytics redaction, pulled into its own
 * zero-local-import module so it's independently unit-testable via
 * `node --test` (scripts/tests/test-day-plan-lib.js) without loading
 * analytics.ts's whole graph (react-ga4, myHub.ts, themes.ts — none of
 * which are relevant to this pure string function, and several of which
 * use extensionless local imports that only Vite's bundler resolution, not
 * Node's native type-stripping loader, can follow).
 *
 * analytics.ts's trackPageView is the ONLY caller that matters: it applies
 * this before any GA4 call, so no route-change call site (App.tsx) can ever
 * bypass it by passing a raw, unredacted path.
 */

/**
 * Matches ANY path beginning with `/d/` — a PREFIX match, deliberately not
 * anchored to the exact 12-char Crockford-base32 shape the `code` CHECK
 * constraint in migration 052 enforces (`^[0-9a-hjkmnp-tv-z]{12}$`).
 *
 * QA (2026-08-08) found the previous exact-match, `$`-anchored regex leaked
 * the full code on every one of these shapes, because each fails an EXACT
 * match while still being a live day-plan URL (or close enough that treating
 * it as one is the only safe call):
 *   - `/d/<code>/anything` — React Router only matches `/d/:code` as an
 *     exact single segment, so a fat-fingered trailing segment, a chat
 *     client's autolinker grabbing trailing text, or a stray trailing slash
 *     typo renders the catch-all NotFound route but the raw path still
 *     reaches `trackPageView`.
 *   - uppercase codes, a 13-char (or any wrong-length) code, `/d//<code>`
 *     (double slash), and leading/trailing whitespace.
 *
 * There are NO nested routes under `/d/<code>` by design (§6.5 of the day
 * planner design), so there is no legitimate path that starts with `/d/` and
 * is NOT a plan link. Over-redacting a path that merely LOOKS like a plan
 * link (e.g. a malformed one) is free; under-redacting a real one hands out
 * a live bearer credential. Do not tighten this back to an exact-shape
 * match — that is precisely the bug this comment documents.
 */
const PLAN_PATH_PREFIX_RE = /^\/d\//i

/**
 * Redact a plan's bearer code out of a path before it can reach GA4.
 *
 * THE PLAN CODE IS A BEARER CREDENTIAL, NOT PII — anyone who has it can
 * read and edit that plan (see migration 052's header). Sending
 * `/d/7k3m9qx2vbn4` to a third party (Google Analytics) as `page_path`
 * would be strictly worse than a PII leak: it hands the reader a live,
 * unrevocable key.
 *
 * On a match the ENTIRE path is replaced with the literal `/d/(code)` — no
 * suffix (query, fragment, trailing segment) is ever preserved, because any
 * of those could themselves be, or contain, the code.
 */
export function redactPath(path: string): string {
  // Leading/trailing whitespace is itself a bypass shape QA found (it
  // defeats a `^`/`$`-anchored regex without defeating the route or the
  // browser's URL bar). Trim before anything else.
  const trimmed = path.trim()
  const pathname = trimmed.split('?')[0].split('#')[0]
  return PLAN_PATH_PREFIX_RE.test(pathname) ? '/d/(code)' : path
}
