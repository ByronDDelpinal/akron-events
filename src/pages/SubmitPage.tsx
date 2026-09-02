import type { TablesInsert } from '@/lib/database.types'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import { ADMIN_CATEGORIES as CATEGORIES } from '@/lib/categories'
import { INTAKE_MAILTO } from '@/lib/intakeEmail'
import { fromDatetimeLocalValue } from '@/lib/datetimeLocal'
import DateTimeField from '@/components/DateTimeField'
import { deriveEndForStart } from '@/lib/eventTimes'
import { easternDateKey, easternTimeKey, easternTodayIso, easternIsoAt } from '@/lib/easternDate'
import { addDaysYmd, occurrenceSourceId, MAX_SERIES_SPAN_DAYS } from '@/lib/recurrence'
import {
  buildSeriesRule, materialiseDates, describeSeries, pickerErrorCopy, occurrenceEndOffset,
  type PickerState, type RepeatChoice,
} from '@/lib/seriesPicker'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './SubmitPage.css'

interface SubmitForm {
  title: string
  description: string
  start_at: string
  end_at: string
  venue_name: string
  venue_address: string
  categories: string[]
  ticket_url: string
  price_min: string
  price_max: string
  age_restriction: string
  organizer_name: string
  organizer_email: string
  tags: string
  // Recurrence picker (ADR-069 slice 3). Kept inside SubmitForm rather than a
  // second useState object so the existing `set()` helper and every setForm
  // call keep working unchanged.
  repeat: RepeatChoice
  endMode: PickerState['endMode']
  count: string
  untilYmd: string
}

