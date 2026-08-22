import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react'

interface ConfirmDialogProps {
  message: ReactNode
  onConfirm: () => void
  onCancel: () => void
  /** Label for the confirming button. Defaults to 'Delete' (the historical use). */
  confirmLabel?: string
  /**
   * Visual weight of the confirming button. 'danger' (default) for
   * destructive confirms, 'primary' for consequential-but-constructive ones
   * like publishing to the public site.
   */
  tone?: 'danger' | 'primary'
}

export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Delete',
  tone = 'danger',
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null)

  // Dialog conventions: focus moves in on mount, Escape cancels.
  useEffect(() => {
    cardRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  return (
    <div className="admin-modal-backdrop" onClick={onCancel}>
      <div
        className="admin-confirm-card"
        role="dialog"
        aria-modal="true"
        aria-label="Confirm"
        tabIndex={-1}
        ref={cardRef}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <p className="admin-confirm-msg">{message}</p>
        <div className="admin-confirm-actions">
          <button className="btn-admin-ghost" onClick={onCancel}>Cancel</button>
          <button
            className={tone === 'primary' ? 'btn-admin-primary' : 'btn-admin-danger'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
