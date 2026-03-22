/**
 * MapView.jsx
 *
 * Full-width event map for the homepage. Displays one marker per venue,
 * grouped from the current filtered event list. Clicking a marker opens a
 * popup showing every event at that venue.
 *
 * Requires: npm install react-map-gl mapbox-gl
 * Token:    VITE_MAPBOX_TOKEN in your .env file
 */

import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import MapGL, { Marker, Popup, NavigationControl } from 'react-map-gl/mapbox'
import { format } from 'date-fns'
import 'mapbox-gl/dist/mapbox-gl.css'
import './MapView.css'

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN
const AKRON_CENTER = { longitude: -81.519, latitude: 41.081 }
const MAP_STYLE    = 'mapbox://styles/mapbox/dark-v11'

// ── Helpers ───────────────────────────────────────────────────────────────

function formatPrice(min, max) {
  if (min === 0 && (!max || max === 0)) return { label: 'Free', free: true }
  if (max && max > min) return { label: `$${min}–$${max}`, free: false }
  return { label: `$${min}`, free: false }
}

const CATEGORY_EMOJI = {
  music:     '🎵',
  art:       '🎨',
  nonprofit: '💛',
  community: '🤝',
  food:      '🍺',
  sports:    '🏃',
  education: '📚',
}

// ── Main component ────────────────────────────────────────────────────────

export default function MapView({ events }) {
  const navigate = useNavigate()
  const [popupVenueId, setPopupVenueId] = useState(null)
  const [viewState, setViewState] = useState({
    ...AKRON_CENTER,
    zoom: 13,
  })

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

  if (!MAPBOX_TOKEN) {
    return (
      <div className="map-token-missing">
        <p>Add <code>VITE_MAPBOX_TOKEN</code> to your <code>.env</code> file to enable the map.</p>
        <p>Get a free token at <a href="https://mapbox.com" target="_blank" rel="noopener noreferrer">mapbox.com</a>.</p>
      </div>
    )
  }

  return (
    <div className="map-wrap">
      <MapGL
        {...viewState}
        onMove={e => setViewState(e.viewState)}
        style={{ width: '100%', height: '100%' }}
        mapStyle={MAP_STYLE}
        mapboxAccessToken={MAPBOX_TOKEN}
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
            maxWidth="320px"
          >
            <div className="map-popup">
              <div className="map-popup-header">
                <span className="map-popup-venue">{activeGroup.venue.name}</span>
                <button className="map-popup-close" onClick={() => setPopupVenueId(null)}>✕</button>
              </div>
              <div className="map-popup-events">
                {activeGroup.events.map(ev => {
                  const price = formatPrice(ev.price_min, ev.price_max)
                  return (
                    <button
                      key={ev.id}
                      className="map-popup-event"
                      onClick={() => navigate(`/events/${ev.id}`)}
                    >
                      <div className="map-popup-event-top">
                        <span className="map-popup-emoji">
                          {CATEGORY_EMOJI[ev.category] ?? '📍'}
                        </span>
                        <span className="map-popup-title">{ev.title}</span>
                      </div>
                      <div className="map-popup-event-meta">
                        <span className="map-popup-date">
                          {format(new Date(ev.start_at), 'EEE MMM d · h:mm a')}
                        </span>
                        <span className={`map-popup-price ${price.free ? 'free' : ''}`}>
                          {price.label}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
              {activeGroup.venue.address && (
                <a
                  className="map-popup-directions"
                  href={`https://maps.google.com/?q=${encodeURIComponent(activeGroup.venue.name + ' ' + activeGroup.venue.address + ' ' + activeGroup.venue.city)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => e.stopPropagation()}
                >
                  Get directions →
                </a>
              )}
            </div>
          </Popup>
        )}
      </MapGL>

      {/* ── Event count badge ── */}
      <div className="map-count-badge">
        {events.length} {events.length === 1 ? 'event' : 'events'} · {venues.length} {venues.length === 1 ? 'venue' : 'venues'}
      </div>
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

// ── Small static venue map (used on EventPage) ────────────────────────────

export function VenueMap({ lat, lng, venueName }) {
  const [ready, setReady] = useState(false)

  if (!MAPBOX_TOKEN || lat == null || lng == null) return null

  return (
    <div className="venue-map-wrap">
      <MapGL
        initialViewState={{
          longitude: Number(lng),
          latitude:  Number(lat),
          zoom:      15,
        }}
        style={{ width: '100%', height: '100%', opacity: ready ? 1 : 0, transition: 'opacity 0.3s' }}
        mapStyle={MAP_STYLE}
        mapboxAccessToken={MAPBOX_TOKEN}
        interactive={false}
        onLoad={() => setReady(true)}
      >
        <Marker longitude={Number(lng)} latitude={Number(lat)} anchor="bottom">
          <VenuePin count={1} active={false} />
        </Marker>
      </MapGL>
    </div>
  )
}
