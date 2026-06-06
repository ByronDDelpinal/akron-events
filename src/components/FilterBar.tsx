import { useState, type ReactNode } from 'react'
import { INTENTS } from '@/lib/intents'
import FilterTray from './FilterTray'
import ViewModeToggle from './ViewModeToggle'
import './FilterBar.css'

interface DateTab {
  id: string | null
  label: string
}

const DATE_TABS: DateTab[] = [
  { id: null,            label: 'All' },
  { id: 'today',         label: 'Today' },
  { id: 'this_weekend',  label: 'This Weekend' },
  { id: 'this_week',     label: 'This Week' },
  { id: 'this_month',    label: 'This Month' },
]

export interface LockedDimensions {
  category?: boolean
  price?: boolean
  dateRange?: boolean
}

interface FilterBarProps {
  activeIntentId: string | null
  onIntentId: (id: string | null) => void
  dateRange: string | null
  onDateRange: (v: string | null) => void
  dateFrom: string | null
  onDateFrom: (v: string | null) => void
  dateTo: string | null
  onDateTo: (v: string | null) => void
  rawCategories: string[]
  onRawCategories: (cats: string[]) => void
  priceFilter: string | null
  onPriceFilter: (v: string | null) => void
  sort: string
  onSort: (v: string) => void
  view: string
  onView?: (v: string) => void
  total: number
  cardViewMode?: string
  onCardViewMode?: (v: string) => void
  onClearAll?: () => void
  lockedDimensions?: LockedDimensions
  showFilterButton?: boolean
}

/**
 * FilterBar — sticky filter zone, consolidated to two rows.
 * Curated intents live inside the FilterTray alongside raw categories;
 * the active-filter summary strip renders below when any filter is on.
 */
export default function FilterBar({
  activeIntentId,  onIntentId,
  dateRange,       onDateRange,
  dateFrom,        onDateFrom,
  dateTo,          onDateTo,
  rawCategories,   onRawCategories,
  priceFilter,     onPriceFilter,
  sort,            onSort,
  view,            onView,
  total,
  cardViewMode,    onCardViewMode,
  onClearAll,
  lockedDimensions = {},
  showFilterButton = true,
}: FilterBarProps) {
  const [trayOpen, setTrayOpen] = useState(false)

  const activeIntent = INTENTS.find((i) => i.id === activeIntentId) ?? null

  // Locked dimensions are presets the user can't undo (category-hub pages,
  // embeds), so their pills never appear in the clearable summary strip.
  const showDatePill = (dateRange || dateFrom || dateTo) && !lockedDimensions.dateRange
  const visibleCategories = lockedDimensions.category ? [] : rawCategories
  const showPricePill = priceFilter && !lockedDimensions.price

  const trayActiveCount = [
    activeIntentId !== null,
    visibleCategories.length > 0,
    showPricePill,
    showDatePill && (dateFrom || dateTo),
    sort !== 'soonest',
  ].filter(Boolean).length

  const hasAnyClearable =
    activeIntentId ||
    showDatePill ||
    visibleCategories.length > 0 ||
    showPricePill ||
    sort !== 'soonest'

  function removeRawCat(cat: string) {
    onRawCategories(rawCategories.filter((c) => c !== cat))
  }

  return (
    <>
      <div className="filter-bar">

        {/* ── Row 1: Filter & Sort + View mode + List/Map toggle ── */}
        <div className="filter-actions-row">
          <div className="filter-actions">
            {showFilterButton && (
              <button
                className={`chip chip--more ${trayActiveCount > 0 ? 'active' : ''}`}
                onClick={() => setTrayOpen(true)}
              >
                <SlidersIcon />
                Filter &amp; Sort
                {trayActiveCount > 0 && (
                  <span className="more-badge">{trayActiveCount}</span>
                )}
              </button>
            )}
          </div>

          <div className="filter-actions-right">
            {/* Card view density toggle — hidden in map view */}
            {view === 'list' && cardViewMode && onCardViewMode && (
              <ViewModeToggle mode={cardViewMode} onChange={onCardViewMode} />
            )}

            {/* List / Map toggle */}
            {onView && (
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
            )}
          </div>
        </div>

        {/* ── Active filter summary strip ── */}
        {hasAnyClearable && (
          <div className="filter-active-strip">
            {activeIntent && (
              <ActivePill
                label={`${activeIntent.emoji} ${activeIntent.label}`}
                onRemove={() => onIntentId(null)}
              />
            )}
            {showDatePill && dateRange && (
              <ActivePill
                label={DATE_TABS.find((t) => t.id === dateRange)?.label ?? dateRange}
                onRemove={() => onDateRange(null)}
              />
            )}
            {showDatePill && (dateFrom || dateTo) && (
              <ActivePill
                label={buildDateRangeLabel(dateFrom, dateTo)}
                onRemove={() => { onDateFrom(null); onDateTo(null) }}
              />
            )}
            {visibleCategories.map((cat) => (
              <ActivePill
                key={cat}
                label={cat.charAt(0).toUpperCase() + cat.slice(1)}
                onRemove={() => removeRawCat(cat)}
              />
            ))}
            {showPricePill && (
              <ActivePill
                label={priceFilter === 'free' ? 'Free only' : priceFilter === 'under10' ? 'Under $10' : 'Under $25'}
                onRemove={() => onPriceFilter(null)}
              />
            )}
            {onClearAll && (
              <button className="active-pill active-pill--clear" onClick={onClearAll}>
                Clear filters
              </button>
            )}
          </div>
        )}

      </div>

      {/* Filter tray */}
      <FilterTray
        open={trayOpen}
        onClose={() => setTrayOpen(false)}
        activeIntentId={activeIntentId} onIntentId={onIntentId}
        rawCategories={rawCategories}   onRawCategories={onRawCategories}
        priceFilter={priceFilter}       onPriceFilter={onPriceFilter}
        dateFrom={dateFrom}             onDateFrom={onDateFrom}
        dateTo={dateTo}                 onDateTo={onDateTo}
        sort={sort}                     onSort={onSort}
        total={total}
        lockedDimensions={lockedDimensions}
      />
    </>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildDateRangeLabel(from: string | null, to: string | null): string {
  const fmt = (d: string | null): string => {
    if (!d) return '…'
    const [, m, day] = d.split('-')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${months[parseInt(m, 10) - 1]} ${parseInt(day, 10)}`
  }
  if (from === to) return fmt(from)
  return `${fmt(from)} – ${fmt(to)}`
}

interface ActivePillProps {
  label: ReactNode
  onRemove: () => void
}

function ActivePill({ label, onRemove }: ActivePillProps) {
  return (
    <span className="active-pill">
      {label}
      <span
        className="active-pill-x"
        role="button"
        aria-label="Remove filter"
        onClick={onRemove}
      >
        ✕
      </span>
    </span>
  )
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function SlidersIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <line x1="4" y1="6"  x2="20" y2="6"/>
      <line x1="4" y1="12" x2="20" y2="12"/>
      <line x1="4" y1="18" x2="20" y2="18"/>
      <circle cx="8"  cy="6"  r="2" fill="currentColor" stroke="none"/>
      <circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/>
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
      <line x1="9"  y1="3" x2="9"  y2="18"/>
      <line x1="15" y1="6" x2="15" y2="21"/>
    </svg>
  )
}
