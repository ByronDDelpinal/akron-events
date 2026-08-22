/**
 * The one control that reveals expired rows on an admin surface.
 *
 * Admin lists default to hiding events that have already ended. The original
 * rule here was that the default is only safe if the operator can always see
 * how much it is hiding, so the hidden count rendered even while the toggle
 * was off. The drawer-standardization spec (Byron, 2026-08-23) deliberately
 * REVERSED that invariant for the review queue: the count next to the toggle
 * reads as noise there, so surfaces may now opt out via `showHint={false}`.
 * This is an intentional product decision, not an oversight; do not restore
 * the hint on opted-out surfaces as a bug fix. Surfaces that keep the hint
 * keep the original guarantee.
 */
interface IncludePastToggleProps {
  includePast: boolean
  onChange: (next: boolean) => void
  /** Rows hidden by the default filter. `null` while still counting. */
  hiddenCount?: number | null
  /**
   * The count could not be fetched (as opposed to "still counting"). Shows
   * an honest "unavailable" instead of a perpetual "Counting…".
   */
  countUnavailable?: boolean
  /** Noun for the copy, e.g. "event". */
  noun?: string
  /**
   * Render the hidden-count copy next to the toggle. Default true (the
   * original honesty guarantee); the review queue passes false per the
   * 2026-08-23 spec reversal documented above.
   */
  showHint?: boolean
}

export default function IncludePastToggle({
  includePast,
  onChange,
  hiddenCount = null,
  countUnavailable = false,
  noun = 'event',
  showHint = true,
}: IncludePastToggleProps) {
  const plural = hiddenCount === 1 ? noun : `${noun}s`
  const hint = countUnavailable
    ? 'Hidden count unavailable'
    : hiddenCount === null
      ? 'Counting…'
      : hiddenCount === 0
        ? `No ended ${noun}s hidden`
        : `${hiddenCount.toLocaleString()} ended ${plural} hidden`

  return (
    <div className="admin-include-past">
      <button
        type="button"
        role="switch"
        aria-checked={includePast}
        className={`admin-toggle ${includePast ? 'admin-toggle--on' : ''}`}
        onClick={() => onChange(!includePast)}
        title="Expired means the event already ended, not that it already started. Events running right now are always shown."
      >
        Include past
      </button>
      {showHint && !includePast && <span className="admin-include-past-hint">{hint}</span>}
    </div>
  )
}
