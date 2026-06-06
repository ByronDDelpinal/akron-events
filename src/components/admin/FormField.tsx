import type { ReactNode } from 'react'
import OverrideToggle from './OverrideToggle'
import type { Overrides } from '@/lib/admin/useOverrides'

interface FormFieldProps {
  label: ReactNode
  field?: string
  overrides?: Overrides
  onToggleOverride?: (field: string) => void
  children?: ReactNode
}

/**
 * Shared form field wrapper. Renders label + optional override toggle + children.
 * For fields without overrides, omit field/overrides/onToggleOverride.
 */
export default function FormField({ label, field, overrides, onToggleOverride, children }: FormFieldProps) {
  const showOverride = field && overrides && onToggleOverride
  return (
    <div className="admin-field">
      <label>
        {label}
        {showOverride && (
          <OverrideToggle field={field} overrides={overrides} onToggle={onToggleOverride} />
        )}
      </label>
      {children}
    </div>
  )
}

/**
 * Side-by-side field container.
 */
export function FormFieldRow({ children }: { children?: ReactNode }) {
  return <div className="admin-field-row">{children}</div>
}
