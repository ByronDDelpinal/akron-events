/**
 * Shared admin select. Accepts options as:
 *   - Array of strings: ['a', 'b']
 *   - Array of { value, label } objects
 *
 * @param {string}  placeholder — optional placeholder option (value="")
 */
export default function FormSelect({ value, onChange, options = [], placeholder, ...rest }) {
  return (
    <select className="form-select" value={value ?? ''} onChange={onChange} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(opt => {
        const val   = typeof opt === 'string' ? opt : opt.value
        const label = typeof opt === 'string' ? opt.replace(/_/g, ' ') : opt.label
        return <option key={val} value={val}>{label}</option>
      })}
    </select>
  )
}
