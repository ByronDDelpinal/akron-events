import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  isValidTheme,
  getThemeFonts,
} from '@/lib/themes'

type ThemeContextValue = [string, Dispatch<SetStateAction<string>>]

// Stable id for the single <link> element that hosts the active
// theme's Google Fonts stylesheet. The element ships in index.html
// pre-populated with the default theme's URL so cold-load first
// paint is correct; on theme switches we just rewrite its href.
// Browsers dedupe identical URLs, so flipping back and forth is free.
const THEME_FONT_LINK_ID = 'theme-fonts'

function applyThemeFonts(themeId: string): void {
  if (typeof document === 'undefined') return
  const fonts = getThemeFonts(themeId)
  if (!fonts?.googleFontsHref) return
  const link = document.getElementById(THEME_FONT_LINK_ID)
  if (!link) return
  if (link.getAttribute('href') !== fonts.googleFontsHref) {
    link.setAttribute('href', fonts.googleFontsHref)
  }
}

/**
 * Theme state — single source of truth.
 *
 * Wrap the app in <ThemeProvider>; any component can call useTheme()
 * to read or update the current theme. The provider:
 *   - reads the initial value from localStorage (with validation)
 *   - applies the .theme-<id> class to <html> whenever it changes
 *   - persists the choice back to localStorage
 *
 * Every theme is applied via a class — including the default. globals.css
 * still defines a safe fallback palette at :root for brief pre-mount
 * paints, but the visible theme is whatever class is on <html>.
 */
const ThemeContext = createContext<ThemeContextValue | null>(null)

// The embed renders under /embed/*. In that context the theme is fixed by
// the partner via the ?theme= query param and must NOT be read from or
// written to localStorage — otherwise a visitor's own saved site theme
// would override the partner's white-label choice (and vice-versa).
function isEmbedPath(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/embed')
}

function readEmbedTheme(): string {
  try {
    const t = new URLSearchParams(window.location.search).get('theme')
    return t && isValidTheme(t) ? t : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

function readInitialTheme(): string {
  return isEmbedPath() ? readEmbedTheme() : readStoredTheme()
}

function readStoredTheme(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME

  // One-time migration: earlier pre-launch builds used sessionStorage.
  const sessionValue = window.sessionStorage.getItem(THEME_STORAGE_KEY)
  if (sessionValue && !window.localStorage.getItem(THEME_STORAGE_KEY)) {
    window.localStorage.setItem(THEME_STORAGE_KEY, sessionValue)
    window.sessionStorage.removeItem(THEME_STORAGE_KEY)
  }

  // Rebrand migration: pre-rebrand users had 'turnout.theme' in localStorage.
  // Move that into the new key on first load so their pick survives.
  const legacyValue = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY)
  if (legacyValue && !window.localStorage.getItem(THEME_STORAGE_KEY)) {
    window.localStorage.setItem(THEME_STORAGE_KEY, legacyValue)
    window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY)
  }

  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored && isValidTheme(stored) ? stored : DEFAULT_THEME
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<string>(readInitialTheme)

  useEffect(() => {
    const root = document.documentElement
    THEMES.forEach((t) => root.classList.remove(`theme-${t.id}`))
    root.classList.add(`theme-${theme}`)
    // The index.html boot script sets an inline background on <html>
    // (pre-CSS anti-flash). Once React owns theming, clear it so the
    // stylesheet's --bg-page wins on later theme switches.
    root.style.background = ''
    // Don't persist inside the embed — the partner's theme is request-scoped.
    if (!isEmbedPath()) window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    // Lazy-load the active theme's Google Fonts. The pre-bundle boot
    // script in index.html primes this for cold loads; this effect
    // handles in-app theme switches.
    applyThemeFonts(theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={[theme, setTheme]}>
      {children}
    </ThemeContext.Provider>
  )
}

// Context module exports its provider + hook together by design; the HMR
// boundary warning doesn't apply meaningfully here.
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within <ThemeProvider>')
  }
  return ctx
}
