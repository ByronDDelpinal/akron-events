// request.test.ts — Deno tests for slack-notify's Tier 1 + Tier 2 request
// parsing/planning logic (./request.ts).
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
// Mirrors render.test.ts's structure: everything under test is a pure
// function of its arguments, so no live server, database, or Slack
// workspace is needed.

import { assertEquals } from 'jsr:@std/assert@1'
import { escapeSlackText, AGENT_IDENTITIES, SLACK } from '../_shared/slack.ts'
import {
  parseRequest,
  planFor,
  resolveAgentIdentity,
  buildAgentPostText,
  buildAgentPostOpts,
  truncateAgentText,
  classifyCaller,
  normalizeSecret,
  MAX_AGENT_TEXT_LEN,
  MAX_ESCAPED_AGENT_TEXT_LEN,
  AGENT_TEXT_TRUNCATION_MARKER,
  AGENT_ID_RE,
  type Req,
  type Caller,
} from './request.ts'

// A plain, non-timing-safe equality comparator for tests — classifyCaller
// takes the comparator as a parameter specifically so tests never need
// jsr:@std/crypto or a real timing-safe implementation. index.ts injects
// timingSafeEqualStrings; these tests inject this instead.
const eq = (a: string, b: string) => a === b

// ── 1. parseRequest — Tier 1 arms still parse (non-regression) ───────────

Deno.test('parseRequest: feedback arm still parses', () => {
  assertEquals(parseRequest({ event: 'feedback', id: 42 }), { event: 'feedback', id: 42 })
})

Deno.test('parseRequest: subscriber_signup arm still parses', () => {
  assertEquals(parseRequest({ event: 'subscriber_signup', id: 'abc-123' }), { event: 'subscriber_signup', id: 'abc-123' })
})

Deno.test('parseRequest: subscriber_confirmed arm still parses', () => {
  assertEquals(parseRequest({ event: 'subscriber_confirmed', id: 'abc-123' }), { event: 'subscriber_confirmed', id: 'abc-123' })
})

// ── embed_request arm (docs/embed-request-capture.md §6.4) ───────────────

Deno.test('parseRequest: embed_request arm parses', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  assertEquals(parseRequest({ event: 'embed_request', id }), { event: 'embed_request', id })
})

Deno.test('parseRequest: embed_request rejects a missing id', () => {
  assertEquals(parseRequest({ event: 'embed_request' }), null)
})

Deno.test('parseRequest: embed_request rejects a non-string id', () => {
  assertEquals(parseRequest({ event: 'embed_request', id: 12345 }), null)
})

Deno.test('parseRequest: embed_request rejects an empty-string id', () => {
  assertEquals(parseRequest({ event: 'embed_request', id: '' }), null)
})

Deno.test('parseRequest: garbage body returns null', () => {
  assertEquals(parseRequest(null), null)
  assertEquals(parseRequest('nope'), null)
  assertEquals(parseRequest({ event: 'nonsense' }), null)
})

// ── 2. parseRequest — agent_post happy path ───────────────────────────────

Deno.test('parseRequest: agent_post happy path parses with all fields', () => {
  const out = parseRequest({
    event: 'agent_post',
    kind: 'daily_report',
    run_key: '2026-07-27',
    agent: 'data-steward',
    text: 'All scrapers green.',
  })
  assertEquals(out, {
    event: 'agent_post',
    kind: 'daily_report',
    run_key: '2026-07-27',
    agent: 'data-steward',
    text: 'All scrapers green.',
  })
})

Deno.test('parseRequest: agent_post with a valid thread_ts parses', () => {
  const out = parseRequest({
    event: 'agent_post',
    kind: 'night_crew',
    run_key: '2026-07-27-scrape',
    agent: 'qa',
    text: 'Follow-up.',
    thread_ts: '1234567890.123456',
  })
  assertEquals(out, {
    event: 'agent_post',
    kind: 'night_crew',
    run_key: '2026-07-27-scrape',
    agent: 'qa',
    text: 'Follow-up.',
    thread_ts: '1234567890.123456',
  })
})

