/**
 * PartnerOrgEditPage: a partner edits their OWN organization's public details,
 * directly and with no review (organizations carry no moderation/publish
 * workflow). The two RPCs are the enforcement:
 *   - partner_org_details(p_org) seeds the form (scope-checked read).
 *   - partner_update_org(p_org, p_patch) writes an allowlist of columns; the
 *     org is verified against partner_scope() server-side. status, slug,
 *     manual_overrides and venue ownership stay admin-only.
 *
 * Org choice mirrors PartnerCreateEventPage: one membership -> suppressed and
 * defaulted; several -> an explicit picker with no default.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { usePartnerContext } from '@/lib/admin/usePartnerContext'
import { FormField, FormFieldRow, FormInput, FormSelect, FormTextarea } from '@/components/admin'

const MAX_ORG_PHOTOS = 12

interface OrgForm {
  name: string
  description: string
  website: string
  contact_email: string
  image_url: string
  address: string
  city: string
  state: string
  zip: string
  photos: string[]
}

const EMPTY: OrgForm = {
  name: '', description: '', website: '', contact_email: '', image_url: '',
  address: '', city: '', state: '', zip: '', photos: [],
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export default function PartnerOrgEditPage() {
  const { orgs } = usePartnerContext()

  const [orgId, setOrgId] = useState<string>(orgs.length === 1 ? orgs[0].organization_id : '')
  const [form, setForm] = useState<OrgForm>(EMPTY)
  const [loading, setLoading] = useState(false)
  // True only once partner_org_details has seeded the form for the chosen
  // org. The patch always carries every key, so saving an unseeded form
  // would overwrite real values with blanks -- lock the form until seeded.
  const [seeded, setSeeded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const chosenOrg = useMemo(
    () => orgs.find((o) => o.organization_id === orgId) ?? null,
    [orgs, orgId],
  )

  const setField = <K extends keyof OrgForm>(key: K, val: OrgForm[K]) => {
    setForm((f) => ({ ...f, [key]: val }))
    setSaved(false)
    setError(null)
  }

  useEffect(() => {
    setSeeded(false)
    if (!orgId) { setForm(EMPTY); return }
    let active = true
    setLoading(true)
    setError(null)
    supabase.rpc('partner_org_details', { p_org: orgId }).then(({ data, error: err }) => {
      if (!active) return
      setLoading(false)
      if (err) { setError(err.message); return }
      const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null
      if (!row) { setError('Could not load this organization.'); return }
      setForm({
        name: str(row.name),
        description: str(row.description),
        website: str(row.website),
        contact_email: str(row.contact_email),
        image_url: str(row.image_url),
        address: str(row.address),
        city: str(row.city),
        state: str(row.state),
        zip: str(row.zip),
        photos: Array.isArray(row.photos) ? (row.photos as string[]) : [],
      })
      setSeeded(true)
    })
    return () => { active = false }
  }, [orgId])

  const locked = !orgId || loading || !seeded

  const photos = form.photos
  const setPhotos = (next: string[]) => setField('photos', next.slice(0, MAX_ORG_PHOTOS))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!orgId) { setError('Choose an organization.'); return }
    if (!seeded) { setError('This organization has not loaded yet.'); return }
    if (!form.name.trim()) { setError('The organization needs a name.'); return }
    setBusy(true)
    setError(null)
    setSaved(false)

    const patch = {
      name: form.name.trim(),
      description: form.description,
      website: form.website,
      contact_email: form.contact_email,
      image_url: form.image_url,
      address: form.address,
      city: form.city,
      state: form.state,
      zip: form.zip,
      photos: photos.map((p) => p.trim()).filter(Boolean).slice(0, MAX_ORG_PHOTOS),
    }

    const { error: rpcError } = await supabase.rpc('partner_update_org', { p_org: orgId, p_patch: patch })
    setBusy(false)
    if (rpcError) { setError(rpcError.message); return }
    setSaved(true)
  }

  return (
    <div className="ashell-work ashell-pcreate">
      <div className="ashell-surface-hd">
        <h2>Your organization</h2>
      </div>

      {orgs.length === 0 ? (
        <div className="ashell-empty">
          <h3>No organization</h3>
          <p>This account is not linked to an organization yet.</p>
        </div>
      ) : (
        <form className="ashell-pform" onSubmit={submit}>
          <div className="ashell-pform-col">
            <h3 className="ashell-pform-lbl">Details</h3>

            {orgs.length > 1 && (
              <FormField label="Organization">
                <FormSelect
                  value={orgId}
                  onChange={(e) => { setOrgId(e.target.value); setSaved(false); setError(null) }}
                  options={orgs.map((o) => ({ value: o.organization_id, label: o.name }))}
                  placeholder="Choose an organization…"
                  required
                />
              </FormField>
            )}

            <p className="admin-hint" role="note">
              Changes to {chosenOrg?.name ?? 'your organization'} go live immediately, with no review.
            </p>

            <FormField label="Name">
              <FormInput value={form.name} onChange={(e) => setField('name', e.target.value)} maxLength={200} required disabled={locked} />
            </FormField>
            <FormField label="Description">
              <FormTextarea value={form.description} onChange={(e) => setField('description', e.target.value)} rows={6} disabled={locked} />
            </FormField>
            <FormField label="Website">
              <FormInput type="url" value={form.website} onChange={(e) => setField('website', e.target.value)} placeholder="https://…" disabled={locked} />
            </FormField>
            <FormField label="Contact email">
              <FormInput type="email" value={form.contact_email} onChange={(e) => setField('contact_email', e.target.value)} placeholder="hello@example.org" disabled={locked} />
            </FormField>
          </div>

          <div className="ashell-pform-col">
            <h3 className="ashell-pform-lbl">Location & images</h3>

            <FormField label="Address">
              <FormInput value={form.address} onChange={(e) => setField('address', e.target.value)} disabled={locked} />
            </FormField>
            <FormFieldRow>
              <FormField label="City">
                <FormInput value={form.city} onChange={(e) => setField('city', e.target.value)} disabled={locked} />
              </FormField>
              <FormField label="State">
                <FormInput value={form.state} onChange={(e) => setField('state', e.target.value)} disabled={locked} />
              </FormField>
              <FormField label="Zip">
                <FormInput value={form.zip} onChange={(e) => setField('zip', e.target.value)} disabled={locked} />
              </FormField>
            </FormFieldRow>

            <FormField label="Logo / image link">
              <FormInput type="url" value={form.image_url} onChange={(e) => setField('image_url', e.target.value)} placeholder="https://…" disabled={locked} />
            </FormField>

            <FormField label={`Photos (${photos.length}/${MAX_ORG_PHOTOS})`}>
              <p className="admin-hint">
                The first photo becomes the fallback image for your events that have no image of
                their own. Use one you have the rights to that reads well as a wide banner.
              </p>
              {photos.map((url, i) => (
                <div key={i} className="ashell-org-photo">
                  <FormInput
                    value={url}
                    placeholder="https://…"
                    onChange={(e) => setPhotos(photos.map((p, j) => (j === i ? e.target.value : p)))}
                    disabled={locked}
                  />
                  <button type="button" className="ashell-edit-link" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              ))}
              {photos.length < MAX_ORG_PHOTOS && (
                <button type="button" className="ashell-edit-link" onClick={() => setPhotos([...photos, ''])} disabled={locked}>
                  + Add photo
                </button>
              )}
            </FormField>
          </div>

          <div className="ashell-pform-foot">
            {error && <p className="ashell-row-error" role="alert">{error}</p>}
            {saved && <p className="admin-hint" role="status">Saved. Your organization is up to date.</p>}
            <div className="ashell-dactions">
              <button type="submit" className="ashell-btn ashell-btn--primary" disabled={busy || locked}>
                {busy ? 'Saving…' : 'Save changes'}
              </button>
              <Link className="ashell-edit-link" to="/admin">Back to overview</Link>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
