import type { LooseRow } from '@/types'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { eventPath } from '@/lib/slug'
import { gradientForEvent, treatmentCategory } from '@/lib/categories.js'
import { categoryGlyph } from '@/lib/categoryGlyphs'
import './CalendarView.css'

type Row = LooseRow
type Mode = 'day' | 'week' | 'month'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const MAX_CHIPS_MONTH = 3
const MAX_CHIPS_WEEK = 8

const pad = (n: number) => String(n).padStart(2, '0')
/** Local-time YYYY-MM-DD key (events display in the viewer's own timezone). */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function dayKeyOf(iso: string): string {
  return ymd(new Date(iso))
}
function parseYmd(s: string): Date {
  return new Date(s + 'T00:00:00')
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}
function startOfWeek(d: Date): Date {
  return addDays(d, -d.getDay()) // back to Sunday
}
function shortTime(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '')
    .replace(' ', '')
    .toLowerCase()
}

/** Seed the calendar's mode + focus from any date-range filter already active. */
function initialState(range: string | null, from: string | null, to: string | null): { mode: Mode; cursor: Date } {
  const today = new Date()
  if (range === 'today') return { mode: 'day', cursor: today }
  if (range === 'this_weekend' || range === 'this_week') return { mode: 'week', cursor: today }
  if (range === 'this_month') return { mode: 'month', cursor: new Date(today.getFullYear(), today.getMonth(), 1) }
  if (from || to) {
    const f = from ? parseYmd(from) : (to ? parseYmd(to) : today)
    const t = to ? parseYmd(to) : f
    const span = Math.round((t.getTime() - f.getTime()) / 86400000)
    if (span <= 0) return { mode: 'day', cursor: f }
    if (span <= 7) return { mode: 'week', cursor: f }
    return { mode: 'month', cursor: new Date(f.getFullYear(), f.getMonth(), 1) }
  }
  return { mode: 'week', cursor: today } // default
}

interface CalendarViewProps {
  events: Row[]
  loading?: boolean
  /** Active date-range filter, used only to seed the initial mode + focus. */
  initialRange?: string | null
  initialFrom?: string | null
  initialTo?: string | null
}

/**
 * CalendarView — day / week / month view of the (filtered, unpaginated) event
 * set. Defaults to week; the initial mode + focus are seeded from whatever
 * date-range filter is already selected.
 */
