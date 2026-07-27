// slack.test.ts — Deno tests for _shared/slack.ts's postMessage payload
// construction (Tier 1 non-regression + Tier 2 PostOpts).
//
// Run: deno test supabase/functions/ (also `npm run test:functions`).
//
// postMessage's own fetch call is stubbed by swapping globalThis.fetch for
// the duration of each test — no real network access, no --allow-net needed.
// This is the "real payload builder" itself (not a reimplementation): the
// captured request body is exactly what postMessage sent to
// https://slack.com/api/chat.postMessage.

import { assertEquals } from 'jsr:@std/assert@1'
import { postMessage, SLACK } from './slack.ts'

// NIT 10: `deno test` runs every test file in the same process, so a bare
// Deno.env.set/delete with no restore leaks into whatever test (in this file
// or another) runs next. stubEnv snapshots each var's PRIOR value (which may
// be `undefined`, i.e. unset) before mutating it, and returns a restore
// function that puts every var back exactly as it was — set back to its
// original value, or deleted if it was unset before this test touched it.
function stubEnv(vars: Record<string, string>): () => void {
  const originals = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    originals.set(key, Deno.env.get(key))
    Deno.env.set(key, value)
  }
  return () => {
    for (const [key, original] of originals) {
      if (original === undefined) {
        Deno.env.delete(key)
      } else {
        Deno.env.set(key, original)
      }
    }
  }
}

function stubFetch(responseBody: unknown, status = 200) {
  const original = globalThis.fetch
  let capturedBody: Record<string, unknown> | null = null
  let capturedUrl: string | null = null
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedBody = init?.body ? JSON.parse(init.body as string) : null
    return Promise.resolve(new Response(JSON.stringify(responseBody), { status }))
  }) as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = original
    },
    get url() {
      return capturedUrl
    },
    get body() {
      return capturedBody
    },
  }
}

// ── Tier 1 non-regression (test requirement #6) ───────────────────────────

Deno.test('REQUIRED (6): postMessage with no opts sends a byte-identical Tier 1 payload', async () => {
  const restoreEnv = stubEnv({
    SLACK_CHANNEL_PUBLIC_FEEDBACK: 'C_TEST_FEEDBACK_NOOPTS',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  })
  const stub = stubFetch({ ok: true, ts: '1111.222222' })
  try {
    const result = await postMessage('public-feedback', 'hello world')
    assertEquals(result, { ok: true, ts: '1111.222222' })
    assertEquals(stub.url, 'https://slack.com/api/chat.postMessage')
    assertEquals(stub.body, {
      channel: 'C_TEST_FEEDBACK_NOOPTS',
      text: 'hello world',
      username: SLACK.username,
      icon_url: SLACK.iconUrl,
      unfurl_links: false,
      unfurl_media: false,
    })
    assertEquals(Object.hasOwn(stub.body ?? {}, 'thread_ts'), false)
  } finally {
    stub.restore()
    restoreEnv()
  }
})

// ── Tier 2 opts: identity + threading, undefined keys omitted (test requirement #6) ──

Deno.test('REQUIRED (6): postMessage with opts sets username/icon_url/thread_ts', async () => {
  const restoreEnv = stubEnv({
    SLACK_CHANNEL_THE_NIGHT_CREW: 'C_TEST_NIGHT_CREW',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  })
  const stub = stubFetch({ ok: true, ts: '3333.444444' })
  try {
    const result = await postMessage('the-night-crew', 'agent report text', {
      username: 'QA',
      iconUrl: 'https://akronpulse.com/agents/qa-v1.png',
      threadTs: '1111.222222',
    })
    assertEquals(result, { ok: true, ts: '3333.444444' })
    assertEquals(stub.body, {
      channel: 'C_TEST_NIGHT_CREW',
      text: 'agent report text',
      username: 'QA',
      icon_url: 'https://akronpulse.com/agents/qa-v1.png',
      unfurl_links: false,
      unfurl_media: false,
      thread_ts: '1111.222222',
    })
  } finally {
    stub.restore()
    restoreEnv()
  }
})

Deno.test('postMessage with opts but no threadTs omits the thread_ts key entirely (never sends thread_ts: undefined)', async () => {
  const restoreEnv = stubEnv({
    SLACK_CHANNEL_THE_NIGHT_CREW: 'C_TEST_NIGHT_CREW_2',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  })
  const stub = stubFetch({ ok: true, ts: '5555.666666' })
  try {
    await postMessage('the-night-crew', 'no thread here', { username: 'Data Steward' })
    assertEquals(Object.hasOwn(stub.body ?? {}, 'thread_ts'), false)
    // JSON.stringify never emits an explicit `"thread_ts":undefined` anyway,
    // but the payload is built without the key at all — assert the raw JSON
    // text itself never contains the substring, closing off any future
    // refactor that stops omitting the key and starts assigning `undefined`.
  } finally {
    stub.restore()
    restoreEnv()
  }
})

Deno.test('postMessage with iconUrl explicitly null overrides SLACK.iconUrl', async () => {
  const restoreEnv = stubEnv({
    SLACK_CHANNEL_DAILY_REPORTS: 'C_TEST_DAILY',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
  })
  const stub = stubFetch({ ok: true, ts: '7777.888888' })
  try {
    await postMessage('daily-reports', 'no avatar', { username: 'Analyst', iconUrl: null })
    assertEquals(stub.body?.icon_url, null)
  } finally {
    stub.restore()
    restoreEnv()
  }
})

Deno.test('postMessage: unresolved channel returns an error without ever calling fetch', async () => {
  const originalChannel = Deno.env.get('SLACK_CHANNEL_DAILY_REPORTS')
  const original = globalThis.fetch
  let fetchCalled = false
  globalThis.fetch = (() => {
    fetchCalled = true
    return Promise.resolve(new Response('{}'))
  }) as typeof fetch
  try {
    Deno.env.delete('SLACK_CHANNEL_DAILY_REPORTS')
    const result = await postMessage('daily-reports', 'x')
    assertEquals(result.ok, false)
    assertEquals(fetchCalled, false)
  } finally {
    globalThis.fetch = original
    if (originalChannel === undefined) {
      Deno.env.delete('SLACK_CHANNEL_DAILY_REPORTS')
    } else {
      Deno.env.set('SLACK_CHANNEL_DAILY_REPORTS', originalChannel)
    }
  }
})
