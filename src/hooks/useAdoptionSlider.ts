import { useEffect, useRef, useState } from 'react'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { ImpactCalcPlacement } from '@/lib/analyticsEvents'
import {
  DEFAULT_ADOPTION_PERCENT,
  SLIDER_SETTLE_MS,
  adoptionValueText,
} from '@/lib/financials'

/**
 * The adoption slider's state and analytics, shared by /financials (the full
 * calculator plus its docked twin) and /friends (the simpler cousin).
 *
 * One integer percent, floored at Today; the share as a fraction; and the
 * two handlers every control on the page must go through:
 *   - onSlide  (range input): debounced, one impact_calc_adjusted per
 *                SETTLED position, never one per tick of a drag
 *   - onPreset (pill): immediate, and it cancels any pending slide hit so a
 *                drag-then-click never fires twice for one exploration
 * Both drive the SAME state, so on /financials the in-section slider, the
 * preset pills, and the docked slider share one settle timer instead of
 * owning competing ones ("living pulse" redesign, 2026-08-17; extracted
 * from FinancialsPage 2026-09-02 when /friends grew the same controls).
 *
 * `placement` tags the analytics hit with which page fired it: one event,
 * one funnel, a dimension to split it.
 */
export function useAdoptionSlider(placement: ImpactCalcPlacement) {
  const [percent, setPercent] = useState(DEFAULT_ADOPTION_PERCENT)
  const settleTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  const onSlide = (next: number) => {
    setPercent(next)
    window.clearTimeout(settleTimer.current)
    settleTimer.current = window.setTimeout(() => {
      trackEvent(EVENTS.IMPACT_CALC_ADJUSTED, { percent: next, via: 'slider', placement })
    }, SLIDER_SETTLE_MS)
  }

  const onPreset = (next: number) => {
    window.clearTimeout(settleTimer.current)
    setPercent(next)
    trackEvent(EVENTS.IMPACT_CALC_ADJUSTED, { percent: next, via: 'preset', placement })
  }

  return {
    percent,
    share: percent / 100,
    /** aria-valuetext, one wording for every adoption slider on the site. */
    valueText: adoptionValueText(percent),
    onSlide,
    onPreset,
  }
}
