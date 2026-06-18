import type { TablesInsert } from '@/lib/database.types'
import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import { ADMIN_CATEGORIES as CATEGORIES } from '@/lib/categories'
import { INTAKE_MAILTO } from '@/lib/intakeEmail'
import { fromDatetimeLocalValue } from '@/lib/datetimeLocal'
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
}

export default function SubmitPage() {
  const [form, setForm] = useState<SubmitForm>({
    title: '', description: '', start_at: '', end_at: '',
    venue_name: '', venue_address: '', categories: [], ticket_url: '',
    price_min: '', price_max: '', age_restriction: 'not_specified',
    organizer_name: '', organizer_email: '', tags: '',
  })
  const [status, setStatus] = useState<string | null>(null) // null | 'submitting' | 'success' | 'error'
  const [error,  setError]  = useState<string | null>(null)

  const set = <K extends keyof SubmitForm>(key: K, val: SubmitForm[K]) =>
    setForm((f) => ({ ...f, [key]: val }))

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Categories are a chip group, not a native <select required> — validate here.
    if (!form.categories || form.categories.length === 0) {
      setStatus('error')
      setError('Please pick at least one category.')
      return
    }

    setStatus('submitting')
    setError(null)

    try {
      // Insert with status='pending_review' and source='manual'.
      const payload = {
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

      const { data: inserted, error: insertError } = await supabase
        .from('events')
        .insert(payload as TablesInsert<'events'>)
        .select('id')
        .single()
      if (insertError) throw insertError

      // Content categories live in event_categories (up to 2).
      const cats = [...new Set(form.categories ?? [])].slice(0, 2)
      if (cats.length) {
        const { error: catError } = await supabase
          .from('event_categories')
          .insert(cats.map((category) => ({ event_id: (inserted as { id: string }).id, category })) as TablesInsert<'event_categories'>[])
        if (catError) console.warn('[submit] event_categories insert failed', catError)
      }

      // Fire the operator notification email (non-blocking — the row is saved).
      try {
        const { error: notifyError } = await supabase.functions.invoke('notify-pending-event', {
          body: {
            event_id:        (inserted as { id: string }).id,
            organizer_name:  form.organizer_name || null,
            organizer_email: form.organizer_email || null,
            venue_name:      form.venue_name || null,
            venue_address:   form.venue_address || null,
          },
        })
        if (notifyError) console.warn('[submit] notify-pending-event failed', notifyError)
      } catch (err) {
        console.warn('[submit] notify-pending-event threw', err)
      }

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
            <input className="form-input" type="datetime-local" required value={form.start_at} onChange={(e) => set('start_at', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">End time</label>
            <input className="form-input" type="datetime-local" value={form.end_at} onChange={(e) => set('end_at', e.target.value)} />
          </div>
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
