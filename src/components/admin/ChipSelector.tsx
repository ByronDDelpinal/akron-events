import { useId } from 'react'

interface ChipItem {
  id: string
  name: string
}

interface ChipSelectorProps {
  label?: string
  items: ChipItem[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  /** optional cap; unselected chips gray out and stop toggling at max */
  max?: number
  /**
   * Copy explaining the cap, shown when unselected chips hit `max`. Rendered
   * as a native `title` tooltip on each capped chip AND as a visually hidden
   * `aria-describedby` note (title alone is not reliably announced).
   */
  maxHint?: string
}

/**
 * Toggleable chip list for multi-select (linking entities, picking categories).
 *
 * Capped chips are `aria-disabled`, not `disabled`: a truly disabled button
 * leaves the tab order and, in some browsers, suppresses hover, which would
 * make the `maxHint` tooltip unreachable exactly when it matters. The
 * `toggle` guard below is what actually ignores activations at the cap.
 */
export default function ChipSelector({ label, items, selectedIds, onChange, max, maxHint }: ChipSelectorProps) {
  const hintId = useId()
  const atMax = max != null && selectedIds.length >= max
  const toggle = (id: string) => {
    const isSelected = selectedIds.includes(id)
    if (!isSelected && atMax) return // cap reached — ignore new selections
    onChange(
      isSelected
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
    )
  }

  return (
    <>
      {label && (
        <div className="admin-section-label">
          {label}{max != null ? ` (max ${max})` : ''}
        </div>
      )}
      <div className="admin-chip-list">
        {items.map((item) => {
          const isSelected = selectedIds.includes(item.id)
          const capped = !isSelected && atMax
          return (
            <button
              key={item.id}
              type="button"
              className={`admin-chip ${isSelected ? 'active' : ''} ${capped ? 'admin-chip--capped' : ''}`}
              onClick={() => toggle(item.id)}
              aria-disabled={capped || undefined}
              aria-describedby={capped && maxHint ? hintId : undefined}
              title={capped && maxHint ? maxHint : undefined}
              aria-pressed={isSelected}
            >
              {item.name}
            </button>
          )
        })}
      </div>
      {maxHint && <span id={hintId} className="sr-only">{maxHint}</span>}
    </>
  )
}
