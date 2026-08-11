import { useEffect, useId, useRef, useState } from 'react'
import { WHEN_PRESETS, buildDateRangeLabel } from '@/lib/filterOptions'
// FilterTray.css supplies the base .tray-chip / .tray-chips / .tray-section-hint
// / .tray-date-* rules this component reuses (see WhenSection.css's header
// comment). Imported HERE, not left to each caller, because CategoryPage's hub
// filter strip mounts this component WITHOUT otherwise loading FilterTray.css —
// a plain global CSS import is idempotent, so FilterTray also importing it is
// harmless.
import '@/components/FilterTray.css'
import './WhenSection.css'
import { deriveWhen, TIME_OF_DAY_OPTIONS, type TimeOfDayId, type WhenAction } from '@/lib/whenFilter'
import { easternTodayIso } from '@/lib/easternDate'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { WhenPreset, TimeOfDay } from '@/lib/analyticsEvents'

// Re-exported so consumers only need one import site for the component + its action type.
export type { WhenAction }

export interface WhenSectionProps {
  /** Effective values — NOT read from useSearchParams by this component. Hub
   * pages resolve their date from the registry (nothing in the query
   * string); embeds have it locked. See docs/when-filter.md §1.5. */
  dateRange: string | null
  dateFrom: string | null
  dateTo: string | null
  timeOfDay: TimeOfDayId | null
  onWhenChange: (action: WhenAction) => void
  onTimeOfDayChange: (id: TimeOfDayId | null) => void
  /** lockedDimensions.dateRange — hub pages and embeds with a preset date. */
  locked?: boolean
  /** Chip text for the locked preset, e.g. "This weekend". Required when locked. */
  lockLabel?: string | null
  /** Which surface is presenting the lock, for the hint copy. */
  lockContext?: 'hub' | 'embed'
  /** Distinguishes multiple mounts (tray vs. hub strip) so radio `name`/`id`
   * never collide if both ever render in the same document. */
  idPrefix?: string
}

/**
 * WhenSection — the single date-preset + custom-range + time-of-day control,
 * shared by FilterTray (the homepage tray) and CategoryPage's hub filter
 * strip (via HubFilterSection). Previously the hub strip had its own bare
 * From/To inputs with no preset chips at all, and the tray had a separate
 * "Custom date range" section with no relationship to a preset row — this
 * replaces both with one component so there is exactly one date control in
 * the product (docs/when-filter.md §4).
 */
