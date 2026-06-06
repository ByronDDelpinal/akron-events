interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

/**
 * Shared admin search input used in list page toolbars.
 */
export default function SearchBar({ value, onChange, placeholder = 'Search…' }: SearchBarProps) {
  return (
    <input
      className="admin-search"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
