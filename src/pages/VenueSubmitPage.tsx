import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { geocodeAddress } from '@/lib/geocode'
import { SEO } from '@/lib/seo'
import './SubmitPage.css'
import './VenueSubmitPage.css'

const PARKING_TYPES = [
  { value: 'street',  label: 'Street parking' },
  { value: 'lot',     label: 'Parking lot' },
  { value: 'garage',  label: 'Parking garage' },
  { value: 'none',    label: 'No dedicated parking' },
  { value: 'unknown', label: "I'm not sure" },
]

interface VenueForm {
  name: string
  address: string
  city: string
  state: string
  zip: string
  description: string
  website: string
  parking_type: string
  parking_notes: string
  contact_email: string
}

interface AreaDraft {
  name: string
  description: string
  capacity: string
}

const EMPTY_FORM: VenueForm = {
  name: '', address: '', city: 'Akron', state: 'OH', zip: '',
  description: '', website: '', parking_type: 'unknown', parking_notes: '',
  contact_email: '',
}

export default function VenueSubmitPage() {
  const [form, setForm] = useState<VenueForm>(EMPTY_FORM)
  const [areas, setAreas] = useState<AreaDraft[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof VenueForm>(key: K, val: VenueForm[K]) =>
    setForm((f) => ({ ...f, [key]: val }))

  const addArea = () => setAreas((prev) => [...prev, { name: '', description: '', capacity: '' }])
  const removeArea = (idx: number) => setAreas((prev) => prev.filter((_, i) => i !== idx))
  const setArea = (idx: number, key: keyof AreaDraft, val: string) =>
    setAreas((prev) => prev.map((a, i) => i === idx ? { ...a, [key]: val } : a))

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      // Geocode the address behind the scenes
      const coords = await geocodeAddress({
        address: form.address, city: form.city,
        state: form.state, zip: form.zip,
      })

      const venuePayload = {
        name:          form.name,
        address:       form.address || null,
        city:          form.city || 'Akron',
        state:         form.state || 'OH',
        zip:           form.zip || null,
        description:   form.description || null,
        website:       form.website || null,
        parking_type:  form.parking_type,
        parking_notes: form.parking_notes || null,
        lat:           coords?.lat ?? null,
        lng:           coords?.lng ?? null,
        status:        'pending_review',
      }

      const { data: venueData, error: venueError } = await supabase
        .from('venues')
        .insert(venuePayload as any)
        .select('id')
        .single()

      if (venueError) throw venueError

      // Insert areas if any
      const validAreas = areas.filter((a) => a.name.trim())
      if (validAreas.length > 0 && venueData?.id) {
        const areaRows = validAreas.map((a) => ({
          venue_id:    venueData.id,
          name:        a.name.trim(),
          description: a.description || null,
          capacity:    a.capacity ? parseInt(a.capacity) : null,
        }))
        const { error: areaError } = await supabase.from('areas').insert(areaRows as any)
        if (areaError) console.warn('Area insert failed:', areaError.message)
      }

      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="page-shell">
        <div className="success-box">
          <div className="success-icon">✓</div>
          <h2 className="page-title">Venue submitted!</h2>
          <p className="page-sub">
            Thanks for adding a venue. We'll review and publish it shortly.
          </p>
          <button className="btn-submit-form" style={{ maxWidth: 240 }} onClick={() => { setStatus(null); setForm(EMPTY_FORM); setAreas([]) }}>
            Submit another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <SEO
        title="Submit Venue | Add an Event Space to Akron Pulse"
        description="Know a great event space in Akron or Summit County? Submit it to Akron Pulse and help map the local events scene."
        path="/venues/submit"
      />
      <h1 className="page-title">Submit a Venue</h1>
      <p className="page-sub">
        Know a great spot for events in Akron? Help us map it for the community.
      </p>

      <div className="notice-box">
        All venues are reviewed before going live. Include as much detail as you can. It helps people plan.
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-section-label">Venue details</div>

        <div className="form-group">
          <label className="form-label">Venue name <span className="req">*</span></label>
          <input className="form-input" required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Lock 3 Park" />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What kind of venue is this?" />
        </div>

        <div className="form-group">
          <label className="form-label">Website</label>
          <input className="form-input" type="url" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://…" />
        </div>

        <div className="form-section-label">Address</div>

        <div className="form-group">
          <label className="form-label">Street address <span className="req">*</span></label>
          <input className="form-input" required value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="200 S Main St" />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">City</label>
            <input className="form-input" value={form.city} onChange={(e) => set('city', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">State</label>
            <input className="form-input" value={form.state} onChange={(e) => set('state', e.target.value)} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Zip code</label>
          <input className="form-input" value={form.zip} onChange={(e) => set('zip', e.target.value)} placeholder="44308" />
        </div>

        <div className="form-section-label">Parking</div>

        <div className="form-group">
          <label className="form-label">Parking type</label>
          <select className="form-select" value={form.parking_type} onChange={(e) => set('parking_type', e.target.value)}>
            {PARKING_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Parking notes</label>
          <input className="form-input" value={form.parking_notes} onChange={(e) => set('parking_notes', e.target.value)} placeholder="e.g. Free after 6pm on weekdays" />
        </div>

        {/* ── Areas Section ── */}
        <div className="form-section-label">Areas (optional)</div>
        <p className="form-hint" style={{ marginBottom: 12 }}>
          Does this venue have distinct spaces where events happen? Add them here (e.g. "Main Stage", "Gallery Room", "Patio").
        </p>

        {areas.map((area, idx) => (
          <div key={idx} className="venue-area-row">
            <div className="venue-area-fields">
              <input className="form-input" placeholder="Area name" value={area.name} onChange={(e) => setArea(idx, 'name', e.target.value)} />
              <input className="form-input" placeholder="Description (optional)" value={area.description} onChange={(e) => setArea(idx, 'description', e.target.value)} />
              <input className="form-input" type="number" placeholder="Capacity" value={area.capacity} onChange={(e) => setArea(idx, 'capacity', e.target.value)} style={{ maxWidth: 120 }} />
            </div>
            <button type="button" className="venue-area-remove" onClick={() => removeArea(idx)} aria-label="Remove area">✕</button>
          </div>
        ))}

        <button type="button" className="venue-add-area-btn" onClick={addArea}>
          + Add an area
        </button>

        <div className="form-section-label">Contact info (not public)</div>

        <div className="form-group">
          <label className="form-label">Contact email</label>
          <input className="form-input" type="email" value={form.contact_email} onChange={(e) => set('contact_email', e.target.value)} placeholder="you@venue.com" />
          <p className="form-hint">Optional. We may reach out if we need more info.</p>
        </div>

        {error && <p className="form-error">{error}</p>}

        <button className="btn-submit-form" type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Submitting…' : 'Submit Venue for Review'}
        </button>
      </form>
    </div>
  )
}