export default function WhenSection({
  dateRange,
  dateFrom,
  dateTo,
  timeOfDay,
  onWhenChange,
  onTimeOfDayChange,
  locked = false,
  lockLabel = null,
  lockContext = 'hub',
  idPrefix,
}: WhenSectionProps) {
  const autoId = useId()
  const prefix = idPrefix ?? autoId
  const radioName = `when-${prefix}`

  const derived = deriveWhen({ dateRange, dateFrom, dateTo })
  const derivedToken = derived.kind === 'preset' ? (derived.id as string) : derived.kind === 'custom' ? 'custom' : 'any'

  // Whether the "Pick dates" disclosure panel is open. It opens the instant
  // the user selects the "Pick dates" radio, before any from/to param exists
  // — so it can't be derived from props alone. It also stays open (rather
  // than snapping back to "Any time") if the user clears both dates from
  // inside it; only picking a DIFFERENT chip closes it. Kept in sync with
  // props so a cold load of `?from=&to=` opens the panel too, and so an
  // external navigation (browser back/forward) that lands on a DIFFERENT
  // preset closes it. Deliberately does NOT force-close when props settle on
  // 'any' with the panel already open — that is exactly what "clear dates"
  // (clearRangeStayInPanel below) produces, and it must stay open through
  // that specific transition per §7.3's "back to the Pick dates radio".
  const [manualPanelOpen, setManualPanelOpen] = useState(derivedToken === 'custom')
  useEffect(() => {
    if (derivedToken === 'custom') setManualPanelOpen(true)
    else if (derivedToken !== 'any') setManualPanelOpen(false)
  }, [derivedToken])
  const panelOpen = manualPanelOpen || derivedToken === 'custom'
  const selectedToken = panelOpen ? 'custom' : derivedToken

  const fromInputRef = useRef<HTMLInputElement>(null)
  const pickDatesRadioRef = useRef<HTMLInputElement>(null)

  // Ghost: `this_week` has no chip in the offered row (docs/when-filter.md
  // §1.4) — it is appended, selected, ONLY when it is already the active
  // value, so an old partner embed's `date=this_week` still reads correctly
  // and nobody can select it fresh. Do not add it to the mapped list below.
  const offeredPresets = WHEN_PRESETS.filter((p) => !p.ghost)
  const ghostActive = derivedToken === 'this_week'
    ? WHEN_PRESETS.find((p) => p.id === 'this_week') ?? null
    : null

  function selectPreset(id: string) {
    setManualPanelOpen(false)
    onWhenChange({ type: 'preset', id })
    fireWhenFilter({ preset: id as WhenPreset, timeOfDay, changed: 'preset' })
  }

  function selectAnyTime() {
    setManualPanelOpen(false)
    onWhenChange({ type: 'clear' })
    fireWhenFilter({ preset: 'any', timeOfDay, changed: 'preset' })
  }

  function openPickDates() {
    setManualPanelOpen(true)
    // Focus follows the disclosure per §7.3 — the move IS the announcement
    // that the panel opened.
    requestAnimationFrame(() => fromInputRef.current?.focus())
  }

  function commitRange(nextFrom: string | null, nextTo: string | null) {
    onWhenChange({ type: 'range', from: nextFrom, to: nextTo })
    const spanDays = nextFrom && nextTo ? inclusiveDaySpan(nextFrom, nextTo) : 0
    fireWhenFilter({ preset: 'custom', timeOfDay, changed: 'range', spanDays })
  }

  function clearRangeStayInPanel() {
    onWhenChange({ type: 'range', from: null, to: null })
    setManualPanelOpen(true)
    pickDatesRadioRef.current?.focus()
  }

  function toggleTimeOfDay(id: TimeOfDayId) {
    const next = timeOfDay === id ? null : id
    onTimeOfDayChange(next)
    const preset = derived.kind === 'preset' ? (derived.id as WhenPreset) : derived.kind === 'custom' ? 'custom' : 'any'
    fireWhenFilter({ preset, timeOfDay: next, changed: 'time_of_day' })
  }

  function fireWhenFilter(args: { preset: WhenPreset; timeOfDay: TimeOfDayId | null; changed: 'preset' | 'range' | 'time_of_day'; spanDays?: number }) {
    trackEvent(EVENTS.WHEN_FILTER, {
      preset: args.preset,
      time_of_day: (args.timeOfDay ?? 'none') as TimeOfDay,
      changed: args.changed,
      span_days: args.spanDays ?? 0,
    })
  }

  const todayIso = easternTodayIso()

  return (
    <div className="when-section">
      {locked ? (
        // Inert, not a control: a plain non-focusable span, not a disabled
        // fieldset of radios — there is nothing here to group or navigate.
        // Renders visible-but-unchangeable per docs/when-filter.md §5 ("reflect,
        // don't fight"): a locked date used to hide this whole section, which
        // left an embed/hub tray silently unable to answer "why am I only
        // seeing weekend events?".
        <div className="when-locked">
          <div className="tray-chips">
            <span className="tray-chip active when-chip--locked" aria-disabled="true">
              {lockLabel ?? 'Set date'}
            </span>
          </div>
          <p className="tray-section-hint">
            {lockContext === 'embed' ? 'Set by the site showing this calendar' : 'Set by this page'}
          </p>
        </div>
      ) : (
        <>
          {/* A real radio group via native inputs, not aria-pressed buttons —
              seven mutually-exclusive options (including "Any time") read as
              noise with aria-pressed announced six times, and native radios
              give arrow-key navigation, single-tab-stop roving focus, and
              checked-state announcement for free. The rest of this tray uses
              aria-pressed buttons because THOSE are independent toggles
              (categories) or an off-able single-select (price) — different
              semantics, hence the mixed pattern. */}
          <fieldset className="when-fieldset">
            <legend className="sr-only">When</legend>
            <div className="tray-chips">
              <WhenRadio
                name={radioName}
                id={`${prefix}-when-any`}
                checked={selectedToken === 'any'}
                onSelect={selectAnyTime}
              >
                Any time
              </WhenRadio>
              {offeredPresets.map((p) => (
                <WhenRadio
                  key={p.id}
                  name={radioName}
                  id={`${prefix}-when-${p.id}`}
                  checked={selectedToken === p.id}
                  onSelect={() => selectPreset(p.id)}
                >
                  {p.label}
                </WhenRadio>
              ))}
              <WhenRadio
                name={radioName}
                id={`${prefix}-when-custom`}
                inputRef={pickDatesRadioRef}
                checked={selectedToken === 'custom'}
                onSelect={openPickDates}
                ariaControls="when-custom-panel"
                extraContent={
                  (dateFrom || dateTo) && (
                    <button
                      type="button"
                      className="when-chip-clear"
                      aria-label="Clear dates"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearRangeStayInPanel() }}
                    >
                      ✕
                    </button>
                  )
                }
              >
                {dateFrom || dateTo ? buildDateRangeLabel(dateFrom, dateTo) : 'Pick dates'}
              </WhenRadio>
              {ghostActive && (
                <WhenRadio
                  name={radioName}
                  id={`${prefix}-when-this_week`}
                  checked={selectedToken === 'this_week'}
                  onSelect={() => { /* not mintable — see WHEN_PRESETS' ghost note */ }}
                  disabled
                >
                  {ghostActive.label}
                </WhenRadio>
              )}
            </div>

            {panelOpen && (
              <div id="when-custom-panel" className="tray-date-row when-custom-panel">
                <label className="tray-date-label">
                  From
                  <input
                    ref={fromInputRef}
                    type="date"
                    className="tray-date-input"
                    value={dateFrom ?? ''}
                    min={todayIso}
                    onChange={(e) => commitRange(e.target.value || null, dateTo)}
                  />
                </label>
                <label className="tray-date-label">
                  To
                  <input
                    type="date"
                    className="tray-date-input"
                    value={dateTo ?? ''}
                    min={dateFrom ?? todayIso}
                    onChange={(e) => commitRange(dateFrom, e.target.value || null)}
                  />
                </label>
              </div>
            )}
          </fieldset>
        </>
      )}

      {/* Time of day stays fully interactive even when the date is locked
          (docs/when-filter.md §5) — it's the one thing a locked hub/embed
          visitor can still narrow. */}
      <div className="when-time-of-day">
        <p className="tray-section-label when-time-label">Time of day</p>
        <div className="tray-chips">
          {TIME_OF_DAY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={`tray-chip ${timeOfDay === opt.id ? 'active' : ''}`}
              aria-pressed={timeOfDay === opt.id}
              onClick={() => toggleTimeOfDay(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* MAINTAINER RULING: no user-facing accuracy caveat here, on purpose.
            The design draft (docs/when-filter.md §0) proposed an "Approximate
            ..." hint under this row; the maintainer rejected it. Time of day
            WILL include events whose hour was fabricated by a scraper default
            (see the code comment above TIME_OF_DAY_BUCKETS in whenFilter.ts
            for exactly which scrapers and which invented hour), and that is a
            known, deliberate tradeoff — not something to hedge in the UI. Do
            NOT add hedging copy here; if that decision is ever revisited, the
            hint text is in the design doc's history, not resurrected from
            memory. */}
      </div>
    </div>
  )
}

