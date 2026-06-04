/**
 * SummitCountyMap.jsx
 *
 * Interactive SVG map of the major incorporated places in Summit
 * County, OH. Mirrors NeighborhoodMap's component shape and UX —
 * click a polygon to select it, then commit through the
 * "View [City] events →" button — but operates one zoom level up,
 * over cities instead of Akron-internal neighborhoods.
 *
 * Renders public/summit-county-cities.geojson, which is produced
 * offline by scripts/convert-summit-cities.js (see that script for
 * the source shapefile and the canonical city slug list). The file
 * may not be present yet on a fresh checkout — in that case the
 * component renders a clean "Map data not loaded" fallback rather
 * than throwing, so the rest of the city hub page stays useful.
 *
 * Interaction model — identical to NeighborhoodMap:
 *   1. Click any non-active polygon → it highlights, the panel
 *      updates with that city's name + a "View {city} events →"
 *      button.
 *   2. Click the button to navigate (with preserveScroll so the user
 *      stays anchored to the map between hub pages).
 *   Polygon clicks never navigate directly. One predictable model on
 *   desktop AND touch.
 *
 * Why a separate component from NeighborhoodMap (for now):
 *   The geometry is different scale, the GeoJSON is different, and
 *   the slug → label lookup comes from a different module. Sharing
 *   logic via a generic InteractivePolygonMap is the obvious
 *   refactor once a third caller turns up — until then duplication
 *   is the cheaper path.
 *
 * Props:
 *   activeSlug — the city hub the user is currently on. That polygon
 *     renders in amber, isn't clickable, and is reflected in the
 *     panel's "You're viewing X" default state. Pass null when
 *     rendering the map in a context that has no active city (e.g.
 *     a future top-level "Browse Summit County" surface).
 *   className — optional, lets the parent control its layout slot.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
// PLACE_LABELS covers both the 14 individual cities and the 3
// regional rollups (Northwest / Northeast / Southeast Summit County)
// so the panel can name whichever polygon the user lands on without
// branching by feature type.
import { PLACE_LABELS } from '@/lib/cities'
import './SummitCountyMap.css'

const GEOJSON_URL = '/summit-county-cities.geojson'

// Module-level fetch cache. Same shape as NeighborhoodMap so concurrent
// mounts don't race-fetch the same file.
let geojsonPromise = null
function loadGeojson() {
  if (!geojsonPromise) {
    geojsonPromise = fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${GEOJSON_URL}: ${r.status}`)
        return r.json()
      })
      .catch((err) => {
        // Clear the cache so a future mount can retry.
        geojsonPromise = null
        throw err
      })
  }
  return geojsonPromise
}

// ── Geometry helpers (mirror NeighborhoodMap) ──────────────────────

function eachCoord(geometry, fn) {
  const polys = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : [geometry.coordinates]
  for (const poly of polys) {
    for (const ring of poly) {
      for (const pt of ring) fn(pt[0], pt[1])
    }
  }
}

function computeProjection(features) {
  let lonMin = Infinity, lonMax = -Infinity
  let latMin = Infinity, latMax = -Infinity
  for (const f of features) {
    eachCoord(f.geometry, (lon, lat) => {
      if (lon < lonMin) lonMin = lon
      if (lon > lonMax) lonMax = lon
      if (lat < latMin) latMin = lat
      if (lat > latMax) latMax = lat
    })
  }
  const latMid = (latMin + latMax) / 2
  const lonScale = Math.cos((latMid * Math.PI) / 180)
  const projWidth  = (lonMax - lonMin) * lonScale
  const projHeight = (latMax - latMin)
  return { lonMin, lonMax, latMin, latMax, lonScale, projWidth, projHeight }
}

function buildPathD(geometry, project) {
  const polys = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : [geometry.coordinates]
  const parts = []
  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length === 0) continue
      const first = project(ring[0][0], ring[0][1])
      let s = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`
      for (let i = 1; i < ring.length; i++) {
        const p = project(ring[i][0], ring[i][1])
        s += `L${p[0].toFixed(2)} ${p[1].toFixed(2)}`
      }
      s += 'Z'
      parts.push(s)
    }
  }
  return parts.join(' ')
}

// ── Layout constants ───────────────────────────────────────────────
// Slightly taller / wider viewBox than NeighborhoodMap because Summit
// County is a long county (roughly NW–SE) and the polygons need
// more vertical room to read cleanly.
const VIEW_W = 600
const VIEW_H = 640
const PAD    = 14

// ── Component ──────────────────────────────────────────────────────

export default function SummitCountyMap({ activeSlug, className }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [selectedSlug, setSelectedSlug] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadGeojson()
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [])

  // Reset selection whenever the active hub changes (the user
  // committed to a new page).
  useEffect(() => { setSelectedSlug(null) }, [activeSlug])

  const features = useMemo(() => {
    if (!data) return null
    const proj = computeProjection(data.features)
    const innerW = VIEW_W - PAD * 2
    const innerH = VIEW_H - PAD * 2
    const scale = Math.min(innerW / proj.projWidth, innerH / proj.projHeight)
    const drawnW = proj.projWidth * scale
    const drawnH = proj.projHeight * scale
    const offsetX = PAD + (innerW - drawnW) / 2
    const offsetY = PAD + (innerH - drawnH) / 2
    const project = (lon, lat) => {
      const x = (lon - proj.lonMin) * proj.lonScale * scale + offsetX
      const y = (proj.latMax - lat) * scale + offsetY
      return [x, y]
    }
    return data.features.map((f) => ({
      slug: f.properties.slug,
      name: f.properties.name,
      d:    buildPathD(f.geometry, project),
    }))
  }, [data])

  if (error) {
    // Fail soft — the city hub page is still useful without the map.
    // The most common reason this fires is the GeoJSON hasn't been
    // generated yet (see scripts/convert-summit-cities.js).
    return (
      <div className={`summit-county-map summit-county-map--unavailable ${className ?? ''}`}>
        <p>
          Map data isn&apos;t loaded yet.{' '}
          <span className="summit-county-map-hint">
            Run <code>npm run gis:convert-cities</code> to generate{' '}
            <code>public/summit-county-cities.geojson</code>.
          </span>
        </p>
      </div>
    )
  }

  if (!features) {
    return (
      <div
        className={`summit-county-map summit-county-map--loading ${className ?? ''}`}
        aria-busy="true"
        aria-label="Loading Summit County map"
      />
    )
  }

  const activeLabel   = activeSlug   ? PLACE_LABELS[activeSlug]   : null
  const selectedLabel = selectedSlug ? PLACE_LABELS[selectedSlug] : null
  const hasSelection  = selectedSlug && selectedSlug !== activeSlug

  const handlePolygonClick = (e, slug) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    setSelectedSlug(slug)
  }

  return (
    <figure className={`summit-county-map ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="summit-county-map-svg"
        role="img"
        aria-label={`Interactive map of Summit County, OH cities${activeLabel ? `, ${activeLabel} currently selected` : ''}`}
      >
        {features.map((f) => {
          const isActive   = f.slug === activeSlug
          const isSelected = f.slug === selectedSlug && !isActive
          const cls = [
            'summit-county-map-shape',
            isActive   ? 'summit-county-map-shape--active'   : '',
            isSelected ? 'summit-county-map-shape--selected' : '',
          ].filter(Boolean).join(' ')

          if (isActive) {
            return (
              <g key={f.slug} aria-current="page">
                <title>{f.name}</title>
                <path d={f.d} className={cls} />
              </g>
            )
          }

          return (
            <a
              key={f.slug}
              href={`/events/${f.slug}`}
              onClick={(e) => handlePolygonClick(e, f.slug)}
              aria-label={`Select ${f.name}`}
            >
              <title>{f.name}</title>
              <path d={f.d} className={cls} />
            </a>
          )
        })}
      </svg>

      <div className="summit-county-map-panel">
        <div className="summit-county-map-panel-text">
          <p className="summit-county-map-panel-eyebrow">
            {hasSelection ? 'Selected' : "You're viewing"}
          </p>
          <p className="summit-county-map-panel-name">
            {selectedLabel ?? activeLabel ?? '—'}
          </p>
        </div>

        {hasSelection && (
          <button
            type="button"
            className="summit-county-map-panel-go"
            onClick={() => navigate(`/events/${selectedSlug}`, { state: { preserveScroll: true } })}
            aria-label={`View ${selectedLabel} events`}
          >
            <span>View {selectedLabel} events</span>
            <svg
              width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </button>
        )}
      </div>

      {!hasSelection && (
        <p className="summit-county-map-panel-hint">
          Tap a city to select it
        </p>
      )}
    </figure>
  )
}
