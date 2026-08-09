import { useEffect, useState } from 'react'

/**
 * Guarded matchMedia read + subscription, matching HeroRotator.tsx's
 * usePrefersReducedMotion -- same pattern, parameterized query. Lifted out
 * of DayPlanBoard.tsx (2026-08-09, festival map work) so FestivalPage.tsx
 * can gate its desktop-only map on the same hook instead of growing a
 * second copy; DayPlanBoard is now a consumer.
 *
 * SSR/prerender-safe: returns false when window/matchMedia is unavailable,
 * so a desktop-only consumer renders nothing rather than throwing.
 */
export function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ))
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}
