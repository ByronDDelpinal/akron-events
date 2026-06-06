import { useState, useEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react'
import './SearchableMultiSelect.css'

interface Entity {
  id: string
  name: string
  [key: string]: unknown
}

interface SearchableMultiSelectProps {
  /** [{ id, name, ... }] (entity mode only) */
  allEntities?: Entity[]
  /** selected IDs (entity) or strings (freeform) */
  selectedIds: string[]
  /** receives the updated array */
  onChange: (ids: string[]) => void
  placeholder?: string
  /** optional fn(entity) → string shown below name */
  renderSubtitle?: (entity: Entity) => string
  /** optional fn(entity) → string if entity is "taken" */
  disabledLabel?: (entity: Entity) => string | null | undefined
  /** max dropdown results shown */
  maxResults?: number
  /** enable freeform text entry mode */
  freeform?: boolean
  /** optional cap on number of selected items */
  maxItems?: number
}

/**
 * Shared searchable multi-select with pill tags + dropdown. Used in both admin
 * pages and public-facing preference pages. Entity mode selects from a list;
 * freeform mode lets the user type any string and press Enter to add a pill.
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
}: SearchableMultiSelectProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [search, setSearch] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const atLimit = maxItems != null && selectedIds.length >= maxItems

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setDropdownOpen(false)
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

    const removeTerm = (term: string) => onChange(selectedIds.filter((t) => t !== term))

    const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); addTerm() }
    }

    return (
      <div className="sms-wrap" ref={wrapRef}>
        {selectedIds.length > 0 && (
          <div className="sms-pills">
            {selectedIds.map((term) => (
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
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={atLimit}
          />
        </div>
      </div>
    )
  }

  /* ── Entity mode (default) ── */
  const selected = allEntities.filter((e) => selectedIds.includes(e.id))
  const unselected = allEntities.filter((e) => !selectedIds.includes(e.id))
  const filtered = search.trim()
    ? unselected.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase()))
    : unselected

  const remove = (id: string) => onChange(selectedIds.filter((x) => x !== id))
  const add = (id: string) => { onChange([...selectedIds, id]); setSearch('') }

  return (
    <div className="sms-wrap" ref={wrapRef}>
      {selected.length > 0 && (
        <div className="sms-pills">
          {selected.map((e) => (
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
          onChange={(e: ChangeEvent<HTMLInputElement>) => { setSearch(e.target.value); setDropdownOpen(true) }}
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
          {filtered.slice(0, maxResults).map((e) => {
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
