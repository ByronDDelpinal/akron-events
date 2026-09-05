import type { Friend } from '@/lib/friends'

/**
 * A Friend, name only - deliberately smaller than FinancialsPage.tsx's
 * SponsorChip. Friends have no logo, no url, and no support tier to
 * disclose, so this stays its own tiny component rather than widening
 * Sponsor's type to fit a shape it was never meant to carry. Shared between
 * /financials and /friends, both of which render an ACTIVE_FRIENDS list
 * inside the same .fin-sponsors layout (openbooks.css).
 */
export default function FriendChip({ friend }: { friend: Friend }) {
  return (
    <div className="fin-sponsor">
      <span className="fin-sponsor__name">{friend.name}</span>
    </div>
  )
}
