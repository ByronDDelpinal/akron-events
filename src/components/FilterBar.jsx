import { useState } from 'react'
import { INTENTS } from '@/lib/intents'
import { SOURCE_LABELS } from '@/lib/sources'
import FilterTray from './FilterTray'
import ViewModeToggle from './ViewModeToggle'
import './FilterBar.css'

const DATE_TABS = [
  { id: null,            label: 'All' },
  { id: 'today',         label: 'Today' },
  { id: 'this_weekend',  label: 'This Weekend' },
  { id: 'this_week',     label: 'This Week' },
  { id: 'this_month',    label: 'This Month' },
]

/**
 * FilterBar — sticky filter zone, consolidated to two rows.
 *
 * Row 1: Date tabs (All / Today / This Weekend / This Week / This Month) + List/Map toggle
 * Row 2: "Filter & Sort" button + card view-mode toggle
 *
 * Curated intents (Date Night, Family Fun, Give Back) now live inside the
 * FilterTray alongside raw categories — a single unified picker rather than
 * a competing pill bar above. Active filter summary strip renders below when
 * any filter is on so users can deselect inline.
 */
export default function FilterBar({
  activeIntentId,  onIntentId,
  dateRange,       onDateRange,
  dateFrom,        onDateFrom,
  dateTo,          onDateTo,
  rawCategories,   onRawCategories,
  hiddenSources,   onHiddenSources,
  priceFilter,     onPriceFilter,
  sort,            onSort,
  view,            onView,
  total,
  cardViewMode,    onCardViewMode,
}) {
  const [trayOpen, setTrayOpen] = useState(false)

  const activeIntent = INTENTS.find(i => i.id === activeIntentId) ?? null

  // Count tray-specific active filters for the badge — intents now count too
  // since they live inside the tray after the consolidation.
  const trayActiveCount = [
    activeIntentId !== null,
    rawCategories.length > 0,
    hiddenSources.length > 0,
    priceFilter !== null,
    dateFrom || dateTo,
    sort !== 'soonest',
  ].filter(Boolean).length

  // Any filter active at all (for the summary strip)
  const hasAnyFilter = activeIntentId || dateRange || rawCategories.length > 0 || hiddenSources.length > 0 || priceFilter || dateFrom || dateTo

  function removeRawCat(cat) {
    onRawCategories(rawCategories.filter(c => c !== cat))
  }

  return (
    <>
      <div className="filter-bar">

        {/* ── Row 1: Date tabs + view toggle [TOGGLED OFF FOR NOW] ── */}
        {/* <div className="filter-date-row">
          <div className="filter-date-tabs">
            {DATE_TABS.map(tab => (
              <button
                key={tab.label}
                className={`date-tab ${dateRange === tab.id ? 'active' : ''}`}
                onClick={() => onDateRange(tab.id === dateRange ? null : tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

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
        </div> */}

        {/* ── Row 2: Filter & Sort + View mode toggle ──
         * Intents (Date Night, Family Fun, Give Back) used to occupy a full
         * pill-bar row between the date tabs and this row. They now live
         * inside the Filter & Sort tray alongside raw categories so the
         * sticky filter zone stays a tight two rows. */}
        <div className="filter-actions-row">
          <div className="filter-actions">
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
          </div>

          {cardViewMode && onCardViewMode && (
            <ViewModeToggle mode={cardViewMode} onChange={onCardViewMode} />
          )}
        </div>

        {/* ── Active filter summary strip ── */}
        {hasAnyFilter && (
          <div className="filter-active-strip">
            {activeIntent && (
              <ActivePill
                label={`${activeIntent.emoji} ${activeIntent.label}`}
                onRemove={() => onIntentId(null)}
              />
            )}
            {dateRange && (
              <ActivePill
                label={DATE_TABS.find(t => t.id === dateRange)?.label ?? dateRange}
                onRemove={() => onDateRange(null)}
              />
            )}
            {(dateFrom || dateTo) && (
              <ActivePill
                label={buildDateRangeLabel(dateFrom, dateTo)}
                onRemove={() => { onDateFrom(null); onDateTo(null) }}
              />
            )}
            {rawCategories.map(cat => (
              <ActivePill
                key={cat}
                label={cat.charAt(0).toUpperCase() + cat.slice(1)}
                onRemove={() => removeRawCat(cat)}
              />
            ))}
            {hiddenSources.map(src => (
              <ActivePill
                key={`hide:${src}`}
                label={`Hide: ${SOURCE_LABELS[src] ?? src}`}
                onRemove={() => onHiddenSources(hiddenSources.filter(s => s !== src))}
              />
            ))}
            {priceFilter && (
              <ActivePill
                label={priceFilter === 'free' ? 'Free only' : priceFilter === 'under10' ? 'Under $10' : 'Under $25'}
                onRemove={() => onPriceFilter(null)}
              />
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
        hiddenSources={hiddenSources}   onHiddenSources={onHiddenSources}
        priceFilter={priceFilter}       onPriceFilter={onPriceFilter}
        dateFrom={dateFrom}             onDateFrom={onDateFrom}
        dateTo={dateTo}                 onDateTo={onDateTo}
        sort={sort}                     onSort={onSort}
        total={total}
      />
    </>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildDateRangeLabel(from, to) {
  const fmt = d => {
    if (!d) return '…'
    const [, m, day] = d.split('-')
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    return `${months[parseInt(m,10)-1]} ${parseInt(day,10)}`
  }
  if (from === to) return fmt(from)
  return `${fmt(from)} – ${fmt(to)}`
}

function ActivePill({ label, onRemove }) {
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
