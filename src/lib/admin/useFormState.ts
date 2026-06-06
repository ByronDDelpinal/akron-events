import { useState, useCallback, type Dispatch, type SetStateAction } from 'react'

/**
 * Generic form state hook. Provides field-level setters and full reset.
 */
export function useFormState<T extends Record<string, unknown>>(initial: T) {
  const [form, setForm] = useState<T>({ ...initial })

  const setField = useCallback(<K extends keyof T>(key: K, val: T[K]) => {
    setForm((prev) => ({ ...prev, [key]: val }))
  }, [])

  const reset = useCallback((data?: T) => {
    setForm({ ...(data ?? initial) })
  }, [initial])

  return {
    form,
    setField,
    setForm: setForm as Dispatch<SetStateAction<T>>,
    reset,
  }
}
