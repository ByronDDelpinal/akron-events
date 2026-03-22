import { useState, useRef, useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import './FilterBar.css'

const CATEGORIES = [
  { value: null,        label: 'All' },
  { value: 'music',     label: '🎵 Music' },
  { value: 'art',       label: '🎨 Art' },
  { value: 'nonprofit', label: '💛 Non-Profit' },
  { value: 'community', label: '🤝 Community' },
  { value: 'food',      label: '🍺 Food & Drink' },
  { value: 'sports',    label: '🏃 Fitness' },
  { value: 'education', label: '📚 Education' },
]

const DATE_PRESETS = [
  { value: 'this_weekend', label: 'This Weekend' },
  { value: 'this_month',   label: 'This Month' },
]

// Today's date in YYYY-MM-DD for the min attribute on date inputs
const TODAY = new Date().toISOString().split('T')[0]

/**
 * @param {Object}   props
 * @param {string[]}     props.categories   active category filters (empty = All)
 * @param {Function}     props.onCategories setter — receives new string[]
 * @param {string|null}  props.dateRange    active preset filter
 * @param {Function}     props.onDateRange  setter
 * @param {string|null}  props.dateFrom     custom start date 'YYYY-MM-DD'
 * @param {Function}     props.onDateFrom   setter
 * @param {string|null}  props.dateTo       custom end date 'YYYY-MM-DD'
 * @param {Function}     props.onDateTo     setter
 * @param {boolean}      props.freeOnly     filter for free events
 * @param {Function}     props.onFreeOnly   setter
 * @param {string}       props.sort         'soonest' | 'latest' | 'recent'
 * @param {Function}     props.onSort       setter
 * @param {'list'|'map'} props.view         current view mode
 * @param {Function}     props.onView       setter
 */
export default function FilterBar({
  categories,  onCategories,
  dateRange,   onDateRange,
  dateFrom,    onDateFrom,
  dateTo,      onDateTo,
  freeOnly,    onFreeOnly,
  sort,        onSort,
  view,        onView,
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef(null)

  // Close popover on outside click
  useEffect(() => {
    if (!pickerOpen) return
    function handleClick(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  function toggleCategory(value) {
    if (value === null) { onCategories([]); return }
    if (categories.includes(value)) {
      onCategories(categories.filter(c => c !== value))
    } else {
      onCategories([...categories, value])
    }
  }

  function selectPreset(value) {
    // Clear custom range when a preset is chosen
    onDateFrom(null)
    onDateTo(null)
    onDateRange(dateRange === value ? null : value)
    setPickerOpen(false)
  }

  function applyCustomRange(from, to) {
    // Clear preset when custom dates are set
    onDateRange(null)
    onDateFrom(from || null)
    onDateTo(to || null)
  }

  function clearDateFilter() {
    onDateRange(null)
    onDateFrom(null)
    onDateTo(null)
  }

  // Build the chip label
  const hasCustom  = dateFrom || dateTo
  const hasPreset  = !!dateRange
  const hasAnyDate = hasCustom || hasPreset

  function dateChipLabel() {
    if (hasCustom) {
      const from = dateFrom ? format(parseISO(dateFrom), 'MMM d') : '…'
      const to   = dateTo   ? format(parseISO(dateTo),   'MMM d') : '…'
      return dateFrom === dateTo ? from : `${from} – ${to}`
    }
    if (hasPreset) {
      return DATE_PRESETS.find(p => p.value === dateRange)?.label ?? 'Date'
    }
    return 'Date'
  }

  return (
    <div className="filter-bar">
      <div className="filter-inner">

        {/* Scrollable chips */}
        <div className="filter-chips">

          {CATEGORIES.map((c) => {
            const isAll    = c.value === null
            const isActive = isAll ? categories.length === 0 : categories.includes(c.value)
            return (
              <button
                key={c.label}
                className={`chip ${isActive ? 'active' : ''}`}
                onClick={() => toggleCategory(c.value)}
              >
                {c.label}
              </button>
            )
          })}

          <div className="f-divider" />

          <button
            className={`chip ${freeOnly ? 'active' : ''}`}
            onClick={() => onFreeOnly(!freeOnly)}
          >
            Free
          </button>

        </div>

        {/* Date picker — lives OUTSIDE the scrollable chips so the popover isn't clipped */}
        <div className="date-picker-wrap" ref={pickerRef}>
          <button
            className={`chip chip--date ${hasAnyDate ? 'active' : ''}`}
            onClick={() => setPickerOpen(o => !o)}
          >
            <CalIcon />
            {dateChipLabel()}
            {hasAnyDate && (
              <span
                className="chip-clear"
                role="button"
                aria-label="Clear date filter"
                onClick={e => { e.stopPropagation(); clearDateFilter() }}
              >
                ✕
              </span>
            )}
          </button>

          {pickerOpen && (
            <div className="date-picker-popover">
              {/* Presets */}
              <p className="date-picker-section">Quick picks</p>
              <div className="date-picker-presets">
                {DATE_PRESETS.map(p => (
                  <button
                    key={p.value}
                    className={`date-preset-btn ${dateRange === p.value ? 'active' : ''}`}
                    onClick={() => selectPreset(p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Custom range */}
              <p className="date-picker-section">Custom range</p>
              <div className="date-picker-inputs">
                <label className="date-input-label">
                  From
                  <input
                    type="date"
                    className="date-input"
                    value={dateFrom ?? ''}
                    min={TODAY}
                    onChange={e => applyCustomRange(e.target.value, dateTo)}
                  />
                </label>
                <label className="date-input-label">
                  To
                  <input
                    type="date"
                    className="date-input"
                    value={dateTo ?? ''}
                    min={dateFrom ?? TODAY}
                    onChange={e => applyCustomRange(dateFrom, e.target.value)}
                  />
                </label>
              </div>

              {hasAnyDate && (
                <button className="date-picker-clear" onClick={() => { clearDateFilter(); setPickerOpen(false) }}>
                  Clear date filter
                </button>
              )}
            </div>
          )}
        </div>

        {/* Fixed right section — never scrolls */}
        <div className="filter-actions">
          {view === 'list' && (
            <select
              className="sort-select"
              value={sort}
              onChange={(e) => onSort(e.target.value)}
            >
              <option value="soonest">Sort: Soonest</option>
              <option value="latest">Sort: Latest</option>
              <option value="recent">Sort: Recently Added</option>
            </select>
          )}

          <div className="view-toggle" role="group" aria-label="View mode">
            <button
              className={`view-toggle-btn ${view === 'list' ? 'active' : ''}`}
              onClick={() => onView('list')}
              aria-pressed={view === 'list'}
              title="List view"
            >
              <ListIcon /> List
            </button>
            <button
              className={`view-toggle-btn ${view === 'map' ? 'active' : ''}`}
              onClick={() => onView('map')}
              aria-pressed={view === 'map'}
              title="Map view"
            >
              <MapIcon /> Map
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}

function CalIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <line x1="16" x2="16" y1="2" y2="6"/>
      <line x1="8"  x2="8"  y1="2" y2="6"/>
      <line x1="3"  x2="21" y1="10" y2="10"/>
    </svg>
  )
}

function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="8" y1="6"  x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <circle cx="3" cy="6"  r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="3" cy="18" r="1.5" fill="currentColor" stroke="none"/>
    </svg>
  )
}

function MapIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/>
      <line x1="9" y1="3" x2="9" y2="18"/>
      <line x1="15" y1="6" x2="15" y2="21"/>
    </svg>
  )
}
