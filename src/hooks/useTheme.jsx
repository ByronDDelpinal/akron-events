import { createContext, useContext, useEffect, useState } from 'react'
import {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isValidTheme,
} from '@/lib/themes'

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
const ThemeContext = createContext(null)

function readStoredTheme() {
  if (typeof window === 'undefined') return DEFAULT_THEME
  // One-time migration: earlier pre-launch builds used sessionStorage.
  // If a value is there and localStorage is empty, carry it over.
  const sessionValue = window.sessionStorage.getItem(THEME_STORAGE_KEY)
  if (sessionValue && !window.localStorage.getItem(THEME_STORAGE_KEY)) {
    window.localStorage.setItem(THEME_STORAGE_KEY, sessionValue)
    window.sessionStorage.removeItem(THEME_STORAGE_KEY)
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  return stored && isValidTheme(stored) ? stored : DEFAULT_THEME
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(readStoredTheme)

  useEffect(() => {
    const root = document.documentElement
    THEMES.forEach((t) => root.classList.remove(`theme-${t.id}`))
    root.classList.add(`theme-${theme}`)
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={[theme, setTheme]}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    throw new Error('useTheme must be used within <ThemeProvider>')
  }
  return ctx
}