const REPEAT_CHOICES: { value: RepeatChoice; label: string }[] = [
  { value: 'none',     label: 'Does not repeat' },
  { value: 'weekly',   label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly',  label: 'Monthly' },
]

// The summary line quotes the EASTERN wall clock, because that is what gets
// stored and what appears on the public listing. Outside Eastern the time
// carries an explicit ET so nobody reads it as their own clock.
const SHOW_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone !== 'America/New_York'

/**
 * Fire the operator notification email. Non-blocking by contract: the rows
 * are already saved, so a failure is a console warning, never an error the
 * submitter sees. Extracted so the single-event and series paths cannot
 * drift in what they send or how they fail.
 */
async function notifyOperator(body: Record<string, unknown>) {
  try {
    const { error: notifyError } = await supabase.functions.invoke('notify-pending-event', { body })
    if (notifyError) console.warn('[submit] notify-pending-event failed', notifyError)
  } catch (err) {
    console.warn('[submit] notify-pending-event threw', err)
  }
}

export default function SubmitPage() {
  const [form, setForm] = useState<SubmitForm>({
    title: '', description: '', start_at: '', end_at: '',
    venue_name: '', venue_address: '', categories: [], ticket_url: '',
    price_min: '', price_max: '', age_restriction: 'not_specified',
    organizer_name: '', organizer_email: '', tags: '',
    repeat: 'none', endMode: 'count', count: '8', untilYmd: '',
  })
  const [status, setStatus] = useState<string | null>(null) // null | 'submitting' | 'success' | 'error'
  const [error,  setError]  = useState<string | null>(null)

  const set = <K extends keyof SubmitForm>(key: K, val: SubmitForm[K]) =>
    setForm((f) => ({ ...f, [key]: val }))

  // Every rrule field is derived from the EASTERN civil date and time of the
  // chosen instant, never from the viewer's calendar. A submitter in Los
  // Angeles picking "Tuesday 10:00 PM" is creating a Wednesday 1:00 AM ET
  // series, and the BYDAY we derive has to say WE or validateOrganizerRule
  // rejects it (event_series.dtstart_date / start_time are the Eastern civil
  // pair, and tz is CHECK-pinned to America/New_York by migration 069).
  const startIso  = form.start_at ? fromDatetimeLocalValue(form.start_at) : null
  const endIso    = form.end_at ? fromDatetimeLocalValue(form.end_at) : null
  const dtstartYmd = startIso ? easternDateKey(startIso) : ''
  const startHms   = startIso ? easternTimeKey(startIso) : ''

  const built = form.repeat !== 'none' && dtstartYmd ? buildSeriesRule(form, dtstartYmd) : null
  const expansion = built?.ok ? materialiseDates(built.parts, dtstartYmd, easternTodayIso()) : null
  // The aria-live hint carries whichever is true right now: the summary of a
  // valid rule, or the same sentence the submit gate would show. A silent
  // hint while the picker sits in a state that cannot submit is worse than
  // either.
  const summary = expansion
    ? describeSeries(form, dtstartYmd, startHms, expansion.all, {
      showZone: SHOW_ZONE, mintedCount: expansion.toMint.length,
    })
    : built && !built.ok
      ? pickerErrorCopy(built.reason, dtstartYmd)
      : ''

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Start is required; the custom date control carries no native `required`.
    if (!form.start_at) {
      setStatus('error')
      setError('Please choose a start date and time.')
      return
    }

    // Categories are a chip group, not a native <select required> — validate here.
    if (!form.categories || form.categories.length === 0) {
      setStatus('error')
      setError('Please pick at least one category.')
      return
    }

    // The repeat rule is derived here, not typed by the submitter, so a
    // rejection means our derivation disagrees with the validator. Keep the
    // warn: it is the only signal if the two ever drift.
    if (built && !built.ok) {
      console.warn('[submit] rrule rejected', built.reason)
      setStatus('error')
      setError(pickerErrorCopy(built.reason, dtstartYmd))
      return
    }

    setStatus('submitting')
    setError(null)

    try {
      // Insert with status='pending_review' and source='manual'.
      //
      // The id is generated client-side on purpose: anon's SELECT policy on
      // events is published-only, and Postgres applies SELECT policies to
      // INSERT ... RETURNING — so `.insert().select('id')` fails for a
      // pending_review row even though the insert itself is allowed (see
      // migration 042). Minting the UUID here lets us link categories and
      // notify without reading the row back.
      const eventId = crypto.randomUUID()
      const payload = {
        id:              eventId,
        title:           form.title,
        description:     form.description || null,
        // Inputs are timezone-naive datetime-local strings (submitter's
        // local wall-clock); convert to a UTC instant before persisting.
        start_at:        fromDatetimeLocalValue(form.start_at),
        end_at:          fromDatetimeLocalValue(form.end_at),
        ticket_url:      form.ticket_url || null,
        // Mirror ticket link into source_url so every event has a source page.
        source_url:      form.ticket_url || null,
        price_min:       parseFloat(form.price_min) || 0,
        price_max:       form.price_max ? parseFloat(form.price_max) : null,
        age_restriction: form.age_restriction,
        tags:            form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        source:          'manual',
        status:          'pending_review',
      }

      // Content categories live in event_categories (up to 2).
      const cats = [...new Set(form.categories ?? [])].slice(0, 2)
      const contact = {
        organizer_name:  form.organizer_name || null,
        organizer_email: form.organizer_email || null,
        venue_name:      form.venue_name || null,
        venue_address:   form.venue_address || null,
      }

      if (built?.ok && expansion) {
        // ── Series branch ───────────────────────────────────────────────
        // Deliberately an early branch, not a generalised "insert N events"
        // rewrite of the path below: the single submission is the
        // overwhelming majority of traffic and it works.
        //
        // The series id is minted client-side for the same reason the event
        // id is (above), and one layer more: migration 069 grants anon
        // INSERT only on event_series and no SELECT at all, so RETURNING is
        // refused at the grant layer as well as the policy layer.
        const seriesId = crypto.randomUUID()

        // Occurrence end times reapply the Eastern civil day offset rather
        // than adding duration_min, so a 10 PM to 1 AM event keeps landing on
        // the next day and the whole series keeps its wall clock across the
        // November DST change instead of drifting an hour. A null offset means
        // End is not actually after Start; that is treated as no End at all,
        // on the series row and every occurrence alike, rather than minting N
        // rows that end before they begin.
        const endHms    = endIso ? easternTimeKey(endIso) : ''
        const dayOffset = endIso
          ? occurrenceEndOffset(dtstartYmd, startHms, easternDateKey(endIso), endHms)
          : null

        // duration_min is what the nightly extender reaches for FIRST when it
        // sizes a minted occurrence (occurrenceDurationMs, scripts/lib/series.js,
        // falls back to the template's own start-to-end delta only when the
        // series has none), so it is load-bearing rather than advisory. A
        // difference of two instants needs no Eastern conversion; outside the
        // 069 CHECK's 1..1440 range it collapses to null rather than refusing
        // a submission over a 25-hour event.
        let durationMin: number | null =
          startIso && endIso && dayOffset != null
            ? Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000)
            : null
        if (durationMin != null && (durationMin < 1 || durationMin > 1440)) durationMin = null

        const { error: seriesError } = await supabase
          .from('event_series')
          .insert({
            id:           seriesId,
            rrule:        built.rrule,
            dtstart_date: dtstartYmd,
            start_time:   startHms,
            duration_min: durationMin,
            source:       'manual',
          } as TablesInsert<'event_series'>)
        if (seriesError) throw seriesError

        // ONE insert with an array, never a loop. PostgREST compiles this to
        // a single INSERT ... VALUES (...), (...), so either every occurrence
        // lands or none does. A loop would make "half a series" the routine
        // outcome of a flaky connection, and anon has no DELETE grant to
        // clean up with.
        const rows = expansion.toMint.map((ymd, i) => ({
          ...payload,
          id:        i === 0 ? eventId : crypto.randomUUID(),
          series_id: seriesId,
          source_id: occurrenceSourceId(seriesId, ymd),
          start_at:  easternIsoAt(ymd, startHms),
          end_at:    dayOffset != null ? easternIsoAt(addDaysYmd(ymd, dayOffset), endHms) : null,
        }))

        const { error: rowsError } = await supabase
          .from('events')
          .insert(rows as TablesInsert<'events'>[])
        if (rowsError) {
          // The orphan event_series row left behind is inert by design: with
          // no occurrences it can never acquire a template, so the nightly
          // extender skips it forever. Anon cannot delete it, and does not
          // need to.
          console.warn('[submit] series occurrence insert failed', rowsError)
          throw new Error(
            'Something went wrong saving the dates. Nothing was saved to the calendar. ' +
            'Please try again, or email intake@akronpulse.com and we will set it up.',
          )
        }

        if (cats.length) {
          const catRows = rows.flatMap((r) => cats.map((category) => ({ event_id: r.id, category })))
          const { error: catError } = await supabase
            .from('event_categories')
            .insert(catRows as TablesInsert<'event_categories'>[])
          if (catError) console.warn('[submit] event_categories insert failed', catError)
        }

        await notifyOperator({ event_id: eventId, ...contact, series_count: rows.length })
        setStatus('success')
        return
      }

      const { error: insertError } = await supabase
        .from('events')
        .insert(payload as TablesInsert<'events'>)
      if (insertError) throw insertError

      if (cats.length) {
        const { error: catError } = await supabase
          .from('event_categories')
          .insert(cats.map((category) => ({ event_id: eventId, category })) as TablesInsert<'event_categories'>[])
        if (catError) console.warn('[submit] event_categories insert failed', catError)
      }

      // Fire the operator notification email (non-blocking, the row is saved).
      await notifyOperator({ event_id: eventId, ...contact })

      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="page-shell">
        <div className="success-box">
          <div className="success-icon">✓</div>
          <h2 className="page-title">Event submitted!</h2>
          <p className="page-sub">Thanks for sharing with the community. We'll review your submission and publish it shortly.</p>
          <button className="btn-submit-form" style={{ maxWidth: 240 }} onClick={() => setStatus(null)}>Submit another</button>
          <p className="success-guides">
            Two things worth two minutes before your next one:{' '}
            <Link
              to="/guides/write-a-listing-that-gets-clicked"
              onClick={() => trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: 'write-a-listing-that-gets-clicked', placement: 'submit_success' })}
            >
              writing a listing people click
            </Link>{' '}
            and{' '}
            <Link
              to="/guides/series-recurrence-and-cancellations"
              onClick={() => trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: 'series-recurrence-and-cancellations', placement: 'submit_success' })}
            >
              handling repeats and cancellations
            </Link>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <SEO
        title="Submit Event | Free Listing in Akron"
        description="Have an event happening in Akron or Summit County? Submit it to Akron Pulse for free and reach locals looking for things to do."
        path="/submit"
      />
      <h1 className="page-title">Submit an Event</h1>
      <p className="page-sub">Have an event happening in Akron or Summit County? Share it with the community.</p>

      <div className="notice-box">
        All submissions are reviewed before going live, usually within 24 hours. We'll reach out if we have questions.
      </div>

      {/* Low-effort alternative to the full form: a pre-filled email.
          Pairs with the intake@ pipeline — a link, flyer photo, or a
          sentence is enough for us to take it from there. */}
      <a className="submit-email-option" href={INTAKE_MAILTO}>
        <strong>In a hurry?</strong> Email us a link or flyer instead, and we'll fill in the details →
      </a>

      <form onSubmit={handleSubmit}>

        <div className="form-section-label">Event details</div>

        <div className="form-group">
          <label className="form-label">Event name <span className="req">*</span></label>
          <input className="form-input" required value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Rubber City Jazz Festival" />
        </div>

        <div className="form-group">
          <label className="form-label">Category <span className="req">*</span> <span className="form-hint">(pick up to 2)</span></label>
          <div className="submit-chip-group">
            {CATEGORIES.map((c) => {
              const selected = form.categories.includes(c.value)
              const atMax = form.categories.length >= 2
              return (
                <button
                  type="button"
                  key={c.value}
                  className={`submit-chip ${selected ? 'active' : ''}`}
                  onClick={() => set('categories', selected
                    ? form.categories.filter((x) => x !== c.value)
                    : (atMax ? form.categories : [...form.categories, c.value]))}
                  disabled={!selected && atMax}
                  aria-pressed={selected}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Start date &amp; time <span className="req">*</span></label>
            <DateTimeField
              value={form.start_at}
              onChange={(v) => setForm((f) => ({ ...f, start_at: v, end_at: deriveEndForStart(v, f.end_at) }))}
              required
              ariaLabel="Start date and time"
            />
          </div>
          <div className="form-group">
            <label className="form-label">End time</label>
            <DateTimeField
              value={form.end_at}
              onChange={(v) => set('end_at', v)}
              min={form.start_at}
              ariaLabel="End date and time"
            />
          </div>
        </div>

        {/* Repeats. Every primitive here already ships (the chip group is the
            category chips' exact pattern, the nested form-row collapses at
            500px), so this control adds no CSS. */}
        <div className="form-group">
          <label className="form-label">Repeats</label>
          <div className="submit-chip-group">
            {REPEAT_CHOICES.map((c) => (
              <button
                type="button"
                key={c.value}
                className={`submit-chip ${form.repeat === c.value ? 'active' : ''}`}
                onClick={() => set('repeat', c.value)}
                disabled={!form.start_at}
                aria-pressed={form.repeat === c.value}
              >
                {c.label}
              </button>
            ))}
          </div>
          {!form.start_at && (
            <p className="form-hint">Pick a start date first, then choose how it repeats.</p>
          )}
          {form.repeat !== 'none' && (
            <>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Ends</label>
                  <select
                    className="form-select"
                    value={form.endMode}
                    onChange={(e) => set('endMode', e.target.value as SubmitForm['endMode'])}
                  >
                    <option value="count">Number of dates</option>
                    <option value="date">End date</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">{form.endMode === 'count' ? 'How many' : 'Last date'}</label>
                  {form.endMode === 'count' ? (
                    <input
                      className="form-input"
                      type="number"
                      min="1"
                      max="52"
                      step="1"
                      value={form.count}
                      onChange={(e) => set('count', e.target.value)}
                    />
                  ) : (
                    /* A bare date input, not DateTimeField: RFC 5545 UNTIL is
                       a civil date here and DateTimeField always carries a
                       time. Binding a control that forces a meaningless time
                       onto a date-only field invites timezone confusion. */
                    <input
                      className="form-input"
                      type="date"
                      min={dtstartYmd ? addDaysYmd(dtstartYmd, 1) : undefined}
                      max={dtstartYmd ? addDaysYmd(dtstartYmd, MAX_SERIES_SPAN_DAYS) : undefined}
                      value={form.untilYmd}
                      onChange={(e) => set('untilYmd', e.target.value)}
                    />
                  )}
                </div>
              </div>
              <p className="form-hint" aria-live="polite">{summary}</p>
            </>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Tell people what to expect…" />
        </div>

        <div className="form-section-label">Venue</div>

        <div className="form-group">
          <label className="form-label">Venue name</label>
          <input className="form-input" value={form.venue_name} onChange={(e) => set('venue_name', e.target.value)} placeholder="e.g. Lock 3 Park" />
        </div>

        <div className="form-group">
          <label className="form-label">Venue address</label>
          <input className="form-input" value={form.venue_address} onChange={(e) => set('venue_address', e.target.value)} placeholder="e.g. 200 S Main St, Akron, OH" />
        </div>

        <div className="form-section-label">Tickets &amp; pricing</div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Minimum price ($)</label>
            <input className="form-input" type="number" min="0" step="0.01" value={form.price_min} onChange={(e) => set('price_min', e.target.value)} placeholder="0 for free" />
          </div>
          <div className="form-group">
            <label className="form-label">Maximum price ($)</label>
            <input className="form-input" type="number" min="0" step="0.01" value={form.price_max} onChange={(e) => set('price_max', e.target.value)} placeholder="Leave blank if single price" />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Ticket / RSVP link</label>
          <input className="form-input" type="url" value={form.ticket_url} onChange={(e) => set('ticket_url', e.target.value)} placeholder="https://eventbrite.com/…" />
        </div>

        <div className="form-section-label">Audience</div>

        <div className="form-group">
          <label className="form-label">Age restriction</label>
          <select className="form-select" value={form.age_restriction} onChange={(e) => set('age_restriction', e.target.value)}>
            <option value="not_specified">Not specified</option>
            <option value="all_ages">All ages</option>
            <option value="18_plus">18+</option>
            <option value="21_plus">21+</option>
          </select>
          <p className="form-hint">If unsure, leave as "Not specified." Do not select "All ages" unless you are certain.</p>
        </div>

        <div className="form-group">
          <label className="form-label">Tags</label>
          <input className="form-input" value={form.tags} onChange={(e) => set('tags', e.target.value)} placeholder="jazz, outdoor, family-friendly (comma separated)" />
          <p className="form-hint">Optional. Helps people find your event.</p>
        </div>

        <div className="form-section-label">Your info (not public)</div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Your name / organization</label>
            <input className="form-input" value={form.organizer_name} onChange={(e) => set('organizer_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Contact email</label>
            <input className="form-input" type="email" value={form.organizer_email} onChange={(e) => set('organizer_email', e.target.value)} />
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <button className="btn-submit-form" type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Submitting…' : 'Submit Event for Review'}
        </button>

      </form>
    </div>
  )
}
