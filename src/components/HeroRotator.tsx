import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './HeroRotator.css'

// Keep in lockstep with --hero-rot-dur in HeroRotator.css: JS commits the swap
// when the CSS roll finishes.
const ROT_MS = 650

interface HeroRotatorProps {
  /** Words to cycle through; words[0] is shown first and on every SSR/first paint. */
  words: string[]
  /** How long each word stays before the next rolls in. */
  intervalMs?: number
}

/** A random index in [0, n) that isn't `current`, so a word never repeats back to back. */
function randomOtherIndex(current: number, n: number): number {
  if (n <= 1) return current
  let r = current
  while (r === current) r = Math.floor(Math.random() * n)
  return r
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * HeroRotator — cycles a single word in place with a vertical "roll": the
 * current word slides up and out while the next slides in from below, and the
 * box width animates to the new word so trailing punctuation glides along.
 *
 * Decorative by design: it's wrapped in aria-hidden and the parent <h1> carries
 * a stable aria-label, so assistive tech and crawlers always read one clean
 * heading regardless of which word is on screen.
 */
export default function HeroRotator({ words, intervalMs = 3000 }: HeroRotatorProps) {
  const reduced = usePrefersReducedMotion()
  const [index, setIndex] = useState(0)
  const [incoming, setIncoming] = useState<number | null>(null)

  // Latest index for the interval closure without re-arming the timer.
  const indexRef = useRef(0)
  indexRef.current = index

  const animating = incoming !== null
  const target = incoming ?? index

  // ── Width morph: measure the target word off-screen and size the box to it.
  const measureRef = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const measure = () => {
      if (measureRef.current) setWidth(measureRef.current.getBoundingClientRect().width)
    }
    measure()
    // Web font swap / responsive font-size changes the measured width.
    window.addEventListener('resize', measure)
    let cancelled = false
    document.fonts?.ready.then(() => { if (!cancelled) measure() })
    return () => { cancelled = true; window.removeEventListener('resize', measure) }
  }, [target, words])

  // ── Advance every intervalMs.
  useEffect(() => {
    if (words.length <= 1) return
    const id = setInterval(() => {
      if (document.hidden) return // don't churn while backgrounded
      const next = randomOtherIndex(indexRef.current, words.length)
      if (reduced) setIndex(next)       // honor reduced-motion: instant swap
      else setIncoming(next)            // otherwise kick off the roll
    }, intervalMs)
    return () => clearInterval(id)
  }, [words.length, intervalMs, reduced])

  // ── Commit the roll once the CSS animation has played.
  useEffect(() => {
    if (incoming === null) return
    const id = setTimeout(() => {
      setIndex(incoming)
      setIncoming(null)
    }, ROT_MS)
    return () => clearTimeout(id)
  }, [incoming])

  return (
    <span
      className="hero-rotator"
      aria-hidden="true"
      style={width != null ? { width: `${width}px` } : undefined}
    >
      <span className={`hero-rotator__word hero-rotator__word--current${animating ? ' is-out' : ''}`}>
        {words[index]}
      </span>
      {animating && (
        <span className="hero-rotator__word hero-rotator__word--incoming">
          {words[incoming]}
        </span>
      )}
      {/* Off-screen sizer drives the width transition. */}
      <span ref={measureRef} className="hero-rotator__measure">{words[target]}</span>
    </span>
  )
}
