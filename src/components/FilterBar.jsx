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

const DATE_RANGES = [
  { value: 'this_weekend', label: '📅 This Weekend' },
  { value: 'this_month',   label: 'This Month' },
]

/**
 * @param {Object}   props
 * @param {string[]}     props.categories   active category filters (empty = All)
 * @param {Function}     props.onCategories setter — receives new string[]
 * @param {string|null}  props.dateRange    active date range filter
 * @param {Function}     props.onDateRange  setter
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
  freeOnly,    onFreeOnly,
  sort,        onSort,
  view,        onView,
}) {
  function toggleCategory(value) {
    if (value === null) {
      // "All" — clear everything
      onCategories([])
      return
    }
    if (categories.includes(value)) {
      // Already selected — deselect it
      onCategories(categories.filter(c => c !== value))
    } else {
      // Add it to the selection
      onCategories([...categories, value])
    }
  }

  return (
    <div className="filter-bar">
      <div className="filter-inner">
        <div className="filter-row">

          {/* Category chips — "All" active when nothing selected; others toggle independently */}
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

          {/* Date range chips */}
          {DATE_RANGES.map((d) => (
            <button
              key={d.value}
              className={`chip ${dateRange === d.value ? 'active' : ''}`}
              onClick={() => onDateRange(dateRange === d.value ? null : d.value)}
            >
              {d.label}
            </button>
          ))}

          <div className="f-divider" />

          {/* Free */}
          <button
            className={`chip ${freeOnly ? 'active' : ''}`}
            onClick={() => onFreeOnly(!freeOnly)}
          >
            Free
          </button>

          <div className="f-divider" />

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

          {/* List / Map view toggle — pinned to the right */}
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
