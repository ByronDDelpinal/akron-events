/**
 * directions.ts
 *
 * One shared builder for outbound Google Maps directions links. Coordinates
 * are the destination of record whenever we have a finite lat/lng pair:
 * minted festival venues (PorchRokr porches/stages) have no address Google
 * can resolve, and a text query for "PorchRokr Porch 21" lands nowhere
 * useful, while the coordinate form pins the exact porch. The legacy
 * text-query form remains the fallback for venues without coordinates.
 *
 * Call sites: EventPage.tsx, VenueDetailPage.tsx, MapView.tsx's venue popup,
 * PlanMap.tsx's plan popup.
 */

export interface DirectionsTarget {
  name?: string | null
  address?: string | null
  city?: string | null
  lat?: number | string | null
  lng?: number | string | null
}

/** DB rows sometimes carry coordinates as strings; '' and null are "absent",
 *  and anything non-finite (NaN from a garbage string) falls back too. */
function toFinite(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function googleDirectionsUrl({ name, address, city, lat, lng }: DirectionsTarget): string {
  const latNum = toFinite(lat)
  const lngNum = toFinite(lng)
  if (latNum != null && lngNum != null) {
    return `https://www.google.com/maps/dir/?api=1&destination=${latNum},${lngNum}`
  }
  return `https://maps.google.com/?q=${encodeURIComponent(
    [name, address, city].filter(Boolean).join(' ')
  )}`
}
