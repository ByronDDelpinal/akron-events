/**
 * ShareButtons.tsx
 *
 * Compact horizontal share row used on event detail pages and
 * category/neighborhood hub pages. Uses the native Web Share API where
 * available, falling back to platform-specific links + copy on desktop.
 *
 * UTM strategy: utm_source = platform key, utm_medium = "share",
 * utm_campaign = the surface that hosted the button.
 *
 * Props:
 *   url      — path-relative URL of the thing being shared.
 *   title    — short descriptor used in pre-filled share text.
 *   text     — optional longer copy for the body of share text.
 *   campaign — optional, defaults to "share"; sets utm_campaign.
 */

import { useCallback, useMemo, useState, type FC, type SVGProps } from 'react'
import { trackEvent, EVENTS } from '@/lib/analytics'
import { SITE } from '@/lib/seo'
import { ShareIcon } from '@/components/icons'
import './ShareButtons.css'

type HrefBuilder = (shareUrl: string, text: string, title: string) => string

interface Platform {
  key: string
  label: string
  href: HrefBuilder
  Icon: FC
}

// Platforms supported in the desktop fallback row. Order matches the visual
// left-to-right layout. `href` is a function so the UTM-tagged URL is built
// at render time.
const PLATFORMS: Platform[] = [
  {
    key: 'twitter',
    label: 'Share on X',
    href: (shareUrl, text) =>
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}` +
      `&text=${encodeURIComponent(text)}`,
    Icon: TwitterIcon,
  },
  {
    key: 'facebook',
    label: 'Share on Facebook',
    href: (shareUrl) =>
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`,
    Icon: FacebookIcon,
  },
  {
    key: 'whatsapp',
    label: 'Share on WhatsApp',
    href: (shareUrl, text) =>
      `https://wa.me/?text=${encodeURIComponent(`${text} ${shareUrl}`)}`,
    Icon: WhatsAppIcon,
  },
  {
    key: 'email',
    label: 'Share by email',
    href: (shareUrl, text, title) =>
      `mailto:?subject=${encodeURIComponent(title)}` +
      `&body=${encodeURIComponent(`${text}\n\n${shareUrl}`)}`,
    Icon: MailIcon,
  },
]

/**
 * Append UTM tags to a fully-qualified URL, preserving any existing query
 * string. Returns the untagged URL if parsing fails.
 */
function tagUrl(absoluteUrl: string, source: string, campaign: string): string {
  try {
    const u = new URL(absoluteUrl)
    u.searchParams.set('utm_source',   source)
    u.searchParams.set('utm_medium',   'share')
    u.searchParams.set('utm_campaign', campaign)
    return u.toString()
  } catch {
    return absoluteUrl
  }
}

interface ShareButtonsProps {
  url: string
  title: string
  text?: string
  campaign?: string
}

export default function ShareButtons({ url, title, text = '', campaign = 'share' }: ShareButtonsProps) {
  const canNativeShare = typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'

  const absoluteUrl = useMemo(() => {
    if (/^https?:\/\//i.test(url)) return url
    const path = url.startsWith('/') ? url : `/${url}`
    return `${SITE.baseUrl}${path}`
  }, [url])

  const shareText = text || title

  const [copied, setCopied] = useState(false)

  // GA4 recommended `share` event. method = channel, content_type = the
  // surface that hosted the button, item_id = the path being shared. This is
  // the only way native Web Share is measurable — its outbound URL never
  // returns through a UTM-tagged visit.
  const trackShare = useCallback((method: string) => {
    trackEvent(EVENTS.SHARE, { method, content_type: campaign, item_id: url })
  }, [campaign, url])

  const onNativeShare = useCallback(async () => {
    try {
      await navigator.share({
        title,
        text: shareText,
        url: tagUrl(absoluteUrl, 'native', campaign),
      })
      trackShare('native')
    } catch {
      // User cancelled or browser threw — no-op.
    }
  }, [title, shareText, absoluteUrl, campaign, trackShare])

  const onCopy = useCallback(async () => {
    const tagged = tagUrl(absoluteUrl, 'copy', campaign)
    trackShare('copy')
    try {
      await navigator.clipboard.writeText(tagged)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Fall back to a synthetic <textarea> + execCommand.
      const ta = document.createElement('textarea')
      ta.value = tagged
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }
  }, [absoluteUrl, campaign, trackShare])

  return (
    <div className="share-buttons" role="group" aria-label="Share this page">
      {canNativeShare ? (
        <button
          type="button"
          className="share-btn share-btn--native"
          onClick={onNativeShare}
          aria-label="Share"
        >
          <ShareIcon />
          <span>Share</span>
        </button>
      ) : (
        <>
          {PLATFORMS.map(({ key, label, href, Icon }) => {
            const tagged = tagUrl(absoluteUrl, key, campaign)
            return (
              <a
                key={key}
                className="share-btn"
                href={href(tagged, shareText, title)}
                target={key === 'email' ? undefined : '_blank'}
                rel="noopener noreferrer"
                aria-label={label}
                title={label}
                onClick={() => trackShare(key)}
              >
                <Icon />
              </a>
            )
          })}
        </>
      )}

      <button
        type="button"
        className={`share-btn${copied ? ' share-btn--copied' : ''}`}
        onClick={onCopy}
        aria-label={copied ? 'Link copied' : 'Copy link'}
        title={copied ? 'Link copied' : 'Copy link'}
      >
        {copied ? <CheckIcon /> : <LinkIcon />}
        <span>{copied ? 'Copied!' : 'Copy link'}</span>
      </button>
    </div>
  )
}

// ── Icon glyphs ──────────────────────────────────────────────────────
const iconProps: SVGProps<SVGSVGElement> = {
  width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true, focusable: false,
}

function TwitterIcon() {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function FacebookIcon() {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none">
      <path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" />
    </svg>
  )
}

function WhatsAppIcon() {
  return (
    <svg {...iconProps} fill="currentColor" stroke="none">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  )
}

function MailIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
