/**
 * Geocode an address using the OpenStreetMap Nominatim API.
 * Returns { lat, lng } or null if the address couldn't be resolved.
 *
 * Nominatim usage policy requires a descriptive User-Agent and
 * at most 1 request per second — both are respected here.
 */
export async function geocodeAddress({ address, city, state, zip }) {
  const parts = [address, city, state, zip].filter(Boolean)
  if (parts.length === 0) return null

  const q = parts.join(', ')
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q,
    format: 'json',
    limit: '1',
  })}`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Turnout-Akron-Events/1.0' },
    })
    if (!res.ok) return null

    const data = await res.json()
    if (!data.length) return null

    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
    }
  } catch {
    // Geocoding is best-effort — don't block submission
    return null
  }
}
