import type { TextareaHTMLAttributes } from 'react'

interface FormTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> {
  value?: string | number | null
}

/**
 * Shared admin textarea. Consistent className + nullish handling.
 */
export default function FormTextarea({ value, onChange, rows = 3, ...rest }: FormTextareaProps) {
  return (
    <textarea
      className="form-textarea"
      value={value ?? ''}
      onChange={onChange}
      rows={rows}
      {...rest}
    />
  )
}
