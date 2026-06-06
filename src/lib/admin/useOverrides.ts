import { useState, useCallback } from 'react'

/** A single manual-override marker: when the operator locked the field. */
export interface OverrideMarker {
  at: string
}

export type Overrides = Record<string, OverrideMarker>

/**
 * Manages manual_overrides state for scraper-safe admin edits.
 */
export function useOverrides(initial: Overrides = {}) {
  const [overrides, setOverrides] = useState<Overrides>({ ...initial })

  const toggleOverride = useCallback((field: string) => {
    setOverrides((prev) => {
      const next = { ...prev }
      if (next[field]) delete next[field]
      else next[field] = { at: new Date().toISOString() }
      return next
    })
  }, [])

  return { overrides, toggleOverride }
}