// ── 3. parseRequest — required rejections (test requirement #1) ──────────

Deno.test('REQUIRED (1): unknown kind is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'weekly_summary', run_key: 'ok', agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): run_key containing "/" is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'a/b', agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): run_key containing a space is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'a b', agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): run_key containing ";" is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'a;b', agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): run_key over 80 chars is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'a'.repeat(81), agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('run_key at exactly 80 chars is accepted', () => {
  const runKey = 'a'.repeat(80)
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: runKey, agent: 'qa', text: 'x' })
  assertEquals(out !== null, true)
})

Deno.test('REQUIRED (1): empty run_key is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: '', agent: 'qa', text: 'x' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): malformed thread_ts is rejected', () => {
  const out = parseRequest({
    event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'x',
    thread_ts: 'not-a-ts',
  })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): thread_ts missing the fractional part is rejected', () => {
  const out = parseRequest({
    event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'x',
    thread_ts: '1234567890',
  })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): missing text is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa' })
  assertEquals(out, null)
})

Deno.test('REQUIRED (1): empty text is rejected', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: '' })
  assertEquals(out, null)
})

// ── 4. planFor — key/channel derivation (test requirement #2) ────────────

Deno.test('REQUIRED (2): planFor derives daily_report:{run_key} and channel daily-reports', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: '2026-07-27', agent: 'qa', text: 'x' }
  const result = planFor(req, 'agent')
  assertEquals(result, {
    ok: true,
    plan: { dedupeKey: 'daily_report:2026-07-27', kind: 'daily_report', channelKey: 'daily-reports' },
  })
})

Deno.test('REQUIRED (2): planFor derives night_crew:{run_key} and channel the-night-crew', () => {
  const req: Req = { event: 'agent_post', kind: 'night_crew', run_key: '2026-07-27-run', agent: 'qa', text: 'x' }
  const result = planFor(req, 'agent')
  assertEquals(result, {
    ok: true,
    plan: { dedupeKey: 'night_crew:2026-07-27-run', kind: 'night_crew', channelKey: 'the-night-crew' },
  })
})

Deno.test('REQUIRED (2): planFor never produces public-feedback or public-new-email-subscribers for any agent_post input', () => {
  const runKeys = ['a', '2026-07-27', 'subscriber_signup:uuid', 'feedback:1', 'public-feedback', 'x'.repeat(80)]
  const kinds: Array<'daily_report' | 'night_crew'> = ['daily_report', 'night_crew']
  for (const kind of kinds) {
    for (const runKey of runKeys) {
      const req: Req = { event: 'agent_post', kind, run_key: runKey, agent: 'qa', text: 'x' }
      const result = planFor(req, 'agent')
      if (result.ok) {
        assertEquals(result.plan.channelKey === 'public-feedback', false)
        assertEquals(result.plan.channelKey === 'public-new-email-subscribers', false)
      }
    }
  }
})

// ── 5. Capability split, both directions (test requirement #3) ───────────

Deno.test('REQUIRED (3): notify-secret caller (trigger) attempting agent_post -> forbidden', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'x' }
  const result = planFor(req, 'trigger')
  assertEquals(result, { ok: false })
})

Deno.test('REQUIRED (3): agent-secret caller attempting feedback -> forbidden', () => {
  const req: Req = { event: 'feedback', id: 1 }
  const result = planFor(req, 'agent')
  assertEquals(result, { ok: false })
})

Deno.test('agent-secret caller attempting subscriber_signup -> forbidden', () => {
  const result = planFor({ event: 'subscriber_signup', id: 'x' }, 'agent')
  assertEquals(result, { ok: false })
})

Deno.test('agent-secret caller attempting subscriber_confirmed -> forbidden', () => {
  const result = planFor({ event: 'subscriber_confirmed', id: 'x' }, 'agent')
  assertEquals(result, { ok: false })
})

