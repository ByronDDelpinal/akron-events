/**
 * Shared admin textarea. Consistent className + nullish handling.
 */
export default function FormTextarea({ value, onChange, rows = 3, ...rest }) {
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
