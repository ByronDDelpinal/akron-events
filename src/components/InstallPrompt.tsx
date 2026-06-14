import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { usePwaInstall, promptInstall, isMobileDevice } from '@/hooks/usePwaInstall'
import { hasInstallIntent } from '@/lib/engagement'
import { ShareIcon } from '@/components/icons'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './InstallPrompt.css'

/**
 * PWA install promotion, two entry points:
 *
 *   <InstallPrompt />     — dismissible pill above the slim footer bar.
 *                           Serves both funnels: Chromium fires the native
 *                           install dialog; iOS (no install API) opens the
 *                           Share-sheet how-to. Shown from the SECOND visit
 *                           on — or sooner for engaged visitors (see
 *                           hasInstallIntent) — and silenced for 60 days
 *                           once dismissed. Mounted once in SiteChrome.
 *   <InstallFooterLink /> — quiet "Add to Home Screen" link for the
 *                           footer. Works on Chromium (native dialog)
 *                           and iOS (instruction sheet). Intent-driven,
 *                           so it has no visit/dismissal gating.
 *
 * Both entry points are mobile-only (Android/iOS, see isMobileDevice):
 * desktop "installs" don't go to a home screen, so the pitch would be
 * wrong. Neither renders when already installed, and the pill never
 * shows on /admin. The /embed routes don't mount SiteChrome at all.
 */

const DISMISSED_AT_KEY  = 'akronpulse.install_dismissed_at'
const VISIT_COUNT_KEY   = 'akronpulse.visit_count'
const SESSION_FLAG_KEY  = 'akronpulse.visit_counted'
const DISMISS_FOR_MS    = 60 * 24 * 60 * 60 * 1000 // 60 days

/** Count one visit per browser session; returns the running total. */
function countVisit(): number {
  try {
    let count = parseInt(localStorage.getItem(VISIT_COUNT_KEY) ?? '0', 10) || 0
    if (!sessionStorage.getItem(SESSION_FLAG_KEY)) {
      sessionStorage.setItem(SESSION_FLAG_KEY, '1')
      count += 1
      localStorage.setItem(VISIT_COUNT_KEY, String(count))
    }
    return count
  } catch {
    return 0
  }
}

function recentlyDismissed(): boolean {
  try {
    const at = parseInt(localStorage.getItem(DISMISSED_AT_KEY) ?? '0', 10) || 0
    return Date.now() - at < DISMISS_FOR_MS
  } catch {
    return false
  }
}

function recordDismissal(): void {
  try {
    localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()))
  } catch { /* ignore */ }
}

export default function InstallPrompt() {
  const { platform, installed } = usePwaInstall()
  const { pathname } = useLocation()
  const [eligible, setEligible] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [iosSheetOpen, setIosSheetOpen] = useState(false)

  // Visit counting + gating run once on mount; `platform` flipping to
  // 'native' later (beforeinstallprompt can fire after mount) is picked
  // up reactively through the hook. Engaged visitors (set a neighborhood,
  // read a few events) qualify ahead of the plain second-visit threshold.
  useEffect(() => {
    const visits = countVisit()
    setEligible((visits >= 2 || hasInstallIntent()) && !recentlyDismissed())
  }, [])

  // The pill now serves both funnels: Chromium's native dialog AND iOS,
  // where there's no install API so the pill opens the Share-sheet how-to.
  const isIosPlatform = platform === 'ios'

  const show =
    eligible &&
    !hidden &&
    !installed &&
    (platform === 'native' || platform === 'ios') &&
    isMobileDevice() &&
    !pathname.startsWith('/admin')

  if (!show) return null

  const onInstall = async () => {
    if (isIosPlatform) {
      // iOS can't be prompted programmatically — coach the gesture. Record a
      // dismissal so we don't re-nag this device; a real install surfaces
      // later as a pwa_standalone_launch instead.
      trackEvent(EVENTS.PWA_INSTALL_CLICKED, { placement: 'pill', method: 'ios' })
      trackEvent(EVENTS.PWA_INSTALL_INSTRUCTIONS_SHOWN, { placement: 'pill' })
      recordDismissal()
      setIosSheetOpen(true)
      return
    }
    trackEvent(EVENTS.PWA_INSTALL_CLICKED, { placement: 'pill', method: 'native' })
    const outcome = await promptInstall()
    if (outcome === 'accepted') {
      trackEvent(EVENTS.PWA_INSTALL_ACCEPTED, { placement: 'pill', method: 'native' })
    } else {
      // Declined the native dialog: treat as a dismissal, don't nag.
      recordDismissal()
    }
    setHidden(true)
  }

  const onDismiss = () => {
    recordDismissal()
    trackEvent(EVENTS.PWA_INSTALL_DISMISSED, {
      placement: 'pill',
      method: isIosPlatform ? 'ios' : 'native',
    })
    setHidden(true)
  }

  return (
    <>
      <div className="install-pill" role="dialog" aria-label="Install Akron Pulse">
        <img src="/pwa-192x192.png" alt="" className="install-pill-icon" aria-hidden="true" />
        <div className="install-pill-text">
          <p className="install-pill-title">Get Akron Pulse on your home screen</p>
          <p className="install-pill-sub">
            {isIosPlatform
              ? "Tap Share, then “Add to Home Screen.” No app store needed."
              : "One tap to this weekend's events. No app store needed."}
          </p>
        </div>
        <button type="button" className="install-pill-btn" onClick={onInstall}>
          {isIosPlatform ? 'Show how' : 'Install'}
        </button>
        <button
          type="button"
          className="install-pill-close"
          aria-label="Not now"
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      {iosSheetOpen && (
        <IosInstallSheet
          onClose={() => {
            setIosSheetOpen(false)
            setHidden(true)
          }}
        />
      )}
    </>
  )
}

// ── Footer entry point ──────────────────────────────────────────────────────

export function InstallFooterLink() {
  const { platform, installed } = usePwaInstall()
  const [sheetOpen, setSheetOpen] = useState(false)

  if (installed || platform === 'unavailable' || !isMobileDevice()) return null

  const onClick = async () => {
    if (platform === 'native') {
      trackEvent(EVENTS.PWA_INSTALL_CLICKED, { placement: 'footer', method: 'native' })
      const outcome = await promptInstall()
      if (outcome === 'accepted') {
        trackEvent(EVENTS.PWA_INSTALL_ACCEPTED, { placement: 'footer', method: 'native' })
      }
    } else {
      trackEvent(EVENTS.PWA_INSTALL_CLICKED, { placement: 'footer', method: 'ios' })
      trackEvent(EVENTS.PWA_INSTALL_INSTRUCTIONS_SHOWN, { placement: 'footer' })
      setSheetOpen(true)
    }
  }

  return (
    <>
      <button type="button" className="footer-install-link" onClick={onClick}>
        Add to Home Screen
      </button>
      {sheetOpen && <IosInstallSheet onClose={() => setSheetOpen(false)} />}
    </>
  )
}

// ── iOS instruction sheet ───────────────────────────────────────────────────

function IosInstallSheet({ onClose }: { onClose: () => void }) {
  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="ios-sheet-backdrop" onClick={onClose}>
      <div
        className="ios-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Add Akron Pulse to your home screen"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="ios-sheet-title">Add Akron Pulse to your home screen</p>
        <ol className="ios-sheet-steps">
          <li>Tap the <strong>Share</strong> button <span className="ios-sheet-icon"><ShareIcon size={15} /></span> in your browser's toolbar</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
          <li>Tap <strong>Add</strong></li>
        </ol>
        <button type="button" className="ios-sheet-close" onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  )
}
