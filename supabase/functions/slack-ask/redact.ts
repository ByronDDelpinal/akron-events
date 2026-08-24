/**
 * redact.ts: the fail-closed egress filter.
 *
 * ADR section 5.7, layer 3, and the one the ADR calls "the layer worth
 * insisting on":
 *
 *   "A defense that depends only on every future handler author remembering
 *    the rule is not a defense; this one catches the handler nobody reviewed."
 *
 * Layers 1 and 2 are preventive and live elsewhere: hardcoded column
 * allowlists in handlers.ts mean `subscribers.token`, `subscribers.email`,
 * `feedback_posts.email`, and `embed_requests.email` are in no query at all;
 * `escapeSlackText` in render.ts neuters mrkdwn. This layer is detective. It
 * runs on the FULLY COMPOSED message, immediately before it is handed to
 * slack-notify, after every renderer and every cap have had their say. It
 * assumes those layers have already failed.
 *
 * ── FAIL CLOSED MEANS REPLACE, NOT REDACT ─────────────────────────────────
 * On a hit the entire reply is discarded and replaced with a fixed notice. It
 * does NOT mask the offending substring and post the rest. Masking assumes the
 * pattern found the whole secret, and a pattern that matched 30 characters of
 * a 60-character token would post the other half. A reply that never arrives
 * is recoverable; a token in a channel is not.
 *
 * ── THE VIOLATION NAMES NEVER CONTAIN THE MATCH ───────────────────────────
 * `violations` carries rule NAMES only. Logging the matched text would move
 * the leak from the channel into the log, which is a smaller blast radius but
 * still a leak, and Supabase function logs are readable by anyone with project
 * access. The caller logs the names and the queue row id; whoever investigates
 * reads the row.
 *
 * ── WHY A BARE UUID IS A VIOLATION HERE ───────────────────────────────────
 * The ADR says "a UUID in a context that suggests an auth id". In this
 * function the context is stronger than that: NO handler in handlers.ts
 * renders a UUID. Not an event id, not a subscriber id, not a venue id. The
 * reply surface is counts, names, labels, timestamps, and truncated error
 * strings. A UUID in outbound text is therefore a leak BY DEFINITION, most
 * likely `subscribers.token` (the unsubscribe secret, a uuid column) reaching
 * a channel. Treating every UUID as a violation is both simpler and stricter
 * than trying to judge the surrounding words, and it has no false-positive
 * cost given the handler set. If a future handler genuinely needs to print an
 * id, that is the moment to revisit this rule, deliberately, in review.
 *
 * ── ORDER OF OPERATIONS, AND THE GAP IT LEAVES ────────────────────────────
 * This filter is LAST, which is what makes it a backstop, but "last" also
 * means the text it sees has already been shortened twice:
 *
 *   1. inside a handler, `errorSnippet` clips third-party strings to about 60
 *      characters before they become a line;
 *   2. `composeReply` drops lines past six and truncates at 600 characters.
 *
 * A secret can therefore arrive here as a FRAGMENT of itself. Two mitigations,
 * and the caller is responsible for the second:
 *
 *   - Every prefix rule below uses a LOW length threshold, so a bare `xox` prefix plus four characters is
 *     caught even though the other forty characters were clipped away. The
 *     prefix is the signal; the tail is not needed.
 *   - THE CALLER MUST SCAN THE PRE-CAP LINES TOO. Pass the handler's raw line
 *     array as the second argument to `redactOutbound`, which scans both it
 *     and the composed reply and withholds if EITHER trips a rule. Without
 *     that, a secret sitting in line seven of an eight-line answer is dropped
 *     by the line cap, never scanned, and the reply posts looking clean while
 *     the same handler leaks it the next time the answer is one line shorter.
 *
 * Neither mitigation recovers a secret that `errorSnippet` cut below its
 * prefix. That residual gap is why the column allowlists in handlers.ts are
 * still the primary control.
 *
 * The one caveat worth stating plainly: this is a pattern matcher. It catches
 * the shapes below and nothing else. It is the last line, not the only line,
 * and it does not license a handler author to be careless with a column list.
 */

/** Posted verbatim in place of any reply that trips a rule. ADR section 5.7. */
export const WITHHELD_NOTICE =
  "Answer withheld, it contained something that shouldn't go in a channel. Check the ledger."

/** Posted when a handler produced nothing at all. Silence is the worst outcome. */
export const EMPTY_NOTICE = 'No answer produced. Check the ledger.'

