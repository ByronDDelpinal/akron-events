import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { CATEGORIES, STATUSES, AGE_OPTIONS } from '@/lib/admin/constants'
import { useFormState } from '@/lib/admin/useFormState'
import { useOverrides } from '@/lib/admin/useOverrides'
import {
  FormField, FormFieldRow, FormInput, FormSelect, FormTextarea,
  ChipSelector, EntityMultiSelect, OverrideLockDisplay,
} from '@/components/admin'

const DEFAULT_EVENT = {
  title: '', description: '', status: 'published', category: '',
  start_at: '', end_at: '', price_min: 0, price_max: null,
  age_restriction: 'not_specified', ticket_url: '', image_url: '',
  featured: false, manual_overrides: {},
}

export default function EventEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id

  const [ready, setReady] = useState(isNew)
  const [seed, setSeed] = useState(DEFAULT_EVENT)

  // Relationship lookups
  const [allVenues, setAllVenues] = useState([])
  const [allOrgs, setAllOrgs] = useState([])
  const [allAreas, setAllAreas] = useState([])
  const [linkedVenueIds, setLinkedVenueIds] = useState([])
  const [linkedOrgIds, setLinkedOrgIds] = useState([])
  const [linkedAreaIds, setLinkedAreaIds] = useState([])

  const fetchRelated = useCallback(async () => {
    const [v, o, a] = await Promise.all([
      supabase.from('venues').select('id, name').order('name'),
      supabase.from('organizations').select('id, name').order('name'),
      supabase.from('areas').select('id, name, venue_id').order('name'),
    ])
    setAllVenues(v.data ?? [])
    setAllOrgs(o.data ?? [])
    setAllAreas(a.data ?? [])
  }, [])

  useEffect(() => {
    fetchRelated()
    if (!isNew) {
      ;(async () => {
        const { data } = await supabase
          .from('events')
          .select(`
            *,
            event_venues ( venue_id, venue:venues ( id, name ) ),
            event_organizations ( organization_id, organization:organizations ( id, name ) ),
            event_areas ( area_id, area:areas ( id, name ) )
          `)
          .eq('id', id)
          .single()
        if (data) {
          setSeed(data)
          setLinkedVenueIds((data.event_venues ?? []).map(ev => ev.venue_id ?? ev.venue?.id).filter(Boolean))
          setLinkedOrgIds((data.event_organizations ?? []).map(eo => eo.organization_id ?? eo.organization?.id).filter(Boolean))
          setLinkedAreaIds((data.event_areas ?? []).map(ea => ea.area_id ?? ea.area?.id).filter(Boolean))
        }
        setReady(true)
      })()
    }
  }, [id, isNew])

  if (!ready) return <div className="admin-loading">Loading event…</div>

  return (
    <EventForm
      seed={seed}
      isNew={isNew}
      allVenues={allVenues}
      allOrgs={allOrgs}
      allAreas={allAreas}
      linkedVenueIds={linkedVenueIds}
      setLinkedVenueIds={setLinkedVenueIds}
      linkedOrgIds={linkedOrgIds}
      setLinkedOrgIds={setLinkedOrgIds}
      linkedAreaIds={linkedAreaIds}
      setLinkedAreaIds={setLinkedAreaIds}
      onNavigateBack={() => navigate('/admin/events')}
      eventId={id}
    />
  )
}

