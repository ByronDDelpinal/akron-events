import { getSourceLabel } from '@/lib/sources'
import './SourceOverflowCard.css'

/**
 * SourceOverflowCard
 *
 * A subtle "show more / hide" trigger that lives in the cards grid.
 * Deliberately low-profile so it reads as a grid utility, not a content card.
 */
export default function SourceOverflowCard({ source, hiddenCount, isExpanded, onToggle }) {
  const label = getSourceLabel(source)

  return (
    <button
      className={`source-overflow-card ${isExpanded ? 'source-overflow-card--expanded' : ''}`}
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={
        isExpanded
          ? `Hide ${hiddenCount} events from ${label}`
          : `Show ${hiddenCount} more events from ${label}`
      }
    >
      <span className="soc-chevron" aria-hidden="true">
        {isExpanded ? '↑' : '↓'}
      </span>
      <span className="soc-label">
        {isExpanded ? `Hide ${hiddenCount} from ${label}` : `+${hiddenCount} more from ${label}`}
      </span>
    </button>
  )
}
