/**
 * SummitCountyMap.tsx
 *
 * Interactive SVG map of the major incorporated places in Summit County, OH.
 * Mirrors NeighborhoodMap's shape and UX, one zoom level up (cities, not
 * Akron neighborhoods). Renders public/summit-county-cities.geojson (produced
 * offline by scripts/convert-summit-cities.js); fails soft when absent.
 *
 * Props:
 *   activeSlug — the city hub currently rendered (brand highlight, no click).
 *   className — optional layout slot.
 */

import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { PLACE_LABELS } from '@/lib/cities'
import './SummitCountyMap.css'

const GEOJSON_URL = '/summit-county-cities.geojson'

// Loose GeoJSON shapes — runtime-fetched, not from a typed API.
/** GeoJSON position pair (lon, lat). Narrowed via the `type` discriminant. */
type Ring = [number, number][]
type Geometry =
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }
type Feature = { geometry: Geometry; properties: { slug: string; name: string } }
type FeatureCollection = { features: Feature[] }
type Point = [number, number]
type Projector = (lon: number, lat: number) => Point

// The cities label map is authored in plain JS; widen to a string index.
const PLACE_LABEL_MAP = PLACE_LABELS as Record<string, string>

// Module-level fetch cache so concurrent mounts don't race-fetch the file.
let geojsonPromise: Promise<FeatureCollection> | null = null
function loadGeojson(): Promise<FeatureCollection> {
  if (!geojsonPromise) {
    geojsonPromise = fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${GEOJSON_URL}: ${r.status}`)
        return r.json() as Promise<FeatureCollection>
      })
      .catch((err) => {
        geojsonPromise = null
        throw err
      })
  }
  return geojsonPromise
}

// ── Geometry helpers (mirror NeighborhoodMap) ──────────────────────

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
const VIEW_H = 640
const PAD    = 14

interface ShapeFeature {
  slug: string
  name: string
  d: string
}

interface SummitCountyMapProps {
  activeSlug?: string | null
  className?: string
  /**
   * Picker mode (e.g. the app-onboarding modal): clicking a city
   * reports the slug via onPick instead of arming the internal
   * selection + "View events" flow. Selection highlight is controlled
   * by pickedSlug, and all navigation affordances (double-click, panel,
   * hint) are suppressed.
   */
  pickedSlug?: string | null
  onPick?: (slug: string) => void
}

// ── Component ──────────────────────────────────────────────────────

export default function SummitCountyMap({ activeSlug, className, pickedSlug, onPick }: SummitCountyMapProps) {
  const navigate = useNavigate()
  const [data, setData] = useState<FeatureCollection | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isPicker = onPick !== undefined
  // Only the picker holds a selection; the hub map navigates on tap.
  const selectedSlug = isPicker ? (pickedSlug ?? null) : null

  useEffect(() => {
    let cancelled = false
    loadGeojson()
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Map error') })
    return () => { cancelled = true }
  }, [])

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

  const activeLabel = activeSlug ? PLACE_LABEL_MAP[activeSlug] : null

  const goToSlug = (slug: string) => {
    navigate(`/events/${slug}`, { state: { preserveScroll: true } })
  }

  const handlePolygonClick = (e: MouseEvent, slug: string) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    if (isPicker) {
      onPick!(slug)
      return
    }
    // A single tap commits straight to that hub — no select-then-confirm step.
    goToSlug(slug)
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
              aria-label={`View ${f.name} events`}
            >
              <title>{f.name}</title>
              <path d={f.d} className={cls} />
            </a>
          )
        })}
      </svg>

      {!isPicker && (
        <div className="summit-county-map-panel">
          <div className="summit-county-map-panel-text">
            <p className="summit-county-map-panel-eyebrow">You're viewing</p>
            <p className="summit-county-map-panel-name">{activeLabel ?? '—'}</p>
          </div>
        </div>
      )}

      {!isPicker && (
        <p className="summit-county-map-panel-hint">
          Tap another community to select it
        </p>
      )}
    </figure>
  )
}
