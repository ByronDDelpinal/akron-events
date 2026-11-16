/**
 * paginate.js — fetch every row of a PostgREST query, one page at a time.
 *
 * Supabase caps a single select at 1000 rows (the project's PostgREST
 * `max-rows`). Any script that does `.from('venues').select(...)` with no
 * `.range()` silently gets the first 1000 and nothing else, which is how the
 * venue sweeps started skipping rows once the table crossed that line.
 *
 * Import-safe: no env reads and no client import. The caller owns the client
 * and builds each page's query; this module only drives the loop.
 */

/**
 * Fetch all rows by repeatedly invoking `buildQuery` with successive
 * inclusive row ranges until a short page comes back.
 *
 * The CALLER applies `.range(from, to)` (plus its own select/filters/order)
 * inside `buildQuery`; the helper only chooses the bounds. Always include a
 * deterministic `.order(...)` (ideally ending in `.order('id')`) or pages can
 * overlap/skip rows between requests.
 *
 * @example
 *   const venues = await fetchAllRows((from, to) =>
 *     supabaseAdmin.from('venues').select('id, name').order('name').order('id').range(from, to))
 *
 * @param {(from: number, to: number) => PromiseLike<{ data?: any[] | null, error?: { message: string } | null }>} buildQuery
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<any[]>} every row, in page order
 * @throws {Error} the first PostgREST error message, aborting the loop
 */
export async function fetchAllRows(buildQuery, { pageSize = 1000 } = {}) {
  const all = []
  let from = 0
  for (;;) {
    const { data, error } = await buildQuery(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const page = data || []
    all.push(...page)
    if (page.length < pageSize) break
    from += pageSize
  }
  return all
}

/**
 * True when a PostgREST/Postgres error is a statement timeout (SQLSTATE 57014,
 * `canceling statement due to statement timeout`). These are load-dependent
 * and worth retrying; most other errors (bad column, RLS) are not.
 *
 * @param {{ code?: string, message?: string } | null | undefined} err
 * @returns {boolean}
 */
export function isStatementTimeout(err) {
  if (!err) return false
  return err.code === '57014' || /statement timeout/i.test(err.message || '')
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fetch all rows with keyset (cursor) pagination: each page asks for rows whose
 * `key` is greater than the last row of the previous page. Unlike OFFSET
 * paging, every page is an index range scan of the same cost, and rows can't
 * be skipped or repeated when the ordering is unique.
 *
 * The CALLER applies `.order(key)`, `.limit(pageSize)` and — when `lastKey` is
 * non-null — `.gt(key, lastKey)` inside `buildQuery`. `key` must be unique and
 * match the column the query orders by.
 *
 * A page that fails with a retryable error (default: statement timeout) is
 * retried up to `retries` times with exponential backoff (1s, 2s, 4s… plus
 * jitter). A non-retryable error, or the last error after retries run out,
 * is thrown as an Error carrying the PostgREST `code`.
 *
 * @example
 *   const events = await fetchAllRowsKeyset((after, n) => {
 *     const q = supabaseAdmin.from('events').select('id, title').order('id').limit(n)
 *     return after ? q.gt('id', after) : q
 *   })
 *
 * @param {(lastKey: any, pageSize: number) => PromiseLike<{ data?: any[] | null, error?: { message: string, code?: string } | null }>} buildQuery
 * @param {{
 *   pageSize?: number,
 *   key?: string,
 *   retries?: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   isRetryable?: (err: { message?: string, code?: string }) => boolean,
 * }} [opts]
 * @returns {Promise<any[]>} every row, in key order
 * @throws {Error} the PostgREST error message (with `.code`), aborting the loop
 */
export async function fetchAllRowsKeyset(buildQuery, {
  pageSize = 500,
  key = 'id',
  retries = 3,
  sleep = defaultSleep,
  isRetryable = isStatementTimeout,
} = {}) {
  const all = []
  let lastKey = null
  for (;;) {
    let page
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await buildQuery(lastKey, pageSize)
      if (!error) { page = data || []; break }
      if (attempt >= retries || !isRetryable(error)) {
        throw Object.assign(new Error(error.message), { code: error.code })
      }
      await sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250))
    }
    all.push(...page)
    if (page.length < pageSize) break
    lastKey = page[page.length - 1][key]
  }
  return all
}
