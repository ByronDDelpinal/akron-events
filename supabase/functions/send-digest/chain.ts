// chain.ts — pure helpers for send-digest's self-chaining invocations.
//
// Background (2026-08-13): the scheduled run CPU-faulted ("CPU Time exceeded",
// isolate code 546) at 91 due subscribers × ~1000 events, because the whole
// cohort filtered + rendered in ONE invocation. The fix (see the approved
// design memo, digest-cpu-fix-design.md) is a chain of invocations: each link
// processes a fixed slice of subscribers, then re-invokes the function with a
// keyset cursor via EdgeRuntime.waitUntil. A 13:00 UTC pg_cron "sweep"
// (migration 057) re-fires the same URL as crash recovery; idempotency makes
// any overlap or replay harmless.
//
// This module is deliberately free of Deno/Supabase/Resend imports (the
// batch.ts pattern) so every decision the chain makes — continuation-body
// parsing, slice math, chunk idempotency keys, the runaway guards, and
// Resend-409 classification — is unit-testable without env vars or a live
// runtime. index.ts owns the I/O; this module owns the logic.

/**
 * Subscribers processed per link. From the observed numbers: 91 subs blew the
 * ~2s CPU budget; fixed cost (parse/flatten ~1000 joined rows) is ~300–500ms
 * and per-subscriber cost ~16–19ms, so 25 subs ≈ 0.9s — under half the
 * budget, tolerating 2× event growth or 2× per-sub cost. Matches the existing
 * `only:` mode cap of 25 (which is also why `only:` never needs to chain).
 */
export const SLICE_SIZE = 25

/**
 * Runaway guard: no legitimate chain is longer than this (50 links × 25 subs
 * = 1250 subscribers; current scale is ~150). A link counter above this means
 * a loop or a forged body — abort with a FATAL log, never keep fetching.
 */
export const MAX_LINKS = 50

/**
 * Continuation body carried between links as `{ continue: {...} }`.
 *
 * date / dow / first are PINNED at link 0 so every link agrees on due-ness
 * and key dates even if the chain straddles midnight UTC or the 1st of the
 * month. cursor is the last subscriber id the previous link's slice covered
 * (keyset pagination: next link queries `id > cursor`). sessionTag carries
 * the idempotency session ('scheduled', or the `force-<ts>` tag minted at
 * link 0 of a force run, so keys stay consistent within one force run).
 * link is a 0-based counter; continuation bodies therefore always have
 * link >= 1.
 */
export interface ContinuationBody {
  date: string       // YYYY-MM-DD, pinned at link 0
  dow: number        // 0=Sun..6=Sat, pinned at link 0
  first: boolean     // first-of-month, pinned at link 0
  cursor: string     // last subscriber id covered by the previous link
  sessionTag: string // 'scheduled' | 'force-<ts>'
  link: number       // this link's index (>= 1 for continuations)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SESSION_TAG_RE = /^(scheduled|force-\d+)$/

/**
 * Parse + validate an untrusted `continue` body. Returns null on any shape
 * violation — the caller aborts the request rather than guessing. Strict on
 * purpose: the self-invocation endpoint is reachable by anyone holding the
 * cron bearer, and a malformed body should die loudly, not half-run.
 */
export function parseContinuation(raw: unknown): ContinuationBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const c = raw as Record<string, unknown>
  const { date, dow, first, cursor, sessionTag, link } = c
  if (typeof date !== 'string' || !DATE_RE.test(date)) return null
  if (typeof dow !== 'number' || !Number.isInteger(dow) || dow < 0 || dow > 6) return null
  if (typeof first !== 'boolean') return null
  if (typeof cursor !== 'string' || cursor.length === 0) return null
  if (typeof sessionTag !== 'string' || !SESSION_TAG_RE.test(sessionTag)) return null
  if (typeof link !== 'number' || !Number.isInteger(link) || link < 1) return null
  return { date, dow, first, cursor, sessionTag, link }
}

/**
 * Build the next link's continuation from this link's pinned parameters.
 * Everything except cursor/link passes through untouched — that is the
 * whole point (date/dow/first/sessionTag are decided once, at link 0).
 */
export function buildContinuation(
  pinned: { date: string; dow: number; first: boolean; sessionTag: string; link: number },
  nextCursor: string,
): ContinuationBody {
  return {
    date: pinned.date,
    dow: pinned.dow,
    first: pinned.first,
    cursor: nextCursor,
    sessionTag: pinned.sessionTag,
    link: pinned.link + 1,
  }
}

