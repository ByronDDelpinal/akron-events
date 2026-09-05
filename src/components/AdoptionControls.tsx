import { forwardRef } from 'react'
import { ADOPTION_PRESETS, SLIDER_MIN_PERCENT } from '@/lib/financials'

/**
 * The adoption slider row plus its preset pills, rendered identically on
 * /financials (inside ImpactCalculator) and /friends. Presentational only:
 * state and analytics live in useAdoptionSlider, so this component cannot
 * fire an event or hold a position of its own. Styles are the shared
 * .fin-calc__slider-row / __presets rules in src/styles/openbooks.css.
 *
 * forwardRef lands on the SLIDER ROW, not the wrapper: FinancialsPage's
 * IntersectionObserver watches the actual control to decide when its docked
 * twin should appear (see that page's dockVisible comment).
 */
const AdoptionControls = forwardRef<HTMLDivElement, {
  /** id for the range input, so each page's <label> pairs with its own control. */
  id: string
  label: string
  percent: number
  valueText: string
  onSlide: (next: number) => void
  onPreset: (next: number) => void
}>(function AdoptionControls({ id, label, percent, valueText, onSlide, onPreset }, ref) {
  return (
    <>
      <div className="fin-calc__slider-row" ref={ref}>
        <label className="fin-calc__label" htmlFor={id}>{label}</label>
        <input
          id={id}
          className="fin-calc__slider"
          type="range"
          min={SLIDER_MIN_PERCENT}
          max={100}
          step={1}
          value={percent}
          onChange={(e) => onSlide(Number(e.target.value))}
          aria-valuetext={valueText}
        />
        <span className="fin-calc__pct" aria-hidden="true">{percent}%</span>
      </div>

      <div className="fin-calc__presets" role="group" aria-label="Sourced adoption comparisons">
        {ADOPTION_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className="fin-calc__preset"
            aria-pressed={percent === p.percent}
            onClick={() => onPreset(p.percent)}
          >
            {p.label} · {p.percent}%
          </button>
        ))}
      </div>
    </>
  )
})

export default AdoptionControls
