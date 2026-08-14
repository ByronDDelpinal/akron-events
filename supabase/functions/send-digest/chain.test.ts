// chain.test.ts — Deno tests for send-digest's self-chaining invocation logic.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// chain.ts is pure (no Deno/Supabase/Resend imports — the batch.ts pattern),
// so everything the chain decides is tested here directly: continuation-body
// parsing, slice determinism under retry, membership-derived chunk-key
// stability, the already-logged pre-filter, the runaway guards, and the
// Resend-409-as-replay classification. The scenario tests at the bottom
// walk a miniature version of index.ts's per-link loop end to end to pin
// the failure-mode guarantees from the design memo: crash-resume mid-chain,
// sweep double-fire after completion (zero Resend calls), 409 on a resumed
// chunk, and the skipped/render-failed interleave that batchLogIndex exists
// for.

import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  type ContinuationBody,
  SLICE_SIZE,
  MAX_LINKS,
  parseContinuation,
  buildContinuation,
  chainGuardError,
  sliceDue,
  filterAlreadyLogged,
  chunkIdempotencyKey,
  resolveChunkSendError,
} from './chain.ts'
import { markChunkFailed, type SendLogEntry } from './batch.ts'

const VALID: ContinuationBody = {
  date: '2026-08-13',
  dow: 4,
  first: false,
  cursor: '00000000-0000-4000-8000-000000000019',
  sessionTag: 'scheduled',
  link: 1,
}

// ── parseContinuation ────────────────────────────────────────────────────

Deno.test('parseContinuation: accepts a valid scheduled body and round-trips every field', () => {
  assertEquals(parseContinuation({ ...VALID }), VALID)
})

Deno.test('parseContinuation: force-<ts> sessionTag passes through untouched (force chains stay force)', () => {
  const tag = 'force-1755100000000'
  const parsed = parseContinuation({ ...VALID, sessionTag: tag })
  assert(parsed !== null)
  assertEquals(parsed!.sessionTag, tag)
})

Deno.test('parseContinuation: rejects malformed bodies field by field', () => {
  const bad: unknown[] = [
    null,
    undefined,
    'string',
    42,
    [],
    {},
    { ...VALID, date: '08/13/2026' },        // wrong date format
    { ...VALID, date: 20260813 },            // wrong date type
    { ...VALID, dow: 7 },                    // dow out of range
    { ...VALID, dow: -1 },
    { ...VALID, dow: 3.5 },                  // non-integer
    { ...VALID, first: 'false' },            // wrong type
    { ...VALID, cursor: '' },                // empty cursor
    { ...VALID, cursor: 42 },
    { ...VALID, sessionTag: 'force-' },      // malformed force tag
    { ...VALID, sessionTag: 'manual' },      // unknown tag
    { ...VALID, link: 0 },                   // continuations start at 1
    { ...VALID, link: 1.5 },
    { ...VALID, link: '2' },
  ]
  for (const body of bad) {
    assertEquals(parseContinuation(body), null, `should reject: ${JSON.stringify(body)}`)
  }
})

Deno.test('buildContinuation: pins date/dow/first/sessionTag from link 0 and only advances cursor + link', () => {
  const pinned = { date: '2026-08-13', dow: 4, first: true, sessionTag: 'force-1755100000000', link: 0 }
  const next = buildContinuation(pinned, 'sub-25')
  assertEquals(next, {
    date: '2026-08-13', dow: 4, first: true, cursor: 'sub-25',
    sessionTag: 'force-1755100000000', link: 1,
  })
  // And it survives its own parse — what one link emits, the next accepts.
  assertEquals(parseContinuation(next), next)
})

// ── Guards ───────────────────────────────────────────────────────────────

Deno.test('chainGuardError: aborts a runaway chain past MAX_LINKS', () => {
  const err = chainGuardError({ ...VALID, link: MAX_LINKS + 1 }, '2026-08-13')
  assert(err !== null && err.includes('runaway'))
  assertEquals(chainGuardError({ ...VALID, link: MAX_LINKS }, '2026-08-13'), null)
})

