/**
 * FinancialsPage - the money counterpart to /technical.
 *
 * Publishes the project's complete monthly bill, an adoption-driven cost
 * model (the calculator's slider evaluates the same per-line schedules the
 * cost table does), live usage stats, and who helps cover it, aimed at four
 * readers: potential funders, businesses who might sponsor, other
 * communities who could run a fork, and residents who might chip in.
 *
 * Static figures come from src/lib/financials.ts, the supporter list from
 * src/lib/sponsors.ts, and the embed-partner list from financials.ts's
 * consented EMBED_PARTNERS registry (one-file updates for all three). Event
 * and venue counts query Supabase live. Traffic stats come from
 * /api/pageviews (GA4-backed, cached daily) and degrade to "n/a" when
 * analytics isn't configured - a missing number is shown as missing, never
 * as a zero. Active users, not pageviews, is the metric this page leads with
 * (users-first, 2026-08-17) - pageviews stays in the response and renders as
 * a demoted note under the users stat, the same "public metric vs internal
 * unit" split src/lib/financials.ts's cost model uses.
 *
 * Every dollar figure on this page is interpolated from the financials
 * module. scripts/tests/test-financials-page-guards.js fails on a literal,
 * because pitch copy quietly drifting away from the real total is the exact
 * failure this page cannot survive.
 */

import { Fragment, useState, useEffect, useRef, forwardRef, type CSSProperties } from 'react'
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
  COST_GROUPS,
  TODAY_INDEX,
  ACTIVE_SOURCE_COUNT,
  SUMMIT_COUNTY_ADULTS,
  NEXTDOOR_ADOPTION_SHARE,
  IMPACT_LADDER,
  AEP6_LOCAL_SPEND_PER_OUTING,
  AEP6_SOURCE,
  centsPerResident,
  lineMonthlyToday,
  lineMonthlyAtShare,
  activeStepIndex,
  driverValueForShare,
  type CostLine,
} from '@/lib/financials'
import { trackEvent, EVENTS } from '@/lib/analytics'
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
  /** Primary public metric (users-first, 2026-08-17) - active users, trailing 30 days. */
  totalUsers30d?: number
  /** Demoted to a note line under the users stat - the internal traffic unit, not the headline. */
  pageviews30d?: number
  embedHosts?: { host: string; views: number }[]
}

const GITHUB_URL = 'https://github.com/byronddelpinal/akron-events'
const NOTIFY_MAILTO =
  'mailto:byron@akronpulse.com?subject=Tell%20me%20when%20Akron%20Pulse%20takes%20donations'

/** Placeholder for a figure we genuinely do not have. Never a zero. */
const NO_DATA = 'n/a'

const money = (n: number) => `$${n.toLocaleString()}`

// The calendar year the event stat covers. Eastern, not UTC - see the count
// query's comment. Module scope: one value per page load is exactly right.
const trackedYear = easternTodayIso().slice(0, 4)

// (AT_SCALE_INDEX left with the fixed At-scale column and the annual-cost
// constants below, all cut 2026-08-17 - the slider's live column covers the
// scenario. DEFAULT_TIER_INDEX stays exported from financials.ts for the
// model test.)

// Cost-model figures, computed once at module scope - none of this depends
// on a live query. Deliberately NOT on the same axis as IMPACT_LADDER below;
// see financials.ts's "Local spending facilitated" header comment.
// (The fixed Today/At-scale annual-cost and cents-per-resident constants
// that used to sit here left with the "one way to hold the cost" paragraph,
// cut 2026-08-17; the calculator's cost line computes its live equivalents
// from centsPerResident directly.)

// The measured Today scenario ('today' is always first in IMPACT_SCENARIOS;
// the fallback only guards against a reordering). It renders as prose below
// the calculator rather than as a preset chip: it is measured, not modeled,
// and it deliberately uses different (lower) outing and spend assumptions,
// so putting it on the same slider would misstate it.
const IMPACT_TODAY = IMPACT_LADDER.find((s) => s.key === 'today') ?? IMPACT_LADDER[0]

// The calculator's sourced preset chips: every modeled scenario, i.e. every
// row that carries an adoption share. Percent is the chip's slider position.
const IMPACT_PRESETS = IMPACT_LADDER
  .filter((s) => s.shareOfAdults != null)
  .map((s) => ({
    key: s.key,
    percent: Math.round((s.shareOfAdults ?? 0) * 100),
    label: s.label,
    isCeiling: s.isCeiling === true,
    source: s.usersSource,
  }))

