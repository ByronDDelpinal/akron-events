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
  excludedCategories?: string[]
  /** Tri-state cycle for a content category: off -> include -> exclude -> off. */
  onCycleCategory?: (slug: string) => void
  priceFilter: string | null
  onPriceFilter: (v: string | null) => void
  dateFrom: string | null
  onDateFrom: (v: string | null) => void
  dateTo: string | null
  onDateTo: (v: string | null) => void
  sort: string
  onSort: (v: string) => void
  /** Audience filter: hide events flagged is_family. */
  excludeFamily?: boolean
  onExcludeFamily?: (v: boolean) => void
  showAudienceToggle?: boolean
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

// Intents (curated, single-select discovery mixes) and raw content categories
// (multi-select, tri-state) are now distinct tray sections — keeping them in one
// "Category" group implied raw-category rules (tap-again-to-exclude) applied to
// intents too, which they don't.
const INTENT_OPTIONS = CATEGORY_OPTIONS.filter((o) => o.kind === 'intent')
const RAW_OPTIONS    = CATEGORY_OPTIONS.filter((o) => o.kind === 'raw')

// Label lookup for raw category slugs, e.g. "music" → "🎵 Music".
const RAW_CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  RAW_OPTIONS.map((o) => [o.value, o.label])
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
  excludedCategories = [], onCycleCategory,
  priceFilter,    onPriceFilter,
  dateFrom,       onDateFrom,
  dateTo,         onDateTo,
  sort,           onSort,
  excludeFamily = false, onExcludeFamily,
  showAudienceToggle = false,
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
    // Raw content categories cycle off -> include -> exclude -> off.
    if (onCycleCategory) {
      onCycleCategory(opt.value)
      return
    }
    // Fallback (no cycle handler wired): legacy include-only toggle.
    if (rawCategories.includes(opt.value)) {
      onRawCategories(rawCategories.filter((c) => c !== opt.value))
    } else {
      onRawCategories([...rawCategories, opt.value])
    }
  }

  // null | 'include' | 'exclude'
  function optionState(opt: CategoryOption): 'include' | 'exclude' | null {
    if (opt.kind === 'intent') return activeIntentId === opt.value ? 'include' : null
    if (rawCategories.includes(opt.value)) return 'include'
    if (excludedCategories.includes(opt.value)) return 'exclude'
    return null
  }

  function clearAll() {
    onIntentId(null)
    // In the embed an empty categories param resets to the full locked set, so
    // this never escapes the lock. Locked price/date are left untouched.
    onRawCategories([])
    onExcludeFamily?.(false)
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

        {/* ── Quick picks (curated intents) ── */}
        {/* Single-select discovery mixes. Their own section so it's clear they
            behave differently from the tri-state content categories below. */}
        {!hasLockedCategories && !lockedDimensions.category && (
          <TraySection label="Quick picks">
            <p className="tray-section-hint">
              Curated mixes for an occasion — pick one.
            </p>
            <div className="tray-chips">
              {INTENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`tray-chip ${activeIntentId === opt.value ? 'active' : ''}`}
                  onClick={() => onIntentId(activeIntentId === opt.value ? null : opt.value)}
                  aria-pressed={activeIntentId === opt.value}
                >
                  <span className="tray-chip-text">{opt.label}</span>
                </button>
              ))}
            </div>
          </TraySection>
        )}

        {/* ── Category ── */}
        {/* Locked embed: offer only the partner's set so the visitor can narrow
            within it. Unlocked: the multi-select, tri-state content categories. */}
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
            <p className="tray-section-hint">
              Tap to show only that category. Tap again to hide it.
            </p>
            <div className="tray-chips">
              {RAW_OPTIONS.map((opt) => {
                const state = optionState(opt)
                return (
                  <button
                    key={opt.value}
                    className={`tray-chip${state === 'include' ? ' active' : ''}${state === 'exclude' ? ' excluded' : ''}`}
                    onClick={() => toggleOption(opt)}
                    aria-pressed={state !== null}
                    title={
                      state === 'exclude' ? 'Hidden — tap to clear'
                        : state === 'include' ? 'Showing only this — tap to hide it'
                        : 'Tap to show only this; tap again to hide'
                    }
                  >
                    <span className="tray-chip-text">{opt.label}</span>
                  </button>
                )
              })}
            </div>
          </TraySection>
        )}

        {/* ── Audience ── */}
        {showAudienceToggle && onExcludeFamily && (
          <TraySection label="Audience">
            <div className="tray-chips">
              <button
                className={`tray-chip ${!excludeFamily ? 'active' : ''}`}
                onClick={() => onExcludeFamily(false)}
                aria-pressed={!excludeFamily}
              >
                <span className="tray-chip-text">Everyone</span>
              </button>
              <button
                className={`tray-chip ${excludeFamily ? 'active' : ''}`}
                onClick={() => {
                  onExcludeFamily(true)
                  // Contradicts the Family intent (shows ONLY kids' events), so
                  // drop that intent if it's set.
                  if (activeIntentId === 'family') onIntentId(null)
                }}
                aria-pressed={excludeFamily}
                title="Hide kids' &amp; family events: storytimes, camps, teen programs"
              >
                <span className="tray-chip-text">Hide kids' &amp; family</span>
              </button>
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