Deno.test('chainGuardError: aborts a chain whose pinned date is no longer today (cross-midnight / stale replay)', () => {
  const err = chainGuardError(VALID, '2026-08-14')
  assert(err !== null && err.includes('2026-08-13'))
  assertEquals(chainGuardError(VALID, '2026-08-13'), null)
})

// ── Slice math ───────────────────────────────────────────────────────────

const subs = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `sub-${String(i + offset).padStart(3, '0')}` }))

Deno.test('sliceDue: SLICE_SIZE+1 rows → 25 processed, lookahead row signals more, cursor is the 25th id (not the 26th)', () => {
  const rows = subs(SLICE_SIZE + 1)
  const { slice, hasMore, nextCursor } = sliceDue(rows)
  assertEquals(slice.length, SLICE_SIZE)
  assertEquals(hasMore, true)
  assertEquals(nextCursor, 'sub-024') // 25th row; sub-025 is re-fetched by the next link
  assertEquals(slice.some((s) => s.id === 'sub-025'), false)
})

Deno.test('sliceDue: a final partial page has no lookahead row → chain terminates', () => {
  for (const n of [0, 1, SLICE_SIZE - 1, SLICE_SIZE]) {
    const { slice, hasMore, nextCursor } = sliceDue(subs(n))
    assertEquals(slice.length, n)
    assertEquals(hasMore, false)
    assertEquals(nextCursor, n > 0 ? `sub-${String(n - 1).padStart(3, '0')}` : null)
  }
})

Deno.test('sliceDue: deterministic — a retried link with the same rows reproduces the identical slice', () => {
  const rows = subs(SLICE_SIZE + 1)
  const a = sliceDue(rows)
  const b = sliceDue(rows.map((r) => ({ ...r }))) // fresh objects, same ids
  assertEquals(a.slice.map((s) => s.id), b.slice.map((s) => s.id))
  assertEquals(a.nextCursor, b.nextCursor)
  assertEquals(a.hasMore, b.hasMore)
})

// ── Pre-filter ───────────────────────────────────────────────────────────

Deno.test('filterAlreadyLogged: set difference preserving order; empty log set is a passthrough', () => {
  const slice = subs(5)
  assertEquals(filterAlreadyLogged(slice, new Set()), slice)
  assertEquals(
    filterAlreadyLogged(slice, new Set(['sub-001', 'sub-003'])).map((s) => s.id),
    ['sub-000', 'sub-002', 'sub-004'],
  )
  assertEquals(filterAlreadyLogged(slice, new Set(slice.map((s) => s.id))), [])
})

// ── Chunk idempotency keys ───────────────────────────────────────────────

Deno.test('chunkIdempotencyKey: membership-deterministic and distinct across date/first-id/sessionTag', () => {
  const k = chunkIdempotencyKey('2026-08-13', 'sub-025', 'scheduled')
  assertEquals(k, 'digest-2026-08-13/chunk-sub-025/scheduled')
  assertEquals(k, chunkIdempotencyKey('2026-08-13', 'sub-025', 'scheduled')) // stable
  assertNotEquals(k, chunkIdempotencyKey('2026-08-14', 'sub-025', 'scheduled'))
  assertNotEquals(k, chunkIdempotencyKey('2026-08-13', 'sub-000', 'scheduled'))
  assertNotEquals(k, chunkIdempotencyKey('2026-08-13', 'sub-025', 'force-1755100000000'))
})

// ── Resend 409 classification ────────────────────────────────────────────

