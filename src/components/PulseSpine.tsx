import type { CSSProperties } from 'react'
import './PulseSpine.css'

/**
 * The pulse spine ("living pulse" redesign, 2026-08-17; extracted from
 * FinancialsPage.tsx into its own component when /friends adopted the same
 * open-books chrome): a continuous vertical EKG line threading .fin-body's
 * left gutter from just below the hero to the footer. The waveform is the
 * site's own brand mark, not an invented heartbeat shape (house rule:
 * visuals use our brand assets) - it is public/favicon.svg's blip path
 * itself, `M 5 16 L 11 16 L 14 10 L 16 23 L 19 5 L 22 18 L 25 16 L 27 16`,
 * the same EKG line every favicon size and the nav/footer logo draw,
 * re-plotted running top-to-bottom instead of left-to-right: the favicon's
 * horizontal traversal (x) becomes the spine's vertical traversal, and its
 * vertical deflection (y - 16, the favicon's own baseline) becomes the
 * spine's horizontal deflection, scaled up into the 48px column. Tiled via
 * an SVG <pattern> (PulseSpine.css) so it repeats at a fixed cadence for
 * any page length, with no JS height measurement.
 *
 * The line "breathes": amplitude and rate both track `intensity` via the
 * --pulse-scale / --pulse-duration custom properties, weak and slow near
 * 0, strong and fast near 1, through one CSS @keyframes animation
 * (PulseSpine.css's fin-pulse-glow). No requestAnimationFrame and no
 * per-frame React render: the two properties are set once per prop change,
 * exactly like every other derived value on /financials - the animation
 * loop itself is the browser's, not ours.
 *
 * `intensity` defaults to a fixed 0.6 (a calm middle value) for callers
 * with nothing live to drive it - /friends and /friends/thank-you render
 * `<PulseSpine />` bare. /financials passes its adoption slider's share
 * (`intensity={adoptionShare}`), so the same mark that breathes gently on
 * every other open-books page visibly quickens there as the reader drags
 * the slider toward full county adoption.
 *
 * aria-hidden and presentational only: a decorative brand mark, never
 * content a crawler or a screen reader needs. Hidden entirely below 1200px
 * (PulseSpine.css) so it never competes with the 960px content column for
 * room.
 */
export default function PulseSpine({ intensity = 0.6 }: { intensity?: number }) {
  const pulseScale = 0.25 + 0.75 * intensity
  const pulseDuration = (2.6 - 1.6 * intensity).toFixed(2)
  return (
    <svg
      className="fin-pulse-spine"
      aria-hidden="true"
      focusable="false"
      style={{ '--pulse-scale': pulseScale, '--pulse-duration': `${pulseDuration}s` } as CSSProperties}
    >
      <defs>
        <pattern id="finPulseTile" patternUnits="userSpaceOnUse" width="48" height="220">
          <path d="M24 0 L24 170 L16.2 178.6 L33.1 184.3 L9.7 192.9 L26.6 201.4 L24 210 L24 220" />
        </pattern>
      </defs>
      <rect width="48" height="100%" fill="url(#finPulseTile)" />
    </svg>
  )
}
