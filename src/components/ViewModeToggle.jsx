import './ViewModeToggle.css'

/**
 * Toggle between Comfortable and Compact views.
 * Each button shows a grid/list icon paired with a character illustration.
 */
export default function ViewModeToggle({ mode, onChange }) {
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
        <CoolPersonIcon />
      </button>
      <button
        className={`vmt-btn ${mode === 'efficient' ? 'vmt-btn--active' : ''}`}
        onClick={() => onChange('efficient')}
        aria-checked={mode === 'efficient'}
        role="radio"
        title="Compact view"
      >
        <ListIcon />
        <NerdPersonIcon />
      </button>
    </div>
  )
}

function GridIcon() {
  return (
    <svg className="vmt-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg className="vmt-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

/** Cool person: sunglasses, relaxed vibe */
function CoolPersonIcon() {
  return (
    <svg className="vmt-avatar" width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Head */}
      <circle cx="16" cy="13" r="8" fill="#F5D6A8" />
      {/* Hair — casual swept */}
      <path d="M8.5 11c0-5.5 4-8.5 7.5-8.5s7.5 3 7.5 8.5c0 0-2-3.5-7.5-3.5S8.5 11 8.5 11z" fill="#5C3D2E" />
      {/* Sunglasses frame */}
      <rect x="9" y="11.5" width="5.5" height="3.5" rx="1.5" fill="#1A1A1A" />
      <rect x="17.5" y="11.5" width="5.5" height="3.5" rx="1.5" fill="#1A1A1A" />
      {/* Bridge */}
      <path d="M14.5 13.2h3" stroke="#1A1A1A" strokeWidth="0.9" strokeLinecap="round" />
      {/* Lens shine */}
      <rect x="10" y="12.2" width="1.5" height="0.7" rx="0.35" fill="rgba(255,255,255,0.35)" />
      <rect x="18.5" y="12.2" width="1.5" height="0.7" rx="0.35" fill="rgba(255,255,255,0.35)" />
      {/* Smirk */}
      <path d="M13.5 17.2c.8 1 3.2 1.2 4.2 0" stroke="#A0755A" strokeWidth="0.8" strokeLinecap="round" fill="none" />
      {/* Shoulders / collar — casual T-shirt */}
      <path d="M6 28c0-5 4.5-7.5 10-7.5s10 2.5 10 7.5" fill="#D4922A" />
      {/* T-shirt neckline */}
      <path d="M12.5 21.5c1-1 2.2-1.3 3.5-1.3s2.5.3 3.5 1.3" stroke="#BC7E20" strokeWidth="0.7" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** Nerdy person: round glasses, button-up shirt with collar */
function NerdPersonIcon() {
  return (
    <svg className="vmt-avatar" width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Head */}
      <circle cx="16" cy="13" r="8" fill="#E8C99B" />
      {/* Hair — neat, parted */}
      <path d="M8.5 11.5c0-5.5 3.5-9 7.5-9s7.5 3.5 7.5 9c0 0-1.5-5-7.5-5s-7.5 5-7.5 5z" fill="#3A2518" />
      <path d="M8.5 11.5c.5-1.5 1.5-3 3-4" stroke="#3A2518" strokeWidth="1.2" strokeLinecap="round" />
      {/* Glasses — round frames */}
      <circle cx="12.8" cy="13" r="2.8" stroke="#4A4A4A" strokeWidth="1" fill="none" />
      <circle cx="19.2" cy="13" r="2.8" stroke="#4A4A4A" strokeWidth="1" fill="none" />
      {/* Bridge */}
      <path d="M15.6 12.8h0.8" stroke="#4A4A4A" strokeWidth="0.9" strokeLinecap="round" />
      {/* Ear stems */}
      <path d="M10 12.8H8.8" stroke="#4A4A4A" strokeWidth="0.8" strokeLinecap="round" />
      <path d="M22 12.8h1.2" stroke="#4A4A4A" strokeWidth="0.8" strokeLinecap="round" />
      {/* Eyes behind glasses */}
      <circle cx="12.8" cy="13" r="0.7" fill="#2C1810" />
      <circle cx="19.2" cy="13" r="0.7" fill="#2C1810" />
      {/* Small smile */}
      <path d="M14 17c.6.7 1.8.9 2.8.4" stroke="#A0755A" strokeWidth="0.7" strokeLinecap="round" fill="none" />
      {/* Shoulders / button-up shirt */}
      <path d="M6 28c0-5 4.5-7.5 10-7.5s10 2.5 10 7.5" fill="#4A7B6F" />
      {/* Collar */}
      <path d="M13 21.2L16 24l3-2.8" stroke="#3A6B5A" strokeWidth="0.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 21l-1 2.5" stroke="#3A6B5A" strokeWidth="0.7" strokeLinecap="round" />
      <path d="M19.5 21l1 2.5" stroke="#3A6B5A" strokeWidth="0.7" strokeLinecap="round" />
      {/* Buttons */}
      <circle cx="16" cy="25.5" r="0.5" fill="#D4D4D4" />
      <circle cx="16" cy="27.5" r="0.5" fill="#D4D4D4" />
    </svg>
  )
}
