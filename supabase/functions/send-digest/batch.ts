// batch.ts — pure helper for attributing a failed Resend batch-send chunk
// back to the correct sendLog entries.
//
// code-reviewer, 2026-07-27, MAJOR: index.ts used to walk `sendLog[i..i +
// chunk.length)` where `i` is an index into `emailBatch`. `sendLog` carries
// one entry per DUE subscriber (including ones marked 'skipped' because they
// matched zero events, or 'failed' during render), while `emailBatch` only
// carries subscribers who actually got an email composed. The two arrays are
// the same length only when nothing was skipped — the moment any subscriber
// is skipped, every later positional index into sendLog is off, and a Resend
// chunk failure marks the WRONG subscribers 'failed' in email_sends.
//
// The fix: track each emailBatch entry's real sendLog index explicitly
// (`logIndex`) as it's built, then use that recorded index — never a
// recomputed position — to mark failures. This module is deliberately kept
// free of any Resend/Supabase imports so it can be unit-tested directly
// (index.ts creates live clients at module load via `Deno.env.get(...)`
// and is not import-safe on its own).

export interface SendLogEntry {
  subscriber_id: string
  event_count: number
  status: string
  error_message?: string
}

/**
 * Mark every sendLog entry named by `logIndexes` as 'failed'. `logIndexes`
 * must be the actual sendLog indices recorded when each emailBatch entry was
 * built (see `send-digest/index.ts`), not a range recomputed from the
 * emailBatch/chunk position — that recomputation is exactly the bug this
 * function exists to make impossible to reintroduce.
 */
export function markChunkFailed(
  sendLog: SendLogEntry[],
  logIndexes: number[],
  message: string,
): void {
  for (const logIndex of logIndexes) {
    const entry = sendLog[logIndex]
    if (entry) {
      entry.status = 'failed'
      entry.error_message = message
    }
  }
}
