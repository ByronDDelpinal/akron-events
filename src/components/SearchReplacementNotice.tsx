import type { SearchReplacement } from '@/hooks/useEvents'
import './SearchReplacementNotice.css'

interface SearchReplacementNoticeProps {
  /** From useEvents; null when the results are for the term as typed. */
  replacement: SearchReplacement | null
}

/**
 * Says so when the results on screen are for a different term than the one
 * typed — a completed word ("jilly" → "jillys") or a corrected spelling
 * ("musika" → "musica").
 *
 * The list is sorted by date, so nothing else on the page distinguishes a
 * substituted match from an exact one. Without this line a visitor who typed
 * "drag" and got dragon listings reads it as a broken search.
 *
 * Shared by EventsBrowser (home + embed) and CategoryPage (every hub): they
 * are independent forks, so anything both must show lives in one component.
 */
export default function SearchReplacementNotice({ replacement }: SearchReplacementNoticeProps) {
  if (!replacement) return null
  return (
    <p className="search-replacement" role="status">
      No exact matches for <q>{replacement.from}</q>. Showing results for{' '}
      <strong>{replacement.to}</strong>.
    </p>
  )
}
