/**
 * PartnerShareDialog — the Tier 0 share kit.
 *
 * A partner cannot create a Facebook Event through any API, so this hands
 * them the two things they would otherwise make by hand: a finished image
 * at the right size for the surface they are posting to, and a finished
 * caption written for that surface. Two clicks and a paste.
 *
 * A DIALOG rather than a section inside the drawer, because the drawer is
 * capped at 320px with its own scroll and a card preview plus a caption box
 * does not fit in it without turning the whole drawer into a scroll well.
 *
 * Every image comes from /api/og/event/[id]?size=..., which already renders
 * the branded card and is already edge-cached. Nothing is generated here.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useTheme } from '@/hooks/useTheme'
import {
  DEFAULT_SIZE, FACEBOOK_EVENT_CREATE_URL, FACEBOOK_HINT, INSTAGRAM_HINT,
  SHARE_SIZES, SHARE_TITLE, SIZE_DIMENSIONS, SIZE_LABELS,
  COPIED_TOAST, COPY_FAILED_TOAST, DOWNLOAD_FAILED_TOAST, IMAGE_FAILED_NOTE,
  captionFor, facebookSharerUrl, shareImagePath,
  type ShareEvent, type ShareSize, type ShareTarget,
} from '@/lib/admin/shareShared'

interface PartnerShareDialogProps {
  ev: ShareEvent
  onClose: () => void
  showToast: (message: string) => void
}

export default function PartnerShareDialog({ ev, onClose, showToast }: PartnerShareDialogProps) {
  const [target, setTarget] = useState<ShareTarget>('facebook')
  const [size, setSize] = useState<ShareSize>(DEFAULT_SIZE.facebook)
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Dialog conventions, matching ConfirmDialog: focus in on mount, Escape
  // closes. Capture phase so the drawer's own Escape handler underneath
  // does not also fire and collapse the row behind the dialog.
  useEffect(() => {
    cardRef.current?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Switching target resets the size to that target's default: Facebook
  // posts a link and needs no download, Instagram needs the square.
  const pickTarget = (next: ShareTarget) => {
    setTarget(next)
    setSize(DEFAULT_SIZE[next])
  }

  const caption = useMemo(() => captionFor(ev, target), [ev, target])
  // The card follows the palette this person has chosen for Akron Pulse. The
  // admin shell renders dark whatever the theme is, but the theme itself is
  // still their choice and it is what their audience associates with them.
  const [theme] = useTheme()
  const imgSrc = useMemo(() => shareImagePath(ev.id, size, theme), [ev.id, size, theme])
  const dims = SIZE_DIMENSIONS[size]

  // The card is rendered on demand by /api/og and can take a second, or fail.
  // Without a state for both, a slow or broken card is an empty frame that
  // says nothing, which is indistinguishable from "this feature is broken".
  const [imgState, setImgState] = useState<'loading' | 'ready' | 'failed'>('loading')
  useEffect(() => { setImgState('loading') }, [imgSrc])

  const copyCaption = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(caption)
      showToast(COPIED_TOAST)
    } catch {
      // Clipboard is permission-gated and fails silently in some contexts.
      // Never claim a copy that did not happen.
      showToast(COPY_FAILED_TOAST)
    }
  }, [caption, showToast])

  /**
   * Download, or on a phone hand the file straight to the OS share sheet so
   * Instagram appears in it. navigator.share with files is the only route
   * into the Instagram composer that does not require a Meta app.
   */
  const takeImage = useCallback(async () => {
    setBusy(true)
    try {
      const resp = await fetch(imgSrc)
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const filename = `${ev.id}-${size}.png`
      const file = new File([blob], filename, { type: blob.type || 'image/png' })

      if (navigator.canShare?.({ files: [file] }) && typeof navigator.share === 'function') {
        await navigator.share({ files: [file], title: ev.title })
        return
      }

      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoked on the next tick, not in this one. Some browsers read the
      // object URL asynchronously after the click and cancel the download if
      // it has already been revoked; the leak from waiting a tick is nothing.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (err) {
      // An abort is the user closing the OS share sheet, which is not a
      // failure and must not be reported as one.
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        showToast(DOWNLOAD_FAILED_TOAST)
      }
    } finally {
      setBusy(false)
    }
  }, [imgSrc, ev.id, ev.title, size, showToast])

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div
        className="ashell-share-card"
        role="dialog"
        aria-modal="true"
        aria-label={SHARE_TITLE}
        tabIndex={-1}
        ref={cardRef}
        onClick={(e: MouseEvent) => e.stopPropagation()}
      >
        <div className="ashell-share-hd">
          <h3>{SHARE_TITLE}</h3>
          <span className="ashell-share-ev">{ev.title}</span>
          <button
            type="button"
            className="ashell-share-x"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="ashell-share-body">
          <div className="ashell-an-win" role="group" aria-label="Where you are posting">
            <button
              type="button"
              className={`ashell-an-winbtn ${target === 'facebook' ? 'ashell-an-winbtn--on' : ''}`}
              aria-pressed={target === 'facebook'}
              onClick={() => pickTarget('facebook')}
            >
              Facebook
            </button>
            <button
              type="button"
              className={`ashell-an-winbtn ${target === 'instagram' ? 'ashell-an-winbtn--on' : ''}`}
              aria-pressed={target === 'instagram'}
              onClick={() => pickTarget('instagram')}
            >
              Instagram
            </button>
          </div>

          <div className="ashell-share-split">
            <div className="ashell-share-prev">
              <div className={`ashell-share-frame ashell-share-frame--${size}`}>
                {/* Keyed on the src so switching size swaps the element
                    rather than repainting the old bitmap under a new
                    aspect ratio for a frame. */}
                {imgState !== 'failed' && (
                  <img
                    key={imgSrc}
                    src={imgSrc}
                    alt={`${ev.title} share card, ${dims.w} by ${dims.h}`}
                    onLoad={() => setImgState('ready')}
                    onError={() => setImgState('failed')}
                  />
                )}
                {imgState === 'loading' && (
                  <span className="ashell-share-frame-msg" role="status">Building the card…</span>
                )}
                {imgState === 'failed' && (
                  <span className="ashell-share-frame-msg" role="alert">{IMAGE_FAILED_NOTE}</span>
                )}
              </div>
              <div className="ashell-an-win" role="group" aria-label="Image size">
                {SHARE_SIZES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`ashell-an-winbtn ${s === size ? 'ashell-an-winbtn--on' : ''}`}
                    aria-pressed={s === size}
                    onClick={() => setSize(s)}
                  >
                    {SIZE_LABELS[s]}
                  </button>
                ))}
              </div>
              <span className="ashell-share-dims">{dims.w} × {dims.h}</span>
            </div>

            <div className="ashell-share-cap">
              <div className="ashell-share-cap-hd">
                <span className="ashell-share-lbl">Caption</span>
                <span className="ashell-share-note">
                  {target === 'facebook' ? 'link included' : 'no link, Instagram strips them'}
                </span>
              </div>
              {/* readOnly, but selectable and select-all on focus: the
                  caption is regenerated whenever the target changes, so an
                  edit made here would vanish on the next tab click without
                  saying so. Editing belongs in the composer they paste into. */}
              <textarea
                className="ashell-share-text"
                value={caption}
                readOnly
                rows={9}
                aria-label="Caption to copy"
                onFocus={(e) => e.currentTarget.select()}
              />

              {/* The primary follows the target, because the post is a
                  different object on each one. On Facebook the URL is the
                  post and the card comes from the page, so the caption is the
                  thing to take; on Instagram the IMAGE is the post and a
                  caption without it is nothing to publish. */}
              <div className="ashell-share-acts">
                <button
                  type="button"
                  className={`ashell-btn ${target === 'facebook' ? 'ashell-btn--primary' : ''}`}
                  onClick={copyCaption}
                >
                  Copy caption
                </button>
                <button
                  type="button"
                  className={`ashell-btn ${target === 'instagram' ? 'ashell-btn--primary' : ''}`}
                  onClick={takeImage}
                  disabled={busy || imgState === 'failed'}
                >
                  {busy ? 'Working…' : 'Download image'}
                </button>
              </div>

              {target === 'facebook' && (
                <div className="ashell-share-links">
                  <a
                    className="ashell-edit-link"
                    href={facebookSharerUrl(ev.path)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Post to Facebook →
                  </a>
                  <a
                    className="ashell-edit-link"
                    href={FACEBOOK_EVENT_CREATE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Create a Facebook event →
                  </a>
                </div>
              )}

              <p className="ashell-share-hint">
                {target === 'facebook' ? FACEBOOK_HINT : INSTAGRAM_HINT}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
