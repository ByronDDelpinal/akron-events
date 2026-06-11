import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { CATEGORY_OPTIONS, SORT_OPTIONS, PRICE_OPTIONS, type CategoryOption } from '@/lib/filterOptions'
import './FilterTray.css'

const TODAY = new Date().toISOString().split('T')[0]

interface LockedDimensions {
  category?: boolean
  price?: boolean
  dateRange?: boolean
}

interface FilterTrayProps {
  open: boolean
  onClose: () => void
  activeIntentId: string | null
  onIntentId: (id: string | null) => void
  rawCategories: string[]
  onRawCategories: (cats: string[]) => void
  priceFilter: string | null
  onPriceFilter: (v: string | null) => void
  dateFrom: string | null
  onDateFrom: (v: string | null) => void
  dateTo: string | null
  onDateTo: (v: string | null) => void
  sort: string
  onSort: (v: string) => void
  total: number
  lockedDimensions?: LockedDimensions
  /**
   * The partner's locked category set (embed only). When present, the Category
   * section stays visible but offers ONLY these chips, so the visitor can narrow
   * within the lock (e.g. view just "music" inside a music+arts embed) without
   * ever escaping it.
   */
  lockedCategories?: string[]
}

// Label lookup for raw category slugs, e.g. "music" → "🎵 Music".
const RAW_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.filter((o) => o.kind === 'raw').map((o) => [o.value, o.label])
)
function rawCategoryLabel(slug: string): string {
  return RAW_CATEGORY_LABELS[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
}

/**
 * FilterTray — bottom-sheet modal for advanced filtering. `lockedDimensions`
 * lets caller pages hide the filter sections that would let a user undo the
 * page's defining constraint.
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
  lockedDimensions = {},
  lockedCategories = [],
}: FilterTrayProps) {
  const hasLockedCategories = lockedCategories.length > 0
  // Which locked chips read as active: the visitor's narrowing, or — when they
  // haven't narrowed — the full locked set (since that's what's being shown).
  const selectedLockedCategories = (() => {
    const narrowed = rawCategories.filter((c) => lockedCategories.includes(c))
    return narrowed.length > 0 ? narrowed : lockedCategories
  })()

  // Toggle a chip within the locked set. Selecting all (or none) means "no
  // narrowing", which we store as an empty param so the hook falls back to the
  // full locked set and the URL stays clean.
  function toggleLockedCategory(slug: string) {
    const current = selectedLockedCategories
    const next = current.includes(slug)
      ? current.filter((c) => c !== slug)
      : [...current, slug]
    onRawCategories(next.length === 0 || next.length === lockedCategories.length ? [] : next)
  }
  // Lock body scroll while tray is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  // ── Drag-to-close ──
  const CLOSE_THRESHOLD = 110 // px pulled down before a release dismisses
  const sheetRef = useRef<HTMLDivElement>(null)
  const dragStartY = useRef<number | null>(null)
  const [dragOffset, setDragOffset] = useState(0)
  const [dragging, setDragging] = useState(false)

  // Reset drag state whenever the tray is (re)opened.
  useEffect(() => {
    if (open) {
      setDragOffset(0)
      setDragging(false)
      dragStartY.current = null
    }
  }, [open])

  function handleDragStart(e: PointerEvent<HTMLDivElement>) {
    dragStartY.current = e.clientY
    setDragging(true)
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  function handleDragMove(e: PointerEvent<HTMLDivElement>) {
    if (dragStartY.current === null) return
    // Only allow downward movement.
    const delta = Math.max(0, e.clientY - dragStartY.current)
    setDragOffset(delta)
  }

  function handleDragEnd() {
    if (dragStartY.current === null) return
    dragStartY.current = null
    setDragging(false)
    if (dragOffset > CLOSE_THRESHOLD) {
      onClose()
    } else {
      setDragOffset(0)
    }
  }

  if (!open) return null

  const sheetStyle: CSSProperties | undefined = dragOffset
    ? {
        transform: `translateY(${dragOffset}px)`,
        transition: dragging ? 'none' : 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
        animation: 'none',
      }
    : undefined

  // Dispatch chip clicks to the right state bucket — intents are single-select,
  // raw categories are multi-select.
  function toggleOption(opt: CategoryOption) {
    if (opt.kind === 'intent') {
      onIntentId(activeIntentId === opt.value ? null : opt.value)
      return
    }
    if (rawCategories.includes(opt.value)) {
      onRawCategories(rawCategories.filter((c) => c !== opt.value))
    } else {
      onRawCategories([...rawCategories, opt.value])
    }
  }

  function isOptionActive(opt: CategoryOption) {
    return opt.kind === 'intent'
      ? activeIntentId === opt.value
      : rawCategories.includes(opt.value)
  }

  function clearAll() {
    onIntentId(null)
    // In the embed an empty categories param resets to the full locked set, so
    // this never escapes the lock. Locked price/date are left untouched.
    onRawCategories([])
    if (!lockedDimensions.price) onPriceFilter(null)
    if (!lockedDimensions.dateRange) { onDateFrom(null); onDateTo(null) }
    onSort('soonest')
  }

  return (
    <div className="tray-overlay" onClick={(e: MouseEvent) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={sheetRef}
        className="tray-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Filter and sort"
        style={sheetStyle}
      >

        {/* Drag handle */}
        <div
          className="tray-handle-zone"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
          role="button"
          tabIndex={0}
          aria-label="Drag down to close"
          onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') onClose() }}
        >
          <div className="tray-handle" />
        </div>

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

        {/* ── Category ── */}
        {/* Locked embed: offer only the partner's set so the visitor can narrow
            within it. Unlocked: the full intents + raw categories picker. */}
        {hasLockedCategories ? (
          <TraySection label="Category">
            <div className="tray-chips">
              {lockedCategories.map((slug) => (
                <button
                  key={slug}
                  className={`tray-chip ${selectedLockedCategories.includes(slug) ? 'active' : ''}`}
                  onClick={() => toggleLockedCategory(slug)}
                >
                  {rawCategoryLabel(slug)}
                </button>
              ))}
            </div>
          </TraySection>
        ) : !lockedDimensions.category && (
          <TraySection label="Category">
            <div className="tray-chips">
              {CATEGORY_OPTIONS.map((opt) => (
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
                  onChange={(e) => onDateFrom(e.target.value || null)}
                />
              </label>
              <label className="tray-date-label">
                To
                <input
                  type="date"
                  className="tray-date-input"
                  value={dateTo ?? ''}
                  min={dateFrom ?? TODAY}
                  onChange={(e) => onDateTo(e.target.value || null)}
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

function TraySection({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="tray-section">
      <p className="tray-section-label">{label}</p>
      {children}
    </div>
  )
}
