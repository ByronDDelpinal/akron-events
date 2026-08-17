/**
 * sponsors.ts — single source of truth for who has helped pay the bill.
 *
 * SINGLE SOURCE OF TRUTH WIRING (mirrors src/lib/dataSources.ts):
 *   One array, one shape, one place. /financials renders this list and
 *   nothing else renders it at all. A sponsor is added by appending an entry
 *   here, and retired by setting `until` on the existing entry. There is no
 *   second copy in page JSX, no CMS row, and no per-sponsor component, so
 *   there is nothing for a registry to drift against.
 *   scripts/tests/test-sponsors-registry.js enforces the shape and, for any
 *   entry carrying a logo, that the file actually exists under public/.
 *
 * ── THE POLICY (this is the load-bearing part) ───────────────────────────
 *   Sponsorship buys a thank-you on the /financials page. That is the entire
 *   product. It does NOT buy:
 *     • placement, boosting, or ordering of any event in any listing
 *     • influence over what gets covered, categorized, or featured
 *     • a mention in the email digest
 *     • a slot on the homepage, a hub page, or any embed
 *     • access to subscriber data, in aggregate or otherwise
 *
 *   /about promises readers "Free, forever. No ads, no paywall, no catch."
 *   That promise is only true while this boundary holds. The moment a
 *   sponsor's money moves an event up a list or into a digest, the sponsor
 *   has bought an ad, the promise on /about becomes false, and the honesty
 *   that makes /financials worth publishing is gone with it. If a future
 *   change needs sponsor data anywhere outside the /financials thank-you
 *   section, that is not a refactor — it is a decision to start selling ads,
 *   and it needs to be made deliberately, in the open, with /about rewritten
 *   to match.
 *
 * ── LOGO ASSETS: strip the tile background ───────────────────────────────
 *   Designer-supplied SVGs in this project consistently ship with a tiled
 *   artboard background: a full-bleed white `<rect class="cls-1">` behind the
 *   artwork. Left in place, the logo renders as a white box in dark theme
 *   (which is the site's default) and looks broken. Before dropping a file
 *   into public/sponsors/, open it and delete the background rect and its
 *   `.cls-1` fill rule, then check it against the dark theme, not just the
 *   light one.
 */

/** How the sponsor helped. Cash and in-kind are never displayed alike. */
export type SponsorSupport = 'cash' | 'in-kind'

export interface Sponsor {
  /**
   * Stable slug. Doubles as the React list key, the logo filename
   * (`/sponsors/<key>.svg`), and the key tests refer to. Never reuse a key
   * for a different organization, even years after the first one retires.
   */
  key: string
  /** Required. The only field that must render for the entry to be useful. */
  name: string
  /** Omit for an unlinked, name-only entry. */
  url?: string
  /** '/sponsors/<key>.svg' under public/. Omit for a name-only chip. */
  logo?: string
  /** Alt text for the logo. Defaults to `name`. */
  logoAlt?: string
  /**
   * REQUIRED, and it always renders. An in-kind supporter's logo sitting
   * under a monthly cost table with no qualifier reads as cash the project
   * never received, which is the exact kind of quiet overstatement this page
   * exists to avoid.
   */
  support: SponsorSupport
  /** Optional one-line note about what they covered. */
  blurb?: string
  /** 'YYYY-MM' the support started. Drives display order. */
  since: string
  /**
   * 'YYYY-MM' the support ended. Setting this RETIRES the entry into past
   * supporters. Never delete a sponsor row: they helped, and the record of
   * who helped is part of the open books.
   */
  until?: string
}

/**
 * No sponsors yet, and that is deliberate. The empty state on /financials is
 * the pitch: a bill nobody is covering, published in full, is a more honest
 * ask than a wall of logos. Do not seed a placeholder row.
 */
export const SPONSORS: Sponsor[] = []

/** Currently supporting, oldest first, then alphabetical. */
export const ACTIVE_SPONSORS: Sponsor[] = SPONSORS
  .filter(s => !s.until)
  .sort((a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name))

/** Retired supporters, most recently retired first. */
export const PAST_SPONSORS: Sponsor[] = SPONSORS
  .filter(s => s.until)
  .sort((a, b) => (b.until ?? '').localeCompare(a.until ?? ''))

/**
 * `rel` for every outbound sponsor link. `sponsored` is the honest
 * declaration to search engines, and `nofollow` means a sponsorship never
 * quietly becomes a purchased backlink.
 */
export const SPONSOR_LINK_REL = 'noopener noreferrer nofollow sponsored'

/** Where an interested business writes. */
export const SPONSOR_CONTACT_MAILTO =
  'mailto:byron@akronpulse.com?subject=Sponsoring%20Akron%20Pulse'
