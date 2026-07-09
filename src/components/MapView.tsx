/**
 * MapView.tsx
 *
 * Full-width event map for the homepage. Displays one marker per venue,
 * grouped from the current filtered event list. Clicking a marker opens a
 * popup showing every event at that venue.
 *
 * Requires: react-map-gl + maplibre-gl. Tiles: OpenFreeMap public instance
 * (free, unlimited, no API key — https://openfreemap.org). Attribution is
 * added automatically by MapLibre.
 */

import type { LooseRow } from '@/types'
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import MapGL, { Marker, Popup, NavigationControl, Source, Layer, type MapRef } from 'react-map-gl/maplibre'
import { format } from 'date-fns'
import { useEventNavigator } from '@/hooks/useEventNavigator'
import { formatPrice } from '@/lib/eventFormatting'
import { loadNeighborhoodGeo, type NeighborhoodGeo, type BBox } from '@/lib/neighborhoodGeo'
import Modal from '@/components/Modal'
import 'maplibre-gl/dist/maplibre-gl.css'
import './MapView.css'
import { BackIcon } from '@/components/icons'

const AKRON_CENTER = { longitude: -81.519, latitude: 41.081 }
const MAP_STYLE    = 'https://tiles.openfreemap.org/styles/dark'
const DEFAULT_ZOOM = 13

const CATEGORY_EMOJI: Record<string, string> = {
  music:     '🎵',
  art:       '🎨',
  nonprofit: '💛',
  community: '🤝',
  food:      '🍺',
  sports:    '🏟',
  fitness:   '🏃',
  education: '📚',
}

/** Loose event/venue shapes — the map consumes joined rows with dynamic keys. */
type MapEvent = LooseRow
interface VenueGroup {
  venue: LooseRow
  events: MapEvent[]
}

interface MapViewProps {
  events: MapEvent[]
  onBackToList?: () => void
  /**
   * When set (embed locked to an Akron neighborhood), the map opens centered on
   * that neighborhood, draws its boundary, and dims the rest of the city.
   */
  neighborhoodSlug?: string | null
}

/** Themed colors pulled from CSS vars so the scope overlay tracks the embed theme. */
interface ScopeColors {
  accent: string
  mask: string
}
const DEFAULT_SCOPE_COLORS: ScopeColors = { accent: '#96671E', mask: '#0b0f14' }

function bboxCenter(b: BBox): { longitude: number; latitude: number } {
  return { longitude: (b[0] + b[2]) / 2, latitude: (b[1] + b[3]) / 2 }
}

/** Rough zoom that frames a bbox, used to seed the controlled camera before the
 *  map can run a precise fitBounds (robust to map-load/container-size timing). */
function zoomForBbox(b: BBox): number {
  const latSpan = Math.abs(b[3] - b[1])
  const lngSpan = Math.abs(b[2] - b[0]) * Math.cos(((b[1] + b[3]) / 2) * Math.PI / 180)
  const span = Math.max(latSpan, lngSpan, 1e-4)
  return Math.max(11, Math.min(15, Math.log2(360 / span) - 1))
}

// ── Main component ────────────────────────────────────────────────────────

