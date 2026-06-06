import { useState, useEffect, useCallback, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { CATEGORIES, STATUSES, AGE_OPTIONS } from '@/lib/admin/constants'
import { useFormState } from '@/lib/admin/useFormState'
import { useOverrides } from '@/lib/admin/useOverrides'
import {
  FormField, FormFieldRow, FormInput, FormSelect, FormTextarea,
  ChipSelector, EntityMultiSelect, OverrideLockDisplay,
} from '@/components/admin'

type Row = Record<string, any>
type SetIds = Dispatch<SetStateAction<string[]>>

const DEFAULT_EVENT: Row = {
  title: '', description: '', status: 'published', categories: [],
  start_at: '', end_at: '', price_min: 0, price_max: null,
  age_restriction: 'not_specified', ticket_url: '', source_url: '', image_url: '',
  featured: false, manual_overrides: {},
}

export default function EventEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id

  const [ready, setReady] = useState(isNew)
  const [seed, setSeed] = useState<Row>(DEFAULT_EVENT)

  // Relationship lookups
  const [allVenues, setAllVenues] = useState<Row[]>([])
  const [allOrgs, setAllOrgs] = useState<Row[]>([])
  const [allAreas, setAllAreas] = useState<Row[]>([])
  const [linkedVenueIds, setLinkedVenueIds] = useState<string[]>([])
  const [linkedOrgIds, setLinkedOrgIds] = useState<string[]>([])
  const [linkedAreaIds, setLinkedAreaIds] = useState<string[]>([])

  const fetchRelated = useCallback(async () => {
    const [v, o, a] = await Promise.all([
      supabase.from('venues').select('id, name').order('name'),
      supabase.from('organizations').select('id, name').order('name'),
      supabase.from('areas').select('id, name, venue_id').order('name'),
    ])
    setAllVenues((v.data ?? []) as Row[])
    setAllOrgs((o.data ?? []) as Row[])
    setAllAreas((a.data ?? []) as Row[])
  }, [])

  useEffect(() => {
    fetchRelated()
    if (!isNew && id) {
      ;(async () => {
        const { data } = await supabase
          .from('events')
          .select(`
            *,
            event_categories ( category ),
            event_venues ( venue_id, venue:venues ( id, name ) ),
            event_organizations ( organization_id, organization:organizations ( id, name ) ),
            event_areas ( area_id, area:areas ( id, name ) )
          `)
          .eq('id', id)
          .single()
        if (data) {
          const row = data as Row
          setSeed({ ...row, categories: (row.event_categories ?? []).map((ec: Row) => ec.category) })
          setLinkedVenueIds((row.event_venues ?? []).map((ev: Row) => ev.venue_id ?? ev.venue?.id).filter(Boolean))
          setLinkedOrgIds((row.event_organizations ?? []).map((eo: Row) => eo.organization_id ?? eo.organization?.id).filter(Boolean))
          setLinkedAreaIds((row.event_areas ?? []).map((ea: Row) => ea.area_id ?? ea.area?.id).filter(Boolean))
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

interface EventFormProps {
  seed: Row
  isNew: boolean
  allVenues: Row[]
  allOrgs: Row[]
  allAreas: Row[]
  linkedVenueIds: string[]
  setLinkedVenueIds: SetIds
  linkedOrgIds: string[]
  setLinkedOrgIds: SetIds
  linkedAreaIds: string[]
  setLinkedAreaIds: SetIds
  onNavigateBack: () => void
  eventId?: string
}

/** Inner form component — only mounts once seed data is ready. */
function EventForm({
  seed, isNew, allVenues, allOrgs, allAreas,
  linkedVenueIds, setLinkedVenueIds,
  linkedOrgIds, setLinkedOrgIds,
  linkedAreaIds, setLinkedAreaIds,
  onNavigateBack, eventId,
}: EventFormProps) {
  const { form, setField } = useFormState(seed)
  const { overrides, toggleOverride } = useOverrides(seed.manual_overrides)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    const eventFields = {
      title:           form.title,
      description:     form.description ?? null,
      status:          form.status,
      start_at:        form.start_at,
      end_at:          form.end_at ?? null,
      price_min:       form.price_min ?? 0,
      price_max:       form.price_max ?? null,
      age_restriction: form.age_restriction ?? 'not_specified',
      ticket_url:      form.ticket_url ?? null,
      source_url:      form.source_url ?? null,
      image_url:       form.image_url ?? null,
      featured:        form.featured ?? false,
      manual_overrides: overrides,
    }

    let id: string | undefined = eventId
    if (isNew) {
      const { data, error } = await supabase.from('events').insert(eventFields as any).select('id').single()
      if (error) { alert('Create failed: ' + error.message); return }
      id = (data as Row).id
    } else {
      const { error } = await supabase.from('events').update(eventFields as any).eq('id', id!)
      if (error) { alert('Save failed: ' + error.message); return }
    }

    // Content categories live in event_categories (up to 2). Replace with the
    // admin-selected set; the manual_overrides 'category' lock prevents scraper
    // re-inference.
    await supabase.from('event_categories').delete().eq('event_id', id!)
    const cats = [...new Set<string>(form.categories ?? [])].slice(0, 2)
    if (cats.length) {
      const { error: catErr } = await supabase
        .from('event_categories')
        .insert(cats.map((category) => ({ event_id: id, category })) as any)
      if (catErr) { alert('Category save failed: ' + catErr.message); return }
    }

    // Junction tables
    if (!isNew) await supabase.from('event_venues').delete().eq('event_id', id!)
    if (linkedVenueIds.length > 0) {
      await supabase.from('event_venues').insert(linkedVenueIds.map((vid) => ({ event_id: id, venue_id: vid })) as any)
    }

    if (!isNew) await supabase.from('event_organizations').delete().eq('event_id', id!)
    if (linkedOrgIds.length > 0) {
      await supabase.from('event_organizations').insert(linkedOrgIds.map((oid) => ({ event_id: id, organization_id: oid })) as any)
    }

    if (!isNew) await supabase.from('event_areas').delete().eq('event_id', id!)
    if (linkedAreaIds.length > 0) {
      await supabase.from('event_areas').insert(linkedAreaIds.map((aid) => ({ event_id: id, area_id: aid })) as any)
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
          <FormInput value={form.title} onChange={(e) => setField('title', e.target.value)} />
        </FormField>

        <FormFieldRow>
          <FormField label="Status">
            <FormSelect value={form.status} onChange={(e) => setField('status', e.target.value)} options={STATUSES as unknown as string[]} />
          </FormField>
          <FormField label="Categories" field="category" overrides={overrides} onToggleOverride={toggleOverride}>
            <ChipSelector
              items={CATEGORIES.map((c) => ({ id: c.value, name: c.label }))}
              selectedIds={form.categories ?? []}
              onChange={(ids) => setField('categories', ids)}
              max={2}
            />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="Start" field="start_at" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput
              type="datetime-local"
              value={form.start_at ? form.start_at.slice(0, 16) : ''}
              onChange={(e) => setField('start_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
            />
          </FormField>
          <FormField label="End" field="end_at" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput
              type="datetime-local"
              value={form.end_at ? form.end_at.slice(0, 16) : ''}
              onChange={(e) => setField('end_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
            />
          </FormField>
        </FormFieldRow>

        <FormField label="Description" field="description" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormTextarea value={form.description} onChange={(e) => setField('description', e.target.value)} rows={4} />
        </FormField>

        <FormFieldRow>
          <FormField label="Price Min" field="price_min" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput type="number" min="0" step="0.01" value={form.price_min} onChange={(e) => setField('price_min', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
          <FormField label="Price Max" field="price_max" overrides={overrides} onToggleOverride={toggleOverride}>
            <FormInput type="number" min="0" step="0.01" value={form.price_max} onChange={(e) => setField('price_max', e.target.value === '' ? null : parseFloat(e.target.value))} />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="Age Restriction">
            <FormSelect value={form.age_restriction} onChange={(e) => setField('age_restriction', e.target.value)} options={AGE_OPTIONS as unknown as string[]} />
          </FormField>
          <FormField label="Featured">
            <label className="admin-checkbox-label">
              <input type="checkbox" checked={!!form.featured} onChange={(e) => setField('featured', e.target.checked)} />
              Featured event
            </label>
          </FormField>
        </FormFieldRow>

        <FormField label="Ticket URL" field="ticket_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.ticket_url} onChange={(e) => setField('ticket_url', e.target.value)} />
        </FormField>

        <FormField label="Source URL" field="source_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.source_url} onChange={(e) => setField('source_url', e.target.value)} />
        </FormField>

        <FormField label="Image URL" field="image_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.image_url} onChange={(e) => setField('image_url', e.target.value)} />
        </FormField>

        <FormField label="Linked Venues">
          <EntityMultiSelect
            allEntities={allVenues as any}
            selectedIds={linkedVenueIds}
            onChange={setLinkedVenueIds}
            placeholder="Search and select venues…"
          />
        </FormField>

        <FormField label="Linked Organizations">
          <EntityMultiSelect
            allEntities={allOrgs as any}
            selectedIds={linkedOrgIds}
            onChange={setLinkedOrgIds}
            placeholder="Search and select organizations…"
          />
        </FormField>

        <ChipSelector label="Linked Areas" items={allAreas as any} selectedIds={linkedAreaIds} onChange={setLinkedAreaIds} />

        <OverrideLockDisplay overrides={overrides} />

        <div className="admin-edit-footer">
          <button type="button" className="btn-admin-ghost" onClick={onNavigateBack}>Cancel</button>
          <button type="submit" className="btn-admin-primary">{isNew ? 'Create Event' : 'Save Changes'}</button>
        </div>
      </form>
    </div>
  )
}