Deno.test('agent-secret caller attempting embed_request -> forbidden', () => {
  const result = planFor({ event: 'embed_request', id: 'x' }, 'agent')
  assertEquals(result, { ok: false })
})

Deno.test('trigger caller using the four Tier 1 arms still succeeds', () => {
  assertEquals(planFor({ event: 'feedback', id: 1 }, 'trigger').ok, true)
  assertEquals(planFor({ event: 'subscriber_signup', id: 'x' }, 'trigger').ok, true)
  assertEquals(planFor({ event: 'subscriber_confirmed', id: 'x' }, 'trigger').ok, true)
  assertEquals(planFor({ event: 'embed_request', id: 'x' }, 'trigger').ok, true)
})

// ── embed_request: dedupe key / kind / channel derivation ────────────────

Deno.test('REQUIRED: planFor(embed_request, trigger) derives embed_request:{uuid}, kind embed_request, channel partner-embed-requests', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const req: Req = { event: 'embed_request', id }
  const result = planFor(req, 'trigger')
  assertEquals(result, {
    ok: true,
    plan: { dedupeKey: `embed_request:${id}`, kind: 'embed_request', channelKey: 'partner-embed-requests' },
  })
})

Deno.test('REQUIRED: an agent_post run_key literally "embed_request:<uuid>" cannot pre-burn the real Tier 1 key', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const collidingReq: Req = { event: 'agent_post', kind: 'night_crew', run_key: `embed_request:${id}`, agent: 'qa', text: 'x' }
  const result = planFor(collidingReq, 'agent')
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.plan.dedupeKey, `night_crew:embed_request:${id}`)
    assertEquals(result.plan.dedupeKey === `embed_request:${id}`, false)
  }
})

// ── 6. Namespace regression (test requirement #4) ─────────────────────────

Deno.test('REQUIRED (4): agent_post run_key="subscriber_signup:<uuid>" produces night_crew:subscriber_signup:<uuid>, not subscriber_signup:<uuid>', () => {
  const uuid = '11111111-1111-4111-8111-111111111111'
  const req: Req = { event: 'agent_post', kind: 'night_crew', run_key: `subscriber_signup:${uuid}`, agent: 'qa', text: 'x' }
  const result = planFor(req, 'agent')
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.plan.dedupeKey, `night_crew:subscriber_signup:${uuid}`)
  }
})

Deno.test('REQUIRED (4): the derived key is NOT the bare subscriber_signup:<uuid> string', () => {
  const uuid = '22222222-2222-4222-8222-222222222222'
  const req: Req = { event: 'agent_post', kind: 'night_crew', run_key: `subscriber_signup:${uuid}`, agent: 'qa', text: 'x' }
  const result = planFor(req, 'agent')
  assertEquals(result.ok, true)
  if (result.ok) {
    assertEquals(result.plan.dedupeKey === `subscriber_signup:${uuid}`, false)
    assertEquals(result.plan.dedupeKey, `night_crew:subscriber_signup:${uuid}`)
  }
})

// ── 7. escapeSlackText applied in the real payload builder (test requirement #5) ──

Deno.test('REQUIRED (5): buildAgentPostText neutralizes <!channel> in the real payload builder', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: '<!channel> ping everyone' }
  const out = buildAgentPostText(req)
  assertEquals(out.includes('<!channel>'), false)
  assertEquals(out, escapeSlackText(req.text))
})

Deno.test('REQUIRED (5): buildAgentPostText neutralizes a masked link', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: '<https://evil.example|Click here>' }
  const out = buildAgentPostText(req)
  assertEquals(out.includes('<https://evil.example|Click here>'), false)
  assertEquals(out, '&lt;https://evil.example|Click here&gt;')
})

Deno.test('REQUIRED (5): buildAgentPostText neutralizes a user mention', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'ping <@U123>' }
  const out = buildAgentPostText(req)
  assertEquals(out.includes('<@U123>'), false)
})

Deno.test('REQUIRED (5): buildAgentPostText escapes a bare &', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'foo & bar' }
  const out = buildAgentPostText(req)
  assertEquals(out, 'foo &amp; bar')
})