/**
 * Runaway guards for a continuation link. Returns a human-readable reason to
 * abort (caller logs it as FATAL and returns without touching Resend), or
 * null when the link may proceed. `todayUtc` is the CURRENT invocation's
 * UTC date — a chain whose pinned date no longer matches it has leaked
 * across midnight (or is replaying a stale/forged body) and must stop:
 * due-ness and every idempotency key were computed for a day that is over.
 */
export function chainGuardError(cont: ContinuationBody, todayUtc: string): string | null {
  if (cont.link > MAX_LINKS) {
    return `chain link ${cont.link} exceeds MAX_LINKS=${MAX_LINKS} — runaway chain`
  }
  if (cont.date !== todayUtc) {
    return `chain date ${cont.date} != today ${todayUtc} — stale or cross-midnight chain`
  }
  return null
}

/**
 * Slice math for the keyset page. The subscriber query fetches
 * SLICE_SIZE + 1 rows (lookahead): the presence of a 26th row is the ONLY
 * signal that more subscribers remain — no count query races with it.
 * The slice is the first SLICE_SIZE rows; nextCursor is the last id the
 * slice covers (the 26th row is NOT consumed — the next link re-fetches it
 * as its first row via `id > nextCursor`).
 *
 * Deterministic by construction: same rows in → same slice out, which is
 * what makes a retried link reproduce the same Resend chunk key.
 */
export function sliceDue<T extends { id: string }>(
  rows: T[],
  sliceSize: number = SLICE_SIZE,
): { slice: T[]; hasMore: boolean; nextCursor: string | null } {
  const slice = rows.slice(0, sliceSize)
  const hasMore = rows.length > sliceSize
  const nextCursor = slice.length > 0 ? slice[slice.length - 1].id : null
  return { slice, hasMore, nextCursor }
}

/**
 * Already-logged pre-filter (scheduled mode only): set-difference the slice
 * against subscriber_ids that already have an email_sends row for today's
 * scheduled session (any status — sent, skipped, or failed all mean "this
 * subscriber was already decided today"). Order is preserved. This is what
 * makes the 13:00 sweep re-fire of a COMPLETED chain a no-op (every slice
 * filters to empty → zero Resend calls), and what makes a mid-chain crash
 * resumable from cursor 0 without re-sending the finished links.
 */
export function filterAlreadyLogged<T extends { id: string }>(
  subs: T[],
  loggedIds: ReadonlySet<string>,
): T[] {
  if (loggedIds.size === 0) return subs
  return subs.filter((s) => !loggedIds.has(s.id))
}

/**
 * Membership-deterministic Resend batch idempotency key.
 *
 * The old key was positional (`chunk-<i>`), which is only stable if every
 * retry rebuilds the exact same full cohort in the exact same order — false
 * the moment a resumed run starts from a different cursor. The new key is
 * named by the chunk's own membership: the subscriber id of the FIRST email
 * in the chunk. Slicing is deterministic (sliceDue + filterAlreadyLogged
 * preserve id order), so any retry of the same slice reproduces the same
 * key and Resend dedupes the send. SLICE_SIZE (25) < BATCH_SIZE (100), so
 * a chain link is always exactly one chunk.
 */
export function chunkIdempotencyKey(date: string, firstSubscriberId: string, sessionTag: string): string {
  return `digest-${date}/chunk-${firstSubscriberId}/${sessionTag}`
}

// Resend 409 error names for idempotency-key conflicts (see Resend's error
// list). invalid_idempotent_request: same key, different payload — the key
// exists at Resend, so a prior invocation's send WAS accepted; our retry
// merely re-rendered with a slightly newer `now`. concurrent_idempotent_requests:
// same key, first request still in flight — the other invocation is
// delivering this exact chunk right now.
const IDEMPOTENCY_CONFLICT_NAMES: ReadonlySet<string> = new Set([
  'invalid_idempotent_request',
  'concurrent_idempotent_requests',
])

/**
 * Classify a Resend batch.send error. 'replayed' means an idempotency-key
 * conflict: the only way that key exists at Resend is a prior accepted send
 * of this same deterministic chunk (the crash-after-Resend-before-upsert
 * window, or a double-fired link). The caller records those rows as sent
 * with a note and MUST NOT route them through markChunkFailed — marking
 * genuinely-delivered emails 'failed' would invite a manual re-send and a
 * duplicate email. Everything else is 'failed' (real batch failure).
 */
export function resolveChunkSendError(
  err: { name?: string; message?: string; statusCode?: number } | null | undefined,
): 'replayed' | 'failed' {
  if (!err) return 'failed'
  if (typeof err.name === 'string' && IDEMPOTENCY_CONFLICT_NAMES.has(err.name)) return 'replayed'
  if (err.statusCode === 409) return 'replayed'
  return 'failed'
}
