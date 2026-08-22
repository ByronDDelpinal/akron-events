import { useCallback, useEffect, useRef, useState } from 'react'
import {
  KITTEN_PHOTOS, kittenSrc, pickKittenIndex, pickKittenCaption,
} from '@/lib/admin/kittens'

/**
 * The kitten break dialog. A real photo by a human photographer on
 * Wikimedia Commons, a random cute name, and a caption. The credit link
 * under the photo is a license requirement and always renders.
 *
 * Dialog conventions: role=dialog + aria-modal, focus moves in on open and
 * back to the opener on close, Tab is trapped inside, Escape and the
 * backdrop both close (the WAI-ARIA dialog pattern, an accessibility
 * requirement rather than a keyboard shortcut).
 */
export default function KittenBreak({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState<number | null>(null)
  const [caption, setCaption] = useState(() => pickKittenCaption())
  const cardRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<Element | null>(null)
  const indexRef = useRef<number | null>(null)
  indexRef.current = index

  const showAnother = useCallback(() => {
    const next = pickKittenIndex(indexRef.current)
    // Preload the pick, then swap, so the card never flashes empty.
    const swap = () => {
      setIndex(next)
      setCaption(pickKittenCaption())
    }
    const img = new Image()
    img.onload = swap
    img.onerror = swap
    img.src = kittenSrc(KITTEN_PHOTOS[next])
    if (img.complete) swap()
  }, [])

  // Fresh kitten on every open; remember and restore the opener's focus.
  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    setIndex((prev) => pickKittenIndex(prev))
    setCaption(pickKittenCaption())
    return () => {
      const opener = openerRef.current
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [open])

  // Move focus INTO the dialog once the card exists. On the first-ever open
  // the card has not rendered yet when the effect above runs (`index` is
  // still null and render returns null), so focusing there is a silent
  // no-op and Tab starts outside the trap. Keying on [open, index] runs
  // again after the card commits. The containment guard keeps "Another
  // kitten" (which also changes `index`) from yanking focus off the button
  // the user just pressed.
  useEffect(() => {
    if (!open || index == null) return
    const card = cardRef.current
    if (card && !card.contains(document.activeElement)) card.focus()
  }, [open, index])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const card = cardRef.current
      if (!card) return
      const focusables = card.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open || index == null) return null
  const photo = KITTEN_PHOTOS[index]

  return (
    <div className="ashell-veil" onClick={onClose}>
      <div
        className="ashell-kitty-card"
        role="dialog"
        aria-modal="true"
        aria-label="Kitten break"
        tabIndex={-1}
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="ashell-kitty-hd">Kitten break</h3>
        <div className="ashell-kitty-stage">
          <img src={kittenSrc(photo)} alt="A kitten photo" />
        </div>
        <p className="ashell-kitty-cap">
          <b>{caption.name}</b> {caption.line}
        </p>
        <p className="ashell-kitty-credit">
          Photo:{' '}
          <a href={photo.url} target="_blank" rel="noopener noreferrer">
            {photo.credit}
          </a>
          , Wikimedia Commons
        </p>
        <div className="ashell-kitty-row">
          <button type="button" className="ashell-btn ashell-btn--primary" onClick={showAnother}>
            Another kitten
          </button>
          <button type="button" className="ashell-btn" onClick={onClose}>
            Back to work
          </button>
        </div>
      </div>
    </div>
  )
}
