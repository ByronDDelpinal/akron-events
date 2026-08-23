/**
 * PartnerHomePage (design §4.4): the scoped overview at /admin for
 * partners. Mirrors AdminHomePage's shape -- band + PulseDivider + the
 * events surface embedded whole -- so the shell reads as one product;
 * dark-first styling comes free from the shell-scoped .admin-shell tokens.
 *
 * The org context strip (§6.10 item 1) names every org the account acts
 * for; each chip is a filter toggle for the list below (default: all).
 * Orgs whose events are reviewed first carry a small "reviewed" affordance
 * that pre-answers "why did my event not publish".
 */

import { useMemo, useState } from 'react'
import { PulseDivider } from '@/components/admin'
import { usePartnerContext } from '@/lib/admin/usePartnerContext'
import { usePartnerCounts } from '@/lib/admin/usePartnerCounts'
import { PartnerEventsSurface } from '@/pages/admin/partner/PartnerEventsPage'

export default function PartnerHomePage() {
  const { orgs, scopeIds } = usePartnerContext()
  const counts = usePartnerCounts(scopeIds)
  // Empty selection means "all orgs" -- the ADR's preferred
  // list-first-filter-optional shape.
  const [selected, setSelected] = useState<string[]>([])

  const toggleOrg = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
  }

  const orgFilter = useMemo(
    () => (selected.length > 0 ? selected : null),
    [selected],
  )

  return (
    <div className="ashell-home">
      <section className="ashell-band" aria-label="Your overview">
        {orgs.length > 0 && (
          <div className="ashell-orgstrip" role="group" aria-label="Your organizations">
            <span className="ashell-orgstrip-lbl">
              {orgs.length === 1 ? 'Your organization:' : 'Your organizations:'}
            </span>
            {orgs.map((org) => (
              <button
                key={org.organization_id}
                type="button"
                className={`ashell-orgchip ${selected.includes(org.organization_id) ? 'ashell-orgchip--on' : ''}`}
                aria-pressed={selected.includes(org.organization_id)}
                onClick={() => toggleOrg(org.organization_id)}
                title={orgs.length > 1 ? `Show only ${org.name}'s events below` : undefined}
              >
                {org.name}
                {!org.auto_publish && (
                  <span
                    className="ashell-orgchip-note"
                    title={`New and republished events from ${org.name} go to Akron Pulse for review before they appear on the public site.`}
                  >
                    reviewed
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="ashell-tiles">
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">Upcoming</span>
            <span className="ashell-tile-big">{fmt(counts.upcoming)}</span>
            <span className="ashell-tile-sub">published events still ahead</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">Awaiting review</span>
            <span className="ashell-tile-big">{fmt(counts.awaitingReview)}</span>
            <span className="ashell-tile-sub">with Akron Pulse, not public yet</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">
              <span className={`ashell-dot ${counts.liveNow != null && counts.liveNow > 0 ? 'ashell-dot--live' : ''}`} aria-hidden="true" />
              Live right now
            </span>
            <span className="ashell-tile-big">{fmt(counts.liveNow)}</span>
            <span className="ashell-tile-sub">in progress, counting known end times only</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">This weekend</span>
            <span className="ashell-tile-big">{fmt(counts.weekend)}</span>
            <span className="ashell-tile-sub">published events</span>
          </div>
        </div>
      </section>

      <PulseDivider liveNow={counts.liveNow} />

      <PartnerEventsSurface orgFilter={orgFilter} />
    </div>
  )
}

function fmt(n: number | null): string {
  return n == null ? '…' : n.toLocaleString()
}
