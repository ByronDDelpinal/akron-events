import { useState, useEffect, useRef } from 'react'
import './SearchableMultiSelect.css'

/**
 * Shared searchable multi-select with pill tags + dropdown.
 * Used in both admin pages and public-facing preference pages.
 *
 * Two modes:
 *  • Entity mode (default): select from a predefined list via dropdown
 *  • Freeform mode (freeform=true): type any string, press Enter to add as a pill
 *
 * @param {Array}    [allEntities]    — [{ id, name, ... }] (entity mode only)
 * @param {string[]} selectedIds      — selected IDs (entity) or strings (freeform)
 * @param {function} onChange          — receives updated array
 * @param {string}   placeholder      — search input placeholder
 * @param {function} [renderSubtitle] — optional fn(entity) → string shown below name
 * @param {function} [disabledLabel]  — optional fn(entity) → string if entity is "taken"
 * @param {number}   [maxResults=50]  — max dropdown results shown
 * @param {boolean}  [freeform=false] — enable freeform text entry mode
 * @param {number}   [maxItems]       — optional cap on number of selected items
 */
export default function SearchableMultiSelect({
  allEntities = [],
  selectedIds,
  onChange,
  placeholder = 'Search and select…',
  renderSubtitle,
  disabledLabel,
  maxResults = 50,
  freeform = false,
  maxItems,
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapRef = useRef(null)

  const atLimit = maxItems != null && selectedIds.length >= maxItems

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  /* ── Freeform mode ── */
  if (freeform) {
    const addTerm = () => {
      const term = search.trim().toLowerCase()
      if (!term || selectedIds.includes(term) || atLimit) return
      onChange([...selectedIds, term])
      setSearch('')
    }

    const removeTerm = (term) => onChange(selectedIds.filter(t => t !== term))

    const handleKeyDown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addTerm() }
    }

    return (
      <div className="sms-wrap" ref={wrapRef}>
        {selectedIds.length > 0 && (
          <div className="sms-pills">
            {selectedIds.map(term => (
              <span key={term} className="sms-pill">
                {term}
                <button
                  type="button"
                  className="sms-pill-x"
                  onClick={() => removeTerm(term)}
                  aria-label={`Remove ${term}`}
                >✕</button>
              </span>
            ))}
          </div>
        )}

        <div className="sms-input-wrap">
          <input
            className="form-input sms-input"
            type="text"
            placeholder={atLimit ? `Limit of ${maxItems} reached` : placeholder}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={atLimit}
          />
        </div>
      </div>
    )
  }

  /* ── Entity mode (default) ── */
  const selected = allEntities.filter(e => selectedIds.includes(e.id))
  const unselected = allEntities.filter(e => !selectedIds.includes(e.id))
  const filtered = search.trim()
    ? unselected.filter(e => e.name.toLowerCase().includes(search.trim().toLowerCase()))
    : unselected

  const remove = (id) => onChange(selectedIds.filter(x => x !== id))
  const add = (id) => { onChange([...selectedIds, id]); setSearch('') }

  return (
    <div className="sms-wrap" ref={wrapRef}>
      {selected.length > 0 && (
        <div className="sms-pills">
          {selected.map(e => (
            <span key={e.id} className="sms-pill">
              {e.name}
              <button
                type="button"
                className="sms-pill-x"
                onClick={() => remove(e.id)}
                aria-label={`Remove ${e.name}`}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="sms-input-wrap">
        <input
          className="form-input sms-input"
          type="text"
          placeholder={atLimit ? `Limit of ${maxItems} reached` : (selected.length > 0 ? 'Add another…' : placeholder)}
          value={search}
          onChange={e => { setSearch(e.target.value); setDropdownOpen(true) }}
          onFocus={() => setDropdownOpen(true)}
          disabled={atLimit}
        />
      </div>

      {dropdownOpen && !atLimit && (
        <div className="sms-dropdown">
          {filtered.length === 0 && (
            <div className="sms-empty">
              {search ? `No matches for "${search}"` : 'All selected'}
            </div>
          )}
          {filtered.slice(0, maxResults).map(e => {
            const takenNote = disabledLabel?.(e)
            return (
              <button
                key={e.id}
                type="button"
                className={`sms-option ${takenNote ? 'sms-option--taken' : ''}`}
                onClick={() => add(e.id)}
              >
                <span className="sms-option-name">{e.name}</span>
                {renderSubtitle && (
                  <span className="sms-option-sub">{renderSubtitle(e)}</span>
                )}
                {takenNote && <span className="sms-taken-note">{takenNote}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
