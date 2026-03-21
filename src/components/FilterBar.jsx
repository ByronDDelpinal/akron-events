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
 * @param {string|null}  props.category     active category filter
 * @param {Function}     props.onCategory   setter
 * @param {string|null}  props.dateRange    active date range filter
 * @param {Function}     props.onDateRange  setter
 * @param {boolean}      props.freeOnly     filter for free events
 * @param {Function}     props.onFreeOnly   setter
 * @param {string}       props.sort         'soonest' | 'latest' | 'recent'
 * @param {Function}     props.onSort       setter
 */
export default function FilterBar({
  category,    onCategory,
  dateRange,   onDateRange,
  freeOnly,    onFreeOnly,
  sort,        onSort,
}) {
  return (
    <div className="filter-bar">
      <div className="filter-inner">
        <div className="filter-row">

          {/* Category chips */}
          {CATEGORIES.map((c) => (
            <button
              key={c.label}
              className={`chip ${category === c.value ? 'active' : ''}`}
              onClick={() => onCategory(c.value)}
            >
              {c.label}
            </button>
          ))}

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

          <select
            className="sort-select"
            value={sort}
            onChange={(e) => onSort(e.target.value)}
          >
            <option value="soonest">Sort: Soonest</option>
            <option value="latest">Sort: Latest</option>
            <option value="recent">Sort: Recently Added</option>
          </select>

        </div>
      </div>
    </div>
  )
}
