import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { useShellCounts } from '@/lib/admin/useShellCounts'

/**
 * The four overview tiles on the admin home surface. Every number is a real
 * query result from ShellCountsProvider; while a number is still loading its
 * slot shows an ellipsis, and a sub-line whose number never arrived is
 * omitted rather than guessed.
 */
export default function OverviewBand() {
  const { reviewCount, clearedToday, liveNow, weekend, weekendPrev, scrape } = useShellCounts()
  const navigate = useNavigate()

  return (
    <section className="ashell-band" aria-label="Today at a glance">
      <div className="ashell-tiles">
        <div className="ashell-tile">
          <span className="ashell-tile-lbl">
            <span className={`ashell-dot ${liveNow != null && liveNow > 0 ? 'ashell-dot--live' : ''}`} aria-hidden="true" />
            Live right now
          </span>
          <span className="ashell-tile-big">{fmt(liveNow)}</span>
          <span className="ashell-tile-sub">in progress, counting known end times only</span>
        </div>

        <div className="ashell-tile">
          <span className="ashell-tile-lbl">This weekend</span>
          <span className="ashell-tile-big">{fmt(weekend)}</span>
          {weekend != null && weekendPrev != null ? (
            <span className="ashell-tile-sub">{weekendDelta(weekend, weekendPrev)}</span>
          ) : (
            <span className="ashell-tile-sub">published events</span>
          )}
        </div>

        <button
          type="button"
          className="ashell-tile ashell-tile--btn"
          onClick={() => navigate('/admin/review')}
          aria-label={`Needs review: ${reviewCount ?? 'loading'}. Open the review queue`}
        >
          <span className="ashell-tile-lbl">Needs review</span>
          <span className="ashell-tile-big">{fmt(reviewCount)}</span>
          {clearedToday != null && (
            <span className="ashell-tile-sub">
              <b>{clearedToday.toLocaleString()}</b> cleared today
            </span>
          )}
        </button>

        <button
          type="button"
          className="ashell-tile ashell-tile--btn"
          onClick={() => navigate('/admin/scraper-runs')}
          aria-label="Last scrape summary. Open scraper runs"
        >
          <span className="ashell-tile-lbl">Last scrape</span>
          {scrape == null ? (
            <span className="ashell-tile-big">…</span>
          ) : scrape.latestRanAt == null ? (
            <>
              <span className="ashell-tile-big">—</span>
              <span className="ashell-tile-sub ashell-warntx">no runs in the last 24 hours</span>
            </>
          ) : (
            <>
              <span className="ashell-tile-big">{scrape.eventsFound.toLocaleString()}</span>
              <span className="ashell-tile-sub">
                events found at {format(new Date(scrape.latestRanAt), 'h:mm a')}
                {scrape.sourcesError > 0 ? (
                  <>
                    {' · '}
                    <span className="ashell-warntx">
                      {scrape.sourcesError} {scrape.sourcesError === 1 ? 'source needs' : 'sources need'} attention
                    </span>
                  </>
                ) : (
                  <> · all {scrape.sourcesOk} sources ok</>
                )}
              </span>
            </>
          )}
        </button>
      </div>
    </section>
  )
}

function fmt(n: number | null): string {
  return n == null ? '…' : n.toLocaleString()
}

function weekendDelta(current: number, previous: number): string {
  if (previous === 0) {
    return current === 0 ? 'same as last weekend' : `up from 0 last weekend`
  }
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct === 0) return 'same as last weekend'
  return pct > 0 ? `▲ ${pct}% vs last weekend` : `▼ ${Math.abs(pct)}% vs last weekend`
}
