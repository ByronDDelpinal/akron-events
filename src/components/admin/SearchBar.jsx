/**
 * Shared admin search input used in list page toolbars.
 */
export default function SearchBar({ value, onChange, placeholder = 'Search…' }) {
  return (
    <input
      className="admin-search"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  )
}
