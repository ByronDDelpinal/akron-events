import { useEffect, useRef, useState } from 'react'
import { trackEvent } from '@/lib/analytics'
import { EVENTS } from '@/lib/analyticsEvents'
import './VideoFacade.css'

interface VideoFacadeProps {
  /** YouTube id. Null until the video for this guide exists. */
  youtubeId: string | null
  /** Poster frame shown before the click. Null until the video exists. */
  posterSrc: string | null
  /** Video title, used as the accessible name and the iframe title. */
  title: string
  /** Which guide this player belongs to, for analytics. */
  guideSlug: string
}

/**
 * VideoFacade — a poster and a play button, and nothing else, until somebody
 * clicks.
 *
 * A plain YouTube iframe pulls roughly half a megabyte of third-party
 * JavaScript on load and hands the page's performance to a domain we do not
 * control. On a guide page, where most visitors read the steps and never hit
 * play, that cost buys nothing. So we render an image, and only build the
 * iframe on the click that actually asks for it. No preconnect, no
 * dns-prefetch, no preload: any of those would put the request back on the
 * critical path and undo the whole point.
 *
 * With no youtubeId (which is every guide today) it renders a static, NON
 * focusable placeholder. Not a disabled button: a dead tab stop repeated on
 * ten pages is a real accessibility problem, and there is nothing here for a
 * keyboard user to do yet.
 *
 * The poster and the iframe both reserve 16:9, so swapping one for the other
 * shifts nothing on the page. The pending state deliberately does not: it holds
 * text, and a 16:9 box clips that on a narrow screen (see VideoFacade.css).
 */
export default function VideoFacade({ youtubeId, posterSrc, title, guideSlug }: VideoFacadeProps) {
  const [playing, setPlaying] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // The click unmounts the button, so without this a keyboard user who pressed
  // Enter loses focus to <body> and has to tab back through the whole page to
  // reach the player they just started.
  useEffect(() => {
    if (playing) frameRef.current?.focus()
  }, [playing])

  if (!youtubeId) {
    return (
      <div className="video-facade video-facade--pending">
        <p className="video-facade-pending-text">
          The video for this one is not shot yet. The written walkthrough below is the
          whole thing, not a summary of it.
        </p>
      </div>
    )
  }

  if (playing) {
    return (
      <div className="video-facade">
        <iframe
          ref={frameRef}
          className="video-facade-frame"
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1`}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
        />
      </div>
    )
  }

  return (
    <button
      type="button"
      className="video-facade video-facade--poster"
      style={posterSrc ? { backgroundImage: `url(${posterSrc})` } : undefined}
      aria-label={`Play video: ${title}`}
      onClick={() => {
        setPlaying(true)
        trackEvent(EVENTS.GUIDE_VIDEO_PLAY, { guide_slug: guideSlug })
      }}
    >
      <span className="video-facade-play" aria-hidden="true">
        <svg viewBox="0 0 68 48" width="68" height="48" focusable="false">
          <path
            className="video-facade-play-bg"
            d="M66.5 7.7c-.8-2.9-2.5-5.4-5.4-6.2C55.8.1 34 0 34 0S12.2.1 6.9 1.5C4 2.3 2.3 4.8 1.5 7.7 0 13 0 24 0 24s0 11 1.5 16.3c.8 2.9 2.5 5.4 5.4 6.2C12.2 47.9 34 48 34 48s21.8-.1 27.1-1.5c2.9-.8 4.6-3.3 5.4-6.2C68 35 68 24 68 24s0-11-1.5-16.3z"
          />
          <path className="video-facade-play-arrow" d="M45 24 27 14v20" />
        </svg>
      </span>
    </button>
  )
}
