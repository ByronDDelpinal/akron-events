/**
 * test-tribe-events.js — unit tests for the shared Tribe REST pagination reader.
 *
 * The eleven scrapers this replaced had NO coverage of their page loops: their
 * tests exercised parsing, never pagination. These tests exist so the loop that
 * now runs for all of them is actually pinned down — page arithmetic, the
 * opt-in 400 handling, error text, and the fact that every varying knob really
 * is honoured per-caller.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchTribeEvents,
  DEFAULT_PER_PAGE,
  DEFAULT_PAGE_DELAY_MS,
} from '../lib/tribe-events.js'

const silent = () => {}

/** A fake fetch that serves a fixed set of pages and records every request. */
function fakeFeed(pages, { status = 200, body = '' } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init })
    if (status !== 200) {
      return { ok: false, status, text: async () => body, json: async () => ({}) }
    }
    const pageNum = Number(new URL(url).searchParams.get('page'))
    const payload = pages[pageNum - 1] ?? { events: [], total_pages: pages.length }
    return { ok: true, status: 200, json: async () => payload, text: async () => '' }
  }
  impl.calls = calls
  return impl
}

const base = {
  baseUrl: 'https://example.org/wp-json/tribe/events/v1/events',
  label: 'Example Source',
  startDate: '2026-07-15',
  endDate: '2027-01-11',
  userAgent: 'test-agent/1.0',
  pageDelayMs: 0,
  log: silent,
}

describe('fetchTribeEvents — required arguments', () => {
  it('refuses to run without a baseUrl or label', async () => {
    await assert.rejects(() => fetchTribeEvents({ ...base, baseUrl: undefined }), TypeError)
    await assert.rejects(() => fetchTribeEvents({ ...base, label: undefined }), TypeError)
    await assert.rejects(() => fetchTribeEvents(), TypeError)
  })
})

