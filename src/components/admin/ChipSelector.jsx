/**
 * Toggleable chip list for linking entities (e.g., linking venues to an event).
 *
 * @param {string}   label       — section label ("Linked Venues")
 * @param {Array}    items       — [{ id, name }]
 * @param {string[]} selectedIds — currently selected IDs
 * @param {function} onChange    — receives updated ID array
 */
export default function ChipSelector({ label, items, selectedIds, onChange }) {
  const toggle = (id) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter(x => x !== id)
        : [...selectedIds, id]
    )
  }

  return (
    <>
      {label && <div className="admin-section-label">{label}</div>}
      <div className="admin-chip-list">
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            className={`admin-chip ${selectedIds.includes(item.id) ? 'active' : ''}`}
            onClick={() => toggle(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>
    </>
  )
}
