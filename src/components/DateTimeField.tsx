/**
 * DateTimeField
 *
 * The single date + time control used by every event form (public submit,
 * partner create, partner drawer, admin editor). It replaces the native
 * `<input type="datetime-local">`, whose calendar/time popup is cramped and
 * inconsistent across browsers, with one accessible control we own and style
 * to the app's design tokens.
 *
 * Value contract -- deliberately identical to the input it replaces so it
 * drops into existing form state with no change to the datetimeLocal.js
 * timezone bridge: `value` and every `onChange` payload are timezone-naive
 * local wall-clock strings of the form `YYYY-MM-DDTHH:mm`, or '' when unset.
 *
 * `min` is a floor of the same shape. Days before it are not selectable and a
 * time that would land before it is snapped forward on commit -- so "before
 * the start" is not an error the user can trigger, it is simply not
 * expressible (clampToMin). The start/end auto-fill lives in the forms via
 * deriveEndForStart; this control only enforces the floor it is given.
 *
 * Start-required forms validate in JS (there is no native `required` to lean
 * on here); this control focuses on selection ergonomics and the floor.
 */

import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format,
  isSameDay, isSameMonth, startOfMonth, startOfWeek,
} from 'date-fns'
import { clampToMin } from '@/lib/eventTimes'
import './DateTimeField.css'

