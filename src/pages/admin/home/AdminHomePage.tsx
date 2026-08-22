import { OverviewBand, PulseDivider } from '@/components/admin'
import ReviewQueueSurface from '@/pages/admin/review/ReviewQueueSurface'
import { useShellCounts } from '@/lib/admin/useShellCounts'

/**
 * /admin -- Pulse, the overview. Four tiles of real numbers, the brand's
 * EKG divider breathing at the pace of the city, and the review queue
 * embedded whole underneath: the same component /admin/review renders,
 * because the queue is the day's actual work and the overview exists to
 * frame it, not to replace it.
 */
export default function AdminHomePage() {
  const { liveNow } = useShellCounts()
  return (
    <div className="ashell-home">
      <OverviewBand />
      <PulseDivider liveNow={liveNow} />
      <ReviewQueueSurface />
    </div>
  )
}
