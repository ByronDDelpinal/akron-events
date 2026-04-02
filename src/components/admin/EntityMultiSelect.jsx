import { useState, useEffect, useRef } from 'react'

/**
 * Generic multiselect dropdown with search + pills.
 * Replaces the old VenueMultiSelect — works for any entity type.
 *
 * @param {Array}    allEntities      — [{ id, name, ... }]
 * @param {string[]} selectedIds      — currently selected IDs
 * @param {function} onChange         — receives updated ID array
 * @param {string}   placeholder      — search input placeholder
 * @param {function} disabledLabel    — optional fn(entity) → string label if entity is "taken"
 */
export default function EntityMultiSelect({
  allEntities,
  selectedIds,
  onChange,
  placeholder = 'Search and select…',
  disabledLabel,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [search, setSearch] = useState('')
  const dropdownRef = useRef(null)

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const selected = allEntities.filter(e => selectedIds.includes(e.id))
  const unselected = allEntities.filter(e => !selectedIds.includes(e.id))
  const filtered = search.trim()
    ? unselected.filter(e => e.name.toLowerCase().includes(search.trim().toLowerCase()))
    : unselected

  const remove = (id) => onChange(selectedIds.filter(x => x !== id))
  const add = (id) => onChange([...selectedIds, id])

  return (
    <div className="venue-multiselect" ref={dropdownRef}>
      {selected.length > 0 && (
        <div className="venue-ms-pills">
          {selected.map(e => (
            <span key={e.id} className="venue-ms-pill">
              {e.name}
              <button
                type="button"
                className="venue-ms-pill-x"
                onClick={() => remove(e.id)}
                aria-label={`Remove ${e.name}`}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="venue-ms-input-wrap">
        <input
          className="form-input venue-ms-input"
          type="text"
          placeholder={selected.length > 0 ? 'Add another…' : placeholder}
          value={search}
          onChange={e => { setSearch(e.target.value); setDropdownOpen(true) }}
          onFocus={() => setDropdownOpen(true)}
        />
      </div>

      {dropdownOpen && (
        <div className="venue-ms-dropdown">
          {filtered.length === 0 && (
            <div className="venue-ms-empty">
              {search ? 'No matches' : 'All selected'}
            </div>
          )}
          {filtered.map(e => {
            const takenNote = disabledLabel?.(e)
            return (
              <button
                key={e.id}
                type="button"
                className={`venue-ms-option ${takenNote ? 'venue-ms-option--taken' : ''}`}
                onClick={() => add(e.id)}
              >
                {e.name}
                {takenNote && <span className="venue-ms-taken-note">{takenNote}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
