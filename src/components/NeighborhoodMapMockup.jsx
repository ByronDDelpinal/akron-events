/**
 * NeighborhoodMapMockup.jsx
 *
 * Static stand-in for the eventual interactive neighborhood map.
 *
 * Why this exists:
 *   The full design vision (see https://artxlove.com/shop/p/this-is-the-city-of-akron-ky6pl)
 *   has the active neighborhood highlighted in the brand color with
 *   siblings grayed out, hoverable, and clickable through to each
 *   neighborhood's own hub page. That requires a polygon-aware SVG
 *   (or GeoJSON + canvas/SVG renderer) keyed by neighborhood slug,
 *   which is blocked on the GIS file from Art × Love or the City of
 *   Akron's planning division.
 *
 *   In the meantime we already have a high-fidelity static poster of
 *   the same map — `public/neighborhood-map.webp`. This component
 *   displays it and overlays a brand-color "you are here" indicator
 *   over the active neighborhood's approximate location on the
 *   poster. That lets us ship the page layout (intro left, map right)
 *   and validate the visual hierarchy without waiting on data.
 *
 * Swap path:
 *   When the GIS asset arrives, replace this component's body with
 *   a `<svg viewBox=...>` of the polygon set, key each `<path>` by
 *   `data-slug`, and apply the same active/idle styling via CSS. The
 *   call site in CategoryPage doesn't need to change — same props,
 *   same slot.
 *
 * Props:
 *   activeLabel — the active neighborhood's display name (e.g.
 *     "Highland Square"), used in the screen-reader-only summary and
 *     the visible callout near the hotspot.
 *   hotspot — { x, y } percentages (0–100) locating the active
 *     neighborhood on the static poster, measured from the image's
 *     top-left. Eyeballed from the poster; precision is acceptable
 *     because this is a mockup. Pulled directly from
 *     `hub.mapMockup.hotspot` in src/lib/seo/categories.js.
 */

import './NeighborhoodMapMockup.css'

const MAP_SRC = '/neighborhood-map.webp'

export default function NeighborhoodMapMockup({ activeLabel, hotspot }) {
  // Defensive default: render the bare map if a hub forgets the
  // hotspot. Better than blowing up the page.
  const x = hotspot?.x ?? 50
  const y = hotspot?.y ?? 50

  return (
    <figure className="neighborhood-map-mockup" aria-label={`Map of City of Akron neighborhoods, with ${activeLabel} highlighted`}>
      <div className="neighborhood-map-frame">
        {/* Static poster of all 24 City of Akron neighborhoods.
            Lazy + async because this is below the H1 on small
            viewports and the page's primary content (events list)
            should paint first. */}
        <img
          src={MAP_SRC}
          alt=""               // decorative — figure already has aria-label
          loading="lazy"
          decoding="async"
          className="neighborhood-map-image"
        />

        {/* Active-neighborhood hotspot. Pulses gently so it reads
            as "this is where you are" rather than a static dot.
            CSS variables let us position it without inline style
            recomputation on every render. */}
        <span
          className="neighborhood-map-hotspot"
          style={{ '--hotspot-x': `${x}%`, '--hotspot-y': `${y}%` }}
          aria-hidden="true"
        />

        {/* Preview badge — flag to ourselves (and any curious
            visitor) that this is a design preview, not the final
            interactive map. Removed when the GIS-backed SVG ships. */}
        <span className="neighborhood-map-preview-badge">Preview</span>
      </div>

      <figcaption className="neighborhood-map-caption">
        Interactive map coming soon. Hover &amp; click navigation will ship
        with the City of Akron neighborhood polygons.
      </figcaption>
    </figure>
  )
}
