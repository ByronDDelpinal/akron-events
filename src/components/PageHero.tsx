import { useCallback, useEffect, useState, type ReactNode } from 'react'
import './PageHero.css'

interface PageHeroMedia {
  /**
   * Deferred background video (mp4). Mounts after window load on any viewport
   * width. Omit for a static image-only hero (the poster alone).
   */
  videoSrc?: string
  /** First frame of the video, shown from first paint until the video mounts. */
  posterSrc: string
}

interface PageHeroProps {
  /** Small uppercase kicker above the title (optional). */
  eyebrow?: ReactNode
  /** The h1. May include a <span> to highlight part of it. */
  title: ReactNode
  /** Subtitle / description (optional). May include links. */
  children?: ReactNode
  /**
   * Optional background video + poster. Follows the homepage hero playbook:
   * the poster paints immediately and the video element only mounts after the
   * window `load` event. Eligibility is checked at unlock time (not mount) so
   * an SSR/hydration mismatch is impossible.
   */
  media?: PageHeroMedia
}

/**
 * Deliberately looser than the homepage hero gate (HomePage.tsx), which is
 * desktop-only: these page heroes carry a much smaller file and the homepage's
 * mobile-payload concern doesn't apply, so phones get the video too. The
 * accessibility and data-cost opt-outs still hold.
 */
function isVideoEligible(): boolean {
  type NetInfo = { saveData?: boolean }
  const conn = (navigator as Navigator & { connection?: NetInfo }).connection
  return (
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    !conn?.saveData
  )
}

/**
 * PageHero — the one standardized page header.
 *
 * A full-bleed dark band with a centered eyebrow / title / subtitle, used by
 * every content page (Organizers, Embed Builder, Venues, About, Organizations,
 * Technical) so headers sit in the same place with the same treatment instead
 * of each page rolling its own slightly-different hero.
 *
 * With `media`, the band grows to match the homepage hero and plays a muted
 * looping background video behind a dark scrim.
 */
export default function PageHero({ eyebrow, title, children, media }: PageHeroProps) {
  const [videoUnlocked, setVideoUnlocked] = useState(false)

  const unlock = useCallback(() => {
    if (isVideoEligible()) setVideoUnlocked(true)
  }, [])

  // Depend on the URL string, not the `media` object: callers pass an inline
  // object literal, so a new reference every render would re-run this effect
  // and cancel the pending unlock frame each time.
  const videoSrc = media?.videoSrc
  useEffect(() => {
    if (!videoSrc) return
    // Defer past the initial page load (same intent as the homepage, which
    // waits for the first page of events) so the video never competes with
    // first-paint resources.
    if (document.readyState === 'complete') {
      const id = requestAnimationFrame(unlock)
      return () => cancelAnimationFrame(id)
    }
    window.addEventListener('load', unlock, { once: true })
    return () => window.removeEventListener('load', unlock)
  }, [videoSrc, unlock])

  return (
    <header className={`page-hero${media ? ' page-hero--media' : ''}`}>
      {media && (
        <div className="page-hero-bg" aria-hidden="true">
          <div
            className="page-hero-bg-poster"
            style={{ backgroundImage: `url(${media.posterSrc})` }}
          />
          {media.videoSrc && videoUnlocked && (
            <video
              className="page-hero-bg-video"
              autoPlay
              muted
              loop
              playsInline
              disablePictureInPicture
              src={media.videoSrc}
            />
          )}
          <div className="page-hero-bg-scrim" />
        </div>
      )}
      <div className="page-hero-inner">
        {eyebrow && <p className="page-hero-eyebrow">{eyebrow}</p>}
        <h1 className="page-hero-title">{title}</h1>
        {children && <p className="page-hero-sub">{children}</p>}
      </div>
    </header>
  )
}
