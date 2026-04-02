import { useState, useCallback } from 'react'

/**
 * Manages manual_overrides state for scraper-safe admin edits.
 * @param {object} initial — existing overrides object (or {})
 */
export function useOverrides(initial = {}) {
  const [overrides, setOverrides] = useState({ ...initial })

  const toggleOverride = useCallback((field) => {
    setOverrides(prev => {
      const next = { ...prev }
      if (next[field]) delete next[field]
      else next[field] = { at: new Date().toISOString() }
      return next
    })
  }, [])

  return { overrides, toggleOverride }
}
