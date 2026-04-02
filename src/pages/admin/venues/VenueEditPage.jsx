import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { STATUSES, PARKING_TYPES } from '@/lib/admin/constants'
import { useFormState } from '@/lib/admin/useFormState'
import { useOverrides } from '@/lib/admin/useOverrides'
import {
  FormField, FormFieldRow, FormInput, FormSelect, FormTextarea,
  OverrideLockDisplay, ConfirmDialog,
} from '@/components/admin'

const DEFAULT_VENUE = {
  name: '', status: 'published', address: '', city: 'Akron', state: 'OH',
  zip: '', description: '', website: '', lat: null, lng: null,
  parking_type: 'unknown', parking_notes: '', organization_id: null,
  tags: [], image_url: '', manual_overrides: {},
}

export default function VenueEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id

  const [ready, setReady] = useState(isNew)
  const [seed, setSeed] = useState(DEFAULT_VENUE)
  const [allOrgs, setAllOrgs] = useState([])
  const [areas, setAreas] = useState([])

  const fetchAreas = useCallback(async (venueId) => {
    if (!venueId) return
    const { data } = await supabase.from('areas').select('*').eq('venue_id', venueId).order('name')
    setAreas(data ?? [])
  }, [])

  useEffect(() => {
    supabase.from('organizations').select('id, name').order('name').then(({ data }) => setAllOrgs(data ?? []))
    if (!isNew) {
      ;(async () => {
        const { data } = await supabase.from('venues').select('*').eq('id', id).single()
        if (data) setSeed(data)
        await fetchAreas(id)
        setReady(true)
      })()
    }
  }, [id, isNew])

  if (!ready) return <div className="admin-loading">Loading venue…</div>

  return (
    <VenueForm
      seed={seed} isNew={isNew} allOrgs={allOrgs} venueId={id}
      areas={areas} onAreasChange={() => fetchAreas(id)}
      onNavigateBack={() => navigate('/admin/venues')}
    />
  )
}

