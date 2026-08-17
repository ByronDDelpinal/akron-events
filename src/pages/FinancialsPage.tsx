/**
 * FinancialsPage — the money counterpart to /technical.
 *
 * Publishes the project's complete monthly bill, the growth-tier cost model,
 * live usage stats, and who helps cover it, aimed at four readers: potential
 * funders, businesses who might sponsor, other communities who could run a
 * fork, and residents who might chip in.
 *
 * Static figures come from src/lib/financials.ts, the supporter list from
 * src/lib/sponsors.ts, and the embed-partner list from financials.ts's
 * consented EMBED_PARTNERS registry (one-file updates for all three). Event
 * and venue counts query Supabase live. Traffic stats come from
 * /api/pageviews (GA4-backed, cached daily) and degrade to "n/a" when
 * analytics isn't configured — a missing number is shown as missing, never
 * as a zero.
 *
 * Every dollar figure on this page is interpolated from the financials
 * module. scripts/tests/test-financials-page-guards.js fails on a literal,
 * because pitch copy quietly drifting away from the real total is the exact
 * failure this page cannot survive.
 */

import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { easternIsoAt, easternTodayIso } from '@/lib/easternDate'
import { SEO } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import {
  TIERS,
  TIER_TOTALS,
  COST_LINES,
  MONTHLY_TOTAL,
  SERVICES_TOTAL,
  OVERHEAD_TOTAL,
  ONE_OFF_EXPENSES,
  oneOffTotalForYear,
  FORK_INFRA_MONTHLY,
  EMBED_PARTNERS,
  PRICES_VERIFIED,
  TODAY_INDEX,
  DEFAULT_TIER_INDEX,
  ACTIVE_SOURCE_COUNT,
} from '@/lib/financials'
import {
  ACTIVE_SPONSORS,
  PAST_SPONSORS,
  SPONSOR_LINK_REL,
  SPONSOR_CONTACT_MAILTO,
  type Sponsor,
} from '@/lib/sponsors'
import './FinancialsPage.css'

interface TrafficStats {
  available: boolean
  pageviews30d?: number
  embedHosts?: { host: string; views: number }[]
}

const GITHUB_URL = 'https://github.com/byronddelpinal/akron-events'
const NOTIFY_MAILTO =
  'mailto:byron@akronpulse.com?subject=Tell%20me%20when%20Akron%20Pulse%20takes%20donations'

/** Placeholder for a figure we genuinely do not have. Never a zero. */
const NO_DATA = 'n/a'

const money = (n: number) => `$${n.toLocaleString()}`

// The calendar year the event stat covers. Eastern, not UTC — see the count
// query's comment. Module scope: one value per page load is exactly right.
const trackedYear = easternTodayIso().slice(0, 4)

// The fixed modeled column. With the tier picker gone (2026-08-17) the table
// always shows Today beside the at-scale scenario; DEFAULT_TIER_INDEX keeps
// its name for the financials-model test but is, in practice, the only
// modeled tier left.
const AT_SCALE_INDEX = DEFAULT_TIER_INDEX