export default function MapView({ events, onBackToList, neighborhoodSlug = null }: MapViewProps) {
  const goToEvent = useEventNavigator()
  const mapRef = useRef<MapRef | null>(null)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const [popupVenueId, setPopupVenueId] = useState<string | null>(null)
  const [mapActive, setMapActive] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  const [geo, setGeo] = useState<NeighborhoodGeo | null>(null)
  const [scopeColors, setScopeColors] = useState<ScopeColors>(DEFAULT_SCOPE_COLORS)
  const [viewState, setViewState] = useState({
    ...AKRON_CENTER,
    zoom: DEFAULT_ZOOM,
  })

  // Load the locked neighborhood's geometry (lazy — only when scoped).
  useEffect(() => {
    if (!neighborhoodSlug) { setGeo(null); return }
    let active = true
    loadNeighborhoodGeo(neighborhoodSlug).then((g) => { if (active) setGeo(g) })
    return () => { active = false }
  }, [neighborhoodSlug])

  // Read themed colors for the scope overlay once the section is mounted.
  useEffect(() => {
    if (!geo || !sectionRef.current) return
    const cs = getComputedStyle(sectionRef.current)
    const accent = cs.getPropertyValue('--amber').trim()
    const mask = cs.getPropertyValue('--bg-nav').trim()
    setScopeColors({
      accent: accent || DEFAULT_SCOPE_COLORS.accent,
      mask: mask || DEFAULT_SCOPE_COLORS.mask,
    })
  }, [geo])

  // Seed the controlled camera onto the neighborhood as soon as its geometry
  // loads. Driving viewState directly guarantees centering regardless of map
  // load order or container-size timing (an imperative fitBounds alone can
  // silently no-op if the map isn't ready or sized yet).
  useEffect(() => {
    if (!geo) return
    const c = bboxCenter(geo.bbox)
    setViewState((vs) => ({ ...vs, longitude: c.longitude, latitude: c.latitude, zoom: zoomForBbox(geo.bbox) }))
  }, [geo])

  // Once the map is ready, refine to a precise, padded fit on the boundary.
  useEffect(() => {
    if (!mapLoaded || !geo) return
    mapRef.current?.fitBounds(
      [[geo.bbox[0], geo.bbox[1]], [geo.bbox[2], geo.bbox[3]]],
      { padding: 48, duration: 0 },
    )
  }, [mapLoaded, geo])

  // Deactivate map scroll-zoom when user clicks outside the map
  useEffect(() => {
    if (!mapActive) return
    function onClickOutside(e: MouseEvent) {
      const wrap = document.querySelector('.map-wrap')
      if (wrap && !wrap.contains(e.target as Node)) {
        setMapActive(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [mapActive])

  // Group events by venue, keeping only venues that have lat/lng
  const venues = useMemo<VenueGroup[]>(() => {
    const map = new Map<string, VenueGroup>()
    for (const ev of events) {
      const v = ev.venue
      if (!v || v.lat == null || v.lng == null) continue
      if (!map.has(v.id)) {
        map.set(v.id, { venue: v, events: [] })
      }
      map.get(v.id)!.events.push(ev)
    }
    return [...map.values()]
  }, [events])

  const activeGroup = venues.find((g) => g.venue.id === popupVenueId) ?? null
  const mappedEventCount = venues.reduce((sum, g) => sum + g.events.length, 0)
  const unmappedCount = events.length - mappedEventCount

  // Recenter target: the locked neighborhood when scoped, else Akron.
  const recenterTarget = geo ? bboxCenter(geo.bbox) : AKRON_CENTER

  const handleRecenter = useCallback(() => {
    setPopupVenueId(null)
    if (geo && mapRef.current) {
      mapRef.current.fitBounds(
        [[geo.bbox[0], geo.bbox[1]], [geo.bbox[2], geo.bbox[3]]],
        { padding: 48, duration: 600 },
      )
    } else {
      setViewState((vs) => ({ ...vs, ...AKRON_CENTER, zoom: DEFAULT_ZOOM }))
    }
  }, [geo])

  const isOffCenter = useMemo(() => {
    const dLng = Math.abs(viewState.longitude - recenterTarget.longitude)
    const dLat = Math.abs(viewState.latitude - recenterTarget.latitude)
    const dZoom = Math.abs(viewState.zoom - DEFAULT_ZOOM)
    // When scoped, the fit zoom varies by neighborhood size, so ignore zoom.
    return dLng > 0.01 || dLat > 0.01 || (!geo && dZoom > 1.5)
  }, [viewState, recenterTarget, geo])

  return (
    <div className="map-section" ref={sectionRef}>
      <div
        className={`map-wrap ${mapActive ? 'map-wrap--active' : ''}`}
        onClick={() => { if (!mapActive) setMapActive(true) }}
      >
        {/* Scroll-to-zoom hint overlay */}
        {!mapActive && (
          <div className="map-activate-hint">
            <span>Click to interact</span>
          </div>
        )}

        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(e: { viewState: typeof viewState }) => setViewState(e.viewState)}
          onLoad={() => setMapLoaded(true)}
          style={{ width: '100%', height: '100%' }}
          mapStyle={MAP_STYLE}
          scrollZoom={mapActive}
          onClick={() => setPopupVenueId(null)}
        >
          <NavigationControl position="top-right" showCompass={false} />

          {/* ── Neighborhood scope: dim the rest of the city, draw the boundary ── */}
          {geo && (
            <>
              <Source id="scope-mask" type="geojson" data={geo.mask}>
                <Layer
                  id="scope-mask-fill"
                  type="fill"
                  paint={{ 'fill-color': scopeColors.mask, 'fill-opacity': 0.55 }}
                />
              </Source>
              <Source id="scope-neighborhood" type="geojson" data={geo.feature}>
                <Layer
                  id="scope-neighborhood-fill"
                  type="fill"
                  paint={{ 'fill-color': scopeColors.accent, 'fill-opacity': 0.08 }}
                />
                <Layer
                  id="scope-neighborhood-line"
                  type="line"
                  paint={{ 'line-color': scopeColors.accent, 'line-width': 2.5, 'line-opacity': 0.9 }}
                />
              </Source>
            </>
          )}

          {/* ── Venue markers ── */}
          {venues.map(({ venue, events: vEvents }) => (
            <Marker
              key={venue.id}
              longitude={Number(venue.lng)}
              latitude={Number(venue.lat)}
              anchor="bottom"
              onClick={(e: { originalEvent: MouseEvent }) => {
                e.originalEvent.stopPropagation()
                setMapActive(true)
                setPopupVenueId((prev) => prev === venue.id ? null : venue.id)
              }}
            >
              <VenuePin count={vEvents.length} active={popupVenueId === venue.id} />
            </Marker>
          ))}

          {/* ── Popup ── */}
          {activeGroup && (
            <Popup
              longitude={Number(activeGroup.venue.lng)}
              latitude={Number(activeGroup.venue.lat)}
              anchor="bottom"
              offset={42}
              closeButton={false}
              closeOnClick={false}
              className="map-popup-outer"
              maxWidth="340px"
            >
              <VenuePopup
                group={activeGroup}
                onClose={() => setPopupVenueId(null)}
                onEventClick={(ev) => goToEvent(ev)}
              />
            </Popup>
          )}
        </MapGL>

        {/* On-theme gradient vignette around the focused neighborhood. */}
        {geo && <div className="map-scope-vignette" aria-hidden="true" />}

        {/* ── Top-left: Back to list + event count ── */}
        <div className="map-top-bar">
          {onBackToList && (
            <button className="map-back-btn" onClick={onBackToList} aria-label="Back to list view">
              <BackIcon size={13} /> List
            </button>
          )}
          <div className="map-count-badge">
            <span className="map-count-primary">
              {mappedEventCount} {mappedEventCount === 1 ? 'event' : 'events'}
            </span>
            <span className="map-count-sep">·</span>
            <span className="map-count-secondary">
              {venues.length} {venues.length === 1 ? 'venue' : 'venues'}
            </span>
            {unmappedCount > 0 && (
              <span className="map-count-note">&nbsp;({unmappedCount} unmapped)</span>
            )}
          </div>
        </div>

        {/* ── Recenter button ── */}
        {isOffCenter && (
          <button
            className="map-recenter-btn"
            onClick={handleRecenter}
            aria-label={geo ? `Re-center map on ${geo.name}` : 'Re-center map on Akron'}
          >
            <ResetIcon /> {geo ? geo.name : 'Akron'}
          </button>
        )}
      </div>
    </div>
  )
}

// ── Venue popup ───────────────────────────────────────────────────────────

interface VenuePopupProps {
  group: VenueGroup
  onClose: () => void
  onEventClick: (ev: MapEvent) => void
}

function VenuePopup({ group, onClose, onEventClick }: VenuePopupProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState(false)

  // Detect whether the event list is scrollable
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    setCanScroll(el.scrollHeight > el.clientHeight)
  }, [group.events.length])

  const eventCount = group.events.length

  return (
    <div className="map-popup">
      {/* Header */}
      <div className="map-popup-header">
        <div className="map-popup-header-text">
          <span className="map-popup-venue">{group.venue.name}</span>
          {eventCount > 1 && (
            <span className="map-popup-event-count">
              {eventCount} events
            </span>
          )}
        </div>
        <button className="map-popup-close" aria-label="Close popup" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {/* Event list */}
      <div className="map-popup-events" ref={listRef}>
        {group.events.map((ev) => {
          const price = formatPrice(ev.price_min, ev.price_max)
          return (
            <button
              key={ev.id}
              className="map-popup-event"
              onClick={() => onEventClick(ev)}
            >
              <span className="map-popup-emoji">
                {CATEGORY_EMOJI[ev.category] ?? '📍'}
              </span>
              <div className="map-popup-event-body">
                <span className="map-popup-title">{ev.title}</span>
                <span className="map-popup-date">
                  {format(new Date(ev.start_at), 'EEE, MMM d · h:mm a')}
                </span>
              </div>
              <span className={`map-popup-price ${price.free ? 'free' : ''}`}>
                {price.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* Scroll hint — only visible when list overflows */}
      {canScroll && <div className="map-popup-scroll-fade" aria-hidden="true" />}

      {/* Footer */}
      {group.venue.address && (
        <a
          className="map-popup-directions"
          href={`https://maps.google.com/?q=${encodeURIComponent(group.venue.name + ' ' + group.venue.address + ' ' + group.venue.city)}`}
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

// ── Venue pin marker ──────────────────────────────────────────────────────

function VenuePin({ count, active }: { count: number; active: boolean }) {
  return (
    <div className={`venue-pin ${active ? 'active' : ''}`}>
      <div className="venue-pin-dot">
        {count > 1 && <span className="venue-pin-count">{count}</span>}
      </div>
      <div className="venue-pin-stem" />
    </div>
  )
}

// ── Small static venue map (used on EventPage / VenueDetailPage) ──────────

interface VenueMapProps {
  lat?: number | string | null
  lng?: number | string | null
  venueName?: string | null
  venueAddress?: string | null
  directionsUrl?: string | null
}

export function VenueMap({ lat, lng, venueName, venueAddress, directionsUrl }: VenueMapProps) {
  const [expanded, setExpanded] = useState(false)

  if (lat == null || lng == null) return null

  return (
    <>
      <button
        type="button"
        className="venue-map-preview"
        onClick={() => setExpanded(true)}
        aria-label={venueName
          ? `Open interactive map for ${venueName}`
          : 'Open interactive map'}
      >
        <MapGL
          initialViewState={{
            longitude: Number(lng),
            latitude:  Number(lat),
            zoom:      15,
          }}
          style={{ width: '100%', height: '100%' }}
          mapStyle={MAP_STYLE}
          interactive={false}
          attributionControl={false}
        >
          <Marker longitude={Number(lng)} latitude={Number(lat)} anchor="bottom">
            <VenuePin count={1} active={false} />
          </Marker>
        </MapGL>
        <span className="venue-map-preview-hint" aria-hidden="true">
          <ExpandIcon />
          Click to interact
        </span>
      </button>

      <Modal
        open={expanded}
        onClose={() => setExpanded(false)}
        size="lg"
      >
        <InteractiveVenueMap
          lat={lat}
          lng={lng}
          venueName={venueName}
          venueAddress={venueAddress}
          directionsUrl={directionsUrl}
        />
      </Modal>
    </>
  )
}

// ── Interactive venue map (rendered inside <Modal>) ───────────────────────

function InteractiveVenueMap({ lat, lng, venueName, venueAddress, directionsUrl }: VenueMapProps) {
  const [popupOpen, setPopupOpen] = useState(true)

  return (
    <div className="venue-map-modal">
      {venueName && (
        <div className="venue-map-modal-header">
          <span className="venue-map-modal-title">{venueName}</span>
        </div>
      )}
      <div className="venue-map-modal-map">
        <MapGL
          initialViewState={{
            longitude: Number(lng),
            latitude:  Number(lat),
            zoom:      15,
          }}
          style={{ width: '100%', height: '100%' }}
          mapStyle={MAP_STYLE}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <Marker
            longitude={Number(lng)}
            latitude={Number(lat)}
            anchor="bottom"
            onClick={(e: { originalEvent: MouseEvent }) => {
              e.originalEvent.stopPropagation()
              setPopupOpen((open) => !open)
            }}
          >
            <VenuePin count={1} active={popupOpen} />
          </Marker>
          {popupOpen && (
            <Popup
              longitude={Number(lng)}
              latitude={Number(lat)}
              anchor="bottom"
              offset={42}
              closeButton={false}
              closeOnClick={false}
              className="map-popup-outer"
              maxWidth="280px"
            >
              <div className="map-popup venue-map-pin-popup">
                <div className="map-popup-header">
                  <div className="map-popup-header-text">
                    <span className="map-popup-venue">{venueName ?? 'Venue'}</span>
                    {venueAddress && (
                      <span className="venue-map-pin-address">{venueAddress}</span>
                    )}
                  </div>
                  <button
                    className="map-popup-close"
                    aria-label="Close popup"
                    onClick={() => setPopupOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
                {directionsUrl && (
                  <a
                    className="venue-map-pin-cta"
                    href={directionsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <DirectionsIcon />
                    Get directions
                  </a>
                )}
              </div>
            </Popup>
          )}
        </MapGL>
      </div>
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────

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

function ExpandIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  )
}


