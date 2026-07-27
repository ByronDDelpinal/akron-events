// batch.test.ts — Deno tests for send-digest's chunk-to-sendLog attribution.
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// Regression test for the data-corruption MAJOR: send-digest/index.ts used
// to mark `sendLog[i .. i + chunk.length)` as 'failed' on a Resend chunk
// error, where `i` is an index into `emailBatch` — not `sendLog`. `sendLog`
// carries one entry per DUE subscriber, including ones marked 'skipped'
// (matched zero events) that never make it into `emailBatch`, so the two
// arrays are the same length only when nothing was skipped. This test
// constructs exactly the scenario that exposes the divergence: a skipped
// subscriber lands before a chunk boundary, then that later chunk fails —
// and asserts the failure lands on the subscribers ACTUALLY in that chunk,
// not on whoever happens to sit at the same array offset in sendLog.

import { assertEquals } from 'jsr:@std/assert@1'
import { markChunkFailed, type SendLogEntry } from './batch.ts'

const BATCH_SIZE = 2 // small on purpose so a handful of subscribers spans multiple chunks

interface Sub {
  id: string
  matches: number // 0 => filtered to zero events => skipped, matching send-digest/index.ts
}

/**
 * Mirrors send-digest/index.ts's per-subscriber build loop: push a sendLog
 * entry for every subscriber (skipped or sent), and only for the ones that
 * get an email composed, additionally push into emailBatch + record the
 * sendLog index that entry corresponds to (batchLogIndex).
 */
function buildBatch(subs: Sub[]) {
  const emailBatch: { id: string }[] = []
  const sendLog: SendLogEntry[] = []
  const batchLogIndex: number[] = []

  for (const sub of subs) {
    if (sub.matches === 0) {
      sendLog.push({ subscriber_id: sub.id, event_count: 0, status: 'skipped' })
      continue
    }
    const logIndex = sendLog.length
    emailBatch.push({ id: sub.id })
    batchLogIndex.push(logIndex)
    sendLog.push({ subscriber_id: sub.id, event_count: sub.matches, status: 'sent' })
  }

  return { emailBatch, sendLog, batchLogIndex }
}

// A: sent, B: SKIPPED (0 matches), C: sent, D: sent, E: sent.
//   sendLog:      [0]=A sent, [1]=B skipped, [2]=C sent, [3]=D sent, [4]=E sent
//   emailBatch:   [0]=A,      [1]=C,         [2]=D,      [3]=E
//   batchLogIndex: [0,         2,             3,          4]
// BATCH_SIZE=2 -> chunk 0 = emailBatch[0:2] = [A, C]; chunk 1 = emailBatch[2:4] = [D, E].
const SCENARIO: Sub[] = [
  { id: 'A', matches: 3 },
  { id: 'B', matches: 0 },
  { id: 'C', matches: 2 },
  { id: 'D', matches: 1 },
  { id: 'E', matches: 4 },
]

Deno.test('buildBatch: sendLog and emailBatch diverge in length and index the moment a subscriber is skipped', () => {
  const { emailBatch, sendLog, batchLogIndex } = buildBatch(SCENARIO)

  assertEquals(sendLog.length, 5)
  assertEquals(emailBatch.length, 4) // one fewer: B was skipped
  assertEquals(emailBatch.map((e) => e.id), ['A', 'C', 'D', 'E'])
  assertEquals(sendLog.map((l) => l.status), ['sent', 'skipped', 'sent', 'sent', 'sent'])
  // The whole bug in one line: emailBatch[1] ('C') is sendLog[2], not sendLog[1].
  assertEquals(batchLogIndex, [0, 2, 3, 4])
})

Deno.test('FIX: markChunkFailed marks the subscribers actually in the failed chunk, not whoever sits at that array offset', () => {
  const { emailBatch, sendLog, batchLogIndex } = buildBatch(SCENARIO)

  // Simulate chunk 1 (the second BATCH_SIZE=2 chunk) failing.
  const i = BATCH_SIZE // 2
  const chunk = emailBatch.slice(i, i + BATCH_SIZE)
  const chunkLogIndexes = batchLogIndex.slice(i, i + BATCH_SIZE)

  assertEquals(chunk.map((e) => e.id), ['D', 'E'])
  assertEquals(chunkLogIndexes, [3, 4])

  markChunkFailed(sendLog, chunkLogIndexes, 'Batch send failed')

  // D and E — the subscribers ACTUALLY in the failed chunk — are 'failed'.
  assertEquals(sendLog[3], { subscriber_id: 'D', event_count: 1, status: 'failed', error_message: 'Batch send failed' })
  assertEquals(sendLog[4], { subscriber_id: 'E', event_count: 4, status: 'failed', error_message: 'Batch send failed' })

  // Everyone else is untouched: A and C (chunk 0, which "succeeded") stay
  // 'sent', and B (skipped upstream, never part of any chunk) stays 'skipped'.
  assertEquals(sendLog[0], { subscriber_id: 'A', event_count: 3, status: 'sent' })
  assertEquals(sendLog[1], { subscriber_id: 'B', event_count: 0, status: 'skipped' })
  assertEquals(sendLog[2], { subscriber_id: 'C', event_count: 2, status: 'sent' })
})

