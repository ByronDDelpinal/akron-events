/**
 * FriendsPage - the individual-giving counterpart to /financials.
 *
 * /financials publishes the whole bill; this page is where a reader who
 * wants to help pay it clicks through. It is copy plus one outbound link
 * to a Square Payment Link (src/lib/friends.ts). No SDK, no iframe, no
 * data model, and checkout itself happens entirely on Square's page.
 *
 * SOFT LAUNCH (Byron, 2026-09-02): this page is deliberately UNLINKED from
 * the rest of the site (no nav, footer, /about, or /financials link, and
 * /financials does not list Friends yet). Byron hands the URL to people
 * personally until the public launch, which is coming soon. It IS indexable
 * and in the sitemap on purpose, so the launch is only a matter of adding
 * the links back. The guard test enforces the unlinked state; flip it then.
 *
 * Branded to match /financials exactly (maintainer request): same 960px
 * .fin-body column, the same PulseSpine EKG line in the left gutter, and
 * the same .fin-section / .fin-cards / .fin-card chrome, all from the
 * shared src/styles/openbooks.css - see that file's own docblock for why
 * the fin- prefix is global rather than page-local. FriendsPage.css keeps
 * only what has no fin- equivalent: the impact figure, the group rows, the
 * checkout hints, and the closing note.
 *
 * The economic-impact section is a deliberately simpler cousin of
 * /financials' adoption calculator: the SAME controls (AdoptionControls:
 * slider plus preset pills) on the SAME state hook (useAdoptionSlider), so
 * floor, default, presets, analytics, and announced wording are one
 * definition, not two. It drives facilitatedSpendAtShare for the headline
 * and the four COST_GROUPS totals via groupMonthlyAtShare. No docked twin
 * and no sources footnote; /financials is one link away for that. Every
 * dollar figure here is interpolated from the financials module, never
 * typed, and test-friends-page-guards.js fails on a literal.
 *
 * See src/lib/friends.ts for the policy this page has to hold: being a
 * Friend buys nothing on the site itself, not placement, not a digest
 * mention, not a listing.
 */

import { Link } from 'react-router-dom'
import { SEO } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import PulseSpine from '@/components/PulseSpine'
import FriendChip from '@/components/FriendChip'
import AdoptionControls from '@/components/AdoptionControls'
import { useAdoptionSlider } from '@/hooks/useAdoptionSlider'
import { trackEvent, EVENTS } from '@/lib/analytics'
import {
  money,
  COST_GROUPS,
  groupMonthlyAtShare,
  facilitatedSpendAtShare,
  AEP6_LOCAL_SPEND_PER_OUTING,
  ADOPTION_OUTINGS_PER_USER,
} from '@/lib/financials'
import { FRIEND_CHECKOUT_URL, FRIEND_LINK_REL, ACTIVE_FRIENDS } from '@/lib/friends'
import './FriendsPage.css'

function handleCheckoutClick() {
  trackEvent(EVENTS.FRIEND_CHECKOUT_CLICK, { placement: 'friends_page' })
}

/** "one more time" / "two more times": derived from the model's assumption, never typed. */
const outingsPhrase =
  ADOPTION_OUTINGS_PER_USER === 1 ? 'one more time' : `${ADOPTION_OUTINGS_PER_USER} more times`