Deno.test('resolveChunkSendError: idempotency conflicts are replays, everything else is a real failure', () => {
  assertEquals(resolveChunkSendError({ name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different payload' }), 'replayed')
  assertEquals(resolveChunkSendError({ name: 'concurrent_idempotent_requests', message: 'Same idempotency key used while original request is in flight' }), 'replayed')
  assertEquals(resolveChunkSendError({ statusCode: 409, message: 'conflict' }), 'replayed')
  assertEquals(resolveChunkSendError({ name: 'validation_error', message: 'bad from address' }), 'failed')
  assertEquals(resolveChunkSendError({ name: 'rate_limit_exceeded', message: 'slow down' }), 'failed')
  assertEquals(resolveChunkSendError({ message: 'Batch send failed' }), 'failed')
  assertEquals(resolveChunkSendError(null), 'failed')
  assertEquals(resolveChunkSendError(undefined), 'failed')
})

// ═════════════════════════════════════════════════════════════════════════
// Scenario harness — a miniature of index.ts's per-link loop, built from
// the SAME pure pieces index.ts uses (sliceDue → filterAlreadyLogged →
// compose with batchLogIndex → chunkIdempotencyKey → upsert). The fake
// Resend records every accepted key and answers a retried key with the 409
// conflict the real API returns when the payload drifted; the fake
// email_sends table is a Map keyed by the per-subscriber idempotency key,
// upsert semantics. "matches" mirrors index.ts: 0 → 'skipped' (no email
// composed), -1 → render throws → 'failed' (no email composed).
// ═════════════════════════════════════════════════════════════════════════

interface FakeSub {
  id: string
  matches: number
}

interface Harness {
  resendAccepted: Map<string, number>   // chunk key → times ACCEPTED (dedupe: 1st only)
  resendCalls: number                   // every batch.send attempt
  emailSends: Map<string, SendLogEntry> // per-subscriber idempotency key → row
}

const newHarness = (): Harness => ({ resendAccepted: new Map(), resendCalls: 0, emailSends: new Map() })

const DATE = '2026-08-13'
const TAG = 'scheduled'

/**
 * Run one link. `crashBeforeUpsert` simulates the one dangerous window from
 * the memo: Resend accepted the chunk, then the isolate died before the
 * email_sends upsert. Returns what index.ts would decide, plus hasMore.
 */
function runLink(
  h: Harness,
  allSubs: FakeSub[],
  cursor: string | null,
  opts: { crashBeforeUpsert?: boolean } = {},
): { hasMore: boolean; nextCursor: string | null; sendLog: SendLogEntry[]; chunkKey: string | null } {
  // Keyset fetch: WHERE id > cursor ORDER BY id LIMIT SLICE_SIZE + 1
  const rows = allSubs
    .filter((s) => cursor === null || s.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, SLICE_SIZE + 1)

  const { slice, hasMore, nextCursor } = sliceDue(rows)

  // Scheduled pre-filter: subscriber ids already decided today.
  const loggedIds = new Set([...h.emailSends.values()].map((r) => r.subscriber_id))
  const subsToProcess = filterAlreadyLogged(slice, loggedIds)

  // Compose — mirrors index.ts's loop: sendLog gets one entry per processed
  // subscriber; emailBatch/batchLogIndex only for composed emails.
  const emailBatch: { to: string }[] = []
  const sendLog: SendLogEntry[] = []
  const batchLogIndex: number[] = []
  for (const sub of subsToProcess) {
    if (sub.matches === 0) {
      sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
      continue
    }
    if (sub.matches === -1) {
      sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'failed', error_message: 'render error' })
      continue
    }
    const logIndex = sendLog.length
    emailBatch.push({ to: sub.id })
    batchLogIndex.push(logIndex)
    sendLog.push({ subscriber_id: sub.id, event_count: sub.matches, status: 'sent' })
  }

  // One chunk per link (SLICE_SIZE < BATCH_SIZE) — send via fake Resend.
  let chunkKey: string | null = null
  if (emailBatch.length > 0) {
    chunkKey = chunkIdempotencyKey(DATE, sendLog[batchLogIndex[0]].subscriber_id, TAG)
    h.resendCalls++
    if (h.resendAccepted.has(chunkKey)) {
      // Key already used with a (drifted) payload → 409 conflict.
      const outcome = resolveChunkSendError({ name: 'invalid_idempotent_request', message: 'same key, different payload' })
      if (outcome === 'replayed') {
        for (const li of batchLogIndex.slice(0, emailBatch.length)) {
          sendLog[li].error_message = 'resend idempotency conflict (409): prior send accepted, recorded as sent'
        }
        // status stays 'sent' — NOT routed through markChunkFailed.
      } else {
        markChunkFailed(sendLog, batchLogIndex, 'unexpected')
      }
    } else {
      h.resendAccepted.set(chunkKey, 1) // accepted + delivered
    }
  }

  // Upsert on the per-subscriber idempotency key — unless this link crashed
  // in the window between Resend and the write.
  if (!opts.crashBeforeUpsert) {
    for (const row of sendLog) {
      h.emailSends.set(`digest-${DATE}/${row.subscriber_id}/${TAG}`, row)
    }
  }

  return { hasMore, nextCursor, sendLog, chunkKey }
}

/** Walk a full chain from cursor 0 to completion, like the sweep does. */
function runChain(h: Harness, allSubs: FakeSub[]): { links: number; chunkKeys: (string | null)[] } {
  let cursor: string | null = null
  let links = 0
  const chunkKeys: (string | null)[] = []
  for (;;) {
    const r = runLink(h, allSubs, cursor)
    links++
    chunkKeys.push(r.chunkKey)
    if (!r.hasMore) break
    cursor = r.nextCursor
    if (links > MAX_LINKS) throw new Error('runaway test chain')
  }
  return { links, chunkKeys }
}

const cohort = (n: number): FakeSub[] =>
  Array.from({ length: n }, (_, i) => ({ id: `sub-${String(i).padStart(3, '0')}`, matches: 3 }))

Deno.test('SCENARIO: a clean 60-subscriber chain runs 3 links, sends everyone exactly once', () => {
  const h = newHarness()
  const { links } = runChain(h, cohort(60))
  assertEquals(links, 3)                       // 25 + 25 + 10
  assertEquals(h.emailSends.size, 60)
  assertEquals(h.resendCalls, 3)
  assertEquals([...h.emailSends.values()].every((r) => r.status === 'sent'), true)
})

Deno.test('SCENARIO: crash-resume mid-chain — the sweep restarts at cursor 0, skips completed links, re-forms the crashed slice identically', () => {
  const all = cohort(60)
  const h = newHarness()

  // Original run: link 0 completes; link 1 CRASHES after Resend accepted the
  // chunk but before the upsert (the one dangerous window). Link 2 never runs.
  const l0 = runLink(h, all, null)
  assertEquals(h.emailSends.size, 25)
  const l1 = runLink(h, all, l0.nextCursor, { crashBeforeUpsert: true })
  const crashedKey = l1.chunkKey!
  assertEquals(h.emailSends.size, 25)          // nothing logged for link 1's slice
  assertEquals(h.resendAccepted.has(crashedKey), true) // but Resend HAS the chunk

  // Sweep: full chain from cursor 0.
  const resendCallsBefore = h.resendCalls
  const { links, chunkKeys } = runChain(h, all)

  // Link 0's slice was fully pre-filtered (processed 0, no Resend call);
  // link 1's slice re-formed IDENTICALLY → same membership → same chunk key
  // → Resend answered 409 → recorded as sent, not failed; link 2 sent fresh.
  assertEquals(links, 3)
  assertEquals(chunkKeys[0], null)             // nothing composed — zero Resend touch
  assertEquals(chunkKeys[1], crashedKey)       // deterministic slice ⇒ deterministic key
  assertEquals(h.resendCalls, resendCallsBefore + 2) // link 1 replay-409 + link 2 fresh
  assertEquals(h.emailSends.size, 60)
  assertEquals([...h.emailSends.values()].every((r) => r.status === 'sent'), true)
  // The replayed rows carry the note; no subscriber was double-delivered
  // (each accepted chunk key delivered once).
  const replayed = [...h.emailSends.values()].filter((r) => r.error_message?.includes('409'))
  assertEquals(replayed.length, 25)
  assertEquals([...h.resendAccepted.values()].every((n) => n === 1), true)
})

Deno.test('SCENARIO: sweep double-fire after full completion is a no-op with ZERO Resend calls', () => {
  const all = cohort(60)
  const h = newHarness()
  runChain(h, all)
  assertEquals(h.emailSends.size, 60)

  const callsBefore = h.resendCalls
  const sendsBefore = new Map(h.emailSends)
  const { chunkKeys } = runChain(h, all)       // 13:00 UTC sweep re-fire

  assertEquals(h.resendCalls, callsBefore)     // ZERO new Resend calls
  assertEquals(chunkKeys.every((k) => k === null), true)
  assertEquals(h.emailSends.size, 60)
  // Rows byte-identical — the sweep changed nothing.
  for (const [k, v] of sendsBefore) assertEquals(h.emailSends.get(k), v)
})

Deno.test('SCENARIO: 409 on a resumed chunk records sent-with-note for exactly the chunk members, untouched elsewhere', () => {
  const all = cohort(30)
  const h = newHarness()

  // Link 0 crashes after Resend, before upsert; then a resume replays it.
  const crashed = runLink(h, all, null, { crashBeforeUpsert: true })
  const resumed = runLink(h, all, null)

  assertEquals(resumed.chunkKey, crashed.chunkKey)
  assertEquals(resumed.sendLog.length, 25)
  for (const row of resumed.sendLog) {
    assertEquals(row.status, 'sent')           // NOT failed — the 409 branch bypasses markChunkFailed
    assert(row.error_message?.includes('409'))
  }
})

Deno.test('SCENARIO: skipped/render-failed interleave — chunk key comes from the first COMPOSED subscriber and failures land on the right rows', () => {
  // First two slice members never reach emailBatch: sub-000 matches zero
  // events ('skipped'), sub-001 throws in render ('failed'). This is the
  // exact divergence batchLogIndex exists for (see batch.test.ts).
  const all = cohort(30)
  all[0].matches = 0
  all[1].matches = -1

  const h = newHarness()
  const { sendLog, chunkKey } = runLink(h, all, null)

  // Key is named by the first subscriber IN THE CHUNK (first composed
  // email), not slice[0] — skipped/failed members are not chunk members.
  assertEquals(chunkKey, chunkIdempotencyKey(DATE, 'sub-002', TAG))
  assertEquals(sendLog[0], { subscriber_id: 'sub-000', event_count: 0, status: 'skipped' })
  assertEquals(sendLog[1].subscriber_id, 'sub-001')
  assertEquals(sendLog[1].status, 'failed')
  assertEquals(sendLog.filter((r) => r.status === 'sent').length, 23)

  // Replay the same link (sweep over an interleaved slice): the skipped and
  // render-failed rows were upserted too, so the pre-filter excludes them
  // along with the sent ones — nothing is re-composed, no Resend touch.
  const again = runLink(h, all, null)
  assertEquals(again.sendLog.length, 0)        // everyone in slice 0 was decided
  assertEquals(again.chunkKey, null)

  // And a genuine chunk failure routes through markChunkFailed onto exactly
  // the composed members' rows — proven in batch.test.ts; here we assert
  // the interleave keeps batchLogIndex non-contiguous so that machinery is
  // actually exercised by chain slices too.
  const composedIds = sendLog.filter((r) => r.status === 'sent').map((r) => r.subscriber_id)
  assertEquals(composedIds[0], 'sub-002')
  assertEquals(composedIds.includes('sub-000'), false)
  assertEquals(composedIds.includes('sub-001'), false)
})