export default function FinancialsPage() {
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [venueCount, setVenueCount] = useState<number | null>(null)
  const [traffic, setTraffic] = useState<TrafficStats | null>(null)

  useEffect(() => {
    async function load() {
      // Both counts must match what this site actually publishes, or
      // /financials and /venues carry different numbers for the same thing
      // on the site whose whole premise is that its figures are true.
      //   events: status='published' with start_at inside the CURRENT YEAR —
      //     "events tracked in {year}", the calendar-year workload the annual
      //     cost stat divides over. Duplicates and tombstones are excluded by
      //     status alone (a merged duplicate is set status='cancelled').
      //     Year bounds are Eastern, via the same easternIsoAt the browse
      //     query's custom-range filter uses — a UTC boundary would move
      //     New Year's Eve events across years.
      //   venues: listed=true mirrors useVenues (src/hooks/useEvents.ts), which
      //     hides tombstoned duplicates and bare-address rows; merges set
      //     listed=false, so without this the venue count drifts upward every
      //     time a duplicate is merged.
      const [events, venues] = await Promise.all([
        supabase.from('events').select('id', { count: 'exact', head: true })
          .eq('status', 'published')
          .gte('start_at', easternIsoAt(`${trackedYear}-01-01`, '00:00:00'))
          .lte('start_at', easternIsoAt(`${trackedYear}-12-31`, '23:59:59')),
        supabase.from('venues').select('id', { count: 'exact', head: true }).eq('listed', true),
      ])
      if (events.count != null) setEventCount(events.count)
      if (venues.count != null) setVenueCount(venues.count)

      try {
        const res = await fetch('/api/pageviews')
        if (res.ok) setTraffic(await res.json())
      } catch {
        setTraffic({ available: false })
      }
    }
    load()
  }, [])

  const pageviews = traffic?.available ? traffic.pageviews30d ?? null : null
  // NOTE: traffic.embedHosts (the sustained-traffic list) is deliberately NOT
  // rendered — the public partner list is the consented EMBED_PARTNERS
  // registry in financials.ts. See its comment for the 2026-08-17 decision.

  // Cents per event ACROSS THE YEAR, one decimal: the full year's bill
  // divided over every event tracked in that same year — numerator and
  // denominator deliberately share the calendar-year window.
  const centsPerEvent = eventCount
    ? ((MONTHLY_TOTAL * 12 * 100) / eventCount).toFixed(1)
    : null

  return (
    <>
      <SEO
        title="Financials | What Akron Pulse Costs to Run"
        description="Akron Pulse publishes its complete monthly bill: every service, every dollar, and what the costs look like at 10x or 100x the traffic."
        path="/financials"
      />

      <PageHero eyebrow="Akron Pulse / Open Books" title="Financials">
        Every dollar, published. A county-wide events calendar doesn't need a
        big budget, so here's the whole bill, updated as prices change.
      </PageHero>

      <div className="fin-body">
        {/* ── Summary stats ── */}
        <div className="fin-stats">
          <div className="fin-stat">
            <span className="fin-stat__num">{money(MONTHLY_TOTAL)}</span>
            <span className="fin-stat__label">
              {/* Annual figure rides in the headline label, derived ×12 —
                  the whole-year number is the one funders and sponsors
                  actually budget against, so it must not hide in the table. */}
              Monthly cost · {money(MONTHLY_TOTAL * 12)}/year
              {/* The "+ N admin and marketing" split is suppressed while
                  OVERHEAD_TOTAL is 0. Rendering it anyway put the page in
                  direct contradiction with itself: the Claude Max line says
                  its cost stands in for unpaid development time, while this
                  note simultaneously announced that administration costs
                  nothing. One claim per page. */}
              <span className="fin-stat__note">
                {OVERHEAD_TOTAL > 0
                  ? `${money(SERVICES_TOTAL)} services + ${money(OVERHEAD_TOTAL)} admin and marketing`
                  : `${money(SERVICES_TOTAL)} in services; nobody has been paid for their time`}
              </span>
            </span>
          </div>
          <div className="fin-stat">
            <span className="fin-stat__num">
              {pageviews != null ? pageviews.toLocaleString() : NO_DATA}
            </span>
            <span className="fin-stat__label">
              Pageviews / 30 days
              <span className="fin-stat__note">
                {pageviews != null ? 'from analytics, refreshed daily' : 'reporting coming online'}
              </span>
            </span>
          </div>
          <div className="fin-stat">
            <span className="fin-stat__num">
              {eventCount != null ? eventCount.toLocaleString() : NO_DATA}
            </span>
            <span className="fin-stat__label">
              Events tracked in {trackedYear}
              <span className="fin-stat__note">
                {venueCount != null
                  ? `${venueCount.toLocaleString()} venues, ${ACTIVE_SOURCE_COUNT} sources`
                  : 'live from the database'}
              </span>
            </span>
          </div>
          <div className="fin-stat">
            <span className="fin-stat__num">{centsPerEvent != null ? `${centsPerEvent}¢` : NO_DATA}</span>
            <span className="fin-stat__label">
              Cost per event
              <span className="fin-stat__note">
                {centsPerEvent != null ? `per event tracked in ${trackedYear}, per year` : 'waiting on the live event count'}
              </span>
            </span>
          </div>
        </div>

        {/* ── Cost table: Today beside At scale, always. The tier PICKER is
            gone (Byron, 2026-08-17 — "that toggle isn't helping anything"):
            with only two tiers left, a toggle whose sole power was hiding
            the second column was interaction without information. Both
            columns simply render; the sr-only status region went with it,
            since nothing changes under the reader any more. */}
        <section className="fin-section" aria-labelledby="fin-costs">
          <h2 className="fin-section__title" id="fin-costs">Where the money goes</h2>
          <p className="fin-section__desc">
            The complete monthly bill, largest line first, next to what the same
            bill looks like modeled at full-region adoption. The $0 lines are
            real: picking services with generous free tiers is most of the cost
            strategy. Prices verified {PRICES_VERIFIED}.
          </p>

          <div className="fin-table-scroll">
            <table className="fin-table">
              <thead>
              <tr>
                <th scope="col">Line item</th>
                <th scope="col" className="fin-table__desc">What it covers</th>
                <th scope="col" className="fin-table__col">
                  Today
                  <span className="fin-table__col-note">{TIERS[TODAY_INDEX].traffic}</span>
                </th>
                <th scope="col" className="fin-table__col">
                  {/* No "At" prefix: the tier label already reads "At scale". */}
                  {TIERS[AT_SCALE_INDEX].label} (modeled)
                  <span className="fin-table__col-note">{TIERS[AT_SCALE_INDEX].traffic}</span>
                </th>
              </tr>
              </thead>
              <tbody>
              {COST_LINES.map(line => {
                const today = line.monthly[TODAY_INDEX]
                const modeled = line.monthly[AT_SCALE_INDEX]
                return (
                  <tr key={line.key}>
                    {/* scope="row", not a <td>: on mobile .fin-table__desc is
                        display:none, so without a row header a screen reader
                        announces "Today," and an amount, with no way to tell
                        which vendor it belongs to. */}
                    <th scope="row">
                      {line.url
                        ? <a href={line.url} target="_blank" rel="noopener noreferrer">{line.label}</a>
                        : line.label}
                    </th>
                    <td className="fin-table__desc">{line.description}</td>
                    <td className={`fin-table__amount${today === 0 ? ' fin-table__amount--free' : ''}`}>
                      {money(today)}
                    </td>
                    <td className={`fin-table__amount${modeled === 0 ? ' fin-table__amount--free' : ''}`}>
                      {money(modeled)}
                    </td>
                  </tr>
                )
              })}
              <tr className="fin-table__total">
                <th scope="row">Total</th>
                <td className="fin-table__desc" />
                <td className="fin-table__amount">{money(TIER_TOTALS[TODAY_INDEX])}</td>
                <td className="fin-table__amount">{money(TIER_TOTALS[AT_SCALE_INDEX])}</td>
              </tr>
              {/* Annual total, called out as its own row: a monthly figure
                  invites mental "×12, carry the…" math and most readers never
                  do it. Derived (×12 of the same tier totals), never typed —
                  the page-guards test forbids a literal here anyway. */}
              <tr className="fin-table__total fin-table__total--annual">
                <th scope="row">Per year</th>
                <td className="fin-table__desc" />
                <td className="fin-table__amount">{money(TIER_TOTALS[TODAY_INDEX] * 12)}</td>
                <td className="fin-table__amount">{money(TIER_TOTALS[AT_SCALE_INDEX] * 12)}</td>
              </tr>
              </tbody>
              {/* One-off expenses live INSIDE the cost table as a second body
                (Byron, 2026-08-17): the amounts must line up under the same
                last column as every other figure, and two separate tables
                with auto-sized columns can never promise that. Row shape is
                date → description → (empty Today cell) → amount, so the
                amount inherits the exact column and .fin-table__amount
                treatment the bill uses. Annual scope, so these stay OUT of
                the monthly and per-year totals above. */}
              {ONE_OFF_EXPENSES.length > 0 && (
              <tbody className="fin-oneoffs-body">
                <tr>
                  <th scope="colgroup" colSpan={4} className="fin-oneoffs__heading">
                    One-off expenses ({new Date().getFullYear()})
                  </th>
                </tr>
                {ONE_OFF_EXPENSES.map(e => (
                  <tr key={`${e.date}-${e.label}`}>
                    <th scope="row" className="fin-oneoffs__date">{e.date}</th>
                    <td className="fin-table__desc">{e.label}</td>
                    <td />
                    <td className="fin-table__amount">{money(e.amount)}</td>
                  </tr>
                ))}
                {/* Year total — the --annual modifier on purpose: this is a
                    per-year figure, so it wears the same amber the Per-year
                    row above does. */}
                <tr className="fin-table__total fin-table__total--annual">
                  <th scope="row">Total</th>
                  <td className="fin-table__desc" />
                  <td />
                  <td className="fin-table__amount">{money(oneOffTotalForYear())}</td>
                </tr>
              </tbody>
              )}
            </table>
          </div>
          {/* No spend-cap promise sits here on purpose. The previous copy
              guaranteed that caps on "every metered service" meant a spike
              could "never produce a surprise bill" — an absolute claim about
              account configuration that no code in this repo sets or checks,
              on plans (Vercel Pro) whose spend management is opt-in and off
              by default. The honest version is an ASSUMPTIONS entry in
              src/lib/financials.ts that errs against us (no longer rendered
              on the page since 2026-08-17, but still the committed
              methodology). Do not reintroduce a softer version of the
              guarantee here. */}

          {/* One-off rows AND their year total render inside the table above;
              only the empty state (heading included) lives down here. */}
          {ONE_OFF_EXPENSES.length === 0 && (
            <>
              <h3 className="fin-oneoffs__title">One-off expenses ({new Date().getFullYear()})</h3>
              <p className="fin-oneoffs__empty">
                $0 so far this year. Non-recurring purchases (equipment, printing, a
                table at a community event) get listed here individually as they happen.
              </p>
            </>
          )}
        </section>

        {/* ── Sponsors ──
            Sits directly after the bill and before the embed partners on
            purpose: the reader has just finished reading what this costs, and
            the next thing they see is who helps pay it. */}
        <section className="fin-section" aria-labelledby="fin-sponsors">
          <h2 className="fin-section__title" id="fin-sponsors">Who helps cover it</h2>
          {/* Wording is deliberate. An earlier draft offered a paid logo
              placement and then claimed "no ad anywhere on the site" two
              sentences later, which cannot both be true. The boundary that IS
              true, and the one src/lib/sponsors.ts documents, is that a
              disclosed thank-you on the open-books page is the entire product:
              nothing a sponsor pays for reaches the listings, the digest, or
              any other page. Keep the claim scoped to that. */}
          <p className="fin-section__desc">
            Sponsors pay part of the bill above and get their name in this
            section. That is the whole arrangement, and a thank-you here is the
            only thing money buys: no placement in any listing, no influence
            over which events get covered or how they rank, no mention in the
            email digest, and no access to subscriber data. Akron Pulse stays
            free, with no paywall and nothing sold anywhere else on the site,
            and that only stays true because this line does not move.
          </p>

          {ACTIVE_SPONSORS.length > 0 ? (
            <>
              <div className="fin-sponsors">
                {ACTIVE_SPONSORS.map(s => <SponsorChip key={s.key} sponsor={s} />)}
              </div>
              {PAST_SPONSORS.length > 0 && (
                <p className="fin-sponsors-past">
                  Past supporters: {PAST_SPONSORS.map(s => s.name).join(', ')}. Thank you.
                </p>
              )}
            </>
          ) : (
            <div className="fin-embeds-empty">
              <p>
                Nobody yet, and the bill above is the whole ask. One business can
                cover a month of Summit County's events calendar for{' '}
                {money(MONTHLY_TOTAL)}. In return your name and logo go right
                here, on the page that shows exactly where the money went. Your
                logo on this page is the only thing money buys: no placement in
                the listings, none in the email digest, nothing anywhere else on
                the site, and no say in what gets covered.
              </p>
              <a className="fin-card__btn" href={SPONSOR_CONTACT_MAILTO}>Sponsor a month</a>
            </div>
          )}
        </section>

        {/* ── Embed partners — the consented registry, never traffic-derived.
               (The sustained-traffic data from /api/pageviews is a private
               nomination signal; see financials.ts's EMBED_PARTNERS note.) */}
        <section className="fin-section" aria-labelledby="fin-embeds">
          <h2 className="fin-section__title" id="fin-embeds">Embedded around Summit County</h2>
          <p className="fin-section__desc">
            Community sites carrying the Akron Pulse calendar on their own
            pages. Everyone here agreed to be listed. It costs them nothing.
          </p>
          {EMBED_PARTNERS.length > 0 ? (
            <div className="fin-embeds">
              {EMBED_PARTNERS.map((p) => (
                <div key={p.host} className="fin-embed-row">
                  <a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a>
                  <span className="fin-embed-row__views">{p.host}</span>
                </div>
              ))}
              <p className="fin-embeds-cta">
                Want the calendar on your site too?{' '}
                <Link to="/embed-builder">Build your free embed</Link>.
              </p>
            </div>
          ) : (
            <div className="fin-embeds-empty">
              <p>No embed partners yet. Your site could be the first.</p>
              <Link className="fin-card__btn" to="/embed-builder">Build your free embed</Link>
            </div>
          )}
        </section>

        {/* ── Replicate + chip in ── */}
        <div className="fin-cards">
          <div className="fin-card">
            <h3>Run this for your city</h3>
            <p>
              Akron Pulse is open source. A calendar like this for your community
              costs $0 to start on free tiers, and about {money(FORK_INFRA_MONTHLY)}/month
              in infrastructure once you outgrow them. The code and this cost
              model are all public.
            </p>
            <a className="fin-card__btn" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              View on GitHub
            </a>
          </div>
          <div className="fin-card">
            <h3>Chip in</h3>
            <p>
              {money(MONTHLY_TOTAL)} a month keeps this running for all of Summit
              County. Donations aren't set up yet. Leave your email and we'll let
              you know when they are. If you're a business rather than a neighbor,
              the sponsor ask above is live today.
            </p>
            <a className="fin-card__btn" href={NOTIFY_MAILTO}>Notify me</a>
          </div>
        </div>

        {/* The assumptions/methodology footnote was removed 2026-08-17
            (Byron). The ASSUMPTIONS list and the full model still live in
            src/lib/financials.ts — the committed methodology — they just no
            longer render here. The table intro still carries the
            prices-verified date. */}
      </div>
    </>
  )
}

