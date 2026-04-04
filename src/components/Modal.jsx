import { useEffect, useCallback } from 'react'
import './Modal.css'

/**
 * Reusable modal component.
 *
 * Props:
 *   open      – boolean, controls visibility
 *   onClose   – called when backdrop, X button, or Escape is pressed
 *   children  – modal content
 *   size      – 'sm' | 'md' | 'lg' | 'full' (default 'md')
 *   bare      – if true, renders no chrome (no header/close button), just the backdrop + content
 */
export default function Modal({ open, onClose, children, size = 'md', bare = false }) {
  const handleKey = useCallback((e) => {
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

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className={`modal-container modal--${size} ${bare ? 'modal--bare' : ''}`}>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        {children}
      </div>
    </div>
  )
}
