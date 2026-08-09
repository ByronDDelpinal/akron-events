/**
 * PlanMap.tsx
 *
 * The day plan's route map, rendered inside DayPlanBoard.tsx on both /day
 * and /d/:code. Fully controlled by its parent: no fetching, no date math,
 * no knowledge of drafts/plans/rot -- DayPlanBoard derives `points` and
 * `connector` from planMapPoints.ts's toPlanMapPoints() and owns the
 * selectedKey state this component reads and writes back to via onSelect.
 *
 * Bounded at 30 markers (dayPlanDraft.ts's MAX_ITEMS / migration 052's
 * item_count CHECK). Thirty DOM markers is nothing -- there is deliberately
 * no clustering, no virtualization, and no GeoJSON symbol layer for the
 * pins. Don't reach for a clustering library here without re-deriving that
 * this bound changed.
 *
 * Not a copy of MapView.tsx and not extending it with a mode prop: MapView
 * fills the viewport, gates scroll-zoom behind a click-to-activate overlay,
 * draws neighborhood scope masks, and navigates away on a popup click. This
 * map is a fixed-height inline panel with numbered stops and a popup that
 * SELECTS rather than navigates -- different enough that a shared component
 * would mean branching on mode through markers, popups, bounds, and the
 * camera controls. What's actually shared (the OpenFreeMap style/center in
 * mapConfig.ts, the popup chrome in MapPopup.css) is extracted, not copied.
 *
 * Scroll-zoom: uses MapLibre's built-in `cooperativeGestures` (confirmed
 * available on maplibre-gl@5's MapOptions, exposed by react-map-gl@8/
 * @vis.gl/react-maplibre's MapProps) rather than porting MapView's bespoke
 * click-to-activate gate, whose click handling would conflict with marker
 * selection here. MapView's own gate is unchanged -- this is a different,
 * accepted inconsistency between the two maps' scroll behavior (inline
 * panel vs. full-viewport view).
 */
