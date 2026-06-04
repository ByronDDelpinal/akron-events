/**
 * NeighborhoodMap.jsx
 *
 * Interactive SVG map of the City of Akron's 24 neighborhoods.
 *
 * Renders public/akron-neighborhoods.geojson directly as SVG paths,
 * keyed by canonical slug. The active neighborhood is filled with the
 * theme's brand color (`--amber`), siblings are muted, hovered
 * siblings light up in the theme's secondary accent (`--coral`) so
 * the "you are here" highlight and the "this is hoverable" highlight
 * never conflict visually. Clicking any non-active polygon navigates
 * to that neighborhood's hub page.
 *
 * Why fetch the GeoJSON at runtime instead of inlining it:
 *   - 419 KB of polygon data does not belong in the JS bundle every
 *     page would have to download even when no map is on screen.
 *   - The static asset gets long-lived browser caching for free, so
 *     the second neighborhood page paints the map instantly.
 *   - Build-time inlining would force a re-deploy on every City
 *     polygon update; the runtime fetch picks up the new file with
 *     just a re-publish of public/akron-neighborhoods.geojson.
 *
 * Module-level cache:
 *   Once the GeoJSON is fetched in a session it's kept in memory so
 *   navigating between neighborhood hubs doesn't refetch. We cache
 *   the *promise* (not just the value) so concurrent mounts dedupe
 *   into a single network request.
 *
 * Projection:
 *   The GeoJSON is already WGS-84 (long/lat). For a city-scale map
 *   we use a longitude-scaled equirectangular projection — multiply
 *   the longitude axis by cos(lat₀) so polygons read with the right
 *   aspect ratio rather than being stretched horizontally. At Akron's
 *   latitude (41°N) that's ~0.755, which makes a meaningful
 *   difference in visual fidelity vs. raw lon/lat.
 *
 * Accessibility:
 *   Each polygon is an SVG <a> with role="link", aria-label, and a
 *   focusable hit area, so keyboard users can tab through and
 *   activate with Enter / Space the same way they would links in a
 *   nav. The currently-active hub renders as a non-interactive
 *   <g aria-current="page"> instead of a link.
 *
 * Props:
 *   activeSlug — slug of the neighborhood whose hub page is currently
 *     rendered. Receives the brand highlight; clicks do nothing.
 *   className — optional, lets the parent control layout slot.
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { NEIGHBORHOOD_LABELS } from '@/lib/neighborhoods'
import './NeighborhoodMap.css'

const GEOJSON_URL = '/akron-neighborhoods.geojson'

// ── Module-level fetch cache (promise-keyed, dedupes parallel mounts).
let geojsonPromise = null
function loadGeojson() {
  if (!geojsonPromise) {
    geojsonPromise = fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${GEOJSON_URL}: ${r.status}`)
        return r.json()
      })
      .catch((err) => {
        // Clear the cache so a future mount can retry — otherwise a
        // transient failure would persist for the whole session.
        geojsonPromise = null
        throw err
      })
  }
  return geojsonPromise
}

// ── Geometry helpers ───────────────────────────────────────────────

/** Walk every coordinate pair in a Polygon / MultiPolygon geometry. */
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

/**
 * Compute the bounding box across every feature, then derive the
 * longitude-scale factor (cos of the central latitude). Returns the
 * tuple the projector needs.
 */
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
  // Width / height in "projected" units (cos-scaled degrees).
  const projWidth  = (lonMax - lonMin) * lonScale
  const projHeight = (latMax - latMin)
  return { lonMin, lonMax, latMin, latMax, lonScale, projWidth, projHeight }
}

/**
 * Build the SVG `d` attribute for one Feature's geometry. Every ring
 * becomes `M x y L x y … Z`. Multiple polygons / holes chain together
 * in one path — the browser fills them with the SVG even-odd rule
 * implicitly because rings retain their winding.
 */
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
// ViewBox sizing — actual rendered size is controlled by CSS. Padding
// keeps the polygons off the SVG edge so the brand highlight ring
// doesn't get clipped.
const VIEW_W = 600
const VIEW_H = 600
const PAD    = 12

// ── Component ──────────────────────────────────────────────────────

