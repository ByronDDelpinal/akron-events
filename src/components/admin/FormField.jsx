import OverrideToggle from './OverrideToggle'

/**
 * Shared form field wrapper. Renders label + optional override toggle + children.
 *
 * Usage:
 *   <FormField label="Title" field="title" overrides={overrides} onToggleOverride={toggle}>
 *     <input className="form-input" value={...} onChange={...} />
 *   </FormField>
 *
 * For fields without overrides, omit field/overrides/onToggleOverride.
 */
export default function FormField({ label, field, overrides, onToggleOverride, children }) {
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
export function FormFieldRow({ children }) {
  return <div className="admin-field-row">{children}</div>
}
