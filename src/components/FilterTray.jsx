import { useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import './FilterTray.css'

const TODAY = new Date().toISOString().split('T')[0]

const RAW_CATEGORIES = [
  { value: 'music',     label: '🎵 Music' },
  { value: 'art',       label: '🎨 Art' },
  { value: 'food',      label: '🍺 Food & Drink' },
  { value: 'community', label: '🤝 Community' },
  { value: 'nonprofit', label: '💛 Non-Profit' },
  { value: 'sports',    label: '🏃 Fitness' },
  { value: 'education', label: '📚 Education' },
]

/**
 * FilterTray — bottom-sheet modal for advanced filtering.
 *
 * Props:
 *   open          {boolean}
 *   onClose       {function}
 *   rawCategories {string[]}   onRawCategories {function}
 *   priceFilter   {string|null} onPriceFilter  {function}  null | 'free' | 'under10' | 'under25'
 *   dateFrom      {string|null} onDateFrom     {function}  'YYYY-MM-DD'
 *   dateTo        {string|null} onDateTo       {function}  'YYYY-MM-DD'
 *   sort          {string}     onSort          {function}
 *   total         {number}     — live result count for the CTA
 */
export default function FilterTray({
  open,
  onClose,
  rawCategories,  onRawCategories,
  priceFilter,    onPriceFilter,
  dateFrom,       onDateFrom,
  dateTo,         onDateTo,
  sort,           onSort,
  total,
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

  function toggleCat(value) {
    if (rawCategories.includes(value)) {
      onRawCategories(rawCategories.filter(c => c !== value))
    } else {
      onRawCategories([...rawCategories, value])
    }
  }

  function clearAll() {
    onRawCategories([])
    onPriceFilter(null)
    onDateFrom(null)
    onDateTo(null)
    onSort('soonest')
  }

  return (
    <div className="tray-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tray-sheet" role="dialog" aria-modal="true" aria-label="More filters">

        {/* Drag handle */}
        <div className="tray-handle" />

        {/* Header */}
        <div className="tray-header">
          <span className="tray-title">More Filters</span>
          <button className="tray-clear-btn" onClick={clearAll}>Clear all</button>
        </div>

        {/* ── Sort ── */}
        <TraySection label="Sort by">
          <div className="tray-chips">
            {[
              ['soonest', '📅 Soonest first'],
              ['latest',  '🕐 Latest first'],
              ['recent',  '🆕 Recently added'],
            ].map(([value, lbl]) => (
              <button
                key={value}
                className={`tray-chip ${sort === value ? 'active' : ''}`}
                onClick={() => onSort(value)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </TraySection>

        {/* ── Category ── */}
        <TraySection label="Category">
          <div className="tray-chips">
            {RAW_CATEGORIES.map(cat => (
              <button
                key={cat.value}
                className={`tray-chip ${rawCategories.includes(cat.value) ? 'active' : ''}`}
                onClick={() => toggleCat(cat.value)}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </TraySection>

        {/* ── Price ── */}
        <TraySection label="Price">
          <div className="tray-chips">
            {[
              [null,       'Any price'],
              ['free',     '🎉 Free'],
              ['under10',  'Under $10'],
              ['under25',  'Under $25'],
            ].map(([value, lbl]) => (
              <button
                key={String(value)}
                className={`tray-chip ${priceFilter === value ? 'active' : ''}`}
                onClick={() => onPriceFilter(priceFilter === value ? null : value)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </TraySection>

        {/* ── Custom date range ── */}
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
