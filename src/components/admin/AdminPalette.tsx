import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * The admin search palette: jump to any section, or run one of a small set
 * of actions. Opens from the topbar search box by click and from the
 * Cmd/Ctrl+K binding AdminLayout owns (the one keyboard affordance this
 * shell keeps, matching the approved prototype). No event or venue search
 * yet -- that needs a query design and arrives with Phase 2; the palette
 * never pretends to search data it cannot reach.
 *
 * Dialog conventions: role=dialog + aria-modal, focus moves into the input
 * on open and back to the opener on close, Escape and the backdrop close.
 * Enter runs the first visible item; every item is a plain button, so Tab
 * reaches them all.
 */

interface PaletteAction {
  id: string
  group: 'Jump to' | 'Do'
  label: string
  run: () => void
}

interface AdminPaletteProps {
  open: boolean
  onClose: () => void
  includeEnded: boolean
  onToggleEnded: () => void
  onKittenBreak: () => void
  onLogout: () => void
}

const SECTIONS: { label: string; to: string }[] = [
  { label: 'Pulse, the overview', to: '/admin' },
  { label: 'Events',              to: '/admin/events' },
  { label: 'Venues',              to: '/admin/venues' },
  { label: 'Organizations',       to: '/admin/organizations' },
  { label: 'Areas',               to: '/admin/areas' },
  { label: 'Scraper runs',        to: '/admin/scraper-runs' },
  { label: 'Review queue',        to: '/admin/review' },
  { label: 'Email',               to: '/admin/email' },
  { label: 'Feedback',            to: '/admin/feedback' },
]

export default function AdminPalette({
  open, onClose, includeEnded, onToggleEnded, onKittenBreak, onLogout,
}: AdminPaletteProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<Element | null>(null)
  const navigate = useNavigate()

  const actions = useMemo<PaletteAction[]>(() => [
    ...SECTIONS.map((s) => ({
      id: `nav-${s.to}`,
      group: 'Jump to' as const,
      label: s.label,
      run: () => navigate(s.to),
    })),
    {
      id: 'toggle-ended',
      group: 'Do',
      label: includeEnded ? 'Hide ended events' : 'Show ended events',
      run: onToggleEnded,
    },
    { id: 'kitten', group: 'Do', label: 'Take a kitten break', run: onKittenBreak },
    { id: 'site',   group: 'Do', label: 'Open the public site', run: () => window.open('/', '_blank', 'noopener') },
    { id: 'logout', group: 'Do', label: 'Log out', run: onLogout },
  ], [navigate, includeEnded, onToggleEnded, onKittenBreak, onLogout])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((a) => a.label.toLowerCase().includes(q))
  }, [actions, query])

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    setQuery('')
    inputRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      const opener = openerRef.current
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [open, onClose])

  if (!open) return null

  const runAction = (a: PaletteAction) => {
    onClose()
    a.run()
  }

  const groups: ReactNode[] = []
  let lastGroup: string | null = null
  for (const a of visible) {
    if (a.group !== lastGroup) {
      lastGroup = a.group
      groups.push(
        <div key={`g-${a.group}`} className="ashell-pgroup" role="presentation">{a.group}</div>,
      )
    }
    groups.push(
      <button
        key={a.id}
        type="button"
        className="ashell-pitem"
        onClick={() => runAction(a)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m9 18 6-6-6-6" />
        </svg>
        {a.label}
      </button>,
    )
  }

  return (
    <div className="ashell-veil ashell-veil--top" onClick={onClose}>
      <div
        className="ashell-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search sections and actions"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && visible.length > 0) runAction(visible[0])
          }}
          placeholder="Jump to a section or run an action…"
          aria-label="Search sections and actions"
          autoComplete="off"
        />
        <div className="ashell-plist">
          {visible.length > 0 ? groups : <div className="ashell-pgroup">No matches</div>}
        </div>
      </div>
    </div>
  )
}
