/**
 * PartnerHomePage (design §4.4): the scoped overview at /admin for
 * partners. Dark-first styling comes free from the shell-scoped
 * .admin-shell tokens.
 *
 * ── ORDER (hierarchy pass, 2026-08-25) ──────────────────────────────────
 * band -> divider -> events -> analytics.
 *
 * Analytics used to sit between the band and the events surface, which put
 * roughly nine hundred pixels of read-out between a partner and the thing
 * they came to do. Publishing, fixing a time and finding what is stuck in
 * review are the daily tasks; traffic is a status check. The work surface
 * goes on the first screen and the read-out goes under it.
 *
 * ── SCOPE (hierarchy pass, 2026-08-25) ──────────────────────────────────
 * ONE scope control for the whole page. It used to be two: this strip as a
 * multi-select filter over the events list, and a second "Organization"
 * dropdown inside the analytics block, using the same word two hundred
 * pixels apart and doing different things. The strip is now single-select
 * with an explicit All, and it drives the tiles, the events list AND the
 * analytics block. The analytics RPC takes exactly one org, so when the
 * scope is All the block picks one itself and offers its own quiet switch
 * inside its band -- see OrgAnalytics.
 */

import { useMemo, useState } from 'react'
import { OrgAnalytics, PulseDivider } from '@/components/admin'
import { usePartnerContext } from '@/lib/admin/usePartnerContext'
import { usePartnerCounts } from '@/lib/admin/usePartnerCounts'
import { PartnerEventsSurface } from '@/pages/admin/partner/PartnerEventsPage'

export default function PartnerHomePage() {
  const { orgs, scopeIds } = usePartnerContext()
  // null means every org in context. One org id means that org, everywhere.
  const [scope, setScope] = useState<string | null>(null)

  const activeIds = useMemo(
    () => (scope ? [scope] : scopeIds),
    [scope, scopeIds],
  )
  const counts = usePartnerCounts(activeIds)
  const orgFilter = useMemo(() => (scope ? [scope] : null), [scope])

  const soleOrg = orgs.length === 1 ? orgs[0] : null

  return (
    <div className="ashell-home">
      <section className="ashell-band" aria-label="Your overview">
        {orgs.length > 1 && (
          <div className="ashell-orgstrip" role="group" aria-label="Show events for">
            <span className="ashell-orgstrip-lbl">Showing:</span>
            <button
              type="button"
              className={`ashell-orgchip ${scope === null ? 'ashell-orgchip--on' : ''}`}
              aria-pressed={scope === null}
              onClick={() => setScope(null)}
            >
              All
            </button>
            {orgs.map((org) => (
              <button
                key={org.organization_id}
                type="button"
                className={`ashell-orgchip ${scope === org.organization_id ? 'ashell-orgchip--on' : ''}`}
                aria-pressed={scope === org.organization_id}
                onClick={() => setScope(org.organization_id)}
                title={org.auto_publish ? undefined : `Events from ${org.name} are reviewed before they go public.`}
              >
                {org.name}
                {!org.auto_publish && (
                  <span className="ashell-orgchip-note">reviewed</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* One org: no control to render, but the reviewed fact still has to
            reach them, and a chip nobody can toggle is not the place. */}
        {soleOrg && !soleOrg.auto_publish && (
          <p className="ashell-band-note">
            Events from {soleOrg.name} are reviewed before they go public.
          </p>
        )}

        {/* Both number rows carry an overline now. The band had none, which
            is why the analytics heading below had to work so hard to explain
            that it was a different kind of thing. */}
        <h2 className="ashell-band-lbl">Right now</h2>

        <div className="ashell-tiles">
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">Upcoming</span>
            <span className="ashell-tile-big">{fmt(counts.upcoming)}</span>
            <span className="ashell-tile-sub">published, still ahead</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">Awaiting review</span>
            <span className="ashell-tile-big">{fmt(counts.awaitingReview)}</span>
            <span className="ashell-tile-sub">not public yet</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">
              <span className={`ashell-dot ${counts.liveNow != null && counts.liveNow > 0 ? 'ashell-dot--live' : ''}`} aria-hidden="true" />
              Live right now
            </span>
            <span className="ashell-tile-big">{fmt(counts.liveNow)}</span>
            <span className="ashell-tile-sub">in progress, end time known</span>
          </div>
          <div className="ashell-tile">
            <span className="ashell-tile-lbl">This weekend</span>
            <span className="ashell-tile-big">{fmt(counts.weekend)}</span>
            <span className="ashell-tile-sub">Friday to Sunday</span>
          </div>
        </div>
      </section>

      <PulseDivider liveNow={counts.liveNow} />

      <PartnerEventsSurface orgFilter={orgFilter} />

      {orgs.length > 0 && <OrgAnalytics orgs={orgs} focusId={scope} />}
    </div>
  )
}

function fmt(n: number | null): string {
  return n == null ? '…' : n.toLocaleString()
}