export default function CalendarView({
  events,
  loading,
  initialRange = null,
  initialFrom = null,
  initialTo = null,
}: CalendarViewProps) {
  const today = useMemo(() => new Date(), [])
  const todayKey = ymd(today)

  const [mode, setMode] = useState<Mode>(() => initialState(initialRange, initialFrom, initialTo).mode)
  const [cursor, setCursor] = useState<Date>(() => initialState(initialRange, initialFrom, initialTo).cursor)
  const [selected, setSelected] = useState<string | null>(null)

  // Bucket events by local day, each day sorted by start time.
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const ev of events) {
      if (!ev.start_at) continue
      const key = dayKeyOf(ev.start_at)
      const arr = map.get(key)
      if (arr) arr.push(ev)
      else map.set(key, [ev])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
    }
    return map
  }, [events])

  // ── Navigation (steps by the active mode) ──
  function step(delta: number) {
    setSelected(null)
    if (mode === 'day') setCursor((c) => addDays(c, delta))
    else if (mode === 'week') setCursor((c) => addDays(c, delta * 7))
    else setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))
  }
  function goToday() {
    setSelected(null)
    setCursor(mode === 'month' ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date())
  }
  function changeMode(m: Mode) {
    setSelected(null)
    setMode(m)
    if (m === 'month') setCursor((c) => new Date(c.getFullYear(), c.getMonth(), 1))
  }

  // Don't page back into a fully-past range (past events are hidden anyway).
  const canPrev =
    mode === 'day' ? ymd(cursor) > todayKey
    : mode === 'week' ? ymd(startOfWeek(cursor)) > ymd(startOfWeek(today))
    : cursor.getFullYear() > today.getFullYear() ||
      (cursor.getFullYear() === today.getFullYear() && cursor.getMonth() > today.getMonth())

  const label =
    mode === 'day'
      ? cursor.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
      : mode === 'week'
        ? (() => {
            const ws = startOfWeek(cursor)
            const we = addDays(ws, 6)
            const left = ws.toLocaleDateString([], { month: 'short', day: 'numeric' })
            const right = we.toLocaleDateString([],
              ws.getMonth() === we.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })
            return `${left} – ${right}`
          })()
        : `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`

  // ── Grid cells for the active mode ──
  const gridCells = useMemo(() => {
    if (mode === 'day') return []
    if (mode === 'week') {
      const ws = startOfWeek(cursor)
      return Array.from({ length: 7 }, (_, i) => {
        const d = addDays(ws, i)
        return { date: d, key: ymd(d), inMonth: true }
      })
    }
    const year = cursor.getFullYear()
    const month = cursor.getMonth()
    const firstDow = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const weeks = Math.ceil((firstDow + daysInMonth) / 7)
    const gridStart = new Date(year, month, 1 - firstDow)
    return Array.from({ length: weeks * 7 }, (_, i) => {
      const d = addDays(gridStart, i)
      return { date: d, key: ymd(d), inMonth: d.getMonth() === month }
    })
  }, [mode, cursor])

  // Open a day by default so the grid→list interaction is self-evident: prefer
  // the focused day (today), else the first upcoming day in view that has
  // events. Only fills an empty selection, so it never fights a manual pick.
  useEffect(() => {
    if (mode === 'day' || selected || byDay.size === 0) return
    const cursorKey = ymd(cursor)
    if (byDay.get(cursorKey)?.length) {
      setSelected(cursorKey)
      return
    }
    const firstWithEvents = gridCells.find((c) => (byDay.get(c.key)?.length ?? 0) > 0)
    if (firstWithEvents) setSelected(firstWithEvents.key)
  }, [mode, selected, byDay, cursor, gridCells])

  const maxChips = mode === 'week' ? MAX_CHIPS_WEEK : MAX_CHIPS_MONTH

  const dayEvents = mode === 'day' ? (byDay.get(ymd(cursor)) ?? []) : []
  const selectedEvents = selected ? (byDay.get(selected) ?? []) : []

  return (
    <div className="calendar-view">
      <div className="cal-toolbar">
        <button type="button" className="cal-nav" onClick={() => step(-1)} disabled={!canPrev} aria-label="Previous">‹</button>
        <h2 className="cal-month" aria-live="polite">{label}</h2>
        <button type="button" className="cal-nav" onClick={() => step(1)} aria-label="Next">›</button>

        <div className="cal-modes" role="group" aria-label="Calendar range">
          {(['day', 'week', 'month'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`cal-mode${mode === m ? ' active' : ''}`}
              aria-pressed={mode === m}
              onClick={() => changeMode(m)}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        <button type="button" className="cal-today" onClick={goToday}>Today</button>
      </div>

      {mode !== 'day' && (
        <div className="cal-weekdays" aria-hidden="true">
          {WEEKDAYS.map((w) => <span key={w} className="cal-weekday">{w}</span>)}
        </div>
      )}

      {mode !== 'day' && (
        <div className={`cal-grid${mode === 'week' ? ' cal-grid--week' : ''}`} role="grid">
          {gridCells.map(({ date, key, inMonth }) => {
            const evs = byDay.get(key) ?? []
            const isToday = key === todayKey
            const cls = [
              'cal-cell',
              !inMonth ? 'cal-cell--out' : '',
              key < todayKey ? 'cal-cell--past' : '',
              isToday ? 'cal-cell--today' : '',
              evs.length ? 'cal-cell--has' : '',
              selected === key ? 'cal-cell--selected' : '',
            ].filter(Boolean).join(' ')
            return (
              <div key={key} role="gridcell" className={cls} onClick={() => evs.length && setSelected(key)}>
                <span className="cal-daynum">{date.getDate()}</span>
                {evs.length > 0 && <span className="cal-daycount" aria-hidden="true">{evs.length}</span>}
                <div className="cal-chips">
                  {evs.slice(0, maxChips).map((ev) => (
                    <Link
                      key={ev.id}
                      to={eventPath(ev)}
                      className={`cal-chip ${gradientForEvent(ev)}`}
                      onClick={(e) => e.stopPropagation()}
                      title={ev.title}
                    >
                      <span className="cal-chip-time">{shortTime(ev.start_at)}</span>
                      <span className="cal-chip-title">{ev.title}</span>
                    </Link>
                  ))}
                  {evs.length > maxChips && (
                    <button type="button" className="cal-more" onClick={(e) => { e.stopPropagation(); setSelected(key) }}>
                      +{evs.length - maxChips} more
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Day mode shows the full agenda for the focused day. */}
      {mode === 'day' && (
        <DayAgenda events={dayEvents} empty="Nothing on this day." />
      )}

      {/* Month / week: a tapped day expands its full list below the grid. */}
      {mode !== 'day' && selected && selectedEvents.length > 0 && (
        <section className="cal-day" aria-label="Selected day">
          <h3 className="cal-day-title">
            {parseYmd(selected).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          </h3>
          <DayAgenda events={selectedEvents} />
        </section>
      )}

      {loading && events.length === 0 && <p className="cal-empty">Loading events…</p>}
      {!loading && events.length === 0 && <p className="cal-empty">No events match your filters.</p>}
    </div>
  )
}

/** A list of events as gradient cards (shared by day mode + the selected-day panel). */
function DayAgenda({ events, empty }: { events: Row[]; empty?: string }) {
  if (events.length === 0) {
    return empty ? <p className="cal-empty">{empty}</p> : null
  }
  return (
    <ul className="cal-day-list">
      {events.map((ev) => {
        const glyph = categoryGlyph(treatmentCategory(ev))
        return (
          <li key={ev.id}>
            <Link to={eventPath(ev)} className={`cal-day-row ${gradientForEvent(ev)}`}>
              <span className="cal-day-time">{shortTime(ev.start_at)}</span>
              <span className="cal-day-info">
                <span className="cal-day-name">{ev.title}</span>
                {ev.venue?.name && <span className="cal-day-venue">{ev.venue.name}</span>}
              </span>
              <span className="cal-day-end" aria-hidden="true">
                {glyph && (
                  <span
                    className="cal-day-glyph"
                    style={{ WebkitMaskImage: `url(${glyph})`, maskImage: `url(${glyph})` }}
                  />
                )}
                <span className="cal-day-arrow">→</span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
