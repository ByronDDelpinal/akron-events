import { useEffect, useCallback, type ReactNode, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'

interface ModalProps {
  /** controls visibility */
  open: boolean
  /** called when backdrop, X button, or Escape is pressed */
  onClose?: () => void
  children?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'full'
  /** if true, renders no chrome (no header/close button), just backdrop + content */
  bare?: boolean
}

/**
 * Reusable modal component, rendered through a portal attached to <body> so
 * it is not subject to any parent component's stacking context.
 */
export default function Modal({ open, onClose, children, size = 'md', bare = false }: ModalProps) {
  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose?.()
  }, [onClose])

  // Lock body scroll and listen for Escape
  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', handleKey)
    }
  }, [open, handleKey])

  if (!open) return null

  return createPortal(
    <div className="modal-backdrop" onClick={(e: MouseEvent) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className={`modal-container modal--${size} ${bare ? 'modal--bare' : ''}`}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </div>
    </div>,
    document.body
  )
}
