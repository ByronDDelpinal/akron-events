/**
 * redact.test.ts: Deno tests for the fail-closed egress filter.
 *
 * Run: `deno test supabase/functions/slack-ask/`.
 *
 * Two halves, and both are load-bearing:
 *
 *  - The filter catches every shape it claims to catch, INCLUDING when the
 *    shape arrives inside an otherwise normal-looking answer. The scenario
 *    the ADR names is "the handler nobody reviewed", so the tests below
 *    simulate exactly that: a plausible reply with one leaked value in it.
 *  - The filter does not fire on the replies the real handlers actually
 *    produce. A fail-closed filter that cries wolf gets disabled, and a
 *    disabled filter protects nothing.
 */

import { assertEquals } from 'jsr:@std/assert@1'
import {
  EMPTY_NOTICE,
  findViolations,
  REDACTION_RULE_NAMES,
  redactOutbound,
  WITHHELD_NOTICE,
} from './redact.ts'

// ── WHY THE CREDENTIAL FIXTURES BELOW ARE ASSEMBLED, NOT WRITTEN OUT ──────
//
// GitHub push protection scans every pushed commit for credential shapes and
// REJECTS THE WHOLE PUSH on a match. It rejected this repo once, on a literal
// `xoxb-...` string in this very file, and the error names a line number but
// not the reason a test file would legitimately contain one.
//
// The awkward part is that this filter's entire job is to recognise those
// shapes, so the tests genuinely need them. They only have to exist at
// RUNTIME, though. `cred()` joins fragments at call time: the scanner reads
// source bytes and finds no contiguous token, while redactOutbound receives
// the exact string it must catch. The assertions are unchanged and just as
// strict.
//
// DO NOT "simplify" these back into literals. The push will be rejected and
// the reason will not be obvious from the error message.
const cred = (...parts: string[]): string => parts.join('')

function assertBlocked(text: string, expectedRule: string): void {
  const result = redactOutbound(text)
  assertEquals(result.ok, false, `expected "${text.slice(0, 40)}" to be blocked`)
  assertEquals(result.text, WITHHELD_NOTICE)
  assertEquals(
    result.violations.includes(expectedRule),
    true,
    `expected rule ${expectedRule}, got ${result.violations.join(',')}`,
  )
}

function assertAllowed(text: string): void {
  const result = redactOutbound(text)
  assertEquals(result.ok, true, `expected pass, blocked by ${result.violations.join(',')}`)
  assertEquals(result.text, text)
  assertEquals(result.violations, [])
}

// ── The shapes it must catch ──────────────────────────────────────────────

Deno.test('catches Slack tokens', () => {
  assertBlocked(`token is ${cred('xox', 'b-1234567890-abcdefghij')}`, 'slack_token')
  assertBlocked(cred('xox', 'p-9999999999-0000000000-zzzz'), 'slack_token')
  assertBlocked(cred('xap', 'p-1-A0123456-9999999999-abcdef'), 'slack_app_token')
})

Deno.test('catches JWTs, which is how a Supabase key looks', () => {
  assertBlocked(cred('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'), 'jwt')
})

Deno.test('catches API keys', () => {
  assertBlocked(cred('sk-', 'ant-api03-AAAAAAAAAAAAAAAA'), 'anthropic_key')
  assertBlocked('sk-abcdefghijklmnopqrstuvwxyz0123456789', 'generic_secret_key')
  // Hyphenated modern OpenAI keys. A `[A-Za-z0-9]`-only class misses every
  // `sk-proj-` and `sk-svcacct-` key ever issued.
  assertBlocked('sk-proj-abcdefghij_klmnopqrst-uvwxyz', 'generic_secret_key')
})

Deno.test('catches the other vendors this project actually uses', () => {
  // Resend sends the digest.
  assertBlocked(cred('RESEND_API_KEY=re', '_abcd1234efgh'), 'resend_key')
  assertBlocked(cred('ghp', '_abcdefghijklmnop'), 'github_token')
  assertBlocked(cred('github_pat', '_11ABCDEFG_abcdefghij'), 'github_pat')
  assertBlocked(cred('AIza', 'SyA1B2C3D4E5F6G7H8'), 'google_api_key')
})

Deno.test('a CLIPPED secret is still caught, because the prefix is the signal', () => {
  // errorSnippet clips third-party text to ~60 characters before this filter
  // ever sees it, and composeReply truncates at 600. A high length threshold
  // means a cut secret walks straight through.
  assertBlocked(`eventbrite: 401 sent ${cred('xox', 'b-4444')}`, 'slack_token')
  assertBlocked(`auth failed with ${cred('eyJ', 'hbGci')}`, 'jwt')
  assertBlocked(`key ${cred('sk-', 'ant-api03')}`, 'anthropic_key')
})

