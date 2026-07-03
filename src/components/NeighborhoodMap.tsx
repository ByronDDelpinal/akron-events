/**
 * NeighborhoodMap.tsx
 *
 * Interactive SVG map of the City of Akron's 24 neighborhoods. Renders
 * public/akron-neighborhoods.geojson directly as SVG paths, keyed by slug.
 * The active neighborhood is brand-highlighted; clicking a sibling selects it
 * and a panel button (or double-click) commits to navigation.
 *
 * The GeoJSON is fetched at runtime (419 KB doesn't belong in the bundle) and
 * cached at module scope by promise so concurrent mounts dedupe.
 *
 * Props:
 *   activeSlug — slug of the currently-rendered hub (brand highlight, no click).
 *   activeLabelOverride — optional panel-name override (e.g. Akron city hub).
 *   className — optional layout slot.
 */

import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { NEIGHBORHOOD_LABELS } from '@/lib/neighborhoods'
import './NeighborhoodMap.css'

const GEOJSON_URL = '/akron-neighborhoods.geojson'

// Loose GeoJSON shapes — the data is fetched at runtime, not from a typed API.
/** GeoJSON position pair (lon, lat). Narrowed via the `type` discriminant. */
type Ring = [number, number][]
type Geometry =
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }
type Feature = { geometry: Geometry; properties: { slug: string; name: string } }
type FeatureCollection = { features: Feature[] }
type Point = [number, number]
type Projector = (lon: number, lat: number) => Point

// ── Module-level fetch cache (promise-keyed, dedupes parallel mounts).
let geojsonPromise: Promise<FeatureCollection> | null = null
function loadGeojson(): Promise<FeatureCollection> {
  if (!geojsonPromise) {
    geojsonPromise = fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${GEOJSON_URL}: ${r.status}`)
        return r.json() as Promise<FeatureCollection>
      })
      .catch((err) => {
        // Clear the cache so a future mount can retry.
        geojsonPromise = null
        throw err
      })
  }
  return geojsonPromise
}

// ── Geometry helpers ───────────────────────────────────────────────

/** Walk every coordinate pair in a Polygon / MultiPolygon geometry. */
function eachCoord(geometry: Geometry, fn: (lon: number, lat: number) => void): void {
  const polys = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : [geometry.coordinates]
  for (const poly of polys) {
    for (const ring of poly) {
      for (const pt of ring) fn(pt[0], pt[1])
    }
  }
}

interface Projection {
  lonMin: number
  lonMax: number
  latMin: number
  latMax: number
  lonScale: number
  projWidth: number
  projHeight: number
}

/**
 * Compute the bounding box across every feature, then derive the
 * longitude-scale factor (cos of the central latitude).
 */
function computeProjection(features: Feature[]): Projection {
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

/**
 * Build the SVG `d` attribute for one Feature's geometry. Every ring becomes
 * `M x y L x y … Z`; multiple polygons / holes chain in one path.
 */
function buildPathD(geometry: Geometry, project: Projector): string {
  const polys = geometry.type === 'MultiPolygon'
    ? geometry.coordinates
    : [geometry.coordinates]
  const parts: string[] = []
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
const VIEW_W = 600
const VIEW_H = 600
const PAD    = 12

interface ShapeFeature {
  slug: string
  name: string
  d: string
}

interface NeighborhoodMapProps {
  activeSlug?: string | null
  activeLabelOverride?: string | null
  className?: string
  /** Picker mode — see SummitCountyMap: controlled selection, no navigation. */
  pickedSlug?: string | null
  onPick?: (slug: string) => void
}

// ── Component ──────────────────────────────────────────────────────

export default function NeighborhoodMap({ activeSlug, activeLabelOverride, className, pickedSlug, onPick }: NeighborhoodMapProps) {
  const navigate = useNavigate()
  const [data, setData] = useState<FeatureCollection | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isPicker = onPick !== undefined
  // Only the picker holds a selection (for its highlight); the hub map navigates
  // on tap, so it has no intermediate "selected" state.
  const selectedSlug = isPicker ? (pickedSlug ?? null) : null

  useEffect(() => {
    let cancelled = false
    loadGeojson()
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Map error') })
    return () => { cancelled = true }
  }, [])

  // Pre-compute SVG paths once per dataset.
  const features = useMemo<ShapeFeature[] | null>(() => {
    if (!data) return null
    const proj = computeProjection(data.features)
    const innerW = VIEW_W - PAD * 2
    const innerH = VIEW_H - PAD * 2
    const scale = Math.min(innerW / proj.projWidth, innerH / proj.projHeight)
    const drawnW = proj.projWidth * scale
    const drawnH = proj.projHeight * scale
    const offsetX = PAD + (innerW - drawnW) / 2
    const offsetY = PAD + (innerH - drawnH) / 2
    const project: Projector = (lon, lat) => {
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
        aria-label="Loading community map"
      />
    )
  }

  const activeLabel = activeLabelOverride
    ?? (activeSlug ? NEIGHBORHOOD_LABELS[activeSlug] : null)

  const goToSlug = (slug: string) => {
    navigate(`/events/${slug}`, { state: { preserveScroll: true } })
  }

  const handlePolygonClick = (e: MouseEvent, slug: string) => {
    // Modified clicks fall through to the native <a> for new-tab behavior.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    if (isPicker) {
      onPick!(slug)
      return
    }
    // Outside the picker, a single tap commits straight to that hub — no
    // select-then-confirm step.
    goToSlug(slug)
  }

  return (
    <figure className={`neighborhood-map ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="neighborhood-map-svg"
        role="img"
        aria-label={`Interactive map of City of Akron communities${activeLabel ? `, ${activeLabel} currently selected` : ''}`}
      >
        {features.map((f) => {
          const isActive   = f.slug === activeSlug
          const isSelected = f.slug === selectedSlug && !isActive
          const cls = [
            'neighborhood-map-shape',
            isActive   ? 'neighborhood-map-shape--active'   : '',
            isSelected ? 'neighborhood-map-shape--selected' : '',
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
              aria-label={`View ${f.name} events`}
            >
              <title>{f.name}</title>
              <path d={f.d} className={cls} />
            </a>
          )
        })}
      </svg>

      {/* Sticky panel — a single tap navigates, so this just states where you
          are and invites the next tap. */}
      {!isPicker && (
        <div className="neighborhood-map-panel">
          <div className="neighborhood-map-panel-text">
            <p className="neighborhood-map-panel-eyebrow">You're viewing</p>
            <p className="neighborhood-map-panel-name">{activeLabel ?? '—'}</p>
          </div>
        </div>
      )}

      {!isPicker && (
        <p className="neighborhood-map-panel-hint">
          Tap another community to select it
        </p>
      )}
    </figure>
  )
}
