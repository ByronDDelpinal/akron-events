/**
 * test-share-kit.js — the partner share kit (Tier 0).
 *
 * Pins the things that would break the feature silently:
 *   - the two captions are DIFFERENT in the way that matters: Facebook
 *     carries a link, Instagram carries none. One caption reused on both is
 *     the failure this feature exists to prevent, and it looks fine in code
 *     review;
 *   - the Facebook SHARER url stays untagged while the caption url is
 *     tagged (a utm variant Facebook has never crawled can unfurl bare);
 *   - the size table matches the renderer's own, so a ?size= the UI offers
 *     can never be one the route silently falls back on;
 *   - the route actually reads ?size= and actually returns the size it was
 *     handed, rather than hardcoding 1200x630 anywhere.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import {
  SHARE_SIZES,
  SIZE_DIMENSIONS,
  DEFAULT_SIZE,
  SITE_HOST,
  FACEBOOK_EVENT_CREATE_URL,
  shareImagePath,
  taggedEventUrl,
  shareDialogUrl,
  facebookSharerUrl,
  shareDateLine,
  sharePriceLine,
  tagify,
  shareHashtags,
  facebookCaption,
  instagramCaption,
  captionFor,
  SHARE_TITLE,
  FACEBOOK_HINT,
  INSTAGRAM_HINT,
} from '../../src/lib/admin/shareShared.ts'
import { THEMES } from '../../src/lib/themes.ts'

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

const EV = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Spread the Word Sundays with DJ Brainwreck',
  path: '/events/spread-the-word-sundays-with-dj-brainwreck-sep-6/11111111-2222-3333-4444-555555555555',
  // 2026-09-07T01:00:00Z is Sunday Sep 6, 9 PM Eastern. The UTC date is the
  // 7th, which is exactly the bug an Eastern-blind formatter would ship.
  startAt: '2026-09-07T01:00:00.000Z',
  venueName: 'Royal Palace',
  priceMin: 0,
  priceMax: null,
  categories: ['music'],
}

// ── The two captions ────────────────────────────────────────────────────

describe('the captions differ where it counts', () => {
  it('Facebook carries the event url, Instagram carries none', () => {
    assert.ok(facebookCaption(EV).includes(SITE_HOST),
      'the link is the payload of a Facebook post: it is what unfurls into a card')
    assert.ok(!instagramCaption(EV).includes(SITE_HOST),
      'Instagram renders no clickable links in captions, so a url there is dead characters ' +
      'that still LOOK like a link to a reader')
    assert.ok(!instagramCaption(EV).includes('http'))
  })

  it('Instagram says where the link actually is', () => {
    assert.match(instagramCaption(EV), /link in bio/i)
  })

  it('Instagram carries hashtags and Facebook does not', () => {
    assert.ok(instagramCaption(EV).includes('#AkronEvents'))
    assert.ok(!facebookCaption(EV).includes('#'),
      'hashtags do nothing for reach on Facebook and read as imported from Instagram')
  })

  it('captionFor routes to the right one', () => {
    assert.equal(captionFor(EV, 'facebook'), facebookCaption(EV))
    assert.equal(captionFor(EV, 'instagram'), instagramCaption(EV))
  })

  it('has no em dashes, same as every other partner-facing string', () => {
    for (const s of [facebookCaption(EV), instagramCaption(EV), SHARE_TITLE, FACEBOOK_HINT, INSTAGRAM_HINT]) {
      assert.ok(!s.includes('—'), `em dash in: ${s.slice(0, 60)}`)
    }
  })

  it('both name the event, the day and the venue', () => {
    for (const cap of [facebookCaption(EV), instagramCaption(EV)]) {
      assert.ok(cap.includes(EV.title))
      assert.ok(cap.includes('Royal Palace'))
      assert.ok(cap.includes('September 6'))
    }
  })
})

// ── Dates are Eastern, not UTC ──────────────────────────────────────────

describe('shareDateLine', () => {
  it('reads the instant in Eastern, not UTC', () => {
    // Naively formatted this is "Monday, September 7 at 1 AM".
    assert.equal(shareDateLine(EV.startAt), 'Sunday, September 6 at 9 PM')
  })

  it('drops :00 minutes and keeps the rest', () => {
    assert.match(shareDateLine('2026-09-07T01:30:00.000Z'), /9:30 PM$/)
  })

  it('takes a joiner so Instagram can stack it', () => {
    assert.equal(shareDateLine(EV.startAt, ' · '), 'Sunday, September 6 · 9 PM')
  })

  it('is empty, never "Invalid Date", on junk', () => {
    assert.equal(shareDateLine(null), '')
    assert.equal(shareDateLine('not a date'), '')
  })
})

// ── Price ───────────────────────────────────────────────────────────────

describe('the caption drops the price clause when we do not know it', () => {
  const unknown = { ...EV, priceMin: null, priceMax: null }

  it('facebook says nothing about price rather than "Free"', () => {
    const cap = facebookCaption(unknown)
    assert.ok(!/free/i.test(cap), 'a caption must not invent a price:\n' + cap)
  })

  it('instagram drops it too, and keeps the venue line intact', () => {
    const cap = instagramCaption(unknown)
    assert.ok(!/free/i.test(cap))
    assert.ok(cap.includes(EV.venueName), 'the venue must survive an empty price')
  })

  it('an explicit zero still says Free on both', () => {
    const free = { ...EV, priceMin: 0, priceMax: 0 }
    assert.match(facebookCaption(free), /Free/)
    assert.match(instagramCaption(free), /Free/)
  })
})

describe('the card follows the palette the partner picked', () => {
  const ID = 'a1b2c3d4-0000-4000-8000-000000000001'

  it('passes the theme through to the renderer', () => {
    const p = shareImagePath(ID, 'square', 'postcard')
    assert.ok(p.includes('theme=postcard'))
    assert.ok(p.includes('size=square'))
  })

  it('omits the theme entirely when there is none, so the ramp stays the default', () => {
    // Every public link unfurl goes through this route with no theme at all.
    // A stray `theme=` or `theme=undefined` would be a silent behaviour change
    // for every share on the open web.
    const p = shareImagePath(ID, 'link', null)
    assert.ok(!p.includes('theme='), p)
    assert.ok(!p.includes('size='), 'link is the renderer default and stays implicit')
  })

  it('every theme in the picker has a gradient in the renderer', () => {
    // Satori cannot read themes.css, so the ramps are inlined in the route.
    // Ship a sixteenth palette without touching that table and the card would
    // quietly fall back to the category ramp for it, which nobody would see
    // until a partner posted one.
    const route = read('api/og/event/[id].js')
    const table = route.slice(route.indexOf('const THEME_GRADIENTS'), route.indexOf('const SCRIM'))
    for (const t of THEMES) {
      assert.ok(table.includes(`'${t.id}':`), `no card gradient for theme "${t.id}"`)
    }
  })

  it('an unknown theme falls back rather than erroring', () => {
    const route = read('api/og/event/[id].js')
    assert.ok(/THEME_GRADIENTS\[raw\]\) \|\| null/.test(route),
      'resolveThemeGradient must return null for anything it does not know')
  })
})

describe('sharePriceLine', () => {
  it('zero is Free, but UNKNOWN is not', () => {
    assert.equal(sharePriceLine(0, null), 'Free')
    assert.equal(sharePriceLine(0, 0), 'Free')
    // The one that matters: null means nobody recorded a price, and 2,563 of
    // 5,190 published upcoming events are in exactly that state. Calling them
    // free advertises a price we never had, in the partner's voice, on
    // ticketed events included. The site says "See tickets" here; a caption
    // says nothing at all.
    assert.equal(sharePriceLine(null, null), '',
      'an unknown price must never render as Free')
  })
  it('a single price, a range, and no stray cents', () => {
    assert.equal(sharePriceLine(12, null), '$12')
    assert.equal(sharePriceLine(12, 12), '$12')
    assert.equal(sharePriceLine(12, 20), '$12 to $20')
    // A free floor is named, not printed as $0: partners post this text.
    assert.equal(sharePriceLine(0, 12.51), 'Free to $12.51')
    assert.equal(sharePriceLine(12.5, null), '$12.50')
  })
})

// ── Hashtags ────────────────────────────────────────────────────────────

describe('shareHashtags', () => {
  it('caps the block rather than filling it', () => {
    const tags = shareHashtags({ ...EV, categories: ['music', 'art', 'food', 'sports', 'fitness'] })
    assert.ok(tags.length <= 6, 'a wall of tags reads as spam on a small local account')
  })
  it('never repeats a tag', () => {
    const tags = shareHashtags({ ...EV, categories: ['music', 'music'] })
    assert.equal(new Set(tags.map((t) => t.toLowerCase())).size, tags.length)
  })
  it('turns a venue name into one tag', () => {
    assert.equal(tagify('Royal Palace'), 'RoyalPalace')
    assert.equal(tagify("Blu Jazz+"), 'BluJazz')
    assert.equal(tagify('Rock & Roll Hall'), 'RockAndRollHall')
    assert.equal(tagify(null), '')
    assert.equal(tagify('!!!'), '', 'a name with nothing taggable in it produces no tag, not "#"')
  })
  it('an unmapped category is skipped, never emitted raw', () => {
    const tags = shareHashtags({ ...EV, categories: ['definitely-not-a-category'] })
    assert.ok(!tags.some((t) => t.includes('definitely')))
  })
})

// ── URLs ────────────────────────────────────────────────────────────────

describe('urls', () => {
  it('the caption url is tagged and the sharer url is NOT', () => {
    assert.ok(taggedEventUrl(EV.path, 'facebook').includes('utm_source=facebook'))
    assert.ok(!shareDialogUrl(EV.path).includes('utm_'),
      "Facebook caches an unfurl per exact url; a utm variant it has never crawled can come " +
      'back as a bare link with no card, losing the image this whole kit exists to produce')
    assert.ok(!facebookSharerUrl(EV.path).includes('utm_'))
  })

  it('the sharer url is the dialog, encoded', () => {
    assert.ok(facebookSharerUrl(EV.path).startsWith('https://www.facebook.com/sharer/sharer.php?u='))
    assert.ok(facebookSharerUrl(EV.path).includes(encodeURIComponent(shareDialogUrl(EV.path))))
  })

  it('the event composer is a bare url, because it takes no prefill', () => {
    assert.equal(FACEBOOK_EVENT_CREATE_URL, 'https://www.facebook.com/events/create')
    assert.ok(!FACEBOOK_EVENT_CREATE_URL.includes('?'),
      'nobody can prefill this form. A query string here would be cargo cult.')
  })

  it('the default size omits ?size= so the og:image url never changes', () => {
    assert.ok(!shareImagePath(EV.id, 'link').includes('size='),
      'the 1200x630 is the og:image every existing caller already asks for; adding a parameter ' +
      'to it would fork the edge cache for no reason')
    assert.ok(shareImagePath(EV.id, 'square').includes('size=square'))
    assert.ok(shareImagePath(EV.id, 'story').includes('size=story'))
  })
})

// ── The UI opens on the right size for the surface ──────────────────────

describe('defaults', () => {
  it('Facebook opens on the link card, Instagram on the square', () => {
    assert.equal(DEFAULT_SIZE.facebook, 'link',
      'a Facebook link post builds its own card, so the partner downloads nothing')
    assert.equal(DEFAULT_SIZE.instagram, 'square',
      'Instagram has no unfurl to lean on, so the image IS the post')
  })
})

// ── The renderer agrees with the table the UI reads ─────────────────────

describe('the og route and the share kit cannot drift', () => {
  const route = 'api/og/event/[id].js'
  const src = read(route)

  it('the route exists and reads ?size=', () => {
    assert.ok(existsSync(new URL(`../../${route}`, import.meta.url)))
    assert.ok(/searchParams\.get\('size'\)/.test(src),
      'the UI offers three sizes; if the route never reads the parameter they all render the same')
  })

  it('every size the UI offers is a size the route declares', () => {
    for (const size of SHARE_SIZES) {
      assert.ok(new RegExp(`\\b${size}:\\s*\\{`).test(src), `${route} has no ${size} entry`)
    }
  })

  it('the dimensions match, both ways', () => {
    for (const size of SHARE_SIZES) {
      const { w, h } = SIZE_DIMENSIONS[size]
      const block = src.slice(src.indexOf(`${size}: {`))
      assert.ok(new RegExp(`width:\\s*${w},\\s*height:\\s*${h}`).test(block.slice(0, 200)),
        `${size} is ${w}x${h} in shareShared.ts but not in ${route}`)
    }
  })

  it('the narrow frames step down to a smaller title sooner than the wide one', () => {
    // What decides line count is maxTextWidth/fontSize -- about 12 characters
    // of em on link, 8.8 on square, 7.9 on story. Sharing one pair of
    // thresholds sizes link right and overruns the other two on exactly the
    // long titles the heuristic exists for.
    const breaks = {}
    for (const size of SHARE_SIZES) {
      const block = src.slice(src.indexOf(`${size}: {`))
      const m = block.slice(0, 400).match(/titleBreaks:\s*\[(\d+),\s*(\d+)\]/)
      assert.ok(m, `${size} has no titleBreaks`)
      breaks[size] = [Number(m[1]), Number(m[2])]
    }
    assert.ok(breaks.square[0] < breaks.link[0], 'square is narrower than link, so it must break sooner')
    assert.ok(breaks.story[0] < breaks.square[0], 'and story is narrower still')
    for (const size of SHARE_SIZES) {
      assert.ok(breaks[size][0] < breaks[size][1], `${size} thresholds must ascend`)
    }
  })

  it('the tiers are read from the table, not from a literal', () => {
    assert.ok(/size\.titleBreaks\[1\]/.test(src) && /size\.titleTiers\[2\]/.test(src),
      'a literal 80 or 54 here would apply one frame\'s sizing to all three')
  })

  it('the response is sized from the table, never hardcoded', () => {
    assert.ok(/width:\s*size\.width/.test(src) && /height:\s*size\.height/.test(src),
      'a hardcoded 1200x630 on the ImageResponse would silently ignore ?size= while the ' +
      'preview in the dialog showed the right aspect ratio')
    assert.ok(!/\{ width: 1200, height: 630 \}/.test(src),
      'the last hardcoded pair was the fallback image, which has to follow the request too: a ' +
      '1200x630 in an Instagram Story slot is a bug the partner sees and we do not')
  })
})

// ── The dialog wires to the pure layer ──────────────────────────────────

describe('the dialog does not reinvent any of this', () => {
  const comp = read('src/pages/admin/partner/PartnerShareDialog.tsx')

  it('takes every string and url from shareShared', () => {
    assert.ok(comp.includes("from '@/lib/admin/shareShared'"))
    assert.ok(!/https:\/\/www\.facebook\.com/.test(comp),
      'a url built inline here is a url the tests above cannot pin')
    assert.ok(!/#Akron/.test(comp), 'and so is a hashtag')
  })

  it('reports a failed clipboard write instead of claiming success', () => {
    assert.ok(/COPY_FAILED_TOAST/.test(comp),
      'clipboard writes are permission-gated and fail silently; "Copied." over a failed write ' +
      'sends a partner to paste nothing')
  })

  it('does not report the user closing the share sheet as an error', () => {
    assert.ok(/AbortError/.test(comp))
  })
})
