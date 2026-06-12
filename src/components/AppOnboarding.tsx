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
          <img src="/pwa-192x192.png" alt="" className="onboard-icon" aria-hidden="true" />
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