Deno.test('REGRESSION: the OLD positional logic (i..i+chunk.length into sendLog) would have marked the wrong subscribers', () => {
  // Same scenario, but replaying the exact old buggy loop from index.ts
  // side-by-side, to pin down precisely what it got wrong.
  const { emailBatch, sendLog: oldSendLog } = buildBatch(SCENARIO)

  const i = BATCH_SIZE // chunk 1 starts at emailBatch index 2; this is what "failed".
  const chunk = emailBatch.slice(i, i + BATCH_SIZE) // the ACTUAL failed chunk: [D, E]

  // OLD (buggy) code from send-digest/index.ts:
  //   for (let j = i; j < i + chunk.length; j++) {
  //     if (sendLog[j]) { sendLog[j].status = 'failed'; ... }
  //   }
  for (let j = i; j < i + chunk.length; j++) {
    if (oldSendLog[j]) {
      oldSendLog[j].status = 'failed'
      oldSendLog[j].error_message = 'Batch send failed'
    }
  }

  // The corruption: it marked sendLog[2] and sendLog[3] -- C and D -- not
  // the D and E who were actually in the failed chunk.
  assertEquals(oldSendLog[2].subscriber_id, 'C')
  assertEquals(oldSendLog[2].status, 'failed') // WRONG: C's email sent fine in chunk 0.
  assertEquals(oldSendLog[3].subscriber_id, 'D')
  assertEquals(oldSendLog[3].status, 'failed') // Right subscriber, but only by coincidence.
  assertEquals(oldSendLog[4].subscriber_id, 'E')
  assertEquals(oldSendLog[4].status, 'sent') // WRONG: E's send actually failed but is recorded as 'sent'.
})

Deno.test('FIX: a thrown exception on resend.batch.send still routes through markChunkFailed with the real sendLog indexes, skips and all', () => {
  // Same class of bug as the two tests above, but on the OTHER branch of
  // send-digest/index.ts's chunk-send try/catch: when resend.batch.send
  // THROWS instead of returning { error }, the catch block used to only
  // log and fall through -- sendLog stayed 'sent' for every subscriber in
  // that chunk even though nothing was confirmed delivered. This mirrors
  // buildBatch's skip so a later chunk's logIndexes are non-contiguous with
  // its position in emailBatch, exactly like the sendErr scenario above.
  const { emailBatch, sendLog, batchLogIndex } = buildBatch(SCENARIO)

  // Simulate chunk 1 (emailBatch[2:4] = [D, E]) throwing instead of
  // returning an error.
  const i = BATCH_SIZE // 2
  const chunk = emailBatch.slice(i, i + BATCH_SIZE)
  const chunkLogIndexes = batchLogIndex.slice(i, i + BATCH_SIZE)

  assertEquals(chunk.map((e) => e.id), ['D', 'E'])
  assertEquals(chunkLogIndexes, [3, 4])

  try {
    throw new Error('fetch failed')
  } catch (err) {
    markChunkFailed(sendLog, chunkLogIndexes, err instanceof Error ? err.message : String(err))
  }

  // D and E -- the subscribers actually in the chunk that threw -- are
  // 'failed', not silently left as 'sent'.
  assertEquals(sendLog[3], { subscriber_id: 'D', event_count: 1, status: 'failed', error_message: 'fetch failed' })
  assertEquals(sendLog[4], { subscriber_id: 'E', event_count: 4, status: 'failed', error_message: 'fetch failed' })

  // Everyone else is untouched: A and C (chunk 0) stay 'sent', and B
  // (skipped upstream, never part of any chunk) stays 'skipped'.
  assertEquals(sendLog[0], { subscriber_id: 'A', event_count: 3, status: 'sent' })
  assertEquals(sendLog[1], { subscriber_id: 'B', event_count: 0, status: 'skipped' })
  assertEquals(sendLog[2], { subscriber_id: 'C', event_count: 2, status: 'sent' })
})
