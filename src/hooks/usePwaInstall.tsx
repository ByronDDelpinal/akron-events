import { useSyncExternalStore } from 'react'

/**
 * PWA install state, shared app-wide.
 *
 * Chrome/Edge fire `beforeinstallprompt` exactly once, early in the
 * page's life, and only hand out the install dialog through that
 * event. The listener therefore lives at MODULE scope (attached the
 * moment the bundle evaluates), not inside a hook effect: a component
 * that mounts later would miss the event entirely. Components
 * subscribe to the captured state via useSyncExternalStore.
 *
 * Platforms:
 *   'native'      — Chromium captured the event; promptInstall() opens
 *                   the real install dialog.
 *   'ios'         — iOS browser; no API exists, the UI must show
 *                   Share → "Add to Home Screen" instructions instead.
 *   'unavailable' — already installed, desktop Safari/Firefox, etc.
 */

// Chromium-only event; not in lib.dom.d.ts.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallPlatform = 'native' | 'ios' | 'unavailable'

interface InstallState {
  platform: InstallPlatform
  installed: boolean
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's pre-standard flag for home-screen launches.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  // iPadOS 13+ masquerades as macOS; the touch-point check unmasks it.
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

/**
 * Android or iOS (tablets included — they have home screens too).
 * Install promotion is mobile-only by design: on desktop, Chromium
 * "installs" to the dock/desktop rather than a home screen, and the
 * pitch ("on your home screen") wouldn't be true. UA-based on purpose:
 * pointer/viewport heuristics misclassify touch laptops and narrow
 * desktop windows.
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData?.mobile) return true
  return /android/i.test(navigator.userAgent) || isIos()
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
let state: InstallState = {
  platform: isIos() && !isStandalone() ? 'ios' : 'unavailable',
  installed: isStandalone(),
}
const subscribers = new Set<() => void>()

function setState(next: Partial<InstallState>): void {
  state = { ...state, ...next }
  subscribers.forEach((fn) => fn())
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress Chrome's ambient mini-infobar; we choose the moment.
    e.preventDefault()
    deferredPrompt = e as BeforeInstallPromptEvent
    setState({ platform: 'native' })
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    setState({ platform: 'unavailable', installed: true })
  })
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

function getSnapshot(): InstallState {
  return state
}

/**
 * Open the native install dialog (platform 'native' only). Must be
 * called from a user gesture. The captured event is single-use:
 * whatever the outcome, it's gone afterwards.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferredPrompt
  if (!evt) return 'unavailable'
  deferredPrompt = null
  await evt.prompt()
  const { outcome } = await evt.userChoice
  if (outcome !== 'accepted') {
    // Event consumed but declined: nothing left to offer this page-load.
    setState({ platform: isIos() ? 'ios' : 'unavailable' })
  }
  return outcome
}

export function usePwaInstall(): InstallState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
