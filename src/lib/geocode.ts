/**
 * Geocode an address using the OpenStreetMap Nominatim API.
 * Returns { lat, lng } or null if the address couldn't be resolved.
 *
 * Nominatim usage policy requires a descriptive User-Agent and
 * at most 1 request per second — both are respected here.
 */

export interface AddressParts {
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

export interface LatLng {
  lat: number
  lng: number
}

// NE-Ohio / Greater Akron bounding box: [west, south, east, north].
// Mirrors SANITY_BBOX in scripts/geocode-venues.js — keep the two in sync.
const SANITY_BBOX = { west: -82.3, south: 40.6, east: -80.7, north: 41.7 }

export async function geocodeAddress({
  address,
  city,
  state,
  zip,
}: AddressParts): Promise<LatLng | null> {
  const parts = [address, city, state, zip].filter(Boolean)
  if (parts.length === 0) return null

  const q = parts.join(', ')
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q,
    format: 'json',
    limit: '1',
    // Bias (not restrict) results toward Greater Akron; bounded=0 keeps the
    // viewbox a preference only. The SANITY_BBOX reject below is the safety.
    viewbox: `${SANITY_BBOX.west},${SANITY_BBOX.north},${SANITY_BBOX.east},${SANITY_BBOX.south}`,
    bounded: '0',
    countrycodes: 'us',
  })}`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AkronPulse-Akron-Events/1.0' },
    })
    if (!res.ok) return null

    const data = (await res.json()) as Array<{ lat: string; lon: string }>
    if (!data.length) return null

    const lat = parseFloat(data[0].lat)
    const lng = parseFloat(data[0].lon)

    // Reject geocodes outside Greater Akron — a match in another state is
    // worse than no coordinates at all (callers treat null as no-coords).
    if (
      !(
        lng >= SANITY_BBOX.west &&
        lng <= SANITY_BBOX.east &&
        lat >= SANITY_BBOX.south &&
        lat <= SANITY_BBOX.north
      )
    ) {
      console.warn(`geocodeAddress: rejecting out-of-area result for "${q}" (${lat}, ${lng})`)
      return null
    }

    return { lat, lng }
  } catch {
    // Geocoding is best-effort — don't block submission
    return null
  }
}
