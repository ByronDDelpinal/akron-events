/**
 * test-middleware-preview.js — guards the crawler SSR rewrite in middleware.js.
 *
 * WHY THIS FILE EXISTS: from July 2026 until 2026-08-25 the event-detail regex
 * demanded a hex FIRST path segment (`/^\/events\/([a-f0-9-]{8,})/`), but every
 * real event URL carries the slug there. Nothing matched, ever. The rewrite
 * never fired, `api/preview/event/[id].js` was never reached, and every link
 * anyone shared unfurled as the bare SPA shell with no og:image. Byron found it
 * the way users do: "the share option doesn't seem to have the image."
 *
 * Nothing about that failure was visible in review, in CI, or in the app. The
 * only thing that would have caught it is this file: the two URL SHAPES that
 * exist in production, pinned against the pattern that has to match them.
 *
 * Imported from middleware.js directly, so it tests the SHIPPED regex rather
 * than a copy of it. `@vercel/edge` is only imported for the default export's
 * body, which this file never calls.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_PATH_PATTERN, CRAWLER_PATTERN } from '../../middleware.js'

// Real production values, copied from the database on 2026-08-25.
const UUID = '68ba09b8-8c2f-4a50-ab71-afb8b1d52115'
const SLUG = 'english-for-beginners-esol-classes-2026-45'

describe('the crawler rewrite matches the URLs production actually serves', () => {
  it('matches /events/<slug>/<uuid>, the shape the app links and shares', () => {
    const m = `/events/${SLUG}/${UUID}`.match(EVENT_PATH_PATTERN)
    assert.ok(m, 'the slug-prefixed detail URL MUST match. This is the shape every ' +
      'shared link, sitemap entry and in-app link uses; when it did not match, the ' +
      'entire crawler SSR path was dead for six weeks and no og:image ever reached ' +
      'an unfurler.')
    assert.equal(m[1], UUID, 'capture group 1 is handed to /api/preview/event/<id>')
  })

  it('matches the bare /events/<uuid> shape too', () => {
    // api/preview/event/[id].js emits exactly this as og:url, so a crawler
    // following that canonical link has to land back on the preview.
    const m = `/events/${UUID}`.match(EVENT_PATH_PATTERN)
    assert.ok(m)
    assert.equal(m[1], UUID)
  })

  it('tolerates a trailing slash on both shapes', () => {
    assert.ok(`/events/${UUID}/`.match(EVENT_PATH_PATTERN))
    assert.ok(`/events/${SLUG}/${UUID}/`.match(EVENT_PATH_PATTERN))
  })

  it('is case-insensitive about the uuid', () => {
    assert.ok(`/events/${SLUG}/${UUID.toUpperCase()}`.match(EVENT_PATH_PATTERN))
  })

  it('leaves every hub route alone', () => {
    // These live under the same /events/ prefix and are NOT detail pages. A
    // pattern loose enough to catch them would rewrite a browse page into a
    // single event's preview HTML for crawlers, which is worse than the bug
    // this file exists to prevent.
    for (const hub of [
      '/events/akron', '/events/this-weekend', '/events/today', '/events/concerts',
      '/events/cuyahoga-falls', '/events/stow', '/events',
    ]) {
      assert.equal(hub.match(EVENT_PATH_PATTERN), null, `${hub} must fall through to the SPA`)
    }
  })

  it('rejects a slug that merely looks hex-ish, and other near misses', () => {
    for (const bad of [
      '/events/deadbeefcafe',                    // hex-ish but not a uuid
      `/events/${UUID}extra`,                    // uuid with a tail
      `/events/${SLUG}/${UUID}/rsvp`,            // deeper path
      `/events/${UUID.slice(0, 30)}`,            // truncated uuid
      `/venues/${UUID}`,                         // different section
    ]) {
      assert.equal(bad.match(EVENT_PATH_PATTERN), null, `${bad} must not rewrite`)
    }
  })
})

describe('the crawler gate still recognises the clients that need SSR', () => {
  it('matches the unfurlers that actually fetch shared links', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Slackbot-LinkExpanding 1.0; +https://api.slack.com/robots)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'WhatsApp/2.19.81 A',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ]) {
      assert.ok(CRAWLER_PATTERN.test(ua), `${ua.slice(0, 40)} must get the SSR preview`)
    }
  })

  it('leaves real browsers on the SPA', () => {
    for (const ua of [
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
    ]) {
      assert.equal(CRAWLER_PATTERN.test(ua), false, 'a browser must hydrate the SPA, not read preview HTML')
    }
  })
})
