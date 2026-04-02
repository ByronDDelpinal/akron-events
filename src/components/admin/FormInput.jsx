/**
 * Shared admin form input. Applies consistent className and handles nullish values.
 * Accepts all standard <input> props.
 */
export default function FormInput({ value, onChange, type = 'text', ...rest }) {
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