Deno.test('REQUIRED (5): combined hostile payload — none of the vectors survive intact', () => {
  const req: Req = {
    event: 'agent_post', kind: 'night_crew', run_key: 'ok', agent: 'qa',
    text: '<!channel> <https://evil.example|Click here> <@U123> & more',
  }
  const out = buildAgentPostText(req)
  assertEquals(out.includes('<!channel>'), false)
  assertEquals(out.includes('<https://evil.example|Click here>'), false)
  assertEquals(out.includes('<@U123>'), false)
  assertEquals(out.includes('<'), false)
  assertEquals(out.includes('>'), false)
})

// ── 8. text > 2800 chars truncates, never throws or rejects (test requirement #8) ──

Deno.test('REQUIRED (8): parseRequest truncates text over 2800 chars rather than rejecting', () => {
  const longText = 'x'.repeat(3000)
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: longText })
  assertEquals(out !== null, true)
  if (out && out.event === 'agent_post') {
    assertEquals([...out.text].length, MAX_AGENT_TEXT_LEN + [...AGENT_TEXT_TRUNCATION_MARKER].length)
    assertEquals(out.text.endsWith(AGENT_TEXT_TRUNCATION_MARKER), true)
  }
})

Deno.test('REQUIRED (8): text at exactly 2800 chars is not truncated', () => {
  const text = 'x'.repeat(MAX_AGENT_TEXT_LEN)
  const out = truncateAgentText(text)
  assertEquals(out, text)
})

Deno.test('REQUIRED (8): text at 2801 chars is truncated with the marker', () => {
  const text = 'x'.repeat(MAX_AGENT_TEXT_LEN + 1)
  const out = truncateAgentText(text)
  assertEquals(out, 'x'.repeat(MAX_AGENT_TEXT_LEN) + AGENT_TEXT_TRUNCATION_MARKER)
})

// ── 9. Unknown agent falls back to the default identity, not 400 (test requirement #9) ──

Deno.test('REQUIRED (9): parseRequest does not reject an unrecognized agent value', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'totally-made-up-persona', text: 'x' })
  assertEquals(out !== null, true)
})

