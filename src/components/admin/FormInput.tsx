import type { InputHTMLAttributes } from 'react'

interface FormInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> {
  value?: string | number | null
}

/**
 * Shared admin form input. Applies consistent className and handles nullish values.
 * Accepts all standard <input> props.
 */
export default function FormInput({ value, onChange, type = 'text', ...rest }: FormInputProps) {
  return (
    <input
      className="form-input"
      type={type}
      value={value ?? ''}
      onChange={onChange}
      {...rest}
    />
  )
}
