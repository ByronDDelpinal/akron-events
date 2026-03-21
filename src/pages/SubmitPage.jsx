import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import './SubmitPage.css'

const CATEGORIES = [
  { value: 'music',     label: 'Music' },
  { value: 'art',       label: 'Art' },
  { value: 'nonprofit', label: 'Non-Profit / Fundraiser' },
  { value: 'community', label: 'Community' },
  { value: 'food',      label: 'Food & Drink' },
  { value: 'sports',    label: 'Fitness / Sports' },
  { value: 'education', label: 'Education' },
  { value: 'other',     label: 'Other' },
]

export default function SubmitPage() {
  const [form,    setForm]    = useState({
    title: '', description: '', start_at: '', end_at: '',
    venue_name: '', venue_address: '', category: '', ticket_url: '',
    price_min: '', price_max: '', age_restriction: 'not_specified',
    organizer_name: '', organizer_email: '', tags: '',
  })
  const [status, setStatus] = useState(null) // null | 'submitting' | 'success' | 'error'
  const [error,  setError]  = useState(null)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      // We insert with status='pending_review' and source='manual'
      // Venue and organizer are stored as plain text for now (admin links them up)
      const payload = {
        title:           form.title,
        description:     form.description || null,
        start_at:        form.start_at,
        end_at:          form.end_at || null,
        category:        form.category,
        ticket_url:      form.ticket_url || null,
        price_min:       parseFloat(form.price_min) || 0,
        price_max:       form.price_max ? parseFloat(form.price_max) : null,
        age_restriction: form.age_restriction,
        tags:            form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        source:          'manual',
        status:          'pending_review',
        // We store organizer contact in description for now; admin reviews and links proper records
        // (Phase 2 will have a proper organizer submission flow)
      }

      const { error: insertError } = await supabase.from('events').insert(payload)
      if (insertError) throw insertError

      setStatus('success')
    } catch (err) {
      setError(err.message ?? 'Something went wrong. Please try again.')
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
      <h1 className="page-title">Submit an Event</h1>
      <p className="page-sub">Have an event happening in Akron or Summit County? Share it with the community.</p>

      <div className="notice-box">
        All submissions are reviewed before going live — usually within 24 hours. We'll reach out if we have questions.
      </div>

      <form onSubmit={handleSubmit}>

        <div className="form-section-label">Event details</div>

        <div className="form-group">
          <label className="form-label">Event name <span className="req">*</span></label>
          <input className="form-input" required value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Rubber City Jazz Festival" />
        </div>

        <div className="form-group">
          <label className="form-label">Category <span className="req">*</span></label>
          <select className="form-select" required value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">Select a category…</option>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Start date &amp; time <span className="req">*</span></label>
            <input className="form-input" type="datetime-local" required value={form.start_at} onChange={e => set('start_at', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">End time</label>
            <input className="form-input" type="datetime-local" value={form.end_at} onChange={e => set('end_at', e.target.value)} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Tell people what to expect…" />
        </div>

        <div className="form-section-label">Venue</div>

        <div className="form-group">
          <label className="form-label">Venue name</label>
          <input className="form-input" value={form.venue_name} onChange={e => set('venue_name', e.target.value)} placeholder="e.g. Lock 3 Park" />
        </div>

        <div className="form-group">
          <label className="form-label">Venue address</label>
          <input className="form-input" value={form.venue_address} onChange={e => set('venue_address', e.target.value)} placeholder="e.g. 200 S Main St, Akron, OH" />
        </div>

        <div className="form-section-label">Tickets &amp; pricing</div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Minimum price ($)</label>
            <input className="form-input" type="number" min="0" step="0.01" value={form.price_min} onChange={e => set('price_min', e.target.value)} placeholder="0 for free" />
          </div>
          <div className="form-group">
            <label className="form-label">Maximum price ($)</label>
            <input className="form-input" type="number" min="0" step="0.01" value={form.price_max} onChange={e => set('price_max', e.target.value)} placeholder="Leave blank if single price" />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Ticket / RSVP link</label>
          <input className="form-input" type="url" value={form.ticket_url} onChange={e => set('ticket_url', e.target.value)} placeholder="https://eventbrite.com/…" />
        </div>

        <div className="form-section-label">Audience</div>

        <div className="form-group">
          <label className="form-label">Age restriction</label>
          <select className="form-select" value={form.age_restriction} onChange={e => set('age_restriction', e.target.value)}>
            <option value="not_specified">Not specified</option>
            <option value="all_ages">All ages</option>
            <option value="18_plus">18+</option>
            <option value="21_plus">21+</option>
          </select>
          <p className="form-hint">If unsure, leave as "Not specified." Do not select "All ages" unless you are certain.</p>
        </div>

        <div className="form-group">
          <label className="form-label">Tags</label>
          <input className="form-input" value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="jazz, outdoor, family-friendly (comma separated)" />
          <p className="form-hint">Optional. Helps people find your event.</p>
        </div>

        <div className="form-section-label">Your info (not public)</div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Your name / organization</label>
            <input className="form-input" value={form.organizer_name} onChange={e => set('organizer_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Contact email</label>
            <input className="form-input" type="email" value={form.organizer_email} onChange={e => set('organizer_email', e.target.value)} />
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
