import { useEffect, useState, type RefObject } from 'react'

/**
 * Latching "has this element been near the viewport yet?" hook, extracted for
 * FestivalPage.tsx's deferred venue map (2026-08-20). Five inline
 * IntersectionObserver setups already live in the tree (EventsBrowser, Footer,
 * FinancialsPage, OrganizationDetailPage, CategoryPage); none of them latch or
 * fail open, so this is a new shared primitive rather than a lift of one of
 * them.
 *
 * Once true, always true: the first intersection disconnects the observer, so
 * a consumer that mounts something heavy can never have it unmounted by a
 * later scroll. Initial state is ALWAYS false and IntersectionObserver is
 * never read during render, so the prerendered snapshot is deterministic and
 * hydration cannot mismatch.
 *
 * SSR/prerender-safe, and fails OPEN inside the effect: no
 * IntersectionObserver (old browser, jsdom) reports in view immediately, and
 * so does a framed document, where a sentinel is clipped or unreliable in a
 * cross-origin iframe. /festival/:slug is routed only from src/App.tsx today
 * and src/pages/embed/ carries just EmbedHomePage, so the frame check is cheap
 * insurance against a future embed route rather than a live bug; it mirrors
 * the guarded-browser-API precedent in useMatchMedia.ts. window.self !==
 * window.top is a reference comparison and never throws cross-origin.
 *
 * `force` is a third fail-open, for a consumer that already knows it wants the
 * thing mounted (FestivalPage's desktop breakpoint). It latches without
 * observing at all, which is the point: an observer's FIRST record can already
 * report false if something scrolled the element away before it was delivered
 * (App.tsx's POP restore jumps inside a rAF, and rAF callbacks run before
 * intersection observations are updated), so a latch that depends on that
 * record is not a latch.
 *
 * Requires the observed element to be mounted in the same commit that turns
 * `enabled` on -- see the note at the null check.
 */
export function useInViewOnce(
  ref: RefObject<Element | null>,
  opts?: { rootMargin?: string; enabled?: boolean; force?: boolean },
): boolean {
  const [inView, setInView] = useState(false)
  const rootMargin = opts?.rootMargin ?? '200px 0px'
  const enabled = opts?.enabled ?? true
  const force = opts?.force ?? false

  useEffect(() => {
    if (!enabled) return
    if (inView) return
    if (force) {
      setInView(true)
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    if (typeof window !== 'undefined' && window.self !== window.top) {
      setInView(true)
      return
    }
    // Invariant: a consumer that passes `enabled` must have the observed
    // element in the SAME commit. FestivalPage satisfies it -- `enabled` is
    // pins.length > 0, while the wrapper carrying the ref renders whenever
    // loading || pins.length > 0, a strictly weaker condition. If a future
    // consumer attaches its ref a commit later, this returns and never retries
    // (nothing in the deps can change to bring it back). Deliberately NOT
    // fail-open here: reporting "in view" for an element we never saw would
    // silently mount the very thing the consumer is deferring.
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setInView(true)
        obs.disconnect()
      },
      { rootMargin, threshold: 0 },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [ref, rootMargin, enabled, force, inView])

  return inView
}
