import './ViewModeToggle.css'

interface ViewModeToggleProps {
  mode: string
  onChange: (mode: string) => void
}

/**
 * Toggle between Comfortable and Compact views.
 */
export default function ViewModeToggle({ mode, onChange }: ViewModeToggleProps) {
  return (
    <div className="view-mode-toggle" role="radiogroup" aria-label="Card view mode">
      <button
        className={`vmt-btn ${mode === 'comfortable' ? 'vmt-btn--active' : ''}`}
        onClick={() => onChange('comfortable')}
        aria-checked={mode === 'comfortable'}
        role="radio"
        title="Comfortable view"
      >
        <GridIcon />
      </button>
      <button
        className={`vmt-btn ${mode === 'efficient' ? 'vmt-btn--active' : ''}`}
        onClick={() => onChange('efficient')}
        aria-checked={mode === 'efficient'}
        role="radio"
        title="Compact view"
      >
        <ListIcon />
      </button>
    </div>
  )
}

/** 2×2 large squares — comfortable (spacious) view */
function GridIcon() {
  return (
    <svg className="vmt-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  )
}

/** 3×3 small squares — compact (dense) view */
function ListIcon() {
  return (
    <svg className="vmt-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3"    y="3"    width="4.5" height="4.5" rx="1" />
      <rect x="9.75" y="3"    width="4.5" height="4.5" rx="1" />
      <rect x="16.5" y="3"    width="4.5" height="4.5" rx="1" />
      <rect x="3"    y="9.75" width="4.5" height="4.5" rx="1" />
      <rect x="9.75" y="9.75" width="4.5" height="4.5" rx="1" />
      <rect x="16.5" y="9.75" width="4.5" height="4.5" rx="1" />
      <rect x="3"    y="16.5" width="4.5" height="4.5" rx="1" />
      <rect x="9.75" y="16.5" width="4.5" height="4.5" rx="1" />
      <rect x="16.5" y="16.5" width="4.5" height="4.5" rx="1" />
    </svg>
  )
}