describe('fetchTribeEvents — pagination', () => {
  it('returns a single page in feed order', async () => {
    const fetchImpl = fakeFeed([{ events: [{ id: 1 }, { id: 2 }], total_pages: 1 }])
    const out = await fetchTribeEvents({ ...base, fetchImpl })
    assert.deepEqual(out.map(e => e.id), [1, 2])
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('walks every page and concatenates in order', async () => {
    const fetchImpl = fakeFeed([
      { events: [{ id: 1 }], total_pages: 3 },
      { events: [{ id: 2 }], total_pages: 3 },
      { events: [{ id: 3 }], total_pages: 3 },
    ])
    const out = await fetchTribeEvents({ ...base, fetchImpl })
    assert.deepEqual(out.map(e => e.id), [1, 2, 3])
    assert.equal(fetchImpl.calls.length, 3)
    assert.deepEqual(fetchImpl.calls.map(c => c.url.searchParams.get('page')), ['1', '2', '3'])
  })

  it('stops after one page when total_pages is missing', async () => {
    // The `?? 1` fallback: a feed with no total_pages must not loop forever.
    const fetchImpl = fakeFeed([{ events: [{ id: 1 }] }])
    const out = await fetchTribeEvents({ ...base, fetchImpl })
    assert.equal(out.length, 1)
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('handles an empty feed without error', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    assert.deepEqual(await fetchTribeEvents({ ...base, fetchImpl }), [])
  })

  it('tolerates a page with no events key', async () => {
    const fetchImpl = fakeFeed([{ total_pages: 2 }, { events: [{ id: 9 }], total_pages: 2 }])
    const out = await fetchTribeEvents({ ...base, fetchImpl })
    assert.deepEqual(out.map(e => e.id), [9])
  })
})

describe('fetchTribeEvents — stopOnEmptyPage is opt-in', () => {
  const feed = () => fakeFeed([
    { events: [{ id: 1 }], total_pages: 3 },
    { events: [],          total_pages: 3 },
    { events: [{ id: 3 }], total_pages: 3 },
  ])

  it('keeps walking past an empty page by default', async () => {
    const fetchImpl = feed()
    const out = await fetchTribeEvents({ ...base, fetchImpl })
    assert.deepEqual(out.map(e => e.id), [1, 3])
    assert.equal(fetchImpl.calls.length, 3)
  })

  it('stops at the first empty page when the caller opted in', async () => {
    // Players Guild and Summit Metro Parks rely on this; without the flag they
    // would start requesting pages they have never requested.
    const fetchImpl = feed()
    const out = await fetchTribeEvents({ ...base, fetchImpl, stopOnEmptyPage: true })
    assert.deepEqual(out.map(e => e.id), [1])
    assert.equal(fetchImpl.calls.length, 2)
  })
})

describe('fetchTribeEvents — request shape', () => {
  it('sends the query parameters every source expects', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl, perPage: 25 })
    const { searchParams } = fetchImpl.calls[0].url
    assert.equal(searchParams.get('per_page'),   '25')
    assert.equal(searchParams.get('page'),       '1')
    assert.equal(searchParams.get('start_date'), '2026-07-15')
    assert.equal(searchParams.get('end_date'),   '2027-01-11')
    assert.equal(searchParams.get('status'),     'publish')
  })

  it('defaults the page size to 50', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl })
    assert.equal(fetchImpl.calls[0].url.searchParams.get('per_page'), String(DEFAULT_PER_PAGE))
    assert.equal(DEFAULT_PER_PAGE, 50)
  })

  it('passes the caller User-Agent through, since sources sit behind different bot challenges', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl, userAgent: 'AkronPulse-bot/1.0' })
    assert.equal(fetchImpl.calls[0].init.headers['User-Agent'], 'AkronPulse-bot/1.0')
    assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/json')
    assert.equal(fetchImpl.calls[0].init.redirect, 'follow')
  })

  it('omits User-Agent entirely when the caller does not supply one', async () => {
    // The proxied sources rely on their fetcher's own UA. Forcing one here
    // would change what the bot challenge sees.
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl, userAgent: undefined })
    assert.ok(!('User-Agent' in fetchImpl.calls[0].init.headers))
    assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/json')
  })

  it('merges caller headers last so they can override the defaults', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl, headers: { Accept: 'text/html', 'X-Trace': 'abc' } })
    assert.equal(fetchImpl.calls[0].init.headers.Accept, 'text/html')
    assert.equal(fetchImpl.calls[0].init.headers['X-Trace'], 'abc')
  })

  it('forwards fetchOptions to the fetcher for proxy and retry control', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    const retryStatuses = new Set([429, 503])
    await fetchTribeEvents({
      ...base,
      fetchImpl,
      fetchOptions: { useProxy: true, treatBotChallengeAsRetryable: true, retryStatuses },
    })
    const { init } = fetchImpl.calls[0]
    assert.equal(init.useProxy, true)
    assert.equal(init.treatBotChallengeAsRetryable, true)
    assert.equal(init.retryStatuses, retryStatuses)
  })

  it('supports several quiet-stop statuses, not just 400', async () => {
    // Islamic Society answers 404 the way other sources answer 400.
    const fetchImpl = fakeFeed([], { status: 404, body: 'not found' })
    assert.deepEqual(await fetchTribeEvents({ ...base, fetchImpl, emptyStatuses: [400, 404] }), [])
    const strict = fakeFeed([], { status: 404, body: 'not found' })
    await assert.rejects(
      () => fetchTribeEvents({ ...base, fetchImpl: strict, emptyStatuses: [400] }),
      /Example Source API error 404/,
    )
  })

  it('preserves an existing query string on the base URL', async () => {
    const fetchImpl = fakeFeed([{ events: [], total_pages: 1 }])
    await fetchTribeEvents({ ...base, fetchImpl, baseUrl: `${base.baseUrl}?categories=music` })
    assert.equal(fetchImpl.calls[0].url.searchParams.get('categories'), 'music')
  })
})

