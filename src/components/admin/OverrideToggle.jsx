export default function OverrideToggle({ field, overrides, onToggle }) {
  const isLocked = !!(overrides && overrides[field])
  return (
    <button
      type="button"
      className={`override-toggle ${isLocked ? 'locked' : ''}`}
      onClick={() => onToggle(field)}
      title={isLocked
        ? `"${field}" is locked — scrapers will skip this field`
        : `Lock "${field}" to protect from scraper overwrites`}
    >
      {isLocked ? '🔒' : '🔓'}
    </button>
  )
}
