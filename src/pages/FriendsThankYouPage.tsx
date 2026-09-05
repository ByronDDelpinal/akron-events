/**
 * FriendsThankYouPage - Square's post-checkout redirect target.
 *
 * The redirect itself is configured in the Square dashboard (see
 * src/lib/friends.ts), not in this repo. This page just needs to exist at
 * /friends/thank-you, stay out of the index (noindex), and record the
 * completed round trip once per visit.
 *
 * Structure follows what good post-gift pages do: gratitude first, then
 * "what happens next" (the three things a supporter actually wonders about
 * in the minute after paying: the receipt, changing a monthly gift, and
 * where the money goes), then one clear next step that keeps them inside
 * the product rather than dead-ending on a confirmation. The newsletter
 * ask reuses NewsletterCTA so a Friend who is not yet a subscriber gets
 * the same well-tested prompt every hub page shows.
 *
 * What friend_checkout_return can and cannot mean: Square's hosted redirect
 * carries no token, receipt id, or amount, so this page cannot verify that
 * a payment happened. Anyone who types the URL fires the event. Read it as
 * "landed on the thank-you page", a ceiling on completed checkouts, and
 * reconcile against Square's own Transactions report for the real count.
 * A verified conversion would need a Square webhook plus a backend, which
 * the hosted-link decision deliberately avoids.
 *
 * Same chrome as /friends and /financials: PageHero for the heading and
 * .fin-body for the column and the PulseSpine gutter.
 */

import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { SEO } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import PulseSpine from '@/components/PulseSpine'
import NewsletterCTA from '@/components/NewsletterCTA'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './FriendsPage.css'

export default function FriendsThankYouPage() {
  // Ref, not state: survives React 18 StrictMode's dev-only mount /
  // unmount / remount, so the event fires once even there.
  const tracked = useRef(false)

  useEffect(() => {
    if (tracked.current) return
    tracked.current = true
    trackEvent(EVENTS.FRIEND_CHECKOUT_RETURN)
  }, [])

  return (
    <>
      <SEO title="Thank You" path="/friends/thank-you" noindex />

      <PageHero eyebrow="You're a Friend of Akron Pulse" title="Thank you.">
        You just helped keep every event in Summit County free to find, for
        everyone, with no ads and no paywall.
      </PageHero>

      <div className="fin-body friends-thanks">
        <PulseSpine intensity={0.85} />

        <section className="fin-section" aria-labelledby="friends-thanks-next">
          <h2 className="fin-section__title" id="friends-thanks-next">What happens next</h2>
          <div className="fin-cards">
            <div className="fin-card">
              <h3>Your receipt is on its way</h3>
              <p>
                Square emails it to the address you entered, usually within a
                minute. It comes from Square, not from us, so check the
                promotions tab if it hides.
              </p>
            </div>
            <div className="fin-card">
              <h3>Monthly? You're in control</h3>
              <p>
                Change the amount or stop any time from the link in that
                receipt email. No account, no login, no asking us.
              </p>
            </div>
          </div>
        </section>

        <section className="fin-section friends-thanks__go" aria-labelledby="friends-thanks-go">
          <h2 className="fin-section__title" id="friends-thanks-go">Now go find something to do</h2>
          <p className="fin-section__desc">
            That is the whole point of this. Tonight, this weekend, whenever:
            it is all in one place, and it is yours.
          </p>
          <Link className="fin-card__btn friends-cta" to="/">Browse what's happening</Link>
        </section>

        <NewsletterCTA variant="hub" surface="friends_thank_you" />
      </div>
    </>
  )
}
