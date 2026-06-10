import type { TablesInsert } from '@/lib/database.types'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
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

interface OrgForm {
  name: string
  description: string
  website: string
  address: string
  city: string
  state: string
  zip: string
  contact_email: string
}

interface VenueDraft {
  name: string
  description: string
  website: string
  address: string
  city: string
  state: string
  zip: string
  parking_type: string
  parking_notes: string
  contact_email: string
}

interface AreaDraft {
  name: string
  description: string
  capacity: string
}

const EMPTY_ORG: OrgForm = {
  name: '', description: '', website: '',
  address: '', city: 'Akron', state: 'OH', zip: '',
  contact_email: '',
}

const EMPTY_VENUE: VenueDraft = {
  name: '', description: '', website: '',
  address: '', city: 'Akron', state: 'OH', zip: '',
  parking_type: 'unknown', parking_notes: '',
  contact_email: '',
}

export default function OrganizationSubmitPage() {
  const [form, setForm] = useState<OrgForm>(EMPTY_ORG)

  const [addVenue, setAddVenue] = useState(false)
  const [venue, setVenue] = useState<VenueDraft>(EMPTY_VENUE)
  const [areas, setAreas] = useState<AreaDraft[]>([])

  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof OrgForm>(key: K, val: OrgForm[K]) => setForm((f) => ({ ...f, [key]: val }))
  const setV = <K extends keyof VenueDraft>(key: K, val: VenueDraft[K]) => setVenue((v) => ({ ...v, [key]: val }))

  const addArea = () => setAreas((prev) => [...prev, { name: '', description: '', capacity: '' }])
  const removeArea = (idx: number) => setAreas((prev) => prev.filter((_, i) => i !== idx))
  const setArea = (idx: number, key: keyof AreaDraft, val: string) =>
    setAreas((prev) => prev.map((a, i) => i === idx ? { ...a, [key]: val } : a))

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      // 1. Insert the organization
      const orgPayload = {
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

      const { data: orgData, error: orgError } = await supabase
        .from('organizations')
        .insert(orgPayload as TablesInsert<'organizations'>)
        .select('id')
        .single()
      if (orgError) throw orgError

      // 2. If venue section is filled, insert the venue linked to this org
      if (addVenue && venue.name.trim()) {
        const coords = await geocodeAddress({
          address: venue.address, city: venue.city,
          state: venue.state, zip: venue.zip,
        })

        const venuePayload = {
          name:            venue.name,
          description:     venue.description || null,
          website:         venue.website || null,
          address:         venue.address || null,
          city:            venue.city || 'Akron',
          state:           venue.state || 'OH',
          zip:             venue.zip || null,
          lat:             coords?.lat ?? null,
          lng:             coords?.lng ?? null,
          parking_type:    venue.parking_type,
          parking_notes:   venue.parking_notes || null,
          organization_id: (orgData as { id: string } | null)?.id ?? null,
          status:          'pending_review',
        }

        const { data: venueData, error: venueError } = await supabase
          .from('venues')
          .insert(venuePayload as TablesInsert<'venues'>)
          .select('id')
          .single()
        if (venueError) throw venueError

        // 3. Insert areas if any
        const validAreas = areas.filter((a) => a.name.trim())
        if (validAreas.length > 0 && venueData?.id) {
          const areaRows = validAreas.map((a) => ({
            venue_id:    venueData.id,
            name:        a.name.trim(),
            description: a.description || null,
            capacity:    a.capacity ? parseInt(a.capacity) : null,
          }))
          const { error: areaError } = await supabase.from('areas').insert(areaRows as TablesInsert<'areas'>[])
          if (areaError) console.warn('Area insert failed:', areaError.message)
        }
      }

      setStatus('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setStatus('error')
    }
  }

  const resetForm = () => {
    setStatus(null)
    setForm(EMPTY_ORG)
    setVenue(EMPTY_VENUE)
    setAreas([])
    setAddVenue(false)
  }

  if (status === 'success') {
    return (
      <div className="page-shell">
        <div className="success-box">
          <div className="success-icon">✓</div>
          <h2 className="page-title">Organization submitted!</h2>
          <p className="page-sub">
            Thanks for registering{addVenue ? ' your organization and venue' : ''}.
            We'll review your submission and publish it shortly.
            Once approved, you'll be able to link your events and venues.
          </p>
          <div className="success-actions">
            <button className="btn-submit-form" onClick={resetForm}>
              Submit Another
            </button>
            <Link to="/" className="btn-submit-form btn-submit-outline">
              Find an Event
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell">
      <SEO
        title="Submit Organization | Register an Akron Nonprofit or Host"
        description="Register your organization on Akron Pulse so locals can find your events, programs, and venues."
        path="/organizations/submit"
      />
      <h1 className="page-title">Register an Organization</h1>
      <p className="page-sub">
        Add your organization to Akron Pulse so people in Akron can discover your events and venues.
      </p>

      <div className="notice-box">
        All submissions are reviewed before going live. We'll reach out if we have questions.
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-section-label">Organization details</div>

        <div className="form-group">
          <label className="form-label">Organization name <span className="req">*</span></label>
          <input className="form-input" required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Akron Art Museum" />
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-textarea" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Tell people about your organization…" />
        </div>

        <div className="form-group">
          <label className="form-label">Website</label>
          <input className="form-input" type="url" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://…" />
        </div>

        <div className="form-section-label">Location</div>

        <div className="form-group">
          <label className="form-label">Address</label>
          <input className="form-input" value={form.address} onChange={(e) => set('address', e.target.value)} placeholder="Street address" />
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

        <div className="form-section-label">Contact info (not public)</div>

        <div className="form-group">
          <label className="form-label">Contact email <span className="req">*</span></label>
          <input className="form-input" type="email" required value={form.contact_email} onChange={(e) => set('contact_email', e.target.value)} placeholder="you@organization.com" />
          <p className="form-hint">We'll use this to contact you about your submission. This is never shown publicly.</p>
        </div>

        {/* ── Venue toggle ── */}
        <div className="form-section-label">Register a venue (optional)</div>
        <p className="form-hint" style={{ marginBottom: 14 }}>
          Does your organization operate a venue where events take place? You can register it here and it will be automatically linked.
        </p>

        {!addVenue ? (
          <button type="button" className="venue-add-area-btn" onClick={() => setAddVenue(true)}>
            + Add a venue
          </button>
        ) : (
          <div className="inline-venue-block">
            <div className="inline-venue-header">
              <span className="inline-venue-title">Venue details</span>
              <button type="button" className="inline-venue-remove" onClick={() => { setAddVenue(false); setVenue(EMPTY_VENUE); setAreas([]) }}>
                Remove venue
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">Venue name <span className="req">*</span></label>
              <input className="form-input" required value={venue.name} onChange={(e) => setV('name', e.target.value)} placeholder="e.g. Lock 3 Park" />
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" value={venue.description} onChange={(e) => setV('description', e.target.value)} placeholder="What kind of venue is this?" />
            </div>

            <div className="form-group">
              <label className="form-label">Website</label>
              <input className="form-input" type="url" value={venue.website} onChange={(e) => setV('website', e.target.value)} placeholder="https://…" />
            </div>

            <div className="form-group">
              <label className="form-label">Street address</label>
              <input className="form-input" value={venue.address} onChange={(e) => setV('address', e.target.value)} placeholder="200 S Main St" />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">City</label>
                <input className="form-input" value={venue.city} onChange={(e) => setV('city', e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">State</label>
                <input className="form-input" value={venue.state} onChange={(e) => setV('state', e.target.value)} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Zip code</label>
              <input className="form-input" value={venue.zip} onChange={(e) => setV('zip', e.target.value)} placeholder="44308" />
            </div>

            <div className="form-group">
              <label className="form-label">Parking type</label>
              <select className="form-select" value={venue.parking_type} onChange={(e) => setV('parking_type', e.target.value)}>
                {PARKING_TYPES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Parking notes</label>
              <input className="form-input" value={venue.parking_notes} onChange={(e) => setV('parking_notes', e.target.value)} placeholder="e.g. Free after 6pm on weekdays" />
            </div>

            {/* ── Areas ── */}
            <div style={{ marginTop: 18, marginBottom: 4, fontSize: '0.7rem', fontFamily: 'var(--font-display)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-muted)' }}>Areas (optional)</div>
            <p className="form-hint" style={{ marginBottom: 12 }}>
              Does this venue have distinct spaces? Add them here (e.g. "Main Stage", "Gallery Room", "Patio").
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

            <div className="form-group">
              <label className="form-label">Venue contact email</label>
              <input className="form-input" type="email" value={venue.contact_email} onChange={(e) => setV('contact_email', e.target.value)} placeholder="venue@example.com" />
              <p className="form-hint">Optional. If different from the organization contact.</p>
            </div>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <button className="btn-submit-form" type="submit" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Submitting…' : addVenue ? 'Submit Organization & Venue for Review' : 'Submit Organization for Review'}
        </button>
      </form>
    </div>
  )
}