Deno.test('REQUIRED (9): resolveAgentIdentity falls back to the default SLACK identity for an unknown agent', () => {
  const identity = resolveAgentIdentity('totally-made-up-persona')
  assertEquals(identity, { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

Deno.test('REQUIRED (9): resolveAgentIdentity falls back to the default identity for a missing/empty agent', () => {
  assertEquals(resolveAgentIdentity(''), { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

Deno.test('resolveAgentIdentity returns the real identity for every known AgentId', () => {
  for (const [agentId, identity] of Object.entries(AGENT_IDENTITIES)) {
    assertEquals(resolveAgentIdentity(agentId), identity)
  }
})

Deno.test('a missing agent field in parseRequest falls back cleanly through to the default identity', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', text: 'x' })
  assertEquals(out !== null, true)
  if (out && out.event === 'agent_post') {
    assertEquals(resolveAgentIdentity(out.agent), { username: SLACK.username, iconUrl: SLACK.iconUrl })
  }
})

// ── 10. buildAgentPostOpts — identity + threading wiring ──────────────────

Deno.test('buildAgentPostOpts carries the resolved identity and omits threadTs when absent', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'x' }
  const opts = buildAgentPostOpts(req)
  assertEquals(opts.username, AGENT_IDENTITIES.qa.username)
  assertEquals(opts.iconUrl, AGENT_IDENTITIES.qa.iconUrl)
  assertEquals('threadTs' in opts, false)
})

Deno.test('buildAgentPostOpts carries threadTs through when present', () => {
  const req: Req = {
    event: 'agent_post', kind: 'night_crew', run_key: 'ok', agent: 'data-steward', text: 'x',
    thread_ts: '1234567890.123456',
  }
  const opts = buildAgentPostOpts(req)
  assertEquals(opts.threadTs, '1234567890.123456')
  assertEquals(opts.username, AGENT_IDENTITIES['data-steward'].username)
})

// ── 11. planFor fails CLOSED for an unknown caller value (MAJOR 2 regression) ──
//
// planFor is typed `(req: Req, caller: Caller)` with Caller = 'trigger' |
// 'agent', so an out-of-band caller value only reaches this function via a
// cast — exactly the situation a future Tier 3 caller class would create if
// classifyCaller (or whatever replaces it) is extended without also
// extending this allowlist. `as any` here is deliberate: it simulates that
// exact future bug, not a type error in today's code.

Deno.test('MAJOR 2 REGRESSION: planFor denies an unrecognized caller value for every event shape', () => {
  const reqs: Req[] = [
    { event: 'feedback', id: 1 },
    { event: 'subscriber_signup', id: 'x' },
    { event: 'subscriber_confirmed', id: 'x' },
    { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'x' },
    { event: 'agent_post', kind: 'night_crew', run_key: 'ok', agent: 'qa', text: 'x' },
  ]
  for (const req of reqs) {
    const result = planFor(req, 'admin' as unknown as Caller)
    assertEquals(result, { ok: false })
  }
})

// ── 12. classifyCaller — full matrix (THE BIG ONE) ────────────────────────
//
// This is the outermost auth boundary on a verify_jwt=false endpoint. Every
// case the code-reviewer named explicitly, plus the blocker as a permanent
// regression test.

Deno.test('classifyCaller: both secrets unset -> null for any headers', () => {
  const result = classifyCaller(
    { notify: 'anything', agent: 'anything' },
    { notify: null, agent: null },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: notify-only secret configured, correct notify header -> trigger', () => {
  const result = classifyCaller(
    { notify: 'notify-secret', agent: null },
    { notify: 'notify-secret', agent: null },
    eq,
  )
  assertEquals(result, 'trigger')
})

Deno.test('classifyCaller: notify-only secret configured, agent header sent -> null (no agent secret to match)', () => {
  const result = classifyCaller(
    { notify: null, agent: 'anything' },
    { notify: 'notify-secret', agent: null },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: agent-only secret configured, correct agent header -> agent', () => {
  const result = classifyCaller(
    { notify: null, agent: 'agent-secret' },
    { notify: null, agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'agent')
})

Deno.test('classifyCaller: agent-only secret configured, notify header sent -> null (no notify secret to match)', () => {
  const result = classifyCaller(
    { notify: 'anything', agent: null },
    { notify: null, agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: both secrets set (distinct), correct notify header -> trigger', () => {
  const result = classifyCaller(
    { notify: 'notify-secret', agent: null },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'trigger')
})

Deno.test('classifyCaller: both secrets set (distinct), correct agent header -> agent', () => {
  const result = classifyCaller(
    { notify: null, agent: 'agent-secret' },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'agent')
})

Deno.test('BLOCKER REGRESSION: both secrets set to the SAME value -> the agent header carrying that value no longer classifies as agent', () => {
  // This is the live exploit the reviewer verified before the fix: with
  // SLACK_NOTIFY_SECRET === SLACK_AGENT_SECRET === shared, an agent-secret
  // holder who ONLY ever received the agent-side value (the four task
  // prompts, .env) could previously move it into X-Slack-Notify-Secret and
  // be classified 'trigger' — full Tier 1 capability, reaching the DB claim.
  // The fix does not (and structurally cannot) prevent that specific
  // notify-header path once the two secrets are literally equal strings —
  // there is no way to distinguish "the real notify-secret holder" from "the
  // agent-secret holder who moved their value" when the values are
  // identical. What the fix DOES do is close the other half: it disables
  // classifying as 'agent' whenever the two secrets collide, so the sanctioned
  // agent_post path itself goes dark (a loud, immediate operational signal —
  // Tier 2 401s on every call) rather than the split silently staying void.
  // Byron sets both secrets by hand; the cold-start error in index.ts is the
  // other half of this mitigation, catching the misconfiguration at boot.
  const shared = 'shared-value'
  const result = classifyCaller(
    { notify: null, agent: shared },
    { notify: shared, agent: shared },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('collision does not break Tier 1: the real notify secret in the notify header slot still classifies as trigger even while colliding with the agent secret', () => {
  // Tier 1 (the three DB-trigger-fired arms) must never break because of a
  // Tier 2 misconfiguration — per-tier fail-closed, verified not to regress.
  const shared = 'shared-value'
  const result = classifyCaller(
    { notify: shared, agent: null },
    { notify: shared, agent: shared },
    eq,
  )
  assertEquals(result, 'trigger')
})

Deno.test('classifyCaller: empty-string header can never match an unset secret', () => {
  const result = classifyCaller(
    { notify: '', agent: '' },
    { notify: null, agent: null },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: empty-string secret (coerced to null by `Deno.env.get(...) || null`) can never match any header', () => {
  // index.ts reads secrets with `Deno.env.get(...) || null`, so an empty-
  // string env var is never passed into classifyCaller as ''  — but this
  // function is tested directly against arbitrary inputs, so verify the
  // property holds even if a future caller passed '' through by mistake:
  // '' is falsy, so the `secrets.notify &&`/`secrets.agent &&` guards must
  // still refuse to match.
  const result = classifyCaller(
    { notify: '', agent: '' },
    { notify: '', agent: '' },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: correct secret sent in the wrong header slot does not classify', () => {
  const result = classifyCaller(
    { notify: 'agent-secret', agent: null },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('classifyCaller: both headers sent at once, only the notify one is correct -> trigger', () => {
  const result = classifyCaller(
    { notify: 'notify-secret', agent: 'wrong-value' },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'trigger')
})

Deno.test('classifyCaller: both headers sent at once, only the agent one is correct -> agent', () => {
  const result = classifyCaller(
    { notify: 'wrong-value', agent: 'agent-secret' },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'agent')
})

Deno.test('classifyCaller: both headers sent at once, both correct -> trigger (notify checked first)', () => {
  const result = classifyCaller(
    { notify: 'notify-secret', agent: 'agent-secret' },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, 'trigger')
})

Deno.test('classifyCaller: null headers (header not sent at all) never match', () => {
  const result = classifyCaller(
    { notify: null, agent: null },
    { notify: 'notify-secret', agent: 'agent-secret' },
    eq,
  )
  assertEquals(result, null)
})

// ── 13. resolveAgentIdentity — prototype-chain hardening (MINOR 5) ────────

Deno.test('MINOR 5 REGRESSION: resolveAgentIdentity does not resolve "constructor" off Object.prototype', () => {
  assertEquals(resolveAgentIdentity('constructor'), { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

Deno.test('MINOR 5 REGRESSION: resolveAgentIdentity does not resolve "__proto__" off Object.prototype', () => {
  assertEquals(resolveAgentIdentity('__proto__'), { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

Deno.test('MINOR 5 REGRESSION: resolveAgentIdentity does not resolve "toString" off Object.prototype', () => {
  assertEquals(resolveAgentIdentity('toString'), { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

Deno.test('MINOR 5 REGRESSION: resolveAgentIdentity does not resolve "hasOwnProperty" off Object.prototype', () => {
  assertEquals(resolveAgentIdentity('hasOwnProperty'), { username: SLACK.username, iconUrl: SLACK.iconUrl })
})

// ── 14. buildAgentPostText — post-escape cap (NIT 11) ─────────────────────

Deno.test('NIT 11: an all-& payload expands under escaping but is capped post-escape with the truncation marker', () => {
  // MAX_AGENT_TEXT_LEN (2800) raw '&' chars each expand to 5 chars ('&amp;'),
  // so the escaped text before this cap would be 14,000 chars — comfortably
  // over MAX_ESCAPED_AGENT_TEXT_LEN.
  const req: Req = {
    event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa',
    text: '&'.repeat(MAX_AGENT_TEXT_LEN),
  }
  const out = buildAgentPostText(req)
  assertEquals([...out].length, MAX_ESCAPED_AGENT_TEXT_LEN + [...AGENT_TEXT_TRUNCATION_MARKER].length)
  assertEquals(out.endsWith(AGENT_TEXT_TRUNCATION_MARKER), true)
})

Deno.test('NIT 11: ordinary short text is unaffected by the post-escape cap', () => {
  const req: Req = { event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'qa', text: 'All scrapers green.' }
  const out = buildAgentPostText(req)
  assertEquals(out, 'All scrapers green.')
})

// ── 15. normalizeSecret — whitespace regression (MAJOR: SECRETS_COLLIDE
// misses secrets differing only by surrounding whitespace) ────────────────
//
// The bug: index.ts used to read `Deno.env.get(...) || null` with no
// trimming, while HTTP already strips leading/trailing whitespace from
// header VALUES before classifyCaller ever compares them. Two secrets that
// are byte-identical over the wire ('x' and 'x ') compared unequal as env
// vars, so SECRETS_COLLIDE never fired and the agent arm quietly voided
// (401s on every call, no diagnostic) or — worse — an agent-secret holder
// moving its value into the notify slot could reach 'trigger'. The fix
// (normalizeSecret, called by index.ts on both env vars before anything else
// touches them) trims before the falsy-check, so the two values above
// collide exactly the way they would on the wire.

Deno.test('normalizeSecret: trims leading and trailing whitespace', () => {
  assertEquals(normalizeSecret('shared-value '), 'shared-value')
  assertEquals(normalizeSecret(' shared-value'), 'shared-value')
  assertEquals(normalizeSecret('\nshared-value\n'), 'shared-value')
})

Deno.test('normalizeSecret: whitespace-only or empty becomes null (same shape as `Deno.env.get(...) || null`)', () => {
  assertEquals(normalizeSecret(''), null)
  assertEquals(normalizeSecret('   '), null)
  assertEquals(normalizeSecret(null), null)
  assertEquals(normalizeSecret(undefined), null)
})

Deno.test('normalizeSecret: a value with no surrounding whitespace is unchanged', () => {
  assertEquals(normalizeSecret('shared-value'), 'shared-value')
})

Deno.test('WHITESPACE REGRESSION: raw string equality misses a whitespace-only difference (this IS the bug: SECRETS_COLLIDE == secrets.notify === secrets.agent)', () => {
  // The exact operator slip: SLACK_NOTIFY_SECRET='x', SLACK_AGENT_SECRET='x '
  // (a trailing space/newline picked up by copy-paste into `supabase secrets
  // set`). These are functionally the SAME secret over the wire (HTTP already
  // strips the whitespace from header values before comparison), but a raw
  // `!==`/`===` compare of the two env-var strings — which is exactly what
  // index.ts's SECRETS_COLLIDE and classifyCaller's internal secretsCollide
  // check both do — says they differ. That silent false-negative is the bug:
  // SECRETS_COLLIDE never logs, and classifyCaller's collide guard never
  // suppresses the 'agent' arm for this pair.
  const rawNotify: string = 'x'
  const rawAgent: string = 'x '
  assertEquals(rawNotify === rawAgent, false, 'raw compare misses the collision — this is what the fix closes')

  // The fix: normalizeSecret trims both BEFORE the comparison ever happens
  // (index.ts calls it on both env vars at read time, so every downstream
  // comparison — the cold-start SECRETS_COLLIDE log and classifyCaller's
  // internal secretsCollide check — now operates on the trimmed values).
  const notifySecret = normalizeSecret(rawNotify)
  const agentSecret = normalizeSecret(rawAgent)
  assertEquals(notifySecret, agentSecret, 'once normalized, the collision is correctly detected')
})

Deno.test('WHITESPACE REGRESSION: once normalized, the collide guard fires exactly as it does for an exact-match pair — the agent arm goes dark for the documented reason, not by accident', () => {
  // Same shape as the pre-existing BLOCKER REGRESSION test above (both
  // secrets set to the SAME value disables classification as 'agent'), but
  // starting from secrets that only match AFTER normalizeSecret is applied
  // — proving the fix routes a whitespace-differing pair through the exact
  // same fail-closed path as a byte-identical pair, rather than leaving it
  // to accidentally 401 (or worse, accidentally still classify) depending on
  // how the mismatch happens to interact with a raw string compare.
  const rawNotify = 'x'
  const rawAgent = 'x '
  const notifySecret = normalizeSecret(rawNotify)
  const agentSecret = normalizeSecret(rawAgent)

  const result = classifyCaller(
    { notify: null, agent: 'x' }, // 'x' is what actually arrives on the wire either way — HTTP already stripped the space
    { notify: notifySecret, agent: agentSecret },
    eq,
  )
  assertEquals(result, null)
})

Deno.test('WHITESPACE REGRESSION: a legitimately-distinct pair still classifies correctly after normalization', () => {
  const notifySecret = normalizeSecret(' notify-secret ')
  const agentSecret = normalizeSecret(' agent-secret\n')
  assertEquals(notifySecret, 'notify-secret')
  assertEquals(agentSecret, 'agent-secret')
  assertEquals(notifySecret === agentSecret, false)

  assertEquals(
    classifyCaller({ notify: 'notify-secret', agent: null }, { notify: notifySecret, agent: agentSecret }, eq),
    'trigger',
  )
  assertEquals(
    classifyCaller({ notify: null, agent: 'agent-secret' }, { notify: notifySecret, agent: agentSecret }, eq),
    'agent',
  )
})

// ── 16. `agent` field bounded by charset + length (MINOR: unbounded log
// volume via resolveAgentIdentity's console.warn) ──────────────────────────

Deno.test('MINOR REGRESSION: an over-long agent value is normalized to empty string, not passed through verbatim', () => {
  const longAgent = 'a'.repeat(200_000)
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: longAgent, text: 'x' })
  assertEquals(out !== null, true)
  if (out && out.event === 'agent_post') {
    assertEquals(out.agent, '')
  }
})

Deno.test('MINOR REGRESSION: an agent value violating the charset (e.g. uppercase, whitespace, punctuation) is normalized to empty string', () => {
  const cases = ['Data-Steward', 'qa ', 'qa\n', 'qa/../etc', 'agent with spaces', 'ok!']
  for (const agent of cases) {
    const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent, text: 'x' })
    assertEquals(out !== null, true, `expected a request with agent=${JSON.stringify(agent)} to still parse (normalized, not rejected)`)
    if (out && out.event === 'agent_post') {
      assertEquals(out.agent, '', `expected agent=${JSON.stringify(agent)} to normalize to '' `)
    }
  }
})

Deno.test('agent value within the charset and length limit is passed through unchanged', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'code-reviewer', text: 'x' })
  assertEquals(out !== null, true)
  if (out && out.event === 'agent_post') {
    assertEquals(out.agent, 'code-reviewer')
  }
})

Deno.test('agent value at exactly the 40-char length limit is accepted', () => {
  const agent = 'a'.repeat(40)
  assertEquals(AGENT_ID_RE.test(agent), true)
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent, text: 'x' })
  if (out && out.event === 'agent_post') {
    assertEquals(out.agent, agent)
  }
})

Deno.test('agent value at 41 chars (one over the limit) is normalized to empty string', () => {
  const agent = 'a'.repeat(41)
  assertEquals(AGENT_ID_RE.test(agent), false)
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent, text: 'x' })
  if (out && out.event === 'agent_post') {
    assertEquals(out.agent, '')
  }
})

Deno.test('an over-long/charset-violating agent still falls through cleanly to the default Slack identity', () => {
  const out = parseRequest({ event: 'agent_post', kind: 'daily_report', run_key: 'ok', agent: 'X'.repeat(200_000), text: 'x' })
  assertEquals(out !== null, true)
  if (out && out.event === 'agent_post') {
    assertEquals(resolveAgentIdentity(out.agent), { username: SLACK.username, iconUrl: SLACK.iconUrl })
  }
})
