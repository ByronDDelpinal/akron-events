import { useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import { CATEGORY_OPTIONS, SORT_OPTIONS, PRICE_OPTIONS } from '@/lib/filterOptions'
import './FilterTray.css'

const TODAY = new Date().toISOString().split('T')[0]

/**
 * FilterTray — bottom-sheet modal for advanced filtering.
 *
 * Props:
 *   open            {boolean}
 *   onClose         {function}
 *   activeIntentId  {string|null} onIntentId      {function}
 *   rawCategories   {string[]}    onRawCategories {function}
 *   priceFilter     {string|null} onPriceFilter   {function}  null | 'free' | 'under10' | 'under25'
 *   dateFrom        {string|null} onDateFrom      {function}  'YYYY-MM-DD'
 *   dateTo          {string|null} onDateTo        {function}  'YYYY-MM-DD'
 *   sort            {string}      onSort          {function}
 *   total           {number}      — live result count for the CTA
 */
export default function FilterTray({
  open,
  onClose,
  activeIntentId, onIntentId,
  rawCategories,  onRawCategories,
  priceFilter,    onPriceFilter,
  dateFrom,       onDateFrom,
  dateTo,         onDateTo,
  sort,           onSort,
  total,
  // `lockedDimensions` lets caller pages (e.g. category-hub pages) hide
  // the filter sections that would let a user undo the page's defining
  // constraint. On /events/concerts we hide Category; on /events/free we
  // hide Price; on /events/today and /events/this-weekend we hide the
  // Custom date range. Sort and any non-locked sections always remain
  // available so users can still narrow further.
  lockedDimensions = {},
}) {
  // Lock body scroll while tray is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  // Dispatch chip clicks to the right state bucket — intents are single-select,
  // raw categories are multi-select, both can coexist (intent stays "selected"
  // but rawCategories override at the query level when both are set).
  function toggleOption(opt) {
    if (opt.kind === 'intent') {
      onIntentId(activeIntentId === opt.value ? null : opt.value)
      return
    }
    if (rawCategories.includes(opt.value)) {
      onRawCategories(rawCategories.filter(c => c !== opt.value))
    } else {
      onRawCategories([...rawCategories, opt.value])
    }
  }

  function isOptionActive(opt) {
    return opt.kind === 'intent'
      ? activeIntentId === opt.value
      : rawCategories.includes(opt.value)
  }

  function clearAll() {
    onIntentId(null)
    onRawCategories([])
    onPriceFilter(null)
    onDateFrom(null)
    onDateTo(null)
    onSort('soonest')
  }

  return (
    <div className="tray-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tray-sheet" role="dialog" aria-modal="true" aria-label="Filter and sort">

        {/* Drag handle */}
        <div className="tray-handle" />

        {/* Header */}
        <div className="tray-header">
          <span className="tray-title">Filter &amp; Sort</span>
          <button className="tray-clear-btn" onClick={clearAll}>Clear all</button>
        </div>

        {/* ── Sort ── */}
        <TraySection label="Sort by">
          <div className="tray-chips">
            {SORT_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                className={`tray-chip ${sort === value ? 'active' : ''}`}
                onClick={() => onSort(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </TraySection>

        {/* ── Category (intents + raw categories, unified) ── */}
        {!lockedDimensions.category && (
          <TraySection label="Category">
            <div className="tray-chips">
              {CATEGORY_OPTIONS.map(opt => (
                <button
                  key={`${opt.kind}:${opt.value}`}
                  className={`tray-chip ${isOptionActive(opt) ? 'active' : ''}`}
                  onClick={() => toggleOption(opt)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </TraySection>
        )}

        {/* ── Price ── */}
        {!lockedDimensions.price && (
          <TraySection label="Price">
            <div className="tray-chips">
              {PRICE_OPTIONS.map(({ value, label }) => (
                <button
                  key={String(value)}
                  className={`tray-chip ${priceFilter === value ? 'active' : ''}`}
                  onClick={() => onPriceFilter(priceFilter === value ? null : value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </TraySection>
        )}

        {/* ── Custom date range ── */}
        {!lockedDimensions.dateRange && (
          <TraySection label="Custom date range">
            <div className="tray-date-row">
              <label className="tray-date-label">
                From
                <input
                  type="date"
                  className="tray-date-input"
                  value={dateFrom ?? ''}
                  min={TODAY}
                  onChange={e => onDateFrom(e.target.value || null)}
                />
              </label>
              <label className="tray-date-label">
                To
                <input
                  type="date"
                  className="tray-date-input"
                  value={dateTo ?? ''}
                  min={dateFrom ?? TODAY}
                  onChange={e => onDateTo(e.target.value || null)}
                />
              </label>
            </div>
            {(dateFrom || dateTo) && (
              <button
                className="tray-date-clear"
                onClick={() => { onDateFrom(null); onDateTo(null) }}
              >
                Clear custom dates
              </button>
            )}
          </TraySection>
        )}

        {/* ── CTA ── */}
        <button className="tray-cta" onClick={onClose}>
          Show {total} {total === 1 ? 'event' : 'events'} →
        </button>

      </div>
    </div>
  )
}

function TraySection({ label, children }) {
  return (
    <div className="tray-section">
      <p className="tray-section-label">{label}</p>
      {children}
    </div>
  )
}