/**
 * One supporter. Logo when we have one, name when we don't, and the kind of
 * support either way: an in-kind supporter's logo under a monthly cost table
 * with no qualifier reads as cash the project never received.
 *
 * Explicit width/height plus loading="lazy" so a logo landing late never
 * shifts the section under the reader.
 */
function SponsorChip({ sponsor }: { sponsor: Sponsor }) {
  const inner = (
    <>
      {sponsor.logo ? (
        <img
          className="fin-sponsor__logo"
          src={sponsor.logo}
          alt={sponsor.logoAlt ?? sponsor.name}
          width={160}
          height={40}
          loading="lazy"
        />
      ) : (
        <span className="fin-sponsor__name">{sponsor.name}</span>
      )}
      <span className="fin-sponsor__kind">
        {sponsor.support === 'in-kind' ? 'in-kind support' : 'sponsor'}
      </span>
      {sponsor.blurb && <span className="fin-sponsor__blurb">{sponsor.blurb}</span>}
    </>
  )

  if (!sponsor.url) return <div className="fin-sponsor">{inner}</div>

  return (
    // rel comes from SPONSOR_LINK_REL, which react/jsx-no-target-blank cannot
    // follow through a constant. It carries noopener AND noreferrer (plus
    // nofollow and sponsored), and test-financials-page-guards.js asserts all
    // four, so the protection the rule checks for is enforced by a test.
    // eslint-disable-next-line react/jsx-no-target-blank
    <a className="fin-sponsor" href={sponsor.url} target="_blank" rel={SPONSOR_LINK_REL}>
      {inner}
    </a>
  )
}
