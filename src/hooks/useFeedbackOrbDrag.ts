import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  type Corner,
  cornerToPosition,
  isTap,
  nearestCorner,
  prefersReducedMotion,
  readCorner,
  writeCorner,
} from '@/lib/feedbackOrb'

interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
}

interface UseFeedbackOrbDragResult {
  corner: Corner
  style: CSSProperties
  dragging: boolean
  handlers: DragHandlers
}

/**
 * Pointer Events drag, tap-vs-drag disambiguation, corner-snap on release,
 * and corner persistence for the feedback orb (spec §1 / plan §4). One
 * pointer-event path covers mouse, touch, and pen.
 *
 * A movement < TAP_THRESHOLD_PX between down and up is a tap: onTap fires
 * and the orb does not move. Anything further is a drag: on release the
 * orb snaps to the nearest of four corners and only the corner id persists
 * (not raw x/y), so it survives viewport resizes and rotation cleanly.
 */
export function useFeedbackOrbDrag(onTap: () => void): UseFeedbackOrbDragResult {
  const [corner, setCorner] = useState<Corner>(() => readCorner())
  const [dragging, setDragging] = useState(false)
  const [delta, setDelta] = useState({ dx: 0, dy: 0 })

  const startRef = useRef({ x: 0, y: 0 })
  const pointerIdRef = useRef<number | null>(null)
  const draggingRef = useRef(false)

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    // Left button / primary touch only.
    if (e.button != null && e.button !== 0) return
    startRef.current = { x: e.clientX, y: e.clientY }
    pointerIdRef.current = e.pointerId
    draggingRef.current = false
    setDelta({ dx: 0, dy: 0 })
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== e.pointerId) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    if (!draggingRef.current && !isTap(dx, dy)) {
      draggingRef.current = true
      setDragging(true)
    }
    if (draggingRef.current) setDelta({ dx, dy })
  }, [])

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (pointerIdRef.current !== e.pointerId) return
    const wasDragging = draggingRef.current

    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch { /* already released */ }

    pointerIdRef.current = null
    draggingRef.current = false
    setDragging(false)
    setDelta({ dx: 0, dy: 0 })

    if (wasDragging) {
      const vw = typeof window === 'undefined' ? 0 : window.innerWidth
      const vh = typeof window === 'undefined' ? 0 : window.innerHeight
      const next = nearestCorner(e.clientX, e.clientY, vw, vh)
      setCorner(next)
      writeCorner(next)
      // A drag never opens the popover.
      return
    }

    // Movement stayed under the tap threshold the whole gesture — open.
    onTap()
  }, [onTap])

  const onPointerCancel = useCallback((_e: ReactPointerEvent<HTMLElement>) => {
    pointerIdRef.current = null
    draggingRef.current = false
    setDragging(false)
    setDelta({ dx: 0, dy: 0 })
  }, [])

  const base = cornerToPosition(corner)
  const reducedMotion = prefersReducedMotion()
  const style: CSSProperties = {
    ...base,
    transform: dragging ? `translate3d(${delta.dx}px, ${delta.dy}px, 0)` : undefined,
    // Reduced motion: corner snap is an instant position change, no transition.
    transition: dragging || reducedMotion ? 'none' : undefined,
  }

  return {
    corner,
    style,
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel },
  }
}
