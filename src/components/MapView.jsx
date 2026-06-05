/**
 * MapView.jsx
 *
 * Full-width event map for the homepage. Displays one marker per venue,
 * grouped from the current filtered event list. Clicking a marker opens a
 * popup showing every event at that venue.
 *
 * Scroll-zoom is disabled by default — the user must click the map first to
 * "activate" it, preventing the scroll-trap problem on the homepage.
 *
 * Requires: npm install react-map-gl mapbox-gl
 * Token:    VITE_MAPBOX_TOKEN in your .env file
 */

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import MapGL, { Marker, Popup, NavigationControl } from 'react-map-gl/mapbox'
import { format } from 'date-fns'
import { useEventNavigator } from '@/hooks/useEventNavigator'
import { formatPrice } from '@/lib/eventFormatting'
import Modal from '@/components/Modal'
import 'mapbox-gl/dist/mapbox-gl.css'
import './MapView.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const AKRON_CENTER = { longitude: -81.519, latitude: 41.081 }
const MAP_STYLE    = 'mapbox://styles/mapbox/dark-v11'
const DEFAULT_ZOOM = 13

const CATEGORY_EMOJI = {
  music:     '🎵',
  art:       '🎨',
  nonprofit: '💛',
  community: '🤝',
  food:      '🍺',
  sports:    '🏟',
  fitness:   '🏃',
  education: '📚',
}

// ── Main component ────────────────────────────────────────────────────────

export default function MapView({ events, onBackToList }) {
  const goToEvent = useEventNavigator()
  const mapRef = useRef(null)
  const [popupVenueId, setPopupVenueId] = useState(null)
  const [mapActive, setMapActive] = useState(false)
  const [viewState, setViewState] = useState({
    ...AKRON_CENTER,
    zoom: DEFAULT_ZOOM,
  })

  // Deactivate map scroll-zoom when user clicks outside the map
  useEffect(() => {
    if (!mapActive) return
    function onClickOutside(e) {
      const wrap = document.querySelector('.map-wrap')
      if (wrap && !wrap.contains(e.target)) {
        setMapActive(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [mapActive])

  // Group events by venue, keeping only venues that have lat/lng
  const venues = useMemo(() => {
    const map = new Map()
    for (const ev of events) {
      const v = ev.venue
      if (!v || v.lat == null || v.lng == null) continue
      if (!map.has(v.id)) {
        map.set(v.id, { venue: v, events: [] })
      }
      map.get(v.id).events.push(ev)
    }
    return [...map.values()]
  }, [events])

  const activeGroup = venues.find(g => g.venue.id === popupVenueId) ?? null
  const mappedEventCount = venues.reduce((sum, g) => sum + g.events.length, 0)
  const unmappedCount = events.length - mappedEventCount

  const handleRecenter = useCallback(() => {
    setViewState(vs => ({ ...vs, ...AKRON_CENTER, zoom: DEFAULT_ZOOM }))
    setPopupVenueId(null)
  }, [])

  const isOffCenter = useMemo(() => {
    const dLng = Math.abs(viewState.longitude - AKRON_CENTER.longitude)
    const dLat = Math.abs(viewState.latitude - AKRON_CENTER.latitude)
    const dZoom = Math.abs(viewState.zoom - DEFAULT_ZOOM)
    return dLng > 0.01 || dLat > 0.01 || dZoom > 1.5
  }, [viewState])

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-token-missing">
        <p>Add <code>VITE_MAPBOX_TOKEN</code> to your <code>.env</code> file to enable the map.</p>
        <p>Get a free token at <a href="https://mapbox.com" target="_blank" rel="noopener noreferrer">mapbox.com</a>.</p>
      </div>
    )
  }

  return (
    <div className="map-section">
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
          onMove={e => setViewState(e.viewState)}
          style={{ width: '100%', height: '100%' }}
          mapStyle={MAP_STYLE}
          mapboxAccessToken={MAPBOX_TOKEN}
          scrollZoom={mapActive}
          onClick={() => setPopupVenueId(null)}
        >
          <NavigationControl position="top-right" showCompass={false} />

          {/* ── Venue markers ── */}
          {venues.map(({ venue, events: vEvents }) => (
            <Marker
              key={venue.id}
              longitude={Number(venue.lng)}
              latitude={Number(venue.lat)}
              anchor="bottom"
              onClick={e => {
                e.originalEvent.stopPropagation()
                setMapActive(true)
                setPopupVenueId(prev => prev === venue.id ? null : venue.id)
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

        {/* ── Top-left: Back to list + event count ── */}
        <div className="map-top-bar">
          {onBackToList && (
            <button className="map-back-btn" onClick={onBackToList} aria-label="Back to list view">
              <BackIcon /> List
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
          <button className="map-recenter-btn" onClick={handleRecenter} aria-label="Re-center map on Akron">
            <ResetIcon /> Akron
          </button>
        )}
      </div>
    </div>
  )
}

// ── Venue popup ───────────────────────────────────────────────────────────

function VenuePopup({ group, onClose, onEventClick }) {
  const listRef = useRef(null)
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
        {group.events.map((ev, i) => {
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
          onClick={e => e.stopPropagation()}
        >
          <DirectionsIcon />
          Get directions
        </a>
      )}
    </div>
  )
}

// ── Venue pin marker ──────────────────────────────────────────────────────

function VenuePin({ count, active }) {
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
//
// Renders a non-interactive thumbnail with a "Click to interact" overlay.
// Activating opens the reusable <Modal> with an interactive map inside —
// pan, scroll-zoom, and pinch-zoom all work. Clicking the pin reveals a
// popup with a prominent "Get directions" link (when `directionsUrl` is
// supplied by the caller).
//
// Props:
//   lat, lng        – required; component returns null without them
//   venueName       – optional; shown in the modal header and pin popup
//   venueAddress    – optional; rendered as a secondary line in the
//                     pin popup so the user can sanity-check the
//                     location without leaving the map
//   directionsUrl   – optional; passed-through link target so callers
//                     keep control over how the directions query is
//                     composed (e.g. with/without state, zip, etc.)
export function VenueMap({ lat, lng, venueName, venueAddress, directionsUrl }) {
  const [expanded, setExpanded] = useState(false)

  if (!MAPBOX_TOKEN || lat == null || lng == null) return null

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
        {/* Non-interactive thumbnail. The opacity-gated fade-in is omitted
         * because mapbox-gl's `load` event sometimes fires before React
         * attaches its listener, which previously left the map stuck at
         * opacity 0 (rendered as a blank white box). Tiles fade in via
         * mapbox's own transitions. */}
        <MapGL
          initialViewState={{
            longitude: Number(lng),
            latitude:  Number(lat),
            zoom:      15,
          }}
          style={{ width: '100%', height: '100%' }}
          mapStyle={MAP_STYLE}
          mapboxAccessToken={MAPBOX_TOKEN}
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
//
// Full mapbox interactivity — drag-pan, scroll-zoom, double-click-zoom,
// and `touchZoomRotate` (which provides two-finger pinch-zoom) are all
// enabled by default when `interactive` is left at its default `true`.
// We start with the pin's popup open so the "Get directions" CTA is
// visible immediately; clicking the pin toggles it.
function InteractiveVenueMap({ lat, lng, venueName, venueAddress, directionsUrl }) {
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
          mapboxAccessToken={MAPBOX_TOKEN}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <Marker
            longitude={Number(lng)}
            latitude={Number(lat)}
            anchor="bottom"
            onClick={(e) => {
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

function BackIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <path d="m12 5-7 7 7 7" />
    </svg>
  )
}