// Starting slider position: the most conservative sourced preset, never a
// flattering one - the reader moves it up themselves or not at all.
const DEFAULT_ADOPTION_PERCENT = Math.round(NEXTDOOR_ADOPTION_SHARE * 100)

// One analytics hit per settled slider position, not one per tick of a drag.
const SLIDER_SETTLE_MS = 800

// Headline formatting only; the exact figure always appears in the math line
// beneath, so compacting here never hides a digit anyone needs.
const compactMoney = (n: number) =>
  n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)} million`
    : `$${Math.round(n / 1_000).toLocaleString()}k`

// Step-threshold formatting for the cost table's step strips (500000 ->
// "500k", 2000000 -> "2M"). Thresholds are authored as round numbers in
// financials.ts, so no decimals are ever needed here.
const compactCount = (n: number) =>
  n >= 1_000_000 ? `${Math.round(n / 1_000_000)}M` : `${Math.round(n / 1_000)}k`

export default function FinancialsPage() {
  const [eventCount, setEventCount] = useState<number | null>(null)
  const [venueCount, setVenueCount] = useState<number | null>(null)
  const [traffic, setTraffic] = useState<TrafficStats | null>(null)
  // Lifted from ImpactCalculator (2026-08-17) so the cost table's live "At
  // this adoption" column and the calculator's cost line read one shared
  // slider position - the table and the calculator can never disagree about
  // what "this adoption" means. The debounced-versus-immediate analytics
  // split also lives here now (onAdoptionSlide/onAdoptionPreset below,
  // "living pulse" redesign, 2026-08-17), so the docked control (a second
  // position for the same slider) shares one settle timer with the
  // in-section one instead of owning a second, competing timer.
  const [adoptionPercent, setAdoptionPercent] = useState(DEFAULT_ADOPTION_PERCENT)
  const adoptionShare = adoptionPercent / 100
  // The cost table's live column total: every line evaluated at the current
  // slider share, summed the same way TIER_TOTALS sums lineMonthlyToday /
  // lineMonthlyAtShare(line, 1) - so Today, this column, and At scale are
  // three evaluations of one function, never three separately-typed numbers.
  const liveMonthlyTotal = COST_LINES.reduce(
    (sum: number, line: CostLine) => sum + lineMonthlyAtShare(line, adoptionShare),
    0,
  )

  // Refs to the two scroll landmarks the docked control's visibility depends
  // on (see the IntersectionObserver effect below): the calculator's SLIDER
  // ROW (attached via forwardRef - the row, not the card, so the dock takes
  // over the moment the actual control scrolls off screen; see
  // ImpactCalculator's forwardRef comment for the screenshot-caught gap the
  // card-level sentinel left) and the sponsors section, the boundary at
  // which the dock retires.
  const calcSentinelRef = useRef<HTMLDivElement>(null)
  const sponsorsSentinelRef = useRef<HTMLElement>(null)
  const [dockVisible, setDockVisible] = useState(false)

  // One settle timer shared by both sliders (the in-section one and its
  // docked twin, "living pulse" redesign, 2026-08-17): they drive the SAME
  // adoptionPercent state and must fire impact_calc_adjusted through the
  // same debounced-slider/immediate-preset split described on
  // ImpactCalculator's own comment, never twice for one interaction.
  const settleTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  const onAdoptionSlide = (next: number) => {
    setAdoptionPercent(next)
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      trackEvent(EVENTS.IMPACT_CALC_ADJUSTED, { percent: next, via: 'slider' })
    }, SLIDER_SETTLE_MS)
  }

  const onAdoptionPreset = (next: number) => {
    window.clearTimeout(settleTimer.current)
    setAdoptionPercent(next)
    trackEvent(EVENTS.IMPACT_CALC_ADJUSTED, { percent: next, via: 'preset' })
  }

  // The docked control appears once the reader has scrolled past the
  // calculator and disappears once they scroll past the sponsors section -
  // it exists to keep the slider reachable through the impact and cost
  // sections, not to precede its own explanation or trail the page forever.
  // Two IntersectionObserver sentinels, same-origin, threshold 0, and
  // disconnected on unmount; no scroll listener of our own, so this never
  // adds per-frame work on top of what Footer.tsx's own scroll handler
  // already does.
  useEffect(() => {
    const calcEl = calcSentinelRef.current
    const sponsorsEl = sponsorsSentinelRef.current
    if (!calcEl || !sponsorsEl) return

    let pastCalc = false
    let sponsorsReached = false
    const update = () => setDockVisible(pastCalc && !sponsorsReached)

    // isIntersecting is false AND the target's top has already scrolled
    // above the viewport (boundingClientRect.top < 0) means the whole
    // element is above the fold - the reader scrolled PAST it, not before it.
    const calcObserver = new IntersectionObserver(([entry]) => {
      pastCalc = !entry.isIntersecting && entry.boundingClientRect.top < 0
      update()
    })
    // The dock retires the moment the sponsors section ENTERS the viewport,
    // not once it has fully scrolled past (the first version's rule, which
    // left the dock floating beside the sponsor, embed, and fork sections it
    // has nothing to say about - flagged in the 2026-08-17 polish pass). In
    // view or above the fold both count as reached.
    const sponsorsObserver = new IntersectionObserver(([entry]) => {
      sponsorsReached = entry.isIntersecting || entry.boundingClientRect.top < 0
      update()
    })
    calcObserver.observe(calcEl)
    sponsorsObserver.observe(sponsorsEl)
    return () => {
      calcObserver.disconnect()
      sponsorsObserver.disconnect()
    }
  }, [])

  // Local spending facilitated and the live cost at the current slider
  // share, computed once here so the in-section calculator and its docked
  // twin read the exact same numbers - the same reason liveMonthlyTotal
  // above is computed once for the cost table rather than inside each cell.
  const adoptionUsers = Math.round(SUMMIT_COUNTY_ADULTS * adoptionShare)
  const adoptionFacilitated = Math.round(SUMMIT_COUNTY_ADULTS * adoptionShare * AEP6_LOCAL_SPEND_PER_OUTING)
  const adoptionAnnualCost = liveMonthlyTotal * 12
  const adoptionCentsAtShare = centsPerResident(adoptionAnnualCost)
  const atAdoptionCeiling = IMPACT_PRESETS.some((p) => p.isCeiling && p.percent === adoptionPercent)
  // Read by both sliders' aria-valuetext, so the docked control's announced
  // value can never drift from the in-section one's wording.
  const adoptionValueText = `${adoptionPercent}% of adults, about ${money(adoptionFacilitated)} a year`

  useEffect(() => {
    async function load() {
      // Both counts must match what this site actually publishes, or
      // /financials and /venues carry different numbers for the same thing
      // on the site whose whole premise is that its figures are true.
      //   events: status='published' with start_at inside the CURRENT YEAR -
      //     "events tracked in {year}", the calendar-year workload the annual
      //     cost stat divides over. Duplicates and tombstones are excluded by
      //     status alone (a merged duplicate is set status='cancelled').
      //     Year bounds are Eastern, via the same easternIsoAt the browse
      //     query's custom-range filter uses - a UTC boundary would move
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

  // Users-first (2026-08-17): active users is the primary public traffic
  // metric; pageviews is demoted to the note line under it - see the stat
  // card below.
  const activeUsers = traffic?.available ? traffic.totalUsers30d ?? null : null
  const pageviews = traffic?.available ? traffic.pageviews30d ?? null : null
  // NOTE: traffic.embedHosts (the sustained-traffic list) is deliberately NOT
  // rendered - the public partner list is the consented EMBED_PARTNERS
  // registry in financials.ts. See its comment for the 2026-08-17 decision.

  // Cents per event ACROSS THE YEAR, one decimal: the full year's bill
  // divided over every event tracked in that same year - numerator and
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
        <PulseSpine adoptionShare={adoptionShare} />

        {/* ── Summary stats ── */}
        <div className="fin-stats">
          <div className="fin-stat">
            <span className="fin-stat__num">{money(MONTHLY_TOTAL)}</span>
            <span className="fin-stat__label">
              {/* Annual figure rides in the headline label, derived ×12 -
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
                  /* "nobody has been paid for their time" read as a grievance
                     rather than a contribution. The time is a gift, and the
                     copy should say so (partner feedback, 2026-08-17). */
                  : `${money(SERVICES_TOTAL)} in services. Time is generously donated by our team to make Akron Pulse a reality.`}
              </span>
            </span>
          </div>
          <div className="fin-stat">
            <span className="fin-stat__num">
              {activeUsers != null ? activeUsers.toLocaleString() : NO_DATA}
            </span>
            <span className="fin-stat__label">
              Active users / 30 days
              <span className="fin-stat__note">
                {activeUsers != null
                  ? `from analytics, refreshed daily${pageviews != null ? ` · ${pageviews.toLocaleString()} pageviews` : ''}`
                  : 'reporting coming online'}
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

        {/* ── What it's worth - leads the page, ahead of the cost section.
            An interactive calculator, not a rendered scenario ladder and not
            one modeled figure (maintainer decisions, both 2026-08-17; see
            src/lib/financials.ts's "Local spending facilitated: adoption
            calculator" block for the history and the full reasoning). The
            reader picks the adoption assumption themselves; the sourced
            scenarios in IMPACT_SCENARIOS become preset chips. Cost and this
            section are deliberately modeled on different axes. */}
        <section className="fin-section" aria-labelledby="fin-impact">
          <h2 className="fin-section__title" id="fin-impact">What it's worth</h2>
          {/* Opening copy authored by Byron verbatim (2026-08-17), trimmed
              from three paragraphs to two; the cents-per-resident paragraph
              was cut with it (its live variant survives in the calculator's
              cost line). Figures are interpolated, never typed - the
              page-guards test still applies to authored copy. */}
          <p className="fin-section__desc">
            Akron Pulse doesn't sell anything, so there's no revenue to report. What there is
            instead is local spending facilitated: money spent at Summit County venues and
            businesses when Akron Pulse helps someone show up to something. As Akron Pulse
            expands, so does the percent of Summit County's{' '}
            {SUMMIT_COUNTY_ADULTS.toLocaleString()} adults that go to one extra thing a year
            because of it. If they spend about {money(AEP6_LOCAL_SPEND_PER_OUTING)} locally per
            outing, excluding admission, the local-attendee figure from{' '}
            <a href={AEP6_SOURCE.url} target="_blank" rel="noopener noreferrer">{AEP6_SOURCE.label}</a>,
            you can see the clear economic impact it will deliver.
          </p>

          {/* Prose ahead of the calculator (Byron, 2026-08-17): the
              calculator sits last in the section so it lands right above
              the cost table, whose live column it drives. */}
          <p className="fin-impact-today">
            For scale: today's measured reach is{' '}
            {IMPACT_TODAY.users.toLocaleString()} annual users, which at our deliberately low
            assumptions (1 in 10 attending one extra thing, {money(IMPACT_TODAY.spendPerOuting)}{' '}
            spent) comes to about {money(IMPACT_TODAY.facilitated)} a year. That reach is young
            and spiky, so expect it to move. None of the money on this page comes to Akron Pulse;
            we don't take a cut of anything.
          </p>

          <ImpactCalculator
            ref={calcSentinelRef}
            percent={adoptionPercent}
            users={adoptionUsers}
            facilitated={adoptionFacilitated}
            annualCost={adoptionAnnualCost}
            centsAtShare={adoptionCentsAtShare}
            atCeiling={atAdoptionCeiling}
            valueText={adoptionValueText}
            onSlide={onAdoptionSlide}
            onPreset={onAdoptionPreset}
          />
        </section>

        {/* ── Cost table: Today beside the live at-this-adoption column.
            History, all 2026-08-17: the tier PICKER went first ("that toggle
            isn't helping anything"); then the fixed At-scale column went too
            (Byron: "if they want to see it, they can use the slider") - the
            live column at 100% IS the at-scale figure, and TIER_TOTALS'
            at-scale evaluation survives in the model as the s=1.0 anchor,
            the cents-per-resident line below, and the test pin. */}
        <section className="fin-section" aria-labelledby="fin-costs">
          <h2 className="fin-section__title" id="fin-costs">Where the money goes</h2>
          <p className="fin-section__desc">
            The complete monthly bill in priority order, essentials first, next to a live figure
            at the adoption level picked in the calculator above; slide it to 100% to see the
            full-region scenario. The $0 lines are real: picking services with generous free
            tiers is most of the cost strategy. Prices verified {PRICES_VERIFIED}.
          </p>

          <div className="fin-table-scroll">
            <table className="fin-table">
              <thead>
              <tr>
                {/* One merged column (Byron, 2026-08-17): the line-item name
                    and what it covers share a column - the name on the row
                    with the amounts, the description on a full-width row
                    beneath it. A separate description column squeezed the
                    amounts and was hidden entirely on mobile; merged, the
                    description always renders and costs no width. */}
                <th scope="col">Line item</th>
                <th scope="col" className="fin-table__col">
                  Today
                  <span className="fin-table__col-note">{TIERS[TODAY_INDEX].traffic}</span>
                </th>
                {/* The live column: every line re-evaluated at the calculator's
                    slider position (lineMonthlyAtShare), so this can never
                    disagree with the calculator's own cost line above. */}
                <th scope="col" className="fin-table__col">
                  At this adoption · {adoptionPercent}%
                  <span className="fin-table__col-note">live, from the slider</span>
                </th>
                {/* No fixed At-scale column (Byron, 2026-08-17): the live
                    column IS the scenario explorer - slide to 100% for the
                    full-region figure. TIER_TOTALS' at-scale evaluation
                    stays in the model as the s=1.0 anchor and test pin. */}
              </tr>
              </thead>
              <tbody>
              {/* Group heading rows (Byron, 2026-08-17: "make it clear where
                  the line of core technologies ends"): the bill renders as
                  its priority groups, each opened by a heading row, same
                  pattern as the one-off expenses heading below. Lines are
                  looked up per group, so a line can never render under the
                  wrong heading. */}
              {COST_GROUPS.map(group => (
                <Fragment key={group.key}>
                  <tr>
                    <th scope="colgroup" colSpan={3} className="fin-group__heading">
                      {group.label}
                    </th>
                  </tr>
                  {COST_LINES.filter(line => line.group === group.key).map(line => {
                const today = lineMonthlyToday(line)
                const live = lineMonthlyAtShare(line, adoptionShare)
                const hasSteps = line.driver !== 'flat' && (line.steps?.length ?? 0) > 0
                return (
                  // Two rows per line: the name + amounts, then the
                  // description spanning the full table width beneath. The
                  // row border moves to the description row (CSS) so the
                  // pair reads as one visual row.
                  <Fragment key={line.key}>
                    <tr className="fin-table__line">
                      {/* scope="row", not a <td>: the row header is what lets
                          a screen reader tie each amount to its vendor. */}
                      <th scope="row">
                        {line.url
                          ? <a href={line.url} target="_blank" rel="noopener noreferrer">{line.label}</a>
                          : line.label}
                      </th>
                      <td className={`fin-table__amount${today === 0 ? ' fin-table__amount--free' : ''}`}>
                        {money(today)}
                      </td>
                      {/* fin-flash + a value-keyed key (2026-08-17 "living
                          pulse" redesign): only the LIVE column re-evaluates
                          from the slider, so only it gets the amber
                          acknowledgment - the Today cell above is measured
                          and must never animate. See FinancialsPage.css's
                          .fin-flash for how a changed key drives a CSS-only
                          fade with no JS per tick. */}
                      <td
                        className={`fin-table__amount fin-flash${live === 0 ? ' fin-table__amount--free' : ''}`}
                        key={live}
                      >
                        {money(live)}
                      </td>
                    </tr>
                    <tr className={`fin-table__what${hasSteps ? ' fin-table__what--open' : ''}`}>
                      <td colSpan={3}>{line.description}</td>
                    </tr>
                    {/* Stepped lines show their whole schedule (Byron,
                        2026-08-17: "I want people to see at what volume
                        these things scale") - one chip per vendor size with
                        its threshold, the step billed at the current slider
                        position highlighted. activeStepIndex is the same
                        lookup lineCostMonthly bills with, so the amber chip
                        and the charged step can never disagree. Generic:
                        any line that grows a `steps` schedule renders this
                        strip for free. */}
                    {/* hasSteps already narrows `line` to a metered line
                        (TS aliased-condition narrowing), so no second
                        driver check is needed here. */}
                    {hasSteps && line.steps != null && (
                      <tr className="fin-table__steps">
                        <td colSpan={3}>
                          <ul
                            className="fin-steps"
                            aria-label={`${line.label} plan sizes by monthly traffic`}
                          >
                            {line.steps.map((step, i) => (
                              <li
                                key={step.label}
                                className={`fin-steps__chip${
                                  i === activeStepIndex(line.steps ?? [], driverValueForShare(line, adoptionShare))
                                    ? ' fin-steps__chip--active'
                                    : ''
                                }`}
                                aria-current={
                                  i === activeStepIndex(line.steps ?? [], driverValueForShare(line, adoptionShare))
                                    ? 'true'
                                    : undefined
                                }
                              >
                                {step.label}
                                <span className="fin-steps__bound">
                                  {step.upToDriverValue === null
                                    ? 'at the ceiling'
                                    : `to ${compactCount(step.upToDriverValue)} views/mo`}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
                  })}
                </Fragment>
              ))}
              <tr className="fin-table__total">
                <th scope="row">Total</th>
                <td className="fin-table__amount">{money(TIER_TOTALS[TODAY_INDEX])}</td>
                <td className="fin-table__amount fin-flash" key={liveMonthlyTotal}>
                  {money(liveMonthlyTotal)}
                </td>
              </tr>
              {/* Annual total, called out as its own row: a monthly figure
                  invites mental "x12, carry the..." math and most readers never
                  do it. Derived (x12 of the same tier totals), never typed -
                  the page-guards test forbids a literal here anyway. */}
              <tr className="fin-table__total fin-table__total--annual">
                <th scope="row">Per year</th>
                <td className="fin-table__amount">{money(TIER_TOTALS[TODAY_INDEX] * 12)}</td>
                <td className="fin-table__amount fin-flash" key={liveMonthlyTotal * 12}>
                  {money(liveMonthlyTotal * 12)}
                </td>
              </tr>
              </tbody>
              {/* One-off expenses live INSIDE the cost table as a second body
                (Byron, 2026-08-17): the amounts must line up under the same
                last column as every other figure, and two separate tables
                with auto-sized columns can never promise that. Row shape is
                date, label, amount, so the amount inherits the exact column
                and .fin-table__amount treatment the bill uses. Annual scope,
                so these stay OUT of the monthly and per-year totals above -
                a one-off purchase isn't a function of the adoption slider. */}
              {ONE_OFF_EXPENSES.length > 0 && (
              <tbody className="fin-oneoffs-body">
                <tr>
                  <th scope="colgroup" colSpan={3} className="fin-oneoffs__heading">
                    One-off expenses ({new Date().getFullYear()})
                  </th>
                </tr>
                {ONE_OFF_EXPENSES.map(e => (
                  <tr key={`${e.date}-${e.label}`}>
                    <th scope="row" className="fin-oneoffs__date">{e.date}</th>
                    <td className="fin-oneoffs__label">{e.label}</td>
                    <td className="fin-table__amount">{money(e.amount)}</td>
                  </tr>
                ))}
                {/* Year total - the --annual modifier on purpose: this is a
                    per-year figure, so it wears the same amber the Per-year
                    row above does. */}
                <tr className="fin-table__total fin-table__total--annual">
                  <th scope="row">Total</th>
                  <td />
                  <td className="fin-table__amount">{money(oneOffTotalForYear())}</td>
                </tr>
              </tbody>
              )}
            </table>
          </div>
          {/* No spend-cap promise sits here on purpose. The previous copy
              guaranteed that caps on "every metered service" meant a spike
              could "never produce a surprise bill" - an absolute claim about
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
        {/* ref: the docked control's "past this, hide" boundary - see the
            IntersectionObserver effect above ImpactCalculator's call site. */}
        <section className="fin-section" aria-labelledby="fin-sponsors" ref={sponsorsSentinelRef}>
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

        {/* ── Embed partners - the consented registry, never traffic-derived.
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
            src/lib/financials.ts - the committed methodology - they just no
            longer render here. The table intro still carries the
            prices-verified date. */}
      </div>

      {/* ── Docked adoption control ("living pulse" redesign, 2026-08-17) ──
          Only exists in the DOM while dockVisible is true, so a prerendered
          (unscrolled) snapshot never contains it - no duplicate control for
          a crawler to trip over. See AdoptionDock's own comment. */}
      {dockVisible && (
        <AdoptionDock
          percent={adoptionPercent}
          facilitated={adoptionFacilitated}
          annualCost={adoptionAnnualCost}
          valueText={adoptionValueText}
          onSlide={onAdoptionSlide}
        />
      )}
    </>
  )
}

/**
 * The adoption calculator: one slider over the share of Summit County adults,
 * one live figure. The reader owns the adoption assumption, so the page never
 * has to defend having chosen one; the sourced scenarios from
 * IMPACT_SCENARIOS render as preset chips that snap the slider to a cited
 * anchor. Today is deliberately not a chip - see IMPACT_TODAY's comment.
 *
 * Slider position AND every derived figure live in FinancialsPage (position
 * lifted 2026-08-17; the figures lifted alongside the docked control,
 * "living pulse" redesign, same day) so the cost table's live "At this
 * adoption" column and the docked control (AdoptionDock, below) can read the
 * exact same numbers this component renders - one evaluation per figure per
 * render, never three separately-typed ones. FinancialsPage also now owns
 * the debounced-versus-immediate analytics split (onSlide/onPreset are
 * passed in) so the in-section slider and its docked twin share one settle
 * timer and can never double-fire impact_calc_adjusted for one interaction.
 *
 * The slider announces its own result via aria-valuetext (screen readers
 * read the dollar figure as the value changes), so the output needs no
 * aria-live region, which would chatter on every drag tick. valueText is
 * passed in rather than built here so the docked slider announces the exact
 * same wording.
 *
 * forwardRef: FinancialsPage's IntersectionObserver watches the SLIDER ROW,
 * not the card root, to know when the docked control should appear. The
 * first version watched the whole card, and because the card is tall the
 * reader could scroll the slider itself off the top while the card's tail
 * kept the dock suppressed - a stretch of page with NO slider on screen
 * (Byron caught it from a screenshot, 2026-08-17). The dock now takes over
 * the moment the actual control leaves the viewport.
 */
const ImpactCalculator = forwardRef<HTMLDivElement, {
  percent: number
  users: number
  facilitated: number
  annualCost: number
  centsAtShare: number
  atCeiling: boolean
  valueText: string
  onSlide: (next: number) => void
  onPreset: (next: number) => void
}>(function ImpactCalculator(
  { percent, users, facilitated, annualCost, centsAtShare, atCeiling, valueText, onSlide, onPreset },
  ref,
) {
  return (
    <div className="fin-calc">
      <div className="fin-calc__slider-row" ref={ref}>
        <label className="fin-calc__label" htmlFor="fin-calc-adoption">Share of adults</label>
        <input
          id="fin-calc-adoption"
          className="fin-calc__slider"
          type="range"
          min={1}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => onSlide(Number(e.target.value))}
          aria-valuetext={valueText}
        />
        <span className="fin-calc__pct" aria-hidden="true">{percent}%</span>
      </div>

      <div className="fin-calc__presets" role="group" aria-label="Sourced adoption comparisons">
        {IMPACT_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="fin-calc__preset"
            aria-pressed={percent === p.percent}
            onClick={() => onPreset(p.percent)}
          >
            {p.label} · {p.percent}%
          </button>
        ))}
      </div>

      <p className="fin-calc__result">
        {/* fin-flash, keyed by the figure itself ("living pulse" redesign,
            2026-08-17): a changed key forces React to remount the node, and
            the amber fade is a plain CSS animation that runs once on mount -
            see FinancialsPage.css's .fin-flash. No JS per tick, and never
            applied to a measured figure (the stat cards above, the table's
            Today column): only what the slider just recomputed gets the
            acknowledgment. */}
        <output
          htmlFor="fin-calc-adoption"
          className="fin-calc__num fin-flash"
          key={`num-${facilitated}`}
        >
          {compactMoney(facilitated)}
        </output>
        <span className="fin-calc__unit">a year into Summit County businesses</span>
        {atCeiling && <span className="fin-calc__badge">Ceiling, not a forecast</span>}
      </p>
      <p className="fin-calc__math">
        {users.toLocaleString()} adults, one extra outing each,{' '}
        {money(AEP6_LOCAL_SPEND_PER_OUTING)} spent locally per outing: {money(facilitated)}.
      </p>
      {/* Cost vs impact, live against the slider. Rewritten 2026-08-17: this
          used to draw a straight line ("chord") between today's bill and the
          at-scale budget and call it an upper bound, because the real cost
          model was two hardcoded numbers per vendor line with nothing
          between them. It is no longer that. src/lib/financials.ts now
          carries a real schedule per line (plan price plus vendor overage
          rates, researched from each vendor's pricing page) and a driver
          (traffic or subscribers) that converts this slider's adoption
          share into the pageviews or subscriber count that schedule
          responds to. annualCost above is that schedule evaluated at THIS
          slider position, the same function the cost table's live column
          and its At-scale column evaluate elsewhere on this page - so there
          is nothing left to bound; the number below is the model's actual
          answer for this adoption level, not a ceiling on it. The
          cents-per-resident clause (2026-08-17) reads centsPerResident the
          same way .fin-impact-noassumption's fixed Today/At-scale figures
          do, just evaluated at the live share instead of a fixed one. */}
      <p className="fin-calc__cost">
        At this adoption level Akron Pulse would cost about{' '}
        <span className="fin-flash" key={`cost-${annualCost}`}>{money(annualCost)}</span> a year to
        run, about <span className="fin-flash" key={`cents-${centsAtShare}`}>{centsAtShare}¢</span>
        {' '}per Summit County resident: today's real bill plus vendor list prices evaluated at the
        traffic and subscriber list this adoption level implies. Even at that cost, this
        is <strong className="fin-calc__mult fin-flash" key={`mult-${annualCost}-${facilitated}`}>
          {Math.round(facilitated / annualCost).toLocaleString()}x
        </strong>{' '}
        the cost in local spending.
      </p>
      <p className="fin-calc__sources">
        The presets are sourced comparisons, not forecasts:{' '}
        {IMPACT_PRESETS.map((p, i) => (
          <span key={p.key}>
            {i > 0 && '; '}
            {p.label.toLowerCase()} from{' '}
            {p.source ? (
              <a href={p.source.url} target="_blank" rel="noopener noreferrer">{p.source.label}</a>
            ) : (
              'our own model'
            )}
          </span>
        ))}
        .
      </p>
    </div>
  )
})

/**
 * The pulse spine ("living pulse" redesign, 2026-08-17): a continuous
 * vertical EKG line threading .fin-body's left gutter from just below the
 * hero to the footer. The waveform is the site's own brand mark, not an
 * invented heartbeat shape (house rule: visuals use our brand assets) - it
 * is public/favicon.svg's blip path itself,
 * `M 5 16 L 11 16 L 14 10 L 16 23 L 19 5 L 22 18 L 25 16 L 27 16`, the same
 * EKG line every favicon size and the nav/footer logo draw, re-plotted
 * running top-to-bottom instead of left-to-right: the favicon's horizontal
 * traversal (x) becomes the spine's vertical traversal, and its vertical
 * deflection (y - 16, the favicon's own baseline) becomes the spine's
 * horizontal deflection, scaled up into the 48px column. Tiled via an SVG
 * <pattern> (FinancialsPage.css) so it repeats at a fixed cadence for any
 * page length, with no JS height measurement.
 *
 * The line "breathes": amplitude and rate both track adoptionShare via the
 * --pulse-scale / --pulse-duration custom properties, weak and slow near
 * the low end of the slider, strong and fast at full adoption, through one
 * CSS @keyframes animation (FinancialsPage.css's fin-pulse-glow). No
 * requestAnimationFrame and no per-frame React render: the two properties
 * are set once per slider move, exactly like every other derived value on
 * this page - the animation loop itself is the browser's, not ours.
 *
 * aria-hidden and presentational only: a decorative brand mark, never
 * content a crawler or a screen reader needs. Hidden entirely below 1200px
 * (FinancialsPage.css) so it never competes with the 960px content column
 * for room.
 */
function PulseSpine({ adoptionShare }: { adoptionShare: number }) {
  const pulseScale = 0.25 + 0.75 * adoptionShare
  const pulseDuration = (2.6 - 1.6 * adoptionShare).toFixed(2)
  return (
    <svg
      className="fin-pulse-spine"
      aria-hidden="true"
      focusable="false"
      style={{ '--pulse-scale': pulseScale, '--pulse-duration': `${pulseDuration}s` } as CSSProperties}
    >
      <defs>
        <pattern id="finPulseTile" patternUnits="userSpaceOnUse" width="48" height="220">
          <path d="M24 0 L24 170 L16.2 178.6 L33.1 184.3 L9.7 192.9 L26.6 201.4 L24 210 L24 220" />
        </pattern>
      </defs>
      <rect width="48" height="100%" fill="url(#finPulseTile)" />
    </svg>
  )
}

/**
 * The docked adoption control ("living pulse" redesign, 2026-08-17): the
 * same slider and state as ImpactCalculator, in a second position that
 * follows the reader once the in-section calculator scrolls out of view.
 * FinancialsPage owns adoptionPercent and the debounced/immediate analytics
 * split (onSlide is the exact same handler ImpactCalculator's slider uses -
 * see onAdoptionSlide in FinancialsPage) so this component and
 * ImpactCalculator can never disagree about what "this adoption" means or
 * double-fire impact_calc_adjusted for one drag. Carries only the slider and
 * the two headline outputs, not the preset chips or the sourced-comparisons
 * footnote - the compact-pill brief this component fills has no room for
 * either, and both are one scroll away in the in-section calculator this
 * mirrors.
 *
 * Visibility is entirely FinancialsPage's call (see dockVisible and its two
 * IntersectionObserver sentinels) - this component only renders while true,
 * so it never exists in a prerendered snapshot (which captures the page at
 * rest, before any scroll) and never precedes the calculator it mirrors.
 */
function AdoptionDock({
  percent,
  facilitated,
  annualCost,
  valueText,
  onSlide,
}: {
  percent: number
  facilitated: number
  annualCost: number
  valueText: string
  onSlide: (next: number) => void
}) {
  return (
    <div className="fin-dock" role="group" aria-label="Adoption calculator">
      <div className="fin-dock__row">
        <label className="fin-dock__label" htmlFor="fin-dock-adoption">Adoption</label>
        <input
          id="fin-dock-adoption"
          className="fin-dock__slider"
          type="range"
          min={1}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => onSlide(Number(e.target.value))}
          aria-valuetext={valueText}
        />
        <span className="fin-dock__pct" aria-hidden="true">{percent}%</span>
      </div>
      <div className="fin-dock__figures">
        <span className="fin-dock__figure fin-flash" key={`dock-facilitated-${facilitated}`}>
          <strong>{compactMoney(facilitated)}</strong> facilitated/yr
        </span>
        <span className="fin-dock__figure fin-flash" key={`dock-cost-${annualCost}`}>
          <strong>{compactMoney(annualCost)}</strong> to run/yr
        </span>
      </div>
    </div>
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