import { useState, useMemo, useCallback, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import MapGL, { Marker, Popup, NavigationControl, Source, Layer, type MapRef } from 'react-map-gl/maplibre'
import { AKRON_CENTER, MAP_STYLE, DEFAULT_ZOOM } from '@/lib/mapConfig'
import { boundsForPoints, roundCoordKey, type PlanMapPoint, type PlanMarkerGroup, type BBox } from '@/lib/planMapPoints'
import { prefersReducedMotion } from '@/lib/feedback'
import { trackEvent, EVENTS } from '@/lib/analytics'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapPopup.css'
import './PlanMap.css'

const DEFAULT_CONNECTOR_COLOR = '#96671E' // fallback amber; overridden from --amber once mounted

export interface PlanMapProps {
  /** Mapped items only, ordered by number. Built by planMapPoints.ts. */
  points: PlanMapPoint[]
  /** One LineString per Eastern day with >=2 mapped stops -- also built by
   *  planMapPoints.ts, since building it requires day grouping (date math)
   *  this component is deliberately kept free of. */
  connector: GeoJSON.FeatureCollection
  /** Selection lives in DayPlanBoard. May reference an item that isn't in
   *  `points` (an unmapped item selected from the list) -- in that case no
   *  group matches, so no popup opens and the camera doesn't move. */
  selectedKey: string | null
  onSelect: (key: string | null) => void
  /** Total plan item count (mapped + unmapped), for the accessible group
   *  label, e.g. "6 of 7 stops shown". */
  totalItems: number
  /** Draws the per-day dotted connector when true. A prop specifically so
   *  it can be killed later without touching anything else about this
   *  component. */
  showConnector?: boolean
}

function centerOfBounds(b: BBox): { longitude: number; latitude: number } {
  return { longitude: (b[0] + b[2]) / 2, latitude: (b[1] + b[3]) / 2 }
}

/** Group by rounded coordinate (planMapPoints.ts's roundCoordKey -- same
 *  function toPlanMapPoints() uses internally) so two events at one venue
 *  share a single marker instead of stacking invisibly. Derived here from
 *  `points` rather than threaded through as its own prop: unlike the
 *  connector, grouping-by-coordinate needs no date math, so it stays a
 *  cheap, local derivation and PlanMap's props surface stays exactly
 *  points + connector + selection. */
function groupPoints(points: PlanMapPoint[]): PlanMarkerGroup[] {
  const byKey = new Map<string, PlanMarkerGroup>()
  for (const p of points) {
    const key = roundCoordKey(p.lat, p.lng)
    const existing = byKey.get(key)
    if (existing) existing.points.push(p)
    else byKey.set(key, { key, lat: p.lat, lng: p.lng, points: [p] })
  }
  return [...byKey.values()]
}

export default function PlanMap({ points, connector, selectedKey, onSelect, totalItems, showConnector = true }: PlanMapProps) {
  const mapRef = useRef<MapRef | null>(null)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [connectorColor, setConnectorColor] = useState(DEFAULT_CONNECTOR_COLOR)
  // Seed the controlled camera onto Akron before the map can run a precise
  // fitBounds (MapView.tsx:117-130's lesson: an imperative fitBounds alone
  // can silently no-op if the map isn't sized yet). The fit effect below
  // immediately refines this once mapLoaded flips true.
  const [viewState, setViewState] = useState({ ...AKRON_CENTER, zoom: DEFAULT_ZOOM })

  // groupPoints keeps grouping local to the DOM-ordering concerns of this
  // component (tab order == marker DOM order == each group's lowest
  // number). planMapPoints.ts's toPlanMapPoints() already returns the same
  // grouping for the connector/points derivation, but re-deriving it here
  // from `points` alone keeps PlanMap's own props surface exactly what the
  // design specifies (points + connector), with no third groups prop to
  // keep in sync.
  const groups = useMemo(() => groupPoints(points), [points])

  const pointsKey = useMemo(() => points.map((p) => p.key).join('|'), [points])

  useEffect(() => {
    if (!sectionRef.current) return
    const cs = getComputedStyle(sectionRef.current)
    const amber = cs.getPropertyValue('--amber').trim()
    if (amber) setConnectorColor(amber)
  }, [])

  const fitToPoints = useCallback((animate: boolean) => {
    const map = mapRef.current
    if (!map || groups.length === 0) return
    const duration = animate ? (prefersReducedMotion() ? 0 : 600) : 0
    if (groups.length === 1) {
      // Single place (one stop, or several stacked at one venue): skip
      // fitBounds entirely. A degenerate bbox (all points at one
      // coordinate) is the classic source of a NaN camera.
      const g = groups[0]
      if (animate) map.easeTo({ center: [g.lng, g.lat], zoom: 15, duration })
      else map.jumpTo({ center: [g.lng, g.lat], zoom: 15 })
      return
    }
    const b = boundsForPoints(points)
    if (!b) return
    // maxZoom: 15 is load-bearing -- without it, a tight cluster of points
    // fits to zoom ~22 and the visitor gets a featureless beige rectangle.
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 56, maxZoom: 15, duration })
  }, [groups, points])

  // Initial fit: on load, and whenever the mapped point SET's identity
  // changes (not just count -- an item swapping in/out re-fits). duration
  // 0 -- an animated camera move on page load is motion nobody asked for.
  useEffect(() => {
    if (!mapLoaded) return
    fitToPoints(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, pointsKey])

  // List -> map: pan/zoom to the selected point and never zoom OUT (a
  // selection that pulls the camera back is disorienting). No-op when
  // selectedKey belongs to an unmapped item -- there's no point to pan to,
  // and the camera should hold still rather than jump to Akron center.
  useEffect(() => {
    if (!mapLoaded || !selectedKey) return
    const point = points.find((p) => p.key === selectedKey)
    if (!point) return
    const map = mapRef.current
    if (!map) return
    map.easeTo({
      center: [point.lng, point.lat],
      zoom: Math.max(map.getZoom(), 15),
      duration: prefersReducedMotion() ? 0 : 600,
    })
  }, [selectedKey, mapLoaded, points])

  const activeGroup = useMemo(
    () => (selectedKey ? groups.find((g) => g.points.some((p) => p.key === selectedKey)) ?? null : null),
    [groups, selectedKey],
  )

  const fitCenter = useMemo(() => {
    if (groups.length === 1) return { longitude: groups[0].lng, latitude: groups[0].lat }
    const b = boundsForPoints(points)
    return b ? centerOfBounds(b) : AKRON_CENTER
  }, [groups, points])

  const isOffCenter = useMemo(() => (
    Math.abs(viewState.longitude - fitCenter.longitude) > 0.01 ||
    Math.abs(viewState.latitude - fitCenter.latitude) > 0.01
  ), [viewState, fitCenter])

  const handleFitClick = useCallback(() => {
    onSelect(null)
    fitToPoints(true)
  }, [onSelect, fitToPoints])

  // Shared by the Marker's own onClick (stem/padding clicks) and PlanPin's
  // onClick (the button itself -- keyboard activation and most mouse
  // clicks land here, see PlanPin below). Never double-fires: PlanPin's
  // handler calls stopPropagation, so a button click never also reaches the
  // Marker wrapper's listener.
  const handleMarkerSelect = useCallback((key: string) => {
    trackEvent(EVENTS.PLAN_MAP_SELECTION, { from: 'marker' })
    onSelect(key)
  }, [onSelect])

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onSelect(null)
  }, [onSelect])

  const mappedCount = points.length
  const groupLabel = mappedCount === totalItems
    ? `Map of your day plan, ${mappedCount} ${mappedCount === 1 ? 'stop' : 'stops'}`
    : `Map of your day plan, ${mappedCount} of ${totalItems} stops shown`

  return (
    <div
      className="plan-map"
      ref={sectionRef}
      role="group"
      aria-label={groupLabel}
      onKeyDown={handleKeyDown}
    >
      <MapGL
        ref={mapRef}
        {...viewState}
        onMove={(e: { viewState: typeof viewState }) => setViewState(e.viewState)}
        onLoad={() => setMapLoaded(true)}
        style={{ width: '100%', height: '100%' }}
        mapStyle={MAP_STYLE}
        cooperativeGestures
        onClick={() => onSelect(null)}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {/* Connector drawn before markers so it sits underneath them. Never
         * across a day boundary, never for a single-stop day, never
         * labelled with a distance or an arrow -- see planMapPoints.ts's
         * toPlanMapPoints for how the geometry is built and why dotted
         * (not solid) is load-bearing: a solid line on a street basemap
         * reads as turn-by-turn directions, which this is not. */}
        {showConnector && connector.features.length > 0 && (
          <Source id="plan-connector" type="geojson" data={connector}>
            <Layer
              id="plan-connector-line"
              type="line"
              paint={{
                'line-color': connectorColor,
                'line-opacity': 0.45,
                'line-width': 2,
                'line-dasharray': [1, 2],
              }}
            />
          </Source>
        )}

        {/* Markers render in `groups` order, which follows each group's
         * earliest chronological occurrence -- so tab order walks the day
         * in sequence. Do not reorder for z-index reasons; the selected
         * pin's z-index is handled in PlanMap.css instead. */}
        {groups.map((g) => {
          const selectedInGroup = g.points.find((p) => p.key === selectedKey)
          const displayPoint = selectedInGroup ?? g.points[0]
          const isSelected = activeGroup?.key === g.key
          return (
            <Marker
              key={g.key}
              longitude={g.lng}
              latitude={g.lat}
              anchor="bottom"
              onClick={(e: { originalEvent: MouseEvent }) => {
                e.originalEvent.stopPropagation()
                handleMarkerSelect(displayPoint.key)
              }}
            >
              <PlanPin
                number={displayPoint.number}
                count={g.points.length}
                selected={isSelected}
                struck={displayPoint.struck}
                label={`Stop ${displayPoint.number}: ${displayPoint.title}${displayPoint.venueName ? ` at ${displayPoint.venueName}` : ''}`}
                onSelect={() => handleMarkerSelect(displayPoint.key)}
              />
            </Marker>
          )
        })}

        {activeGroup && (
          <Popup
            longitude={activeGroup.lng}
            latitude={activeGroup.lat}
            anchor="bottom"
            offset={42}
            closeButton={false}
            closeOnClick={false}
            className="map-popup-outer"
            maxWidth="320px"
          >
            <PlanPopup group={activeGroup} selectedKey={selectedKey} onSelect={onSelect} />
          </Popup>
        )}
      </MapGL>

      {isOffCenter && (
        <button
          type="button"
          className="plan-map-fit map-recenter-btn"
          onClick={handleFitClick}
          aria-label="Fit the map to your whole day"
        >
          <ResetIcon /> Fit whole day
        </button>
      )}
    </div>
  )
}