/** Inner form component — only mounts once seed data is ready. */
function EventForm({
  seed, isNew, allVenues, allOrgs, allAreas,
  linkedVenueIds, setLinkedVenueIds,
  linkedOrgIds, setLinkedOrgIds,
  linkedAreaIds, setLinkedAreaIds,
  onNavigateBack, eventId,
}) {
  const { form, setField } = useFormState(seed)
  const { overrides, toggleOverride } = useOverrides(seed.manual_overrides)

  const handleSubmit = async (e) => {
    e.preventDefault()

    const eventFields = {
      title:           form.title,
      description:     form.description ?? null,
      status:          form.status,
      category:        form.category ?? null,
      start_at:        form.start_at,
      end_at:          form.end_at ?? null,
      price_min:       form.price_min ?? 0,
      price_max:       form.price_max ?? null,
      age_restriction: form.age_restriction ?? 'not_specified',
      ticket_url:      form.ticket_url ?? null,
      image_url:       form.image_url ?? null,
      featured:        form.featured ?? false,
      manual_overrides: overrides,
    }

    let id = eventId
    if (isNew) {
      const { data, error } = await supabase.from('events').insert(eventFields).select('id').single()
      if (error) { alert('Create failed: ' + error.message); return }
      id = data.id
    } else {
      const { error } = await supabase.from('events').update(eventFields).eq('id', id)
      if (error) { alert('Save failed: ' + error.message); return }
    }

    // Junction tables
    if (!isNew) await supabase.from('event_venues').delete().eq('event_id', id)
    if (linkedVenueIds.length > 0) {
      await supabase.from('event_venues').insert(linkedVenueIds.map(vid => ({ event_id: id, venue_id: vid })))
    }

    if (!isNew) await supabase.from('event_organizations').delete().eq('event_id', id)
    if (linkedOrgIds.length > 0) {
      await supabase.from('event_organizations').insert(linkedOrgIds.map(oid => ({ event_id: id, organization_id: oid })))
    }

    if (!isNew) await supabase.from('event_areas').delete().eq('event_id', id)
    if (linkedAreaIds.length > 0) {
      await supabase.from('event_areas').insert(linkedAreaIds.map(aid => ({ event_id: id, area_id: aid })))
    }

    onNavigateBack()
  }

  return (
    <div className="admin-edit-page">
      <div className="admin-edit-header">
        <button className="btn-admin-ghost" onClick={onNavigateBack}>← Back</button>
        <h2 className="admin-edit-title">{isNew ? 'New Event' : 'Edit Event'}</h2>
      </div>

      <form onSubmit={handleSubmit} className="admin-edit-form">
        <FormField label="Title" field="title" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.title} onChange={e => setField('title', e.target.value)} />
        </FormField>

        <FormFieldRow>
          <FormField label="Status">
            <FormSelect value={form.status} onChange={e => setField('status', e.target.value)} options={STATUSES} />
          </FormField>
          <FormField label="Category" field="category" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormSelect value={form.category} onChange={e => setField('category', e.target.value)} options={CATEGORIES} placeholder="—" />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="Start" field="start_at" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput
              type="datetime-local"
              value={form.start_at ? form.start_at.slice(0, 16) : ''}
              onChange={e => setField('start_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
            />
          </FormField>
          <FormField label="End" field="end_at" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput
              type="datetime-local"
              value={form.end_at ? form.end_at.slice(0, 16) : ''}
              onChange={e => setField('end_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
            />
          </FormField>
        </FormFieldRow>

        <FormField label="Description" field="description" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormTextarea value={form.description} onChange={e => setField('description', e.target.value)} rows={4} />
        </FormField>

        <FormFieldRow>
          <FormField label="Price Min" field="price_min" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput type="number" min="0" step="0.01" value={form.price_min} onChange={e => setField('price_min', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
          <FormField label="Price Max" field="price_max" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput type="number" min="0" step="0.01" value={form.price_max} onChange={e => setField('price_max', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="Age Restriction">
            <FormSelect value={form.age_restriction} onChange={e => setField('age_restriction', e.target.value)} options={AGE_OPTIONS} />
          </FormField>
          <FormField label="Featured">
            <label className="admin-checkbox-label">
              <input type="checkbox" checked={!!form.featured} onChange={e => setField('featured', e.target.checked)} />
              Featured event
            </label>
          </FormField>
        </FormFieldRow>

        <FormField label="Ticket URL" field="ticket_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.ticket_url} onChange={e => setField('ticket_url', e.target.value)} />
        </FormField>

        <FormField label="Image URL" field="image_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.image_url} onChange={e => setField('image_url', e.target.value)} />
        </FormField>

        <FormField label="Linked Venues">
          <EntityMultiSelect
            allEntities={allVenues}
            selectedIds={linkedVenueIds}
            onChange={setLinkedVenueIds}
            placeholder="Search and select venues…"
          />
        </FormField>

        <FormField label="Linked Organizations">
          <EntityMultiSelect
            allEntities={allOrgs}
            selectedIds={linkedOrgIds}
            onChange={setLinkedOrgIds}
            placeholder="Search and select organizations…"
          />
        </FormField>

        <ChipSelector label="Linked Areas" items={allAreas} selectedIds={linkedAreaIds} onChange={setLinkedAreaIds} />

        <OverrideLockDisplay overrides={overrides} />

        <div className="admin-edit-footer">
          <button type="button" className="btn-admin-ghost" onClick={onNavigateBack}>Cancel</button>
          <button type="submit" className="btn-admin-primary">{isNew ? 'Create Event' : 'Save Changes'}</button>
        </div>
      </form>
    </div>
  )
}
