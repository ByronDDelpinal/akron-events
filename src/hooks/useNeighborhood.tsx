import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isStandalone } from '@/hooks/usePwaInstall'
import {
  getMyHubSlug,
  rememberMyHub,
  clearMyHub as clearStoredHub,
  getHubLabel,
} from '@/lib/myHub'
import { trackEvent, EVENTS, setNeighborhoodContext } from '@/lib/analytics'

/**
 * "My Neighborhood" state, shared across the app.
 *
 * The saved hub lives in localStorage (see src/lib/myHub.ts), but the
 * Header label and the picker modal both need it to react instantly when
 * the user saves or clears — localStorage isn't reactive. This provider
 * keeps the slug in React state and is the one place that mutates it, so
 * every consumer (the menu item, the modal) stays in sync.
 *
 * It also owns the picker modal's open state and the first-launch
 * onboarding trigger that used to live in AppOnboarding: on the installed
 * app's first launch (never the website), open the picker once.
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

interface NeighborhoodContextValue {
  /** Saved hub slug, or null if none is set. */
  hubSlug: string | null
  /** Display label for the saved hub (e.g. "Highland Square"), or null. */
  hubLabel: string | null
  /** Whether the picker modal is currently open. */
  pickerOpen: boolean
  /** Open the picker on demand (e.g. from the menu item). */
  openPicker: () => void
  /** Dismiss the picker without saving. */
  closePicker: () => void
  /** Persist a hub, sync state, and navigate to it. */
  saveHub: (slug: string) => void
  /** Forget the saved hub. */
  clearHub: () => void
}

const NeighborhoodContext = createContext<NeighborhoodContextValue | null>(null)

// Context module exports its provider + hook together by design; the HMR
// fast-refresh rule only wants components here, so silence it for the hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useNeighborhood(): NeighborhoodContextValue {
  const ctx = useContext(NeighborhoodContext)
  if (!ctx) {
    throw new Error('useNeighborhood must be used within a NeighborhoodProvider')
  }
  return ctx
}

export function NeighborhoodProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [hubSlug, setHubSlug] = useState<string | null>(() => getMyHubSlug())
  const [pickerOpen, setPickerOpen] = useState(false)

  // True only while the picker is open because of the first-launch
  // onboarding trigger, so we report the onboarding funnel (saved/skipped)
  // for that case and not for every "change my neighborhood" reopen.
  const onboardingOpenRef = useRef(false)

  const openPicker = useCallback(() => {
    onboardingOpenRef.current = false
    setPickerOpen(true)
  }, [])

  const closePicker = useCallback(() => {
    markOnboarded()
    if (onboardingOpenRef.current) {
      trackEvent(EVENTS.ONBOARDING_CLOSED, { outcome: 'skipped' })
      onboardingOpenRef.current = false
    }
    setPickerOpen(false)
  }, [])

  const saveHub = useCallback((slug: string) => {
    rememberMyHub(slug)
    setHubSlug(slug)
    markOnboarded()
    if (onboardingOpenRef.current) {
      trackEvent(EVENTS.ONBOARDING_CLOSED, { outcome: 'saved' })
      onboardingOpenRef.current = false
    }
    trackEvent(EVENTS.NEIGHBORHOOD_SET, { neighborhood: slug })
    setPickerOpen(false)
    navigate(`/events/${slug}`)
  }, [navigate])

  const clearHub = useCallback(() => {
    clearStoredHub()
    setHubSlug(null)
    trackEvent(EVENTS.NEIGHBORHOOD_CLEARED)
  }, [])

  // Keep the persistent GA4 `neighborhood` dimension in step with the saved
  // hub, so every subsequent hit is attributable to it. Sited here rather than
  // inside saveHub/clearHub so it also covers the mount case (a returning user
  // with a hub already in localStorage) and can't be missed by a future
  // mutation path that forgets to call it.
  useEffect(() => {
    setNeighborhoodContext(hubSlug)
  }, [hubSlug])

  // First-launch onboarding — installed app only, once, and never over
  // /admin. Evaluated once on mount, mirroring the original AppOnboarding.
  useEffect(() => {
    if (isStandalone() && !alreadyOnboarded() && !pathname.startsWith('/admin')) {
      onboardingOpenRef.current = true
      setPickerOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value: NeighborhoodContextValue = {
    hubSlug,
    hubLabel: getHubLabel(hubSlug),
    pickerOpen,
    openPicker,
    closePicker,
    saveHub,
    clearHub,
  }

  return (
    <NeighborhoodContext.Provider value={value}>
      {children}
    </NeighborhoodContext.Provider>
  )
}
