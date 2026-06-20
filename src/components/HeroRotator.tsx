import { useEffect, useRef, useState } from 'react'
import './HeroRotator.css'

// Keep in lockstep with --hero-rot-dur in HeroRotator.css.
const ROT_MS = 950

interface HeroRotatorProps {
  /** Words to cycle through; words[0] is shown first and on every SSR/first paint. */
  words: string[]
  /** How long each word stays before the next rolls in. */
  intervalMs?: number
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

/** A random index in [0, n) that isn't `current`, so a word never repeats back to back. */
function randomOtherIndex(current: number, n: number): number {
  if (n <= 1) return current
  let r = current
  while (r === current) r = Math.floor(Math.random() * n)
  return r
}

/**
 * HeroRotator — cycles a single word in place with a vertical "roll": the new
 * word rolls up into view while the old one rolls up and out.
 *
 * Layout-safe by construction: the *current* word is the only in-flow element,
 * so the box is always exactly the current word's width — there's no animated
 * width and nothing that can push the page wider or jitter at small sizes. The
 * outgoing word is an absolutely-positioned overlay (zero layout footprint),
 * clipped by the box. The parent `.hero h1` also has `overflow: hidden` as a
 * hard guard. Decorative: wrapped in aria-hidden, parent <h1> carries the label.
 */
export default function HeroRotator({ words, intervalMs = 3000 }: HeroRotatorProps) {
  const reduced = usePrefersReducedMotion()
  const [index, setIndex] = useState(0)
  const [outgoing, setOutgoing] = useState<number | null>(null)

  const indexRef = useRef(index)
  indexRef.current = index

  useEffect(() => {
    if (words.length <= 1) return
    const id = setInterval(() => {
      if (document.hidden) return // don't churn while backgrounded
      const next = randomOtherIndex(indexRef.current, words.length)
      if (reduced) {
        setIndex(next) // reduced-motion: instant swap, no roll
        return
      }
      setOutgoing(indexRef.current) // old word rolls out (overlay)
      setIndex(next)                // new word becomes current (in-flow)
    }, intervalMs)
    return () => clearInterval(id)
  }, [words.length, intervalMs, reduced])

  useEffect(() => {
    if (outgoing === null) return
    const id = setTimeout(() => setOutgoing(null), ROT_MS)
    return () => clearTimeout(id)
  }, [outgoing])

  const animating = outgoing !== null

  return (
    <span className="hero-rotator" aria-hidden="true">
      <span
        key={index}
        className={`hero-rotator__word hero-rotator__word--current${animating ? ' is-in' : ''}`}
      >
        {words[index]}
      </span>
      {animating && (
        <span key={`out-${outgoing}`} className="hero-rotator__word hero-rotator__word--outgoing">
          {words[outgoing]}
        </span>
      )}
    </span>
  )
}