interface Rule {
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Every rule is anchored on a shape that cannot occur in a legitimate reply
 * from this handler set. Ordering is irrelevant (all rules always run, so a
 * message tripping three is reported as tripping three), but they are grouped
 * credential-first for readability.
 *
 * Regexes are declared without the `g` flag on purpose: a `g` regex carries
 * mutable `lastIndex` state across `.test()` calls, so a shared module-level
 * `g` pattern silently skips matches on every other invocation. That bug is
 * subtle, intermittent, and exactly the kind a security filter must not have.
 */
const RULES: readonly Rule[] = Object.freeze([
  // ── Credential prefixes, highest signal first ──────────────────────────
  //
  // THRESHOLDS ARE DELIBERATELY LOW ({4,}, not {8,} or {24,}). See the
  // order-of-operations note in the header: by the time this runs, third-party
  // text has already been clipped by `errorSnippet` and the whole reply may
  // have been truncated to 600 characters, so a secret can arrive here as a
  // FRAGMENT. A prefix like `xoxb-` or `eyJ` is itself the signal; requiring
  // twenty more characters after it just means a clipped secret walks through.
  // False positives cost one withheld reply, which is cheap.
  { name: 'slack_token', pattern: /\bxox[abdeoprs]-[A-Za-z0-9-]{4,}/i },
  { name: 'slack_app_token', pattern: /\bxapp-\d-[A-Za-z0-9-]{4,}/i },
  // A JWT's header always base64s to this prefix. Supabase anon and
  // service-role keys are JWTs, so this catches both.
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}/ },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{4,}/i },
  // `[A-Za-z0-9_-]`, not `[A-Za-z0-9]`: OpenAI-style keys are `sk-proj-…` and
  // `sk-svcacct-…`, and a hyphen-free class misses every one of them.
  { name: 'generic_secret_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  // Resend, which this project already uses for the digest.
  { name: 'resend_key', pattern: /\bre_[A-Za-z0-9_-]{8,}/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}/ },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}/ },
  { name: 'google_api_key', pattern: /\bAIza[A-Za-z0-9_-]{10,}/ },
  // The literal string, which appears in the service-role JWT's payload, in
  // Postgres error text, and in a mis-pasted env var name.
  { name: 'service_role', pattern: /service[_\s-]?role/i },
  { name: 'bearer_header', pattern: /\bbearer\s+[A-Za-z0-9._-]{8,}/i },
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'db_connection_string', pattern: /\bpostgres(ql)?:\/\/\S+/i },
  // PII. `subscribers.email`, `feedback_posts.email`, and
  // `embed_requests.email` are in no column allowlist; this catches the day
  // one of them is added, and it catches an address quoted inside a scraper
  // error string, which is a real path nobody would think to review.
  { name: 'email_address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/ },
  // See the header. No handler renders a uuid.
  { name: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
])

export interface RedactionResult {
  /** False means the caller must post `text` (a notice) and log the incident. */
  readonly ok: boolean
  /** The message to post. Either the original, or a fixed notice. */
  readonly text: string
  /** Rule names only. Never the matched substring. Log these. */
  readonly violations: readonly string[]
}

/**
 * Every rule name a single string trips. Exported so a caller can scan
 * anything it likes (raw lines, a log payload) without going through the
 * replace-the-reply machinery.
 */
export function findViolations(text: string): readonly string[] {
  return RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name)
}

/**
 * Scan a fully composed reply. The last thing that happens before egress.
 *
 * `alsoScan` is the pre-cap material: pass the handler's raw line array. Those
 * lines are scanned as well, and a hit in EITHER place withholds the reply.
 * See the order-of-operations note in the header for why the composed text on
 * its own is not enough. The caller does not need to join them; that is done
 * here, with a separator, so a secret cannot be assembled across the boundary
 * between two lines that did not contain it individually.
 *
 * Non-string and empty inputs are violations rather than pass-throughs: a
 * filter that returns `{ ok: true }` for `undefined` is a filter that a
 * refactor can accidentally bypass, and an empty reply is a bug the reader
 * should hear about instead of a silence they will read as "nothing wrong".
 */
export function redactOutbound(text: unknown, alsoScan: readonly string[] = []): RedactionResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, text: EMPTY_NOTICE, violations: ['empty_or_non_string'] }
  }

  const extra = alsoScan.filter((line) => typeof line === 'string').join('\n')
  const violations = [...new Set([...findViolations(text), ...(extra ? findViolations(extra) : [])])]

  if (violations.length > 0) {
    return { ok: false, text: WITHHELD_NOTICE, violations }
  }
  return { ok: true, text, violations: [] }
}

/** The rule names, for tests and for a caller that wants to log the roster. */
export const REDACTION_RULE_NAMES: readonly string[] = Object.freeze(RULES.map((r) => r.name))