// ── Numbered pin ─────────────────────────────────────────────────────────

interface PlanPinProps {
  number: number
  count: number
  selected: boolean
  struck: boolean
  label: string
  /** P1-10: this button previously had NO onClick of its own -- selection
   *  relied entirely on the Marker wrapper's click handler, which meant
   *  whether Enter/Space on this focused, aria-pressed button actually
   *  selected anything depended on MapLibre's marker element not stopping
   *  propagation of a SYNTHETIC click React fires for keyboard activation.
   *  That's not a contract to rely on, and a button advertising
   *  aria-pressed with no working keyboard activation is worse than one
   *  with no aria-pressed at all. The handler here calls stopPropagation so
   *  a real mouse click never also re-fires the Marker's own handler. */
  onSelect: () => void
}

function PlanPin({ number, count, selected, struck, label, onSelect }: PlanPinProps) {
  const handleClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onSelect()
  }, [onSelect])

  return (
    <button
      type="button"
      className={`plan-pin${selected ? ' plan-pin--selected' : ''}${struck ? ' plan-pin--struck' : ''}`}
      aria-label={label}
      aria-pressed={selected}
      onClick={handleClick}
    >
      <span className="plan-pin-dot">
        <span className="plan-pin-num">{number}</span>
        {count > 1 && <span className="plan-pin-count">{count}</span>}
      </span>
      <span className="plan-pin-stem" aria-hidden="true" />
    </button>
  )
}

