import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import './SubmitPage.css'

export default function OrganizationSubmitPage() {
  const [form, setForm] = useState({
    name: '', description: '', website: '',
    address: '', city: 'Akron', state: 'OH', zip: '',
    contact_email: '',
  })
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      const payload = {
        name:          form.name,
        description:   form.description || null,
        website:       form.website || null,
        address:       form.address || null,
        city:          form.city || 'Akron',
        state:         form.state || 'OH',
        zip:           form.zip || null,
        contact_email: form.contact_email || null,
        status:        'pending_review',
      }

      const { error: insertError } = await supabase.from('organizations').insert(payload)
      if (insertError) throw insertError
      setStatus('success')
    } catch (err) {
      setError(err.message ?? 'Something went wrong.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="page-shell">
        <div className="success-box">
          <div className="success-icon">✓</div>
          <h2 className="page-title">Organization submitted!</h2>
          <p className="page-sub">
            Thanks for registering. We'll review your submission and publish it shortly.
            Once approved, you'll be able to link your events and venues.
          </p>
          <button className="btn-submit-form" style={{ maxWidth: 260 }} onClick={() => { setStatus(null); setForm({ name: '', description: '', website: '', address: '', city: 'Akron', state: 'OH', zip: '', contact_email: '' }) }}>
            Submit another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <h1 className="page-title">Register an Organization</h1>
      <p className="page-sub">
        Add your organization to Turnout so people in Akron can discover your events and venues.
      </p>

      <div className="notice-box">
        All submissions are reviewed before going live. We'll reach out if we have questions.
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-section-label">Organization details</div>

        <div className="form-group">
          <label className="form-label">Organization name <span className="req">*</span></label>
          <input className="form-input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Akron Art Museum" />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Tell people about your organization…" />
        </div>

        <div className="form-group">
          <label className="form-label">Website</label>
          <input className="form-input" type="url" value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://…" />
        </div>

        <div className="form-section-label">Location</div>

        <div className="form-group">
          <label className="form-label">Address</label>
          <input className="form-input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Street address" />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">City</label>
            <input className="form-input" value={form.city} onChange={e => set('city', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">State</label>
            <input className="form-input" value={form.state} onChange={e => set('state', e.target.value)} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Zip code</label>
          <input className="form-input" value={form.zip} onChange={e => set('zip', e.target.value)} placeholder="44308" />
        </div>

        <div className="form-section-label">Contact info (not public)</div>

        <div className="form-group">
          <label className="form-label">Contact email <span className="req">*</span></label>
          <input className="form-input" type="email" required value={form.contact_email} onChange={e => set('contact_email', e.target.value)} placeholder="you@organization.com" />
          <p className="form-hint">We'll use this to contact you about your submission. This is never shown publicly.</p>
        </div>

        {error && <p className="form-error">{error}</p>}

        <button className="btn-submit-form" type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Submitting…' : 'Submit Organization for Review'}
        </button>
      </form>
    </div>
  )
}
