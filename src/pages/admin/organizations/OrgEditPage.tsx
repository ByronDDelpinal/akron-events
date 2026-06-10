import type { TablesInsert, TablesUpdate } from '@/lib/database.types'
import type { LooseRow } from '@/types'
import { useState, useEffect, type Dispatch, type FormEvent, type SetStateAction } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { STATUSES } from '@/lib/admin/constants'
import { useFormState } from '@/lib/admin/useFormState'
import { useOverrides } from '@/lib/admin/useOverrides'
import {
  FormField, FormFieldRow, FormInput, FormSelect, FormTextarea,
  EntityMultiSelect, OverrideLockDisplay,
} from '@/components/admin'

type Row = LooseRow

const DEFAULT_ORG: Row = {
  name: '', status: 'published', description: '', website: '',
  address: '', city: '', state: 'OH', zip: '', contact_email: '',
  image_url: '', manual_overrides: {},
}

export default function OrgEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id

  const [ready, setReady] = useState(isNew)
  const [seed, setSeed] = useState<Row>(DEFAULT_ORG)
  const [allVenues, setAllVenues] = useState<Row[]>([])
  const [ownedVenueIds, setOwnedVenueIds] = useState<string[]>([])

  useEffect(() => {
    supabase.from('venues').select('id, name, organization_id').order('name').then(({ data }) => setAllVenues((data ?? []) as Row[]))
    if (!isNew && id) {
      ;(async () => {
        const { data } = await supabase
          .from('organizations')
          .select('*, venues ( id, name )')
          .eq('id', id)
          .single()
        if (data) {
          setSeed(data as Row)
          setOwnedVenueIds(((data as Row).venues ?? []).map((v: Row) => v.id))
        }
        setReady(true)
      })()
    }
  }, [id, isNew])

  if (!ready) return <div className="admin-loading">Loading organization…</div>

  return (
    <OrgForm
      seed={seed} isNew={isNew} orgId={id}
      allVenues={allVenues} ownedVenueIds={ownedVenueIds} setOwnedVenueIds={setOwnedVenueIds}
      onNavigateBack={() => navigate('/admin/organizations')}
    />
  )
}

interface OrgFormProps {
  seed: Row
  isNew: boolean
  orgId?: string
  allVenues: Row[]
  ownedVenueIds: string[]
  setOwnedVenueIds: Dispatch<SetStateAction<string[]>>
  onNavigateBack: () => void
}

function OrgForm({ seed, isNew, orgId, allVenues, ownedVenueIds, setOwnedVenueIds, onNavigateBack }: OrgFormProps) {
  const { form, setField } = useFormState(seed)
  const { overrides, toggleOverride } = useOverrides(seed.manual_overrides)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const orgFields = {
      name:             form.name,
      status:           form.status,
      description:      form.description ?? null,
      website:          form.website ?? null,
      address:          form.address ?? null,
      city:             form.city ?? null,
      state:            form.state ?? null,
      zip:              form.zip ?? null,
      contact_email:    form.contact_email ?? null,
      image_url:        form.image_url ?? null,
      manual_overrides: overrides,
    }

    let id: string | undefined = orgId
    if (isNew) {
      const { data, error } = await supabase.from('organizations').insert(orgFields as unknown as TablesInsert<'organizations'>).select('id').single()
      if (error) { alert('Create failed: ' + error.message); return }
      id = (data as Row).id
    } else {
      const { error } = await supabase.from('organizations').update(orgFields as unknown as TablesUpdate<'organizations'>).eq('id', id!)
      if (error) { alert('Save failed: ' + error.message); return }
    }

    // Update venue ownership
    const currentlyOwned = allVenues.filter((v) => v.organization_id === id).map((v) => v.id)
    const toAssign = ownedVenueIds.filter((vid) => !currentlyOwned.includes(vid))
    const toRemove = currentlyOwned.filter((vid: string) => !ownedVenueIds.includes(vid))

    if (toAssign.length > 0) {
      const { error } = await supabase.from('venues').update({ organization_id: id }).in('id', toAssign)
      if (error) { alert('Failed to assign venues: ' + error.message); return }
    }
    if (toRemove.length > 0) {
      const { error } = await supabase.from('venues').update({ organization_id: null }).in('id', toRemove)
      if (error) { alert('Failed to unassign venues: ' + error.message); return }
    }

    onNavigateBack()
  }

  return (
    <div className="admin-edit-page">
      <div className="admin-edit-header">
        <button className="btn-admin-ghost" onClick={onNavigateBack}>← Back</button>
        <h2 className="admin-edit-title">{isNew ? 'New Organization' : 'Edit Organization'}</h2>
      </div>

      <form onSubmit={handleSubmit} className="admin-edit-form">
        <FormField label="Name" field="name" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.name} onChange={(e) => setField('name', e.target.value)} />
        </FormField>

        <FormField label="Status">
          <FormSelect value={form.status} onChange={(e) => setField('status', e.target.value)} options={STATUSES as unknown as string[]} />
        </FormField>

        <FormField label="Description" field="description" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormTextarea value={form.description} onChange={(e) => setField('description', e.target.value)} />
        </FormField>

        <FormField label="Website" field="website" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.website} onChange={(e) => setField('website', e.target.value)} />
        </FormField>

        <FormFieldRow>
          <FormField label="Address">
            <FormInput value={form.address} onChange={(e) => setField('address', e.target.value)} />
          </FormField>
          <FormField label="City">
            <FormInput value={form.city} onChange={(e) => setField('city', e.target.value)} />
          </FormField>
        </FormFieldRow>

        <FormFieldRow>
          <FormField label="State">
            <FormInput value={form.state} onChange={(e) => setField('state', e.target.value)} />
          </FormField>
          <FormField label="Zip">
            <FormInput value={form.zip} onChange={(e) => setField('zip', e.target.value)} />
          </FormField>
        </FormFieldRow>

        <FormField label="Contact Email">
          <FormInput type="email" value={form.contact_email} onChange={(e) => setField('contact_email', e.target.value)} />
        </FormField>

        <FormField label="Image URL" field="image_url" overrides={overrides} onToggleOverride={toggleOverride}>
          <FormInput value={form.image_url} onChange={(e) => setField('image_url', e.target.value)} />
          {form.image_url && (
            <div style={{ marginTop: 8 }}>
              <img
                src={form.image_url}
                alt="Preview"
                style={{ maxHeight: 140, maxWidth: '100%', borderRadius: 6, objectFit: 'cover', border: '1px solid var(--border)' }}
                onError={(e) => { e.currentTarget.style.display = 'none' }}
                onLoad={(e) => { e.currentTarget.style.display = 'block' }}
              />
            </div>
          )}
        </FormField>

        <div className="admin-section-label">Owned Venues</div>
        <EntityMultiSelect
          allEntities={allVenues as { id: string; name: string }[]}
          selectedIds={ownedVenueIds}
          onChange={setOwnedVenueIds}
          placeholder="Search and select venues…"
          disabledLabel={(v) => v.organization_id && v.organization_id !== orgId ? 'owned by other org' : null}
        />

        <OverrideLockDisplay overrides={overrides} />

        <div className="admin-edit-footer">
          <button type="button" className="btn-admin-ghost" onClick={onNavigateBack}>Cancel</button>
          <button type="submit" className="btn-admin-primary">{isNew ? 'Create Organization' : 'Save Changes'}</button>
        </div>
      </form>
    </div>
  )
}
