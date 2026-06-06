import type { SelectHTMLAttributes } from 'react'

type SelectOption = string | { value: string; label: string }

interface FormSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value'> {
  value?: string | number | null
  options?: SelectOption[]
  placeholder?: string
}

/**
 * Shared admin select. Accepts options as an array of strings or
 * { value, label } objects.
 */
export default function FormSelect({ value, onChange, options = [], placeholder, ...rest }: FormSelectProps) {
  return (
    <select className="form-select" value={value ?? ''} onChange={onChange} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((opt) => {
        const val   = typeof opt === 'string' ? opt : opt.value
        const label = typeof opt === 'string' ? opt.replace(/_/g, ' ') : opt.label
        return <option key={val} value={val}>{label}</option>
      })}
    </select>
  )
}
