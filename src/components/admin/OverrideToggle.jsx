/**
 * OverrideToggle
 *
 * Pill-shaped toggle that appears next to a form field's label and
 * controls whether the field is locked against scraper overwrites.
 *
 * Two visual states, designed to be readable at a glance from a
 * normal editing distance:
 *
 *   - Locked   → filled amber pill, lock icon, the word "Locked".
 *                High contrast so you can scan a long form and
 *                immediately see which fields are protected.
 *   - Unlocked → outlined muted pill, open-lock icon, the word "Lock"
 *                (an action prompt, not a state — it tells the user
 *                what clicking will do).
 *
 * The colored fill on the locked state is the primary signal; the
 * icon and label are redundant on purpose so the affordance still
 * reads when users are scanning fast, color-blind, or printing.
 */

export default function OverrideToggle({ field, overrides, onToggle }) {
  const isLocked = !!(overrides && overrides[field])

  const label = isLocked ? 'Locked' : 'Lock'
  const title = isLocked
    ? `"${field}" is locked — scrapers will skip this field on the next run. Click to unlock.`
    : `Lock "${field}" to protect it from scraper overwrites.`

  return (
    <button
      type="button"
      className={`override-toggle ${isLocked ? 'override-toggle--locked' : 'override-toggle--unlocked'}`}
      onClick={() => onToggle(field)}
      title={title}
      aria-pressed={isLocked}
      aria-label={title}
    >
      <LockIcon locked={isLocked} />
      <span className="override-toggle-label">{label}</span>
    </button>
  )
}

/**
 * Inline SVG lock — the closed-shackle vs. open-shackle path swaps
 * based on `locked`. Inlining keeps the component dependency-free
 * and crisp at any size; the emoji versions previously used rendered
 * inconsistently across browsers and operating systems.
 */
function LockIcon({ locked }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  }

  if (locked) {
    // Closed padlock — body + curved shackle that lands on top of the body.
    return (
      <svg {...common}>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
    )
  }
  // Open padlock — shackle swings to the right of the body, leaving
  // the top-left open so the difference reads even when small.
  return (
    <svg {...common}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0" />
    </svg>
  )
}
