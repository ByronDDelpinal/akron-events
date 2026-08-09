import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

// Matches setDraftTitle's slice (dayPlanDraft.ts) and the day_plans.title
// CHECK constraint (migration 052: `char_length(title) between 1 and 80`).
const MAX_TITLE_LENGTH = 80

interface PlanTitleHeadingProps {
  /** null/empty means "unset" -- renders `fallback` instead. */
  title: string | null
  /** Shown when there is no title: "Your day plan" (/day) or "A shared day
   *  plan" (/d/:code) -- matches each page's existing untitled heading. */
  fallback: string
  /** Called with the trimmed, length-capped title (or null to clear it) on
   *  commit. The moderation trigger (day_plans.title) and, on /day, nothing
   *  server-side at all still apply on top of this -- this component only
   *  owns the editing UI, not the write path. */
  onSave: (title: string | null) => void
}

/**
 * Wires up the plan title (day-plan-audit.md P1-1 / Decision 3). The RPC,
 * the moderation trigger, the `title` column, and the .ics X-WR-CALNAME
 * were all built and reachable by NOTHING before this -- every plan read
 * "A shared day plan" or "Your day plan" regardless of what a visitor might
 * have wanted to call it. Click-to-edit on the `<h1>`, matching the pattern
 * a shared link needs: low-friction, no separate "edit" affordance to
 * discover, Escape to cancel, Enter or blur to save.
 */
export default function PlanTitleHeading({ title, fallback, onSave }: PlanTitleHeadingProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title ?? '')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Keep the draft input in step with an externally-changed title (e.g. a
  // reconcile/refresh landed a new value) as long as we're not mid-edit.
  useEffect(() => {
    if (!editing) setValue(title ?? '')
  }, [title, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commit = useCallback(() => {
    setEditing(false)
    const trimmed = value.trim()
    const next = trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null
    if (next !== (title ?? null)) onSave(next)
  }, [value, onSave, title])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setValue(title ?? '')
        setEditing(false)
      }
    },
    [commit, title],
  )

  if (editing) {
    return (
      <h1 className="day-plan-heading">
        <input
          ref={inputRef}
          type="text"
          className="day-plan-heading-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          maxLength={MAX_TITLE_LENGTH}
          placeholder="Name this plan"
          aria-label="Plan name"
        />
      </h1>
    )
  }

  return (
    <h1 className="day-plan-heading">
      <button
        type="button"
        className="day-plan-heading-btn"
        onClick={() => setEditing(true)}
        aria-label={title ? `Plan name: ${title}. Click to rename.` : 'Name this plan'}
      >
        {title || fallback}
      </button>
    </h1>
  )
}
