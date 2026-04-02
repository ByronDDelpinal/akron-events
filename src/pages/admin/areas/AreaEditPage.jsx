import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useFormState } from '@/lib/admin/useFormState'
import { FormField, FormInput, FormSelect, FormTextarea } from '@/components/admin'

const DEFAULT_AREA = { name: '', venue_id: null, description: '', capacity: null }

export default function AreaEditPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id

  const [ready, setReady] = useState(isNew)
  const [seed, setSeed] = useState(DEFAULT_AREA)
  const [allVenues, setAllVenues] = useState([])

  useEffect(() => {
    supabase.from('venues').select('id, name').order('name').then(({ data }) => setAllVenues(data ?? []))
    if (!isNew) {
      ;(async () => {
        const { data } = await supabase.from('areas').select('*').eq('id', id).single()
        if (data) setSeed(data)
        setReady(true)
      })()
    }
  }, [id, isNew])

  if (!ready) return <div className="admin-loading">Loading area…</div>

  return <AreaForm seed={seed} isNew={isNew} areaId={id} allVenues={allVenues} onNavigateBack={() => navigate('/admin/areas')} />
}

function AreaForm({ seed, isNew, areaId, allVenues, onNavigateBack }) {
  const { form, setField } = useFormState(seed)

  const handleSubmit = async (e) => {
    e.preventDefault()
    const areaFields = {
      name:        form.name,
      venue_id:    form.venue_id,
      description: form.description ?? null,
      capacity:    form.capacity ?? null,
    }

    if (isNew) {
      const { error } = await supabase.from('areas').insert(areaFields)
      if (error) { alert('Create failed: ' + error.message); return }
    } else {
      const { error } = await supabase.from('areas').update(areaFields).eq('id', areaId)
      if (error) { alert('Save failed: ' + error.message); return }
    }
    onNavigateBack()
  }

  return (
    <div className="admin-edit-page">
      <div className="admin-edit-header">
        <button className="btn-admin-ghost" onClick={onNavigateBack}>← Back</button>
        <h2 className="admin-edit-title">{isNew ? 'New Area' : 'Edit Area'}</h2>
      </div>

      <form onSubmit={handleSubmit} className="admin-edit-form">
        <FormField label="Name">
          <FormInput value={form.name} onChange={e => setField('name', e.target.value)} />
        </FormField>

        <FormField label="Venue">
          <FormSelect
            value={form.venue_id}
            onChange={e => setField('venue_id', e.target.value || null)}
            options={allVenues.map(v => ({ value: v.id, label: v.name }))}
            placeholder="Select venue…"
          />
        </FormField>

        <FormField label="Description">
          <FormTextarea value={form.description} onChange={e => setField('description', e.target.value)} rows={2} />
        </FormField>

        <FormField label="Capacity">
          <FormInput type="number" value={form.capacity} onChange={e => setField('capacity', e.target.value === '' ? null : parseInt(e.target.value))} />
        </FormField>

        <div className="admin-edit-footer">
          <button type="button" className="btn-admin-ghost" onClick={onNavigateBack}>Cancel</button>
          <button type="submit" className="btn-admin-primary">{isNew ? 'Create Area' : 'Save Changes'}</button>
        </div>
      </form>
    </div>
  )
}