interface WhenRadioProps {
  name: string
  id: string
  checked: boolean
  onSelect: () => void
  children?: React.ReactNode
  ariaControls?: string
  disabled?: boolean
  extraContent?: React.ReactNode
  inputRef?: React.RefObject<HTMLInputElement>
}

/** One visually-hidden native radio + its label styled as the existing chip.
 * `aria-expanded` is deliberately NOT set on the "Pick dates" control —
 * that state isn't supported on role="radio" and the checked state already
 * carries the disclosure meaning (docs/when-filter.md §7.2). */
function WhenRadio({ name, id, checked, onSelect, children, ariaControls, disabled, extraContent, inputRef }: WhenRadioProps) {
  return (
    <label
      htmlFor={id}
      className={`tray-chip when-chip${checked ? ' active' : ''}${disabled ? ' when-chip--ghost-disabled' : ''}`}
    >
      <input
        ref={inputRef}
        type="radio"
        id={id}
        name={name}
        className="when-chip-input sr-only"
        checked={checked}
        disabled={disabled}
        aria-controls={ariaControls}
        onChange={() => { if (!disabled) onSelect() }}
      />
      <span className="tray-chip-text">{children}</span>
      {extraContent}
    </label>
  )
}

/** Inclusive day count between two 'YYYY-MM-DD' keys, for the `span_days`
 * analytics parameter. Pure calendar-key arithmetic (UTC-anchored, explicit
 * Y/M/D triple) — not a clock read, so it's exempt from the UTC-today ban. */
function inclusiveDaySpan(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const a = Date.UTC(fy, fm - 1, fd)
  const b = Date.UTC(ty, tm - 1, td)
  return Math.round((b - a) / 86_400_000) + 1
}
