/**
 * shareShared.ts
 *
 * Every pure decision the partner share kit makes, plus every string it
 * says. No React, no Supabase, no DOM, no runtime imports, so `node --test`
 * can load it directly the way test-partner-ui.js loads partnerShared.ts.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * A partner cannot publish a Facebook EVENT from here, and neither can we.
 * Meta removed `create_event` from the Graph API in 2014 and never replaced
 * it; Instagram has no event object at all. Anything that promises "export
 * your event to Facebook" is lying about what the platform allows.
 *
 * So the kit does the honest version: it hands the partner a finished image
 * and a finished caption, and gets out of the way. Two clicks and a paste.
 * No Meta app, no app review, no OAuth, no tokens, and nothing to break
 * when Meta next changes its permission model.
 *
 * ── THE TWO CAPTIONS ────────────────────────────────────────────────────
 *
 * Facebook and Instagram get DIFFERENT text, and that is the whole point of
 * the feature rather than an embellishment on it. Instagram renders no
 * links in captions, so a URL there is dead characters a reader cannot
 * click; Facebook unfurls the link into a card, so the URL is the most
 * valuable thing in the post. One caption for both would be wrong on one of
 * them every time.
 */

/** The image sizes /api/og/event/[id] renders. Mirrors its SIZES table. */
export const SHARE_SIZES = ['link', 'square', 'story'] as const
export type ShareSize = (typeof SHARE_SIZES)[number]

export const SIZE_LABELS: Record<ShareSize, string> = {
  link: 'Link',
  square: 'Square',
  story: 'Story',
}

/** Pixel dimensions per size, pinned against the route's own table. */
export const SIZE_DIMENSIONS: Record<ShareSize, { w: number; h: number }> = {
  link: { w: 1200, h: 630 },
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
}

export type ShareTarget = 'facebook' | 'instagram'

/**
 * The size each target opens on.
 *
 * Facebook opens on `link` because a link post builds its own card from the
 * page's og:image: the partner downloads nothing, they just post the URL.
 * Instagram opens on `square` because there is no unfurl to lean on, so the
 * image IS the post.
 */
export const DEFAULT_SIZE: Record<ShareTarget, ShareSize> = {
  facebook: 'link',
  instagram: 'square',
}

export const SITE_HOST = 'akronpulse.com'
const SITE_BASE = `https://${SITE_HOST}`

export interface ShareEvent {
  id: string
  title: string
  /** Canonical path from lib/slug's eventPath, e.g. /events/night-market-sep-6/uuid */
  path: string
  startAt: string | null
  venueName: string | null
  priceMin: number | null
  priceMax: number | null
  /** Category slugs, in the order the event carries them. */
  categories: string[]
}

// ── URLs ────────────────────────────────────────────────────────────────

/**
 * The share image for one event at one size, in one theme.
 *
 * `theme` is the palette the person is looking at right now, so the card they
 * hand their followers is their own brand rather than the category ramp the
 * open web gets. Omitted (or unknown to the renderer) falls back to that ramp,
 * which is what every public link unfurl still uses.
 *
 * Relative, so it is same-origin fetchable for the download path.
 */
export function shareImagePath(eventId: string, size: ShareSize, theme?: string | null): string {
  const id = encodeURIComponent(eventId)
  const q = size === 'link' ? '' : `&size=${size}`
  const t = theme ? `&theme=${encodeURIComponent(theme)}` : ''
  return `/api/og/event/${id}?id=${id}${q}${t}`
}

/**
 * The public event URL, UTM-tagged, for pasting INTO a caption.
 *
 * Not for the sharer dialog: see shareDialogUrl. Matches ShareButtons.tsx's
 * scheme (utm_source = platform, utm_medium = share) so partner shares land
 * in the same report as reader shares rather than a parallel one.
 */
