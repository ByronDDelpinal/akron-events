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