// ── Group popup ───────────────────────────────────────────────────────────

interface PlanPopupProps {
  group: PlanMarkerGroup
  selectedKey: string | null
  onSelect: (key: string | null) => void
}

function PlanPopup({ group, selectedKey, onSelect }: PlanPopupProps) {
  const first = group.points[0]
  const address = first.address
  const city = first.city

  return (
    <div className="map-popup plan-popup">
      <div className="map-popup-header">
        <div className="map-popup-header-text">
          <span className="map-popup-venue">{first.venueName ?? 'This stop'}</span>
          {group.points.length > 1 && (
            <span className="map-popup-event-count">{group.points.length} stops here</span>
          )}
        </div>
        <button className="map-popup-close" aria-label="Close popup" onClick={() => onSelect(null)}>
          <CloseIcon />
        </button>
      </div>

      <div className="plan-popup-events">
        {group.points.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`plan-popup-event${p.key === selectedKey ? ' plan-popup-event--selected' : ''}${p.struck ? ' plan-popup-event--struck' : ''}`}
            onClick={() => {
              trackEvent(EVENTS.PLAN_MAP_SELECTION, { from: 'popup' })
              onSelect(p.key)
            }}
          >
            <span className="plan-popup-event-number" aria-hidden="true">{p.number}</span>
            <span className="plan-popup-event-body">
              <span className="plan-popup-event-title">{p.title}</span>
              <span className="plan-popup-event-time">{p.timeLabel}</span>
              {p.struck && <span className="plan-popup-event-note">Cancelled by the organizer</span>}
            </span>
          </button>
        ))}
      </div>

      {address && (
        <a
          className="map-popup-directions"
          href={`https://maps.google.com/?q=${encodeURIComponent(`${first.venueName ?? ''} ${address} ${city ?? ''}`.trim())}`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          <DirectionsIcon />
          Get directions
        </a>
      )}
    </div>
  )
}

// ── Icons (small, local copies -- MapView.tsx doesn't export its own) ─────

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" /><path d="m6 6 12 12" />
    </svg>
  )
}

function DirectionsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11l18-5-5 18-4-8-9-5z" />
    </svg>
  )
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}
