import { useState, useCallback } from 'react'

/**
 * Generic form state hook. Provides field-level setters and full reset.
 * @param {object} initial — initial form values
 */
export function useFormState(initial) {
  const [form, setForm] = useState({ ...initial })

  const setField = useCallback((key, val) => {
    setForm(prev => ({ ...prev, [key]: val }))
  }, [])

  const reset = useCallback((data) => {
    setForm({ ...(data ?? initial) })
  }, [initial])

  return { form, setField, setForm, reset }
}