function VenueForm({ seed, isNew, allOrgs, venueId, areas, onAreasChange, onNavigateBack }) {
  const { form, setField } = useFormState(seed)
  const { overrides, toggleOverride } = useOverrides(seed.manual_overrides)

  const handleSubmit = async (e) => {
    e.preventDefault()
    const venueFields = {
      name:             form.name,
      status:           form.status ?? 'published',
      address:          form.address ?? null,
      city:             form.city ?? null,
      state:            form.state ?? null,
      zip:              form.zip ?? null,
      description:      form.description ?? null,
      website:          form.website ?? null,
      lat:              form.lat ?? null,
      lng:              form.lng ?? null,
      parking_type:     form.parking_type ?? 'unknown',
      parking_notes:    form.parking_notes ?? null,
      organization_id:  form.organization_id ?? null,
      tags:             form.tags ?? [],
      image_url:        form.image_url ?? null,
      manual_overrides: overrides,
    }

    if (isNew) {
      const { error } = await supabase.from('venues').insert(venueFields)
      if (error) { alert('Create failed: ' + error.message); return }
    } else {
      const { error } = await supabase.from('venues').update(venueFields).eq('id', venueId)
      if (error) { alert('Save failed: ' + error.message); return }
    }
    onNavigateBack()
  }

  return (
    <div className="admin-edit-page">
      <div className="admin-edit-header">
        <button className="btn-admin-ghost" onClick={onNavigateBack}>← Back</button>
        <h2 className="admin-edit-title">{isNew ? 'New Venue' : 'Edit Venue'}</h2>
      </div>

      <form onSubmit={handleSubmit} className="admin-edit-form">
        <FormField label="Name" field="name" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.name} onChange={e => setField('name', e.target.value)} />
        </FormField>

        <FormField label="Status">
          <FormSelect value={form.status} onChange={e => setField('status', e.target.value)} options={STATUSES} />
        </FormField>

        <FormField label="Address" field="address" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.address} onChange={e => setField('address', e.target.value)} />
        </FormField>

        <FormFieldRow>
          <FormField label="City">
            <FormInput value={form.city} onChange={e => setField('city', e.target.value)} />
          </FormField>
          <FormField label="State">
            <FormInput value={form.state} onChange={e => setField('state', e.target.value)} />
          </FormField>
          <FormField label="Zip">
            <FormInput value={form.zip} onChange={e => setField('zip', e.target.value)} />
          </FormField>
        </FormFieldRow>

        <FormField label="Description">
          <FormTextarea value={form.description} onChange={e => setField('description', e.target.value)} />
        </FormField>

        <FormFieldRow>
          <FormField label="Lat">
            <FormInput type="number" step="any" value={form.lat} onChange={e => setField('lat', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
          <FormField label="Lng">
            <FormInput type="number" step="any" value={form.lng} onChange={e => setField('lng', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="Parking Type">
            <FormSelect value={form.parking_type} onChange={e => setField('parking_type', e.target.value)} options={PARKING_TYPES} />
          </FormField>
          <FormField label="Website">
            <FormInput value={form.website} onChange={e => setField('website', e.target.value)} />
          </FormField>
        </FormFieldRow>

        <FormField label="Parking Notes">
          <FormInput value={form.parking_notes} onChange={e => setField('parking_notes', e.target.value)} />
        </FormField>

        <FormField label="Organization">
          <FormSelect
            value={form.organization_id}
            onChange={e => setField('organization_id', e.target.value || null)}
            options={allOrgs.map(o => ({ value: o.id, label: o.name }))}
            placeholder="None"
          />
        </FormField>

        <FormField label="Tags (comma-separated)">
          <FormInput
            value={(form.tags ?? []).join(', ')}
            onChange={e => setField('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
          />
        </FormField>

        <FormField label="Image URL">
          <FormInput value={form.image_url} onChange={e => setField('image_url', e.target.value)} />
        </FormField>

        <OverrideLockDisplay overrides={overrides} />

        <div className="admin-edit-footer">
          <button type="button" className="btn-admin-ghost" onClick={onNavigateBack}>Cancel</button>
          <button type="submit" className="btn-admin-primary">{isNew ? 'Create Venue' : 'Save Changes'}</button>
        </div>
      </form>

      {/* Areas section — only shown for existing venues */}
      {!isNew && (
        <VenueAreasSection venueId={venueId} areas={areas} onAreasChange={onAreasChange} />
      )}
    </div>
  )
}

// ── Venue Areas ───────────────────────────────────────────────────────────

function VenueAreasSection({ venueId, areas, onAreasChange }) {
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('areas').delete().eq('id', deleting.id)
    setDeleting(null)
    onAreasChange()
  }

  return (
    <div className="admin-venue-areas">
      <div className="admin-section-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Areas ({areas.length})</span>
        {!adding && (
          <button type="button" className="btn-admin-sm" onClick={() => setAdding(true)}>+ Add Area</button>
        )}
      </div>

      {adding && (
        <AddAreaForm
          venueId={venueId}
          onSaved={() => { setAdding(false); onAreasChange() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {areas.length === 0 && !adding && (
        <p className="admin-hint">No areas yet. Add areas like stages, rooms, or fields within this venue.</p>
      )}

      {areas.length > 0 && (
        <div className="admin-areas-list">
          {areas.map(a => (
            <div key={a.id} className="admin-area-row">
              <div className="admin-area-info">
                <Link to={`/admin/areas/${a.id}/edit`} className="admin-td-link admin-area-name">{a.name}</Link>
                {a.capacity && <span className="admin-area-cap">Capacity: {a.capacity}</span>}
                {a.description && <span className="admin-area-desc">{a.description}</span>}
              </div>
              <div className="admin-area-actions">
                <Link to={`/admin/areas/${a.id}/edit`} className="btn-admin-sm">Edit</Link>
                <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(a)}>Del</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          message={`Delete area "${deleting.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

function AddAreaForm({ venueId, onSaved, onCancel }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [capacity, setCapacity] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    const { error } = await supabase.from('areas').insert({
      name: name.trim(),
      venue_id: venueId,
      description: description.trim() || null,
      capacity: capacity ? parseInt(capacity) : null,
    })
    setSaving(false)
    if (error) { alert('Failed to add area: ' + error.message); return }
    onSaved()
  }

  return (
    <form onSubmit={handleSubmit} className="admin-add-area-form">
      <FormFieldRow>
        <FormField label="Name">
          <FormInput value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Main Stage" autoFocus />
        </FormField>
        <FormField label="Capacity">
          <FormInput type="number" value={capacity} onChange={e => setCapacity(e.target.value)} placeholder="Optional" />
        </FormField>
      </FormFieldRow>
      <FormField label="Description">
        <FormInput value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
      </FormField>
      <div className="admin-add-area-actions">
        <button type="button" className="btn-admin-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-admin-primary" disabled={!name.trim() || saving}>
          {saving ? 'Adding…' : 'Add Area'}
        </button>
      </div>
    </form>
  )
}
