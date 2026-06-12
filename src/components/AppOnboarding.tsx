import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isStandalone } from '@/hooks/usePwaInstall'
import { rememberMyHub, getMyHubSlug } from '@/lib/myHub'
import { NEIGHBORHOODS, NEIGHBORHOOD_SLUGS } from '@/lib/neighborhoods'
import { CITIES } from '@/lib/cities'
import { trackEvent } from '@/lib/analytics'
import SummitCountyMap from '@/components/SummitCountyMap'
import NeighborhoodMap from '@/components/NeighborhoodMap'
import './AppOnboarding.css'

/**
 * One-time onboarding for the INSTALLED app only (never the website):
 * shown on first launch in standalone display mode, it invites the user
 * to pick their city/neighborhood, which seeds the same localStorage
 * slot the "My Neighborhood" app shortcut reads (see src/lib/myHub.ts).
 *
 * The picker mirrors the hub pages' map UX: the Summit County map by
 * default, drilling into the Akron neighborhood map when Akron (or any
 * neighborhood) is chosen. Map taps and the dropdown stay in sync —
 * both write the same `slug` state.
 *
 * "First launch" is keyed off ONBOARDED_KEY alone, so users who
 * installed before this shipped see it exactly once too. Skipping also
 * sets the flag: the modal never re-prompts; the shortcut and hub pages
 * remain the ways to (re)set the preference later.
 */

const ONBOARDED_KEY = 'akronpulse.app_onboarded'

function alreadyOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    return true // storage unavailable: never show, never loop
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, '1')
  } catch { /* ignore */ }
}

/**
 * Illustration of the Android long-press shortcut menu. Most users
 * never discover long-press on their own, so the modal SHOWS the
 * gesture instead of only describing it: the app icon with a press
 * ring, and the shortcut popup it reveals. Glyphs mirror the real
 * shortcut icons (public/shortcut-*.png); popup uses --bg-nav and the
 * accent uses --amber so every theme renders it on-brand.
 */
function ShortcutHintGraphic() {
  return (
    <svg
      viewBox="0 0 220 178"
      className="onboard-hint-graphic"
      role="img"
      aria-label="Tip: press and hold the Akron Pulse app icon to reveal shortcuts like My Neighborhood"
    >
      <rect x="24" y="6" width="190" height="104" rx="14" fill="var(--bg-nav)" />
      <path d="M44 110 L56 110 L44 124 Z" fill="var(--bg-nav)" />
      <g>
        <circle cx="48" cy="28" r="12" fill="#FFFFFF" />
        <g fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" transform="translate(40 20) scale(0.5)">
          <path d="M16 27 C16 27 25 19.5 25 13 C25 8 21 4.5 16 4.5 C11 4.5 7 8 7 13 C7 19.5 16 27 16 27 Z" />
          <circle cx="16" cy="13" r="3.4" />
        </g>
        <text x="70" y="33" fontSize="13" fontWeight="600" fill="#FFFFFF" opacity="0.95">My Neighborhood</text>
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

export default function AppOnboarding() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // Prefill with the hub they've already shown us (visited hub page or
  // shortcut use, written via rememberMyHub) — existing installs get the
  // modal pre-set to their place; true first-timers start empty.
  const [slug, setSlug] = useState(() => getMyHubSlug() ?? '')

  // Evaluated once on mount: standalone launches land on '/' (the
  // manifest start_url) or a shortcut deep link; the modal may appear
  // over either, but never over /admin.
  useEffect(() => {
    if (isStandalone() && !alreadyOnboarded() && !pathname.startsWith('/admin')) {
      setOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!open) return null

  // Akron selected (or one of its neighborhoods): drill into the
  // neighborhood map, exactly like the city hub page does.
  const isNeighborhood = slug !== '' && NEIGHBORHOOD_SLUGS.has(slug)
  const drilledIn = slug === 'akron' || isNeighborhood

  const close = (reason: 'saved' | 'skipped') => {
    markOnboarded()
    trackEvent('app_onboarding_closed', { category: 'PWA', label: reason })
    setOpen(false)
  }

  const onSave = () => {
    if (!slug) return
    rememberMyHub(slug)
    close('saved')
    navigate(`/events/${slug}`)
  }

  return (
    <div className="onboard-backdrop">
      <div
        className="onboard-card"
        role="dialog"
        aria-modal="true"
        aria-label="Personalize Akron Pulse"
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
          <p className="onboard-title">Check your Pulse</p>
          <p className="onboard-sub">
            Select your city for a more personal view around you. We'll
            keep it one tap away: long-press the app icon anytime for
            "My Neighborhood."
          </p>
          <select
            className="onboard-select"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-label="Choose your city or Akron neighborhood"
          >
            <option value="" disabled>Choose your neighborhood</option>
            <optgroup label="Cities">
              {CITIES.map((c) => (
                <option key={c.slug} value={c.slug}>{c.label}</option>
              ))}
            </optgroup>
            <optgroup label="Akron Neighborhoods">
              {NEIGHBORHOODS.map((n) => (
                <option key={n.slug} value={n.slug}>{n.label}</option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            className="onboard-save"
            disabled={!slug}
            onClick={onSave}
          >
            Show me what's happening
          </button>
          <button type="button" className="onboard-skip" onClick={() => close('skipped')}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  )
}
