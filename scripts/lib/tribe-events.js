/**
 * tribe-events.js — paginated reader for The Events Calendar (Tribe) REST API.
 *
 * `wp-json/tribe/events/v1/events` is the single most common shape in this
 * project: twenty-odd WordPress sources expose it. Each scraper had hand-rolled
 * the same page loop — build the URL, fetch, read `data.events`, compare `page`
 * against `data.total_pages`, sleep, repeat — and each copy was one more place
 * for an off-by-one to hide. This is the single implementation.
 *
 * DESIGN NOTE — every knob that differed between the copies is an explicit
 * parameter, deliberately NOT normalised to a house default:
 *
 *   • `emptyStatuses` — Tribe answers 400 with a "no results" code when the
 *     date window is empty. Some sources rely on that, one also treats 404 the
 *     same way, and others have never returned either and treat both as genuine
 *     failures. Forcing every caller onto one behaviour would either swallow
 *     real errors or start throwing on quiet calendars.
 *   • `userAgent` / `headers` / `fetchOptions` — sources sit behind different
 *     bot challenges. The proxied sources deliberately send NO `User-Agent`
 *     (their fetcher supplies one) and pass their own `useProxy` /
 *     `retryStatuses` options, so none of this can be hardcoded here.
 *   • `errorBodyLimit` — most callers truncate the error body to 200 chars;
 *     two deliberately keep the whole thing.
 *   • `fetchImpl` — several sources must route through the retrying/proxied
 *     fetcher rather than global `fetch`. Passing it in keeps that choice at
 *     the call site, where the egress decision belongs.
 *   • `stopOnEmptyPage` — Players Guild and Summit Metro Parks additionally
 *     stop the moment a page comes back empty, rather than trusting
 *     `total_pages`. Two sources out of eleven, and dropping the guard would
 *     make them walk pages they currently never request.
 *
 * If you find yourself wanting to collapse these, that is a product decision
 * about each source, not a refactor.
 *
 * NOT MIGRATED, on purpose — five sources still hand-roll their loop:
 *   • `scrape-missing-falls`, `scrape-summit-artspace`, `scrape-torchbearers`
 *     read the response body once and sniff it for an HTML error page before
 *     parsing JSON. That is real per-source response handling, not pagination,
 *     and folding it in here would either drop the guard or bloat this module
 *     with a body-inspection hook used by three callers.
 *   • `scrape-akronym` and `scrape-village-of-reminderville` do not use this
 *     page shape at all (no `total_pages` walk).
 * Adding a `parseResponse` hook would let the first three join. That is worth
 * doing only if a fourth source needs it.
 */

/** Tribe's default page size across every source in this project. */
export const DEFAULT_PER_PAGE = 50

/** Polite pause between pages, matching the value the scrapers already used. */
export const DEFAULT_PAGE_DELAY_MS = 200

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read every page of a Tribe events feed and return the raw event objects.
 *
 * @param {object}   options
 * @param {string}   options.baseUrl            Full `…/wp-json/tribe/events/v1/events` URL.
 * @param {string}   options.label              Human name, used in log and error text.
 * @param {string}   options.startDate          `start_date` query value.
 * @param {string}   options.endDate            `end_date` query value.
 * @param {string}  [options.userAgent]         `User-Agent` header. Omit for
 *   fetchers that supply their own.
 * @param {object}  [options.headers]           Extra request headers, merged last.
 * @param {object}  [options.fetchOptions]      Extra options merged into the
 *   fetch init — `useProxy`, `retryStatuses` and friends for the retrying fetcher.
 * @param {number}  [options.perPage]           Page size. Defaults to 50.
 * @param {Function}[options.fetchImpl]         Fetch implementation. Defaults to global `fetch`.
 * @param {number[]}[options.emptyStatuses]     Statuses meaning "no results" —
 *   stop the walk quietly instead of throwing. Defaults to none.
 * @param {boolean} [options.stopOnEmptyPage]   Stop as soon as a page is empty,
 *   without trusting `total_pages`. Defaults to false.
 * @param {number}  [options.pageDelayMs]       Pause between pages. Defaults to 200.
 * @param {number}  [options.errorBodyLimit]    Chars of error body to include. Defaults to 200.
 * @param {Function}[options.log]               Logger. Defaults to `console.log`.
 * @returns {Promise<object[]>} Every raw event across all pages, in feed order.
 */
export async function fetchTribeEvents({
  baseUrl,
  label,
  startDate,
  endDate,
  userAgent,
  headers = {},
  fetchOptions = {},
  perPage = DEFAULT_PER_PAGE,
  fetchImpl = fetch,
  emptyStatuses = [],
  stopOnEmptyPage = false,
  pageDelayMs = DEFAULT_PAGE_DELAY_MS,
  errorBodyLimit = 200,
  log = console.log,
} = {}) {
  if (!baseUrl) throw new TypeError('fetchTribeEvents: baseUrl is required')
  if (!label)   throw new TypeError('fetchTribeEvents: label is required')

  const quietStop = new Set(emptyStatuses)
  const all = []
  let page = 1
  let hasMore = true

  while (hasMore) {
    const url = new URL(baseUrl)
    url.searchParams.set('per_page',   perPage)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetchImpl(url.toString(), {
      headers: {
        Accept: 'application/json',
        ...(userAgent ? { 'User-Agent': userAgent } : {}),
        ...headers,
      },
      redirect: 'follow',
      ...fetchOptions,
    })

    // Tribe returns 400 with a "no results" code when the window is empty, and
    // one source answers 404 the same way. Only sources that actually do this
    // opt in; see the design note.
    if (quietStop.has(res.status)) break

    if (!res.ok) {
      throw new Error(`${label} API error ${res.status}: ${(await res.text()).slice(0, errorBodyLimit)}`)
    }

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = (!stopOnEmptyPage || events.length > 0) && page < (data.total_pages ?? 1)
    page++
    if (hasMore && pageDelayMs > 0) await sleep(pageDelayMs)
  }

  return all
}
