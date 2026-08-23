/**
 * FestivalMap.tsx
 *
 * The festival hub's desktop venue map: one pin per porch/stage, derived by
 * festivalSchedule.ts's toFestivalMapPins (pure, node-tested) from the same
 * rows the schedule renders -- no query of its own. Registry-driven and
 * festival-agnostic: everything specific to a festival (bounds, venue-name
 * prefix, pins) arrives through props from FestivalPage.tsx.
 *
 * Built on the PlanMap.tsx stack, not on MapView and not by adding mode
 * props to either: shared resolveMapStyle/DEFAULT_ZOOM from mapConfig.ts, popup
 * chrome from MapPopup.css, camera math from planMapPoints.ts. Pins are
 * plain DOM markers (a festival is <100 venues; PlanMap's no-clustering
 * rationale applies with the same force). The popup is click-only and
 * NAVIGATES NOWHERE in-app -- its one link is the external "Get directions",
 * exactly like PlanMap's popup footer.
 *
 * Lazy-mounted by FestivalPage (desktop match only), so mobile never fetches
 * this chunk or a single tile.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import MapGL, { Marker, Popup, NavigationControl, type MapRef } from 'react-map-gl/maplibre'
import { resolveMapStyle, DEFAULT_ZOOM } from '@/lib/mapConfig'
import { googleDirectionsUrl } from '@/lib/directions'
import { boundsForPoints, type BBox } from '@/lib/planMapPoints'
import type { FestivalMapPin } from '@/lib/festivalSchedule'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapPopup.css'
import './FestivalMap.css'

export interface FestivalMapProps {
  pins: FestivalMapPin[]
  /** Festival.mapBounds from the registry -- seeds the camera before the
   *  pin fit runs (and is all the camera has if every pin lacks coords). */
  bounds: BBox
  /** Venue ids hosting at least one set in the visitor's day-plan draft
   *  (festivalSchedule.ts's plannedVenueIds) -- rendered as an amber ring.
   *  No numbering and no connectors here, ever: that's /day's job. */
  plannedVenueIds: Set<string>
  /** Festival.name from the registry, for the accessible group label. */
  festivalName: string
}

/** "11:00 AM" in the viewer's local timezone (site-wide display rule). */
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Popup subline: "8 performances, 11:00 AM to 7:00 PM" (single time when
 *  everything at the venue starts together). "Performance" over "set": not
 *  every festival act plays a set (Byron 2026-08-09). Copy rule: no em
 *  dashes. */
function setsLine(pin: FestivalMapPin): string {
  const count = `${pin.setCount} ${pin.setCount === 1 ? 'performance' : 'performances'}`
  const first = timeLabel(pin.firstStartAt)
  const last = timeLabel(pin.lastStartAt)
  return first === last ? `${count}, ${first}` : `${count}, ${first} to ${last}`
}

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

export default function FestivalMap({ pins, bounds, plannedVenueIds, festivalName }: FestivalMapProps) {
  const mapRef = useRef<MapRef | null>(null)
  // Resolved once on mount: the basemap must match the page's background, and
  // re-reading it per render would churn the style for no gain.
  const mapStyle = useMemo(() => resolveMapStyle(), [])
  const [selectedVenueId, setSelectedVenueId] = useState<string | null>(null)
  // Seed the camera on the registry bounds' center before the map can run a
  // precise fitBounds (PlanMap.tsx's lesson: an imperative fitBounds can
  // silently no-op if the map isn't sized yet). Refined once on load.
  const [viewState, setViewState] = useState({
    longitude: (bounds[0] + bounds[2]) / 2,
    latitude: (bounds[1] + bounds[3]) / 2,
    zoom: DEFAULT_ZOOM + 1,
  })

  const selected = useMemo(
    () => (selectedVenueId ? pins.find((p) => p.venueId === selectedVenueId) ?? null : null),
    [pins, selectedVenueId],
  )

  // One fit on load, duration 0 (an animated camera move on page load is
  // motion nobody asked for). PlanMap's guards kept: zero pins leave the
  // seeded registry-bounds camera alone; a single pin (degenerate bbox, the
  // classic NaN-camera source) jumps instead of fitting.
  const handleLoad = useCallback(() => {
    const map = mapRef.current
    if (!map || pins.length === 0) return
    if (pins.length === 1) {
      map.jumpTo({ center: [pins[0].lng, pins[0].lat], zoom: 15 })
      return
    }
    const b = boundsForPoints(pins)
    if (!b) return
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 48, maxZoom: 15, duration: 0 })
  }, [pins])

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') setSelectedVenueId(null)
  }, [])

  return (
    <div
      className="festival-map"
      role="group"
      aria-label={`Map of ${festivalName} venues, ${pins.length} ${pins.length === 1 ? 'location' : 'locations'}`}
      onKeyDown={handleKeyDown}
    >
      <MapGL
        ref={mapRef}
        {...viewState}
        onMove={(e: { viewState: typeof viewState }) => setViewState(e.viewState)}
        onLoad={handleLoad}
        style={{ width: '100%', height: '100%' }}
        mapStyle={mapStyle}
        cooperativeGestures
        /* Compact (collapsible) attribution, NOT false: OpenFreeMap/
         * OpenMapTiles/OSM attribution is a license requirement. */
        attributionControl={{ compact: true }}
        onClick={() => setSelectedVenueId(null)}
      >
        <NavigationControl position="top-right" showCompass={false} />

        {pins.map((pin) => {
          const isSelected = pin.venueId === selectedVenueId
          const planned = plannedVenueIds.has(pin.venueId)
          return (
            <Marker
              key={pin.venueId}
              longitude={pin.lng}
              latitude={pin.lat}
              anchor="bottom"
              onClick={(e: { originalEvent: MouseEvent }) => {
                e.originalEvent.stopPropagation()
                setSelectedVenueId(pin.venueId)
              }}
            >
              <button
                type="button"
                className={[
                  'festival-pin',
                  `festival-pin--${pin.kind}`,
                  isSelected ? 'festival-pin--selected' : '',
                  planned ? 'festival-pin--planned' : '',
                ].filter(Boolean).join(' ')}
                aria-label={`${pin.label}${pin.venueName ? `, ${pin.venueName}` : ''}: ${setsLine(pin)}${planned ? '. In your plan' : ''}`}
                aria-pressed={isSelected}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedVenueId(pin.venueId)
                }}
              >
                <span className="festival-pin-dot"><span className="festival-pin-glyph">{pin.glyph}</span></span>
                <span className="festival-pin-stem" aria-hidden="true" />
              </button>
            </Marker>
          )
        })}

        {selected && (
          <Popup
            longitude={selected.lng}
            latitude={selected.lat}
            anchor="bottom"
            offset={42}
            closeButton={false}
            closeOnClick={false}
            className="map-popup-outer"
            maxWidth="320px"
          >
            <div className="map-popup festival-map-popup">
              <div className="map-popup-header">
                <div className="map-popup-header-text">
                  <span className="map-popup-venue">{selected.venueName ?? selected.label}</span>
                  <span className="festival-map-popup-sets">{setsLine(selected)}</span>
                </div>
                <button className="map-popup-close" aria-label="Close popup" onClick={() => setSelectedVenueId(null)}>
                  <CloseIcon />
                </button>
              </div>
              <a
                className="map-popup-directions"
                href={googleDirectionsUrl({ name: selected.venueName, lat: selected.lat, lng: selected.lng })}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <DirectionsIcon />
                Get directions
              </a>
            </div>
          </Popup>
        )}
      </MapGL>
    </div>
  )
}
