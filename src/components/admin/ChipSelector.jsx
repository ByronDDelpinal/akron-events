/**
 * Toggleable chip list for multi-select (linking entities, picking categories).
 *
 * @param {string}   label       — section label ("Linked Venues")
 * @param {Array}    items       — [{ id, name }]
 * @param {string[]} selectedIds — currently selected IDs
 * @param {function} onChange    — receives updated ID array
 * @param {number}   [max]       — optional cap; unselected chips disable at max
 */
export default function ChipSelector({ label, items, selectedIds, onChange, max }) {
  const atMax = max != null && selectedIds.length >= max
  const toggle = (id) => {
    const isSelected = selectedIds.includes(id)
    if (!isSelected && atMax) return // cap reached — ignore new selections
    onChange(
      isSelected
        ? selectedIds.filter(x => x !== id)
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
        {items.map(item => {
          const isSelected = selectedIds.includes(item.id)
          return (
            <button
              key={item.id}
              type="button"
              className={`admin-chip ${isSelected ? 'active' : ''}`}
              onClick={() => toggle(item.id)}
              disabled={!isSelected && atMax}
              aria-pressed={isSelected}
            >
              {item.name}
            </button>
          )
        })}
      </div>
    </>
  )
}
