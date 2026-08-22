import type { CSSProperties } from 'react'

/**
 * The overview band's horizontal EKG divider: the site's "living pulse"
 * treatment (FinancialsPage's PulseSpine, 2026-08-17) laid horizontal. The
 * waveform is public/favicon.svg's blip path re-tiled left-to-right -- the
 * brand mark itself, not an invented heartbeat -- and it "breathes" at a
 * rate driven by how many events are live right now, through the exact
 * mapping the financials spine uses for its adoption slider:
 *   share    = min(1, liveNow / 80)
 *   scale    = 0.25 + 0.75 * share
 *   duration = (2.6 - 1.6 * share)s
 * The two custom properties are set once per render; the animation loop is
 * the browser's (AdminShell.css's ashell-pulse-glow keyframes), disabled
 * under prefers-reduced-motion. aria-hidden: decorative only.
 */
export default function PulseDivider({ liveNow }: { liveNow: number | null }) {
  const share = Math.min(1, (liveNow ?? 0) / 80)
  const scale = (0.25 + 0.75 * share).toFixed(2)
  const duration = (2.6 - 1.6 * share).toFixed(2)
  return (
    <div
      className="ashell-pulse-divider"
      aria-hidden="true"
      style={{ '--pulse-scale': scale, '--pulse-duration': `${duration}s` } as CSSProperties}
    >
      <svg preserveAspectRatio="none" focusable="false">
        <defs>
          <pattern id="ashellPulseTile" patternUnits="userSpaceOnUse" width="220" height="26">
            <path d="M0,13 L170,13 L178.6,8.8 L184.3,17.9 L192.9,5.3 L201.4,14.4 L210,13 L220,13" />
          </pattern>
        </defs>
        <rect width="100%" height="26" fill="url(#ashellPulseTile)" />
      </svg>
    </div>
  )
}
