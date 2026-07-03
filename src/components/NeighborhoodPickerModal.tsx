import { useEffect, useState } from 'react'
import { useNeighborhood } from '@/hooks/useNeighborhood'
import { NEIGHBORHOODS, NEIGHBORHOOD_SLUGS } from '@/lib/neighborhoods'
import { CITIES } from '@/lib/cities'
import SummitCountyMap from '@/components/SummitCountyMap'
import NeighborhoodMap from '@/components/NeighborhoodMap'
import './AppOnboarding.css'

/**
 * The "My Neighborhood" picker. Driven entirely by NeighborhoodProvider:
 * it opens on the installed app's first launch (onboarding) and on demand
 * from the menu item's "Set" / "Change" actions. Picking a city or Akron
 * neighborhood seeds the same localStorage slot the menu item reads.
 *
 * The picker mirrors the hub pages' map UX: the Summit County map by
 * default, drilling into the Akron neighborhood map when Akron (or any
 * neighborhood) is chosen. Map taps and the dropdown stay in sync — both
 * write the same `slug` state.
 */

/**
 * Illustration of the Android long-press shortcut menu. Most users never
 * discover long-press on their own, so the modal SHOWS the gesture: the
 * app icon with a press ring and the shortcut popup it reveals. Glyphs
 * mirror the real shortcut icons (public/shortcut-*.png).
 */
function ShortcutHintGraphic() {
  return (
    <svg
      viewBox="0 0 220 178"
      className="onboard-hint-graphic"
      role="img"
      aria-label="Tip: press and hold the Akron Pulse app icon to reveal shortcuts like My Community"
    >
      <rect x="24" y="6" width="190" height="104" rx="14" fill="var(--bg-nav)" />
      <path d="M44 110 L56 110 L44 124 Z" fill="var(--bg-nav)" />
      <g>
        <circle cx="48" cy="28" r="12" fill="#FFFFFF" />
        <g fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform="translate(40 20) scale(0.5)">
          <path d="M16 27 C16 27 25 19.5 25 13 C25 8 21 4.5 16 4.5 C11 4.5 7 8 7 13 C7 19.5 16 27 16 27 Z" />
          <circle cx="16" cy="13" r="3.4" />
        </g>
        <text x="70" y="33" fontSize="13" fontWeight="600" fill="#FFFFFF" opacity="0.95">My Community</text>
      </g>
      <g>
        <circle cx="48" cy="58" r="12" fill="#FFFFFF" />
        <g fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform="translate(40 50) scale(0.5)">
          <rect x="6" y="8" width="20" height="18" rx="2" />
          <path d="M6 14 H26 M11.5 4.5 V9.5 M20.5 4.5 V9.5" />
        </g>
        <text x="70" y="63" fontSize="13" fontWeight="600" fill="#FFFFFF" opacity="0.95">This Weekend</text>
      </g>
      <g>
        <circle cx="48" cy="88" r="12" fill="#FFFFFF" />
        <g fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform="translate(40 80) scale(0.5)">
          <path d="M16 8.5 V23.5 M8.5 16 H23.5" />
        </g>
        <text x="70" y="93" fontSize="13" fontWeight="600" fill="#FFFFFF" opacity="0.95">Submit an Event</text>
      </g>
      <g>
        <rect x="28" y="130" width="40" height="40" rx="9" fill="#0E5163" />
        <path
          d="M35 150 L42 150 L45.5 142.5 L48 159 L51.5 136 L55.5 152.5 L59 150 L61 150"
          fill="none" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"
        />
        <circle cx="48" cy="150" r="27" fill="none" stroke="var(--amber)" strokeWidth="2" strokeDasharray="4 5" opacity="0.85" />
        <text x="84" y="148" fontSize="12" fill="var(--text-muted)">Press and hold the</text>
        <text x="84" y="163" fontSize="12" fill="var(--text-muted)">app icon to try it</text>
      </g>
    </svg>
  )
}

export default function NeighborhoodPickerModal() {
  const { pickerOpen, hubSlug, saveHub, clearHub, closePicker } = useNeighborhood()
  // Prefill with the saved hub so reopening to "change" starts on the
  // current pick; true first-timers start empty.
  const [slug, setSlug] = useState(hubSlug ?? '')

  // Each time the picker opens, re-sync the draft to the saved hub (it may
  // have changed since the modal last closed).
  useEffect(() => {
    if (pickerOpen) setSlug(hubSlug ?? '')
  }, [pickerOpen, hubSlug])

  if (!pickerOpen) return null

  // Akron selected (or one of its neighborhoods): drill into the
  // neighborhood map, exactly like the city hub page does.
  const isNeighborhood = slug !== '' && NEIGHBORHOOD_SLUGS.has(slug)
  const drilledIn = slug === 'akron' || isNeighborhood
  const hasSavedHub = hubSlug !== null

  const onClear = () => {
    clearHub()
    closePicker()
  }

  return (
    <div className="onboard-backdrop">
      <div
        className="onboard-card"
        role="dialog"
        aria-modal="true"
        aria-label="Choose your community"
      >
        <div className="onboard-map-pane">
          {drilledIn ? (
            <NeighborhoodMap
              className="onboard-map"
              pickedSlug={isNeighborhood ? slug : null}
              onPick={setSlug}
            />
          ) : (
            <SummitCountyMap
              className="onboard-map"
              pickedSlug={slug || null}
              onPick={setSlug}
            />
          )}
          {drilledIn && (
            <button
              type="button"
              className="onboard-map-back"
              onClick={() => setSlug('')}
            >
              ← All of Summit County
            </button>
          )}
        </div>

        <div className="onboard-content">
          <ShortcutHintGraphic />
          <p className="onboard-title">
            {hasSavedHub ? 'Update My Community' : 'Check your Pulse'}
          </p>
          <p className="onboard-sub">
            Select your city for a more personal view around you. We'll
            keep it one tap away in the menu, and long-press the app icon
            anytime for "My Community."
          </p>
          <select
            className="onboard-select"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-label="Choose your city or Akron community"
          >
            <option value="" disabled>Choose your community</option>
            <optgroup label="Cities">
              {CITIES.map((c) => (
                <option key={c.slug} value={c.slug}>{c.label}</option>
              ))}
            </optgroup>
            <optgroup label="Akron Communities">
              {NEIGHBORHOODS.map((n) => (
                <option key={n.slug} value={n.slug}>{n.label}</option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            className="onboard-save"
            disabled={!slug}
            onClick={() => slug && saveHub(slug)}
          >
            Show me what's happening
          </button>
          {hasSavedHub && (
            <button type="button" className="onboard-clear" onClick={onClear}>
              Clear My Community
            </button>
          )}
          <button type="button" className="onboard-skip" onClick={closePicker}>
            {hasSavedHub ? 'Cancel' : 'Maybe later'}
          </button>
        </div>
      </div>
    </div>
  )
}