interface DateTimeFieldProps {
  /** `YYYY-MM-DDTHH:mm` local wall-clock, or '' when unset. */
  value: string
  /** Receives the same local shape (or '' when cleared). */
  onChange: (value: string) => void
  /** Floor, same shape. Earlier days are disabled; earlier times snap up. */
  min?: string
  disabled?: boolean
  required?: boolean
  /** Associates the visible trigger with an outer <label>. */
  id?: string
  /** Fallback label when there is no wrapping <label htmlFor>. */
  ariaLabel?: string
  placeholder?: string
  /** Default time (HH:mm) when a day is picked before any time is set. */
  defaultTime?: string
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const datePartOf = (v: string) => (v ? v.slice(0, 10) : '')
const timePartOf = (v: string) => (v && v.length >= 16 ? v.slice(11, 16) : '')

/** Parse a `YYYY-MM-DD` day into a local Date at midnight (no TZ drift). */
function dayToDate(dayStr: string): Date | null {
  if (!dayStr) return null
  const [y, m, d] = dayStr.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

export default function DateTimeField({
  value, onChange, min, disabled, required,
  id, ariaLabel, placeholder = 'Select date & time', defaultTime = '19:00',
}: DateTimeFieldProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const dialogId = useId()

  const selectedDay = datePartOf(value)
  const timePart = timePartOf(value)
  const minDay = datePartOf(min ?? '')

  // Visible month; follows the selection when there is one, else the floor,
  // else today. Kept in state so the arrows and keyboard can page it.
  const [month, setMonth] = useState<Date>(
    () => dayToDate(selectedDay) ?? dayToDate(minDay) ?? new Date(),
  )
  // Focused day for keyboard nav (roving tabindex).
  const [activeDay, setActiveDay] = useState<Date>(
    () => dayToDate(selectedDay) ?? dayToDate(minDay) ?? new Date(),
  )

  // When the popup opens, re-anchor the month/focus to the current selection.
  useEffect(() => {
    if (!open) return
    const anchor = dayToDate(selectedDay) ?? dayToDate(minDay) ?? new Date()
    setMonth(anchor)
    setActiveDay(anchor)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Keep DOM focus on the active day as it moves.
  useEffect(() => {
    if (!open) return
    const el = gridRef.current?.querySelector<HTMLButtonElement>('[data-active="true"]')
    el?.focus()
  }, [open, activeDay])

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 0 })
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 0 })
    return eachDayOfInterval({ start, end })
  }, [month])

  const isDisabledDay = useCallback(
    (day: Date) => (minDay ? format(day, 'yyyy-MM-dd') < minDay : false),
    [minDay],
  )

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const commit = useCallback(
    (dayStr: string, time: string) => {
      const next = clampToMin(`${dayStr}T${time || defaultTime}`, min)
      onChange(next)
    },
    [min, defaultTime, onChange],
  )

  const pickDay = useCallback(
    (day: Date) => {
      if (isDisabledDay(day)) return
      commit(format(day, 'yyyy-MM-dd'), timePart)
      setActiveDay(day)
    },
    [commit, isDisabledDay, timePart],
  )

  const onTimeChange = useCallback(
    (time: string) => {
      if (!time) return
      const dayStr = selectedDay || format(activeDay, 'yyyy-MM-dd')
      commit(dayStr, time)
    },
    [commit, selectedDay, activeDay],
  )

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: Date | null = null
    switch (e.key) {
      case 'ArrowLeft':  next = new Date(activeDay); next.setDate(activeDay.getDate() - 1); break
      case 'ArrowRight': next = new Date(activeDay); next.setDate(activeDay.getDate() + 1); break
      case 'ArrowUp':    next = new Date(activeDay); next.setDate(activeDay.getDate() - 7); break
      case 'ArrowDown':  next = new Date(activeDay); next.setDate(activeDay.getDate() + 7); break
      case 'Home':       next = startOfWeek(activeDay, { weekStartsOn: 0 }); break
      case 'End':        next = endOfWeek(activeDay, { weekStartsOn: 0 }); break
      case 'PageUp':     next = addMonths(activeDay, -1); break
      case 'PageDown':   next = addMonths(activeDay, 1); break
      case 'Enter':
      case ' ':
        e.preventDefault()
        pickDay(activeDay)
        return
      default:
        return
    }
    e.preventDefault()
    if (next) {
      setActiveDay(next)
      if (!isSameMonth(next, month)) setMonth(startOfMonth(next))
    }
  }

  const triggerLabel = value
    ? format(new Date(value), "EEE, MMM d, yyyy '·' h:mm a")
    : placeholder

  return (
    <div className="dtf" ref={rootRef}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={`dtf-trigger${value ? '' : ' dtf-trigger--empty'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="dtf-icon" viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
          <rect x="3" y="4.5" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 9h18M8 2.5v4M16 2.5v4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="dtf-value">{triggerLabel}</span>
      </button>

      {open && !disabled && (
        <div
          className="dtf-pop"
          role="dialog"
          aria-modal="false"
          aria-label="Choose date and time"
          id={dialogId}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }}
        >
          <div className="dtf-cal-hd">
            <button type="button" className="dtf-nav" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
            <span className="dtf-month" aria-live="polite">{format(month, 'MMMM yyyy')}</span>
            <button type="button" className="dtf-nav" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>›</button>
          </div>

          <div className="dtf-weekrow" aria-hidden="true">
            {WEEKDAYS.map((w) => <span key={w} className="dtf-weekday">{w}</span>)}
          </div>

          <div
            className="dtf-grid"
            role="grid"
            ref={gridRef}
            onKeyDown={onGridKeyDown}
          >
            {days.map((day) => {
              const inMonth = isSameMonth(day, month)
              const isSel = selectedDay === format(day, 'yyyy-MM-dd')
              const isActive = isSameDay(day, activeDay)
              const dis = isDisabledDay(day)
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  role="gridcell"
                  data-active={isActive || undefined}
                  className={
                    'dtf-day' +
                    (inMonth ? '' : ' dtf-day--muted') +
                    (isSel ? ' dtf-day--selected' : '') +
                    (isSameDay(day, new Date()) ? ' dtf-day--today' : '')
                  }
                  tabIndex={isActive ? 0 : -1}
                  aria-pressed={isSel}
                  aria-label={format(day, 'EEEE, MMMM d, yyyy')}
                  disabled={dis}
                  onClick={() => pickDay(day)}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          <div className="dtf-foot">
            <label className="dtf-time">
              <span className="dtf-time-lbl">Time</span>
              <input
                type="time"
                className="dtf-time-input"
                value={timePart}
                min={selectedDay && minDay && selectedDay === minDay ? timePartOf(min ?? '') : undefined}
                onChange={(e) => onTimeChange(e.target.value)}
              />
            </label>
            <div className="dtf-foot-actions">
              {!required && value && (
                <button type="button" className="dtf-link" onClick={() => { onChange(''); }}>Clear</button>
              )}
              <button type="button" className="dtf-done" onClick={close}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
