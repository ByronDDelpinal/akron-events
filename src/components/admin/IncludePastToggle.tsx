/**
 * The one control that reveals expired rows on an admin surface.
 *
 * Admin lists default to hiding events that have already ended. That default
 * is only safe if the operator can always see how much it is hiding, so this
 * renders the count even while the toggle is off. Silent truncation reads as
 * "there is nothing else", which is how work disappears.
 */
interface IncludePastToggleProps {
  includePast: boolean
  onChange: (next: boolean) => void
  /** Rows hidden by the default filter. `null` while still counting. */
  hiddenCount: number | null
  /**
   * The count could not be fetched (as opposed to "still counting"). Shows
   * an honest "unavailable" instead of a perpetual "Counting…".
   */
  countUnavailable?: boolean
  /** Noun for the copy, e.g. "event". */
  noun?: string
}

export default function IncludePastToggle({
  includePast,
  onChange,
  hiddenCount,
  countUnavailable = false,
  noun = 'event',
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
      {!includePast && <span className="admin-include-past-hint">{hint}</span>}
    </div>
  )
}
