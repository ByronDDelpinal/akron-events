import { useEffect } from 'react'
import { format, parseISO } from 'date-fns'
import './FilterTray.css'

const TODAY = new Date().toISOString().split('T')[0]

/**
 * Unified category list. Intents and raw categories live side-by-side so the
 * user picks a vibe (Date Night) or a specific bucket (Music) from the same
 * row, no UI hierarchy to learn. `kind` decides which state bucket the chip
 * toggles when clicked. Order follows partner's preferred sequencing.
 */
const CATEGORY_OPTIONS = [
  { kind: 'intent', value: 'date-night', label: '🌙 Date Night' },
  { kind: 'raw',    value: 'music',      label: '🎵 Music' },
  { kind: 'raw',    value: 'art',        label: '🎨 Art' },
  { kind: 'raw',    value: 'food',       label: '🍺 Food & Drink' },
  { kind: 'intent', value: 'family-fun', label: '👨‍👩‍👧 Family Fun' },
  { kind: 'raw',    value: 'nonprofit',  label: '🤲 Non-Profit' },
  { kind: 'raw',    value: 'sports',     label: '🏟 Sports' },
  { kind: 'raw',    value: 'fitness',    label: '🏃 Fitness' },
  { kind: 'raw',    value: 'education',  label: '📚 Education' },
  { kind: 'raw',    value: 'nature',     label: '🌿 Nature' },
  { kind: 'intent', value: 'give-back',  label: '💛 Give Back' },
  { kind: 'raw',    value: 'community',  label: '🤝 Community' },
]

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
// Sources that can be hidden — ordered by volume (most prolific first)
const FILTERABLE_SOURCES = [
  { value: 'akron_library',      label: 'Akron Library' },
  { value: 'summit_metro_parks', label: 'Metro Parks' },
  { value: 'eventbrite',         label: 'Eventbrite' },
  { value: 'ticketmaster',       label: 'Ticketmaster' },
]

export default function FilterTray({
  open,
  onClose,
  activeIntentId, onIntentId,
  rawCategories,  onRawCategories,
  hiddenSources,  onHiddenSources,
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
    onHiddenSources([])
    onPriceFilter(null)
    onDateFrom(null)
    onDateTo(null)
    onSort('soonest')
  }

  function toggleHiddenSource(value) {
    if (hiddenSources.includes(value)) {
      onHiddenSources(hiddenSources.filter(s => s !== value))
    } else {
      onHiddenSources([...hiddenSources, value])
    }
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

        {/* ── Category (intents + raw categories, unified) ── */}
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

        {/* ── Hide sources ── */}
        <TraySection label="Hide sources">
          <div className="tray-chips">
            {FILTERABLE_SOURCES.map(({ value, label }) => (
              <button
                key={value}
                className={`tray-chip ${hiddenSources.includes(value) ? 'active' : ''}`}
                onClick={() => toggleHiddenSource(value)}
              >
                {hiddenSources.includes(value) ? `✕ ${label}` : label}
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