describe('fetchTribeEvents — HTTP 400 is opt-in', () => {
  it('stops quietly on 400 when the caller opted in', async () => {
    const fetchImpl = fakeFeed([], { status: 400, body: 'no results' })
    const out = await fetchTribeEvents({ ...base, fetchImpl, emptyStatuses: [400] })
    assert.deepEqual(out, [])
  })

  it('throws on 400 when the caller did NOT opt in', async () => {
    // This asymmetry is the whole reason the flag exists: collapsing it would
    // either swallow real failures or start throwing on quiet calendars.
    const fetchImpl = fakeFeed([], { status: 400, body: 'no results' })
    await assert.rejects(
      () => fetchTribeEvents({ ...base, fetchImpl, emptyStatuses: [] }),
      /Example Source API error 400: no results/,
    )
  })

  it('keeps events collected before a 400 that ends the walk', async () => {
    let n = 0
    const fetchImpl = async () => {
      n++
      if (n === 1) return { ok: true, status: 200, json: async () => ({ events: [{ id: 1 }], total_pages: 5 }), text: async () => '' }
      return { ok: false, status: 400, text: async () => 'no results', json: async () => ({}) }
    }
    const out = await fetchTribeEvents({ ...base, fetchImpl, emptyStatuses: [400] })
    assert.deepEqual(out.map(e => e.id), [1])
  })
})

describe('fetchTribeEvents — errors', () => {
  it('reports the label, status and body', async () => {
    const fetchImpl = fakeFeed([], { status: 503, body: 'upstream down' })
    await assert.rejects(
      () => fetchTribeEvents({ ...base, fetchImpl }),
      /Example Source API error 503: upstream down/,
    )
  })

  it('truncates the error body to 200 chars by default', async () => {
    const fetchImpl = fakeFeed([], { status: 500, body: 'x'.repeat(500) })
    await assert.rejects(() => fetchTribeEvents({ ...base, fetchImpl }), (err) => {
      const body = err.message.split(': ').at(-1)
      assert.equal(body.length, 200)
      return true
    })
  })

  it('keeps the whole body when the caller asks for it', async () => {
    const fetchImpl = fakeFeed([], { status: 500, body: 'y'.repeat(500) })
    await assert.rejects(
      () => fetchTribeEvents({ ...base, fetchImpl, errorBodyLimit: Infinity }),
      (err) => err.message.split(': ').at(-1).length === 500,
    )
  })

  it('lets a transport failure propagate untouched', async () => {
    const boom = new Error('ECONNRESET')
    await assert.rejects(
      () => fetchTribeEvents({ ...base, fetchImpl: async () => { throw boom } }),
      (err) => err === boom,
    )
  })
})

describe('fetchTribeEvents — pacing', () => {
  it('exposes the delay the scrapers already used', () => {
    assert.equal(DEFAULT_PAGE_DELAY_MS, 200)
  })

  it('does not pause after the final page', async () => {
    const fetchImpl = fakeFeed([{ events: [{ id: 1 }], total_pages: 1 }])
    const started = Date.now()
    await fetchTribeEvents({ ...base, fetchImpl, pageDelayMs: 60 })
    assert.ok(Date.now() - started < 50, 'single-page read should not sleep')
  })

  it('pauses between pages', async () => {
    const fetchImpl = fakeFeed([
      { events: [{ id: 1 }], total_pages: 2 },
      { events: [{ id: 2 }], total_pages: 2 },
    ])
    const started = Date.now()
    await fetchTribeEvents({ ...base, fetchImpl, pageDelayMs: 40 })
    assert.ok(Date.now() - started >= 35, 'multi-page read should sleep between pages')
  })
})

describe('fetchTribeEvents — logging', () => {
  it('reports progress per page in the established format', async () => {
    const lines = []
    const fetchImpl = fakeFeed([
      { events: [{ id: 1 }, { id: 2 }], total_pages: 2 },
      { events: [{ id: 3 }], total_pages: 2 },
    ])
    await fetchTribeEvents({ ...base, fetchImpl, log: (l) => lines.push(l) })
    assert.deepEqual(lines, [
      '  Page 1/2: 2 events (total: 2)',
      '  Page 2/2: 1 events (total: 3)',
    ])
  })
})