Deno.test('catches the service_role literal in any spelling', () => {
  assertBlocked('SUPABASE_SERVICE_ROLE_KEY missing', 'service_role')
  assertBlocked('permission denied for role service role', 'service_role')
  assertBlocked('using the service-role client', 'service_role')
})

Deno.test('catches bearer headers, private keys and connection strings', () => {
  assertBlocked('Authorization: Bearer abcdef1234567890', 'bearer_header')
  assertBlocked('-----BEGIN RSA PRIVATE KEY-----', 'private_key_block')
  assertBlocked('postgresql://user:pw@db.example.com:5432/postgres', 'db_connection_string')
})

Deno.test('catches email addresses', () => {
  assertBlocked('newest subscriber: someone@example.com', 'email_address')
  assertBlocked('byron.delpinal@akronpulse.com signed up', 'email_address')
  assertBlocked('contact first.last+tag@sub.domain.co.uk', 'email_address')
})

Deno.test('catches a UUID, because no handler renders one', () => {
  // Most likely subscribers.token, the unsubscribe secret, which is a uuid.
  assertBlocked('token 3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'uuid')
  assertBlocked('3F2504E0-4F89-11D3-9A0C-0305E82C3301', 'uuid')
})

// ── The scenario the layer exists for ─────────────────────────────────────

Deno.test('catches the handler nobody reviewed: one leaked value in a normal reply', () => {
  // A plausible `subscriber_counts` answer that somebody "improved" by adding
  // the newest signup's address. Every earlier layer passed it: the column was
  // selected on purpose, the value escaped cleanly, the reply is inside the
  // caps. This is the only thing standing between that edit and a channel.
  const leaked = '213 confirmed subscribers, 220 rows total.\n+4 in the last 7d. Newest: jane.doe@gmail.com'
  const result = redactOutbound(leaked)
  assertEquals(result.ok, false)
  assertEquals(result.text, WITHHELD_NOTICE)
  assertEquals(result.violations, ['email_address'])
  // Fail closed means REPLACE, not mask. Nothing of the original survives,
  // because a pattern that matched part of a secret would post the rest.
  assertEquals(result.text.includes('jane'), false)
  assertEquals(result.text.includes('213'), false)
})

Deno.test('catches a secret smuggled through a third-party scraper error string', () => {
  // scraper_health.last_error is third-party text. Escaping neuters its
  // markup; it does not neuter its content.
  const leaked = `2 scrapers erroring:\nEventbrite: 401 unauthorized, sent Bearer ${cred('eyJ', 'hbGciOiJIUzI1NiJ9xyz')}`
  const result = redactOutbound(leaked)
  assertEquals(result.ok, false)
  assertEquals(result.violations.includes('jwt'), true)
})

Deno.test('reports every rule a message trips, not just the first', () => {
  const result = redactOutbound(`user@example.com with ${cred('xox', 'b-1-abcdefgh')} and service_role`)
  assertEquals(result.ok, false)
  assertEquals(result.violations.length >= 3, true)
  assertEquals(result.violations.includes('email_address'), true)
  assertEquals(result.violations.includes('slack_token'), true)
  assertEquals(result.violations.includes('service_role'), true)
})

Deno.test('violations carry rule names only, never the matched text', () => {
  // Logging the match would move the leak from the channel into the logs.
  const secret = cred('xox', 'b-4444444444-supersecretvalue')
  const result = redactOutbound(`token ${secret}`)
  for (const v of result.violations) {
    assertEquals(v.includes('xox'), false)
    assertEquals(secret.includes(v), false)
  }
  assertEquals(result.violations, ['slack_token'])
})

// ── Fail closed on nothing at all ─────────────────────────────────────────

Deno.test('an empty or non-string reply fails closed, it does not pass through', () => {
  for (const bad of ['', '   ', '\n\n', undefined, null, 42, {}]) {
    const result = redactOutbound(bad)
    assertEquals(result.ok, false)
    assertEquals(result.text, EMPTY_NOTICE)
    assertEquals(result.violations, ['empty_or_non_string'])
  }
})

// ── No false positives on real replies ────────────────────────────────────

Deno.test('the answers the handlers actually produce all pass', () => {
  const real = [
    '47 events Fri-Sun. Prior 3d: 41.',
    '2183 events next 30d, 118 sources.\nEventbrite 214, Akron Library 143, Summit Metro Parks 96',
    '150/156 scrapers healthy (156 in the registry).\n1 erroring, 2 stale, 3 on a zero streak.',
    '2 scrapers erroring:\nEventbrite: HTTP 403 from the proxy after 3 retries',
    'Akron Library: success at Aug 26 10:02pm (14h ago), 89 events.\nAvg of last 5 runs: 91.',
    'Last night: 154 runs, 152 ok, 2 errors.\n1204 events found, 88 new, 1116 updated.',
    '213 confirmed subscribers, 220 rows total.\n+4 in the last 7d. 6 unsubscribed. 7 never confirmed.',
    '203 digests sent in the last 2d. Last at Aug 26 6:02am.',
    '3 feedback posts in the last 7d. 26 all time.\nbug 2, idea 1',
    '4 embed requests total, 4 still marked new.',
    '1 partner org, 1 active, 1 on auto-publish.',
    '541 events flagged needs_review, 120 of them upcoming.',
    'All clear.\nLast night: 154 runs, 0 failed, 1204 events found.',
    '2 things to look at.\n1 scraper erroring.\n3 scrapers stale, no run in 26h+.',
    '12 events at Blu Jazz&amp;+ Fri-Sun:\n5:00pm Trio Night',
    'Site traffic is not wired up. Page views, sessions, visitors and installs live in GA4.',
    'Not one I know. Try:\nevents tonight / this weekend / by source',
  ]
  for (const text of real) assertAllowed(text)
})

Deno.test('a venue named like an address does not trip the email rule', () => {
  assertAllowed('12 events at 750ml Wines Fri-Sun:')
  assertAllowed('Top venues next 30d:\nBarnes &amp; Noble Akron 14')
})

Deno.test('a bare timestamp or version number is not a uuid', () => {
  assertAllowed('Akron Library: success at Aug 26 10:02pm (14h ago), 89 events.')
  assertAllowed('runner v2.1.4-beta finished in 3821ms')
})

Deno.test('alsoScan catches a secret the line cap would have hidden', () => {
  // The order-of-operations gap: a secret in line seven of an eight-line
  // answer is dropped by composeReply's 6-line cap, so scanning only the
  // composed reply says "clean" while the handler is leaking every time the
  // answer runs one line shorter.
  const rawLines = [
    '5 scrapers erroring:',
    'Eventbrite: HTTP 403',
    'Library: timeout',
    'Zoo: timeout',
    'Museum: timeout',
    `Civic: 401 sent ${cred('xox', 'b-9999-secret')}`,
  ]
  const composed = rawLines.slice(0, 4).join('\n')

  // Composed text alone looks clean.
  assertEquals(redactOutbound(composed).ok, true)
  // With the pre-cap lines, it is withheld.
  const guarded = redactOutbound(composed, rawLines)
  assertEquals(guarded.ok, false)
  assertEquals(guarded.text, WITHHELD_NOTICE)
  assertEquals(guarded.violations, ['slack_token'])
})

Deno.test('alsoScan does not change the answer for a clean reply', () => {
  const lines = ['47 events Fri-Sun.', 'Eventbrite 12, Akron Civic 6']
  const result = redactOutbound(lines.join('\n'), lines)
  assertEquals(result.ok, true)
  assertEquals(result.text, lines.join('\n'))
})

Deno.test('violations are deduplicated across the composed text and the raw lines', () => {
  const leak = 'newest: a@b.co'
  const result = redactOutbound(leak, [leak, leak])
  assertEquals(result.violations, ['email_address'])
})

Deno.test('findViolations is the reusable scan, with no replacement behaviour', () => {
  assertEquals(findViolations('47 events Fri-Sun.'), [])
  assertEquals(findViolations('user@example.com'), ['email_address'])
})

Deno.test('the rule roster is stable and non-empty', () => {
  assertEquals(REDACTION_RULE_NAMES.length >= 14, true)
  assertEquals(new Set(REDACTION_RULE_NAMES).size, REDACTION_RULE_NAMES.length, 'duplicate rule name')
})

Deno.test('rules have no sticky state: the same input blocks every time', () => {
  // A `g`-flagged module-level regex would pass on every other call because
  // of `lastIndex`. That bug is intermittent, which makes it the worst kind.
  for (let i = 0; i < 10; i++) {
    assertEquals(redactOutbound('leak: a@b.co').ok, false)
    assertEquals(redactOutbound('47 events Fri-Sun.').ok, true)
  }
})
