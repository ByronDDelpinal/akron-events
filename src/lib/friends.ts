/**
 * friends.ts - single source of truth for the /friends "Become a Friend" ask.
 *
 * SINGLE SOURCE OF TRUTH WIRING (mirrors src/lib/sponsors.ts):
 *   One place for the checkout link, the friends registry,
 *   and the link rel. /friends and /financials render these and nothing
 *   else defines them a second time.
 *
 * ── THE POLICY (this is the load-bearing part) ───────────────────────────
 *   Being a Friend of Akron Pulse buys exactly one thing: the project stays
 *   funded a little longer, and a thank-you by name on /friends and on
 *   /financials. A name in that thank-you list is a thank-you, nothing
 *   more, so the src/lib/sponsors.ts boundary is unchanged and applies here
 *   the same way. It does NOT buy:
 *     - placement, boosting, or ordering of any event in any listing
 *     - a mention in the email digest
 *     - a slot on the homepage, a hub page, or any embed
 *     - access to subscriber data, in aggregate or otherwise
 *     - any influence over which events get covered or how they rank
 *
 *   /about promises readers "Free, forever. No ads, no paywall, no catch."
 *   That promise holds regardless of who gives or how much. A Friend's
 *   support pays for hosting, the scrapers, and notifications, the same bill
 *   /financials publishes in full. It does not change what anyone sees.
 *
 * ── CONSENT: names are opt-in, added by hand ──────────────────────────────
 *   FRIENDS below is never populated automatically from a Square payment.
 *   A name goes in only after the person agrees to be named. The ask itself
 *   happens at checkout: Square's payment link editor has a "Custom fields"
 *   toggle that can collect an optional name-and-consent field on its own
 *   checkout page, so the person opts in (or doesn't) before they ever pay.
 *   That toggle is dashboard-side state, exactly like the redirect and
 *   default-frequency notes below - nothing in this repo keeps it in sync,
 *   so a change there needs no matching change here, and vice versa.
 *
 * ── CHECKOUT: Square, not us ──────────────────────────────────────────────
 *   FRIEND_CHECKOUT_URL is a single Square Payment Link that carries BOTH
 *   frequencies: Square's own checkout page shows a One-time / Monthly
 *   toggle, and the visitor picks one there. There is deliberately no
 *   second URL for the monthly case, and no query-string switch either -
 *   Square Payment Links do not support a pass-through frequency or amount
 *   override via URL, so the toggle only exists on Square's page, not ours.
 *   A future reader tempted to add a second link for "monthly" should stop:
 *   this one link already covers it, and /friends has a single button. We
 *   never see or store a card number; that entire surface lives on Square's
 *   own checkout page.
 *
 *   Two things about this link live entirely in the Square dashboard, not
 *   in this repo:
 *     - The post-checkout redirect from Square back to /friends/thank-you.
 *       If that redirect is ever changed or removed, update it there; there
 *       is nothing here to keep in sync with it.
 *     - The Custom fields name-and-consent toggle described above. If it is
 *       ever turned off, FRIENDS stops gaining new entries by that route
 *       and someone has to ask supporters to opt in another way.
 */

/** Square Payment Link. Square, not us, handles the card and the receipt. */
export const FRIEND_CHECKOUT_URL = 'https://square.link/u/ypiiUPFa'

/** `rel` for the outbound Square checkout link. */
export const FRIEND_LINK_REL = 'noopener noreferrer'

/** How a Friend gives: Square's One-time / Monthly toggle, recorded by hand. */
export type FriendKind = 'monthly' | 'one_time'

export interface Friend {
  /** Stable slug. Doubles as the React list key. Never reuse a key for a
   *  different person, even years after they stop giving. */
  key: string
  /** Display name, exactly as the person asked to be named. */
  name: string
  /** 'YYYY-MM' the support started. Drives display order. */
  since: string
  /**
   * 'YYYY-MM' the support ended. Setting this RETIRES the entry into past
   * friends. Never delete a row: they helped, and the record of who
   * helped is part of the open books.
   */
  until?: string
  /** One-time or monthly, when known. Optional: a name can be added before
   *  this detail is on hand. */
  kind?: FriendKind
}

/**
 * No Friends listed yet, and that is deliberate, same as SPONSORS in
 * sponsors.ts. Nobody should ever seed a placeholder row to make a page
 * look less empty.
 */
export const FRIENDS: Friend[] = []

/** Currently supporting, oldest first, then alphabetical. */
export const ACTIVE_FRIENDS: Friend[] = FRIENDS
  .filter(f => !f.until)
  .sort((a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name))

/** Retired friends, most recently retired first. */
export const PAST_FRIENDS: Friend[] = FRIENDS
  .filter(f => f.until)
  .sort((a, b) => (b.until ?? '').localeCompare(a.until ?? ''))
