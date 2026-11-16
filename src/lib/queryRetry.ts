/**
 * One automatic retry for read queries that failed for a reason a second
 * attempt usually fixes.
 *
 * Why this exists (2026-11-12): the database runs on a small instance, and a
 * query that has to touch a few thousand pages that have gone cold can take
 * seconds the first time and milliseconds the second. The first attempt hits
 * the anon role's 3s statement_timeout (Postgres 57014, surfaced by PostgREST
 * as HTTP 500) and the visitor saw "Couldn't load events" for a query that
 * succeeds if simply asked again -- the failed attempt has already warmed the
 * pages it needs.
 *
 * Scope is deliberately narrow:
 *   - 57014 (statement timeout), and
 *   - 502 / 503 / 504 from the gateway or PostgREST's connection pool.
 * supabase-js already retries GETs on network failures and Cloudflare 520s, so
 * those are not repeated here. Anything else (4xx, a real SQL error) is a bug
 * a retry cannot fix and is returned as-is.
 */

/** The parts of a supabase-js response this module reads. */
export interface QueryOutcome {
  error: unknown
  status?: number
}

const STATEMENT_TIMEOUT = '57014'
const RETRYABLE_STATUSES = [502, 503, 504]

/** Delay before the second attempt. Short: the failed attempt did the warming. */
export const RETRY_DELAY_MS = 300

export function isTransientQueryError(outcome: QueryOutcome): boolean {
  const { error, status } = outcome
  if (!error) return false
  const code = typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  if (code === STATEMENT_TIMEOUT) return true
  return typeof status === 'number' && RETRYABLE_STATUSES.includes(status)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run a query; if it fails transiently, wait briefly and run it once more.
 *
 * `run` must BUILD a fresh query on each call: a supabase-js builder is a
 * one-shot thenable and cannot be awaited twice. The second outcome is
 * returned whatever it is -- one retry, never a loop.
 */
export async function withOneRetry<T extends QueryOutcome>(
  run: () => PromiseLike<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  const first = await run()
  if (!isTransientQueryError(first)) return first
  await sleep(RETRY_DELAY_MS)
  return run()
}