export default function FriendsPage() {
  // Same state, floor, default, analytics split, and announced wording as
  // /financials' calculator: one hook, not a second copy.
  const { percent: adoptionPercent, share: adoptionShare, valueText, onSlide, onPreset } =
    useAdoptionSlider('friends')
  const facilitated = facilitatedSpendAtShare(adoptionShare)
  // Summed from the same four group figures the rows render, so the total
  // can never disagree with the rows above it.
  const monthlyTotalAtShare = COST_GROUPS.reduce(
    (sum, g) => sum + groupMonthlyAtShare(g.key, adoptionShare),
    0,
  )

  return (
    <>
      <SEO
        title="Become a Friend of Akron Pulse"
        description="Chip in to help keep Akron Pulse free, ad-free, and running for everyone in Summit County."
        path="/friends"
      />

      <PageHero eyebrow="Akron Pulse / Friends" title="Become a Friend of Akron Pulse">
        Be part of the reason people leave their house.
      </PageHero>

      <div className="fin-body">
        <PulseSpine intensity={adoptionShare} />

        <p className="friends-why">
          Akron Pulse pulls together events from all over Summit County and
          keeps the site free, with no ads and no paywall. That still costs
          something every month: hosting, the scrapers that go out and find
          events, and the notifications that get them to you. Friends are the
          neighbors who help cover it.
        </p>

        <section className="fin-section friends-give" aria-label="Become a Friend">
          {/* rel comes from FRIEND_LINK_REL, which react/jsx-no-target-blank
              cannot statically follow; the guard test asserts the constant's
              value. One link, one button: Square's own checkout page carries
              the amount field and the One-time / Monthly toggle (see
              src/lib/friends.ts), so there is nothing to choose here. */}
          {/* eslint-disable-next-line react/jsx-no-target-blank */}
          <a
            className="fin-card__btn friends-cta"
            href={FRIEND_CHECKOUT_URL}
            target="_blank"
            rel={FRIEND_LINK_REL}
            onClick={handleCheckoutClick}
          >
            Become a Friend
          </a>
        </section>

        <section className="fin-section" aria-labelledby="friends-impact">
          {/* The headline figure IS the section title: it re-renders with the
              slider, so a reader sees the dollar amount move as they drag. */}
          <h2 className="fin-section__title" id="friends-impact">
            Your support turns into <span className="friends-impact__num">{money(facilitated)}</span> for our local economy
          </h2>
          <p className="fin-section__desc">
            Your contributions help us grow even further, and every bit of that
            growth flows straight into the local economy. One person using Akron
            Pulse to leave the house {outingsPhrase} a year, spending about{' '}
            {money(Math.round(AEP6_LOCAL_SPEND_PER_OUTING))}, has huge implications
            at scale. Help us get to that scale.
          </p>

          <div className="friends-impact">
            <AdoptionControls
              id="friends-adoption"
              label="Share of adults using Akron Pulse"
              percent={adoptionPercent}
              valueText={valueText}
              onSlide={onSlide}
              onPreset={onPreset}
            />

            <ul className="friends-impact__groups" aria-label="What running Akron Pulse costs at this adoption, by group">
              {COST_GROUPS.map((g) => (
                <li key={g.key} className="friends-impact__row">
                  <span className="friends-impact__group">{g.label}</span>
                  <span className="friends-impact__amount">
                    {money(Math.round(groupMonthlyAtShare(g.key, adoptionShare)))} / month
                  </span>
                </li>
              ))}
            </ul>
            <p className="friends-impact__total">
              <span className="friends-impact__group">Total</span>
              <span className="friends-impact__amount">{money(Math.round(monthlyTotalAtShare))} / month</span>
            </p>
            <p className="friends-impact__more">
              That is the whole bill at this adoption.{' '}
              <Link to="/financials">See the full breakdown</Link>.
            </p>
          </div>
        </section>

        <section className="fin-section" aria-labelledby="friends-list">
          <h2 className="fin-section__title" id="friends-list">
            {ACTIVE_FRIENDS.length > 0 ? "You're joining a great group of friends!" : 'Be the first Friend'}
          </h2>
          {ACTIVE_FRIENDS.length > 0 ? (
            <div className="fin-sponsors">
              {ACTIVE_FRIENDS.map((f) => <FriendChip key={f.key} friend={f} />)}
            </div>
          ) : (
            <p className="fin-section__desc">Nobody yet. Be the first.</p>
          )}
        </section>

      </div>
    </>
  )
}