export default function NeighborhoodMap({ activeSlug, className }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [hoveredSlug, setHoveredSlug] = useState(null)

  useEffect(() => {
    let cancelled = false
    loadGeojson()
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [])

  // Pre-compute SVG paths once per dataset. Re-renders driven by hover
  // state never recompute the geometry — only the className changes.
  const features = useMemo(() => {
    if (!data) return null
    const proj = computeProjection(data.features)
    // Available drawing area inside the viewBox.
    const innerW = VIEW_W - PAD * 2
    const innerH = VIEW_H - PAD * 2
    // Uniform scale = fit the projected bbox into the viewBox while
    // preserving aspect ratio. Center the result inside the padded
    // area so the map sits visually balanced.
    const scale = Math.min(innerW / proj.projWidth, innerH / proj.projHeight)
    const drawnW = proj.projWidth * scale
    const drawnH = proj.projHeight * scale
    const offsetX = PAD + (innerW - drawnW) / 2
    const offsetY = PAD + (innerH - drawnH) / 2
    const project = (lon, lat) => {
      const x = (lon - proj.lonMin) * proj.lonScale * scale + offsetX
      // SVG y grows downward; map highest latitude → lowest y.
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
    // Fail soft — the rest of the hub page is still useful without
    // the map. Show a one-liner instead of a broken visual.
    return (
      <div className={`neighborhood-map neighborhood-map--error ${className ?? ''}`}>
        <p>Map unavailable.</p>
      </div>
    )
  }

  if (!features) {
    return (
      <div
        className={`neighborhood-map neighborhood-map--loading ${className ?? ''}`}
        aria-busy="true"
        aria-label="Loading neighborhood map"
      />
    )
  }

  const activeLabel = activeSlug ? NEIGHBORHOOD_LABELS[activeSlug] : null
  const hoveredLabel = hoveredSlug ? NEIGHBORHOOD_LABELS[hoveredSlug] : null
  // The caption shows whichever name is most informative at the moment:
  // the hovered one if it isn't the active hub, otherwise the active
  // one — so the user always knows what their pointer is over.
  const captionLabel =
    hoveredSlug && hoveredSlug !== activeSlug ? hoveredLabel : activeLabel

  return (
    <figure className={`neighborhood-map ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="neighborhood-map-svg"
        role="img"
        aria-label={`Interactive map of City of Akron neighborhoods${activeLabel ? `, ${activeLabel} currently selected` : ''}`}
      >
        {/* One <path> per neighborhood. The active hub renders as a
            plain <g> with aria-current="page" — it's a destination,
            not a navigation target. Every other hub renders as an
            <a> so click + Enter + middle-click all behave like
            normal navigation. The href is the real route so SSR
            crawlers and link-preview tools follow it; React Router
            intercepts the click event for SPA navigation. */}
        {features.map((f) => {
          const isActive = f.slug === activeSlug
          const className = `neighborhood-map-shape ${isActive ? 'neighborhood-map-shape--active' : ''}`
          if (isActive) {
            return (
              <g key={f.slug} aria-current="page">
                <title>{f.name}</title>
                <path d={f.d} className={className} />
              </g>
            )
          }
          return (
            <a
              key={f.slug}
              href={`/events/${f.slug}`}
              onClick={(e) => {
                // Let modified clicks (ctrl/cmd/shift/middle-click)
                // fall through to native href behavior — that's how
                // users open hubs in new tabs.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                navigate(`/events/${f.slug}`)
              }}
              onMouseEnter={() => setHoveredSlug(f.slug)}
              onMouseLeave={() => setHoveredSlug((s) => (s === f.slug ? null : s))}
              onFocus={() => setHoveredSlug(f.slug)}
              onBlur={() => setHoveredSlug((s) => (s === f.slug ? null : s))}
              aria-label={`Go to ${f.name} events`}
            >
              <title>{f.name}</title>
              <path d={f.d} className={className} />
            </a>
          )
        })}
      </svg>

      {/* Caption — surfaces the current label so users on touch
          devices (no hover) still get feedback about which polygon
          they tapped, and sighted desktop users get a name reveal
          on hover without the SVG needing per-polygon labels. */}
      <figcaption className="neighborhood-map-caption">
        {captionLabel ? (
          <>
            <span className="neighborhood-map-caption-dot" aria-hidden="true" />
            {captionLabel}
          </>
        ) : (
          'Hover or tap a neighborhood to explore'
        )}
      </figcaption>
    </figure>
  )
}
