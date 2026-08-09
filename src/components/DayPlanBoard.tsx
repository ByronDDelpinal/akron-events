import { useCallback, useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react'
import DayPlanTimeline, { type PlanRenderItem } from '@/components/DayPlanTimeline'
import { numberPlanItems, toPlanMapPoints } from '@/lib/planMapPoints'
import { prefersReducedMotion } from '@/lib/feedback'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './DayPlanBoard.css'

// React.lazy so a visitor who never opens the map (mobile, collapsed --
// see the collapse effect below) never fetches the maplibre chunk. Measured
// 2026-08-08: swapping this for a static import grows the entry chunk from
// 999.44 kB to 1,004.81 kB (295.74 kB -> 297.35 kB gzip) -- the ~5.4 kB of
// PlanMap.tsx's own code. The much larger maplibre-gl chunk (~1.05 MB) is
// already split out on its own regardless of this lazy() call, because
// MapView.tsx/VenueMap still import it statically elsewhere in the app --
// so this does NOT shrink what a homepage visitor downloads. What it DOES
// do: a mobile visitor who leaves the map collapsed never fetches EITHER
// chunk, and the day planner needs no revisiting when the app is eventually
// route-split. Making MapView/VenueMap lazy too (the change that would
// actually shrink the homepage's bundle) is separate, larger, and out of
// scope here -- it touches the homepage's critical path and deserves its
// own review.
const PlanMap = lazy(() => import('@/components/PlanMap'))

const MAP_COLLAPSED_KEY = 'akronpulse_plan_map_collapsed'
// Matches DESKTOP_QUERY in DayPlanTimeline.css/.tsx and the grid breakpoint
// in DayPlanBoard.css -- keep all three in step if this ever changes.
const MOBILE_QUERY = '(max-width: 899px)'

function readMapCollapsed(): boolean {
  try {
    return localStorage.getItem(MAP_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeMapCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(MAP_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch { /* private mode / storage disabled -- the toggle just doesn't persist */ }
}

/** Guarded matchMedia read + subscription, matching HeroRotator.tsx's
 *  usePrefersReducedMotion -- same pattern, different query. */
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export interface DayPlanBoardProps {
  items: PlanRenderItem[]
  /** Passed straight through to DayPlanTimeline (both render branches
   *  below) -- see that component's own prop doc (day-plan-audit.md P1-8). */
  emptyMessage?: string
}

/**
 * DayPlanBoard — the shared wrapper both /day (DayPlanPage, localStorage
 * draft) and /d/:code (SharedPlanPage, server response) render instead of
 * DayPlanTimeline directly. Owns EVERYTHING selection-related so neither
 * page duplicates it: the selectedKey state, the numbering/point derivation
 * (planMapPoints.ts, computed ONCE here and handed to both DayPlanTimeline
 * and PlanMap), the row-ref registry for map-to-list scrolling, and the
 * mobile map-collapse toggle + its localStorage persistence.
 *
 * Renders no map at all when there are zero mapped points (covers both the
 * empty plan and the rare all-unmapped plan with one rule) -- an empty
 * basemap with no pins reads as "we lost your stuff", which is worse than
 * no map.
 */
export default function DayPlanBoard({ items, emptyMessage }: DayPlanBoardProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => readMapCollapsed())
  const isMobile = useMatchMedia(MOBILE_QUERY)

  const rowRefs = useRef(new Map<string, HTMLElement>())
  const mapSectionRef = useRef<HTMLDivElement | null>(null)

  const numbers = useMemo(() => numberPlanItems(items), [items])
  const { points, connector } = useMemo(() => toPlanMapPoints(items), [items])

  const registerRow = useCallback((key: string, el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el)
    else rowRefs.current.delete(key)
  }, [])

  // Map -> list: scroll the selected row into view. `block: 'nearest'`, not
  // 'center' -- on desktop the list sits beside a sticky map, and centering
  // would yank the page for a row that was already visible. It's also a
  // no-op when the row is already in view, so this effect needs no origin
  // tracking to avoid re-scrolling on every selection.
  useEffect(() => {
    if (!selectedKey) return
    const el = rowRefs.current.get(selectedKey)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [selectedKey])

  // "Show on map" (or the desktop row-click convenience). On mobile this is
  // the ONLY selection affordance, and pressing it explicitly requests the
  // map -- expanding it if collapsed, then scrolling it into view. That is
  // not the anti-pattern of silently scrolling on an incidental tap: the
  // button is a deliberate request, so honoring it isn't theft of the
  // reader's position. On desktop the sticky map is already visible, so
  // selecting never scrolls the page.
  const handleSelectRow = useCallback((key: string) => {
    trackEvent(EVENTS.PLAN_MAP_SELECTION, { from: 'list' })
    setSelectedKey(key)
    if (!isMobile) return
    if (collapsed) {
      setCollapsed(false)
      writeMapCollapsed(false)
    }
    // Deferred a frame so the map section (and, if it was collapsed, the
    // just-mounted map) has laid out before we measure where to scroll.
    requestAnimationFrame(() => {
      mapSectionRef.current?.scrollIntoView({
        block: 'start',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
    })
  }, [isMobile, collapsed])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      writeMapCollapsed(next)
      trackEvent(EVENTS.PLAN_MAP_TOGGLED, { state: next ? 'collapsed' : 'expanded' })
      return next
    })
  }, [])

  // Zero mapped points (empty plan, or the rare all-unmapped one): no map,
  // no toggle -- the board collapses to exactly what DayPlanTimeline alone
  // renders today.
  if (points.length === 0) {
    return (
      <DayPlanTimeline
        items={items}
        numbers={numbers}
        selectedKey={null}
        onSelectRow={() => {}}
        registerRow={registerRow}
        emptyMessage={emptyMessage}
      />
    )
  }

  // Mobile-collapsed unmounts PlanMap entirely (not just CSS-hidden) so the
  // lazy-loaded maplibre chunk is never requested for a visitor who leaves
  // the map collapsed. Desktop ignores `collapsed` -- the toggle itself is
  // hidden there (DayPlanBoard.css) and the map is always shown.
  const mapHidden = isMobile && collapsed

  return (
    <div className="day-plan-board">
      <DayPlanTimeline
        items={items}
        numbers={numbers}
        selectedKey={selectedKey}
        onSelectRow={handleSelectRow}
        registerRow={registerRow}
        emptyMessage={emptyMessage}
      />
      <div className="day-plan-board-map" ref={mapSectionRef}>
        <button
          type="button"
          className="day-plan-map-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show map' : 'Hide map'}
        </button>
        {!mapHidden && (
          <Suspense fallback={<div className="plan-map-skeleton" aria-hidden="true" />}>
            <PlanMap
              points={points}
              connector={connector}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              totalItems={items.length}
              showConnector
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}