export function taggedEventUrl(path: string, target: ShareTarget): string {
  return `${SITE_BASE}${path}?utm_source=${target}&utm_medium=share&utm_campaign=partner`
}

/**
 * The URL handed to Facebook's sharer, deliberately UNTAGGED.
 *
 * Facebook's crawler caches an unfurl per exact URL. A utm-tagged variant it
 * has never scraped can come back as a bare link with no card, which loses
 * the image the whole kit exists to produce. The clean canonical is the one
 * that has been crawled, so the dialog gets that and the caption carries the
 * tagged copy.
 */
export function shareDialogUrl(path: string): string {
  return `${SITE_BASE}${path}`
}

/** Facebook's share dialog. Takes a URL and nothing else: message prefill was removed. */
export function facebookSharerUrl(path: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareDialogUrl(path))}`
}

/**
 * Facebook's event composer.
 *
 * It accepts NO prefill parameters, from us or from anybody. The partner
 * lands on an empty form with the caption already on their clipboard, which
 * is the trade that keeps this feature small.
 */
export const FACEBOOK_EVENT_CREATE_URL = 'https://www.facebook.com/events/create'

// ── Formatting ──────────────────────────────────────────────────────────

/**
 * "Sunday, September 6 at 9 PM".
 *
 * Reads the instant in Eastern, which is where every event in this corpus
 * happens, via the same Intl route easternDate.ts uses. A caption is written
 * for a reader standing in Akron, not for the viewer's own timezone.
 */
export function shareDateLine(iso: string | null, joiner = ' at '): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const minute = get('minute')
  const time = `${get('hour')}${minute === '00' ? '' : `:${minute}`} ${get('dayPeriod')}`
  return `${get('weekday')}, ${get('month')} ${get('day')}${joiner}${time}`
}

/**
 * "Free", "$12", "$12 to $20", or '' when we do not know.
 *
 * NULL IS UNKNOWN, NOT FREE, and the distinction is the whole point of this
 * function. Until 2026-08-25 a null price fell through `min ?? 0` and came
 * out as "Free": 2,563 of 5,190 published upcoming events carry no price at
 * all, so half the catalog would have been advertised as free in a partner's
 * own voice, ticketed events included. The site has always drawn this line
 * the same way (`formatPrice` in src/lib/eventFormatting.ts answers "See
 * tickets" for null and "Free" only for an explicit zero); this now agrees
 * with it.
 *
 * A caption omits the clause entirely rather than saying "See tickets",
 * because a sentence a partner posts should not tell their followers to go
 * find a price we never had. Both captions already drop an empty string.
 */
export function sharePriceLine(min: number | null, max: number | null): string {
  if (min == null && max == null) return ''
  const lo = min ?? 0
  if (lo === 0 && (max == null || max === 0)) return 'Free'
  if (max == null || max === lo) return `$${trimMoney(lo)}`
  // "$0 to $12.51" is how a spreadsheet says it. A caption a partner posts
  // says the free part out loud, because "free" is the word that makes
  // somebody stop scrolling.
  if (lo === 0) return `Free to $${trimMoney(max)}`
  return `$${trimMoney(lo)} to $${trimMoney(max)}`
}

function trimMoney(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// ── Hashtags ────────────────────────────────────────────────────────────

/** Always present: the two that make a post findable at all locally. */
const BASE_TAGS = ['AkronEvents', 'ThingsToDoAkron']

const CATEGORY_TAGS: Record<string, string> = {
  music: 'AkronMusic',
  art: 'AkronArt',
  food: 'AkronFood',
  theater: 'AkronTheatre',
  film: 'AkronFilm',
  comedy: 'AkronComedy',
  sports: 'AkronSports',
  fitness: 'AkronFitness',
  outdoors: 'AkronOutdoors',
  nature: 'AkronOutdoors',
  learning: 'AkronLearning',
  education: 'AkronLearning',
  festivals: 'AkronFestivals',
  markets: 'AkronMarkets',
  community: 'AkronCommunity',
  civic: 'AkronCommunity',
  nonprofit: 'AkronNonprofit',
  family: 'AkronFamily',
}

/** PascalCase a venue or org name into one tag. '' when nothing survives. */
export function tagify(name: string | null | undefined): string {
  if (!name) return ''
  const words = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return ''
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}

/**
 * The hashtag block, deduped and capped.
 *
 * Capped at six on purpose. Instagram allows thirty and the temptation is to
 * use thirty; a wall of tags reads as spam to a human and the reach past the
 * first handful is not worth the way it makes a small local account look.
 */
export function shareHashtags(ev: ShareEvent, max = 6): string[] {
  const out: string[] = []
  const push = (tag: string) => {
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag)
  }
  push(BASE_TAGS[0])
  for (const c of ev.categories) push(CATEGORY_TAGS[c] ?? '')
  push(tagify(ev.venueName))
  push('Akron')
  push(BASE_TAGS[1])
  return out.slice(0, max)
}

// ── The captions ────────────────────────────────────────────────────────

/**
 * Facebook: prose, and the URL is the payload.
 *
 * One paragraph a person would actually write, then the link on its own
 * line where the unfurl attaches. No hashtags: they do nothing for reach on
 * Facebook and read as imported-from-Instagram.
 */
export function facebookCaption(ev: ShareEvent): string {
  const when = shareDateLine(ev.startAt)
  const price = sharePriceLine(ev.priceMin, ev.priceMax)
  const where = ev.venueName ? ` at ${ev.venueName}` : ''
  const opening = when
    ? `${ev.title} is${where} on ${when}.`
    : `${ev.title}${where}.`
  return [
    price ? `${opening} ${price}.` : opening,
    '',
    'Full details, plus everything else happening in Akron this week:',
    taggedEventUrl(ev.path, 'facebook'),
  ].join('\n')
}

/**
 * Instagram: stacked facts, no URL, hashtags at the end.
 *
 * The link line says "link in bio" because that is the only clickable place
 * Instagram gives an account. Putting the URL in the caption anyway would
 * look like a link to a reader and behave like plain text, which is worse
 * than not offering one.
 */
export function instagramCaption(ev: ShareEvent): string {
  const lines = [ev.title]
  const when = shareDateLine(ev.startAt, ' · ')
  if (when) lines.push(when)
  const price = sharePriceLine(ev.priceMin, ev.priceMax)
  const venueLine = [ev.venueName, price].filter(Boolean).join(' · ')
  if (venueLine) lines.push(venueLine)
  lines.push('', 'Link in bio for details and the rest of the week.', '')
  lines.push(shareHashtags(ev).map((t) => `#${t}`).join(' '))
  return lines.join('\n')
}

export function captionFor(ev: ShareEvent, target: ShareTarget): string {
  return target === 'facebook' ? facebookCaption(ev) : instagramCaption(ev)
}

// ── Copy ────────────────────────────────────────────────────────────────
//
// Same voice as the rest of the partner surfaces: informal, plain, second
// person, short. No em dashes.

export const SHARE_TITLE = 'Share to Meta'

export const FACEBOOK_HINT =
  'Facebook builds the card from the event page, so posting the link needs no image. The event form cannot be pre-filled by anyone, but your caption is already copied when it opens.'

export const INSTAGRAM_HINT =
  'Instagram does not make caption links clickable, so this one says link in bio. On a phone, Download hands the image straight to Instagram.'

export const COPIED_TOAST = 'Caption copied.'
export const COPY_FAILED_TOAST = 'Could not copy. Select the caption and copy it.'
export const DOWNLOAD_FAILED_TOAST = 'Could not build the image. Try again in a moment.'

/** Shown in the preview frame itself when the card will not load at all. */
export const IMAGE_FAILED_NOTE = 'The card did not load. Reopen this in a moment, or copy the caption and post the link on its own.'
