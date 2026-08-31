/**
 * PartnerCreateEventPage (design §4.5, the D4 full-flow decision): the
 * partner create form at /admin/events/new. Submission goes through
 * `partner_upsert_event` (create branch) ONLY -- no direct table writes.
 *
 * Org choice rules (§6.10 item 3, verbatim): with exactly one membership
 * the org picker is SUPPRESSED and defaulted; with more than one, an
 * explicit picker with NO default. The chosen org becomes p_org, is written
 * permanently into `source = 'partner:<slug>'`, and is re-checked
 * server-side -- a security control wearing a form control's clothes; never
 * trust the widget.
 *
 * The outcome is reported honestly: most partner events land
 * pending_review (auto_publish defaults false per tenant), the success
 * panel says so plainly and names the org whose rules forced it, and the
 * existing notify-pending-event email fires (non-blocking) so Akron Pulse
 * gets the same nudge the public submit form produces.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { CATEGORIES, AGE_OPTIONS } from '@/lib/admin/constants'
import { fromDatetimeLocalValue } from '@/lib/datetimeLocal'
import DateTimeField from '@/components/DateTimeField'
import { deriveEndForStart } from '@/lib/eventTimes'
import { eventPath } from '@/lib/slug'
import { ChipSelector, FormField, FormFieldRow, FormInput, FormSelect, FormTextarea } from '@/components/admin'
import { usePartnerContext } from '@/lib/admin/usePartnerContext'
import { reviewOutcomeCopy, rpcFriendlyMessage, type PartnerPatch } from '@/lib/admin/partnerShared'
import PartnerVenueControl, { type VenueOption } from '@/pages/admin/partner/PartnerVenueControl'

const TAG_OPTIONS = CATEGORIES.filter((c) => c.value !== 'other')

interface RpcResult {
  id: string
  status: string
  review_required_by: string | null
}

interface Outcome {
  id: string
  status: string
  reviewRequiredBy: string | null
  orgName: string
  eventUrl: string
}

export default function PartnerCreateEventPage() {
  const { orgs } = usePartnerContext()

  // One membership: suppressed picker, defaulted. Several: NO default.
  const [orgId, setOrgId] = useState<string>(orgs.length === 1 ? orgs[0].organization_id : '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [priceMin, setPriceMin] = useState('0')
  const [priceMax, setPriceMax] = useState('')
  const [age, setAge] = useState('not_specified')
  const [ticketUrl, setTicketUrl] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [cats, setCats] = useState<string[]>([])
  const [venueId, setVenueId] = useState<string | null>(null)
  const [venues, setVenues] = useState<VenueOption[]>([])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  useEffect(() => {
    let active = true
    supabase.from('venues').select('id, name').order('name').then(({ data, error: err }) => {
      if (active && !err) setVenues((data ?? []) as VenueOption[])
    })
    return () => { active = false }
  }, [])

  const chosenOrg = useMemo(
    () => orgs.find((o) => o.organization_id === orgId) ?? null,
    [orgs, orgId],
  )

  const addVenueOption = (v: VenueOption) => {
    setVenues((prev) =>
      prev.some((x) => x.id === v.id)
        ? prev
        : [...prev, v].sort((a, b) => a.name.localeCompare(b.name)))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!orgId) {
      setError('Choose an organization.')
      return
    }
    if (!title.trim()) {
      setError('The event needs a title.')
      return
    }
    const startIso = fromDatetimeLocalValue(startAt)
    if (!startIso) {
      setError('The event needs a start time.')
      return
    }
    if (cats.length < 1 || cats.length > 2) {
      setError('Choose one or two categories.')
      return
    }
    setBusy(true)
    setError(null)

    const patch: PartnerPatch = {
      title: title.trim(),
      description: description.trim() || null,
      start_at: startIso,
      end_at: fromDatetimeLocalValue(endAt),
      price_min: priceMin.trim() === '' ? 0 : Number(priceMin),
      price_max: priceMax.trim() === '' ? null : Number(priceMax),
      age_restriction: age,
      ticket_url: ticketUrl.trim() || null,
      source_url: sourceUrl.trim() || null,
      image_url: imageUrl.trim() || null,
    }

    const { data, error: rpcError } = await supabase.rpc('partner_upsert_event', {
      p_org: orgId,
      // Create branch: the codegen-style types cannot express the nullable
      // p_event, hence the cast. Null is the create signal, by contract.
      p_event: null as unknown as string,
      p_patch: patch,
      ...(venueId ? { p_venue: venueId } : {}),
      p_categories: cats,
    })
    setBusy(false)
    if (rpcError) {
      setError(rpcFriendlyMessage(rpcError, 'Could not create the event.'))
      return
    }
    const result = data as unknown as RpcResult
    const orgName = chosenOrg?.name ?? 'your organization'
    setOutcome({
      id: result.id,
      status: result.status,
      reviewRequiredBy: result.review_required_by,
      orgName,
      eventUrl: eventPath({ id: result.id, title: title.trim(), start_at: startIso }),
    })

    if (result.status === 'pending_review') {
      // Same operator email the public submit queue produces; non-blocking,
      // the row is already saved (SubmitPage precedent).
      try {
        const { error: notifyError } = await supabase.functions.invoke('notify-pending-event', {
          body: { event_id: result.id, organizer_name: orgName },
        })
        if (notifyError) console.warn('[partner-create] notify-pending-event failed', notifyError)
      } catch (err) {
        console.warn('[partner-create] notify-pending-event threw', err)
      }
    }
  }

  if (outcome) {
    return (
      <div className="ashell-work ashell-pcreate ashell-pcreate--outcome" role="status">
        <div className="ashell-empty">
          <div className="ashell-empty-ring" aria-hidden="true">✓</div>
          {outcome.status === 'published' ? (
            <>
              <h3>Event published</h3>
              <p>Live on the public site, credited to {outcome.orgName}.</p>
            </>
          ) : (
            <>
              <h3>Event sent to review</h3>
              {/* Name the org only when the RPC named it -- a moderation
                  demotion is not the org's rules, and we never guess. */}
              <p>{reviewOutcomeCopy(outcome.reviewRequiredBy)}</p>
            </>
          )}
          <p className="ashell-pcreate-links">
            {outcome.status === 'published' && (
              <Link className="ashell-edit-link" to={outcome.eventUrl}>View event →</Link>
            )}
            <Link className="ashell-edit-link" to="/admin/events">Go to your events →</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ashell-work ashell-pcreate">
      <div className="ashell-surface-hd">
        <h2>New event</h2>
      </div>
      {/* Two columns on anything wide enough for them. One column of fields
          on a 2600px screen meant scrolling past the fold to reach the venue
          on a form that fits a laptop screen whole. The split is by question,
          not by field count: what the event IS on the left, when and where
          and how much on the right. */}
      <form className="ashell-pform" onSubmit={submit}>
        <div className="ashell-pform-col">
          <h3 className="ashell-pform-lbl">The event</h3>

          {orgs.length > 1 && (
            <FormField label="Organization">
              <FormSelect
                value={orgId}
                onChange={(e) => { setOrgId(e.target.value); setError(null) }}
                options={orgs.map((o) => ({ value: o.organization_id, label: o.name }))}
                placeholder="Choose an organization…"
                required
              />
              <p className="admin-hint">Credited permanently to this organization.</p>
            </FormField>
          )}
          {chosenOrg && !chosenOrg.auto_publish && (
            <p className="admin-hint" role="note">
              New events from {chosenOrg.name} are reviewed before they go public.
            </p>
          )}

          <FormField label="Title">
            <FormInput value={title} onChange={(e) => { setTitle(e.target.value); setError(null) }} maxLength={200} required />
          </FormField>
          <FormField label="Description">
            <FormTextarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8} />
          </FormField>
          <FormField label="Categories">
            <ChipSelector
              items={TAG_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
              selectedIds={cats}
              onChange={(ids) => { setCats(ids); setError(null) }}
              max={2}
              maxHint="Two at a time"
            />
          </FormField>
        </div>

        <div className="ashell-pform-col">
          <h3 className="ashell-pform-lbl">When, where, how much</h3>

          <FormFieldRow>
            <FormField label="Starts">
              <DateTimeField
                value={startAt}
                onChange={(v) => { setStartAt(v); setEndAt((prev) => deriveEndForStart(v, prev)); setError(null) }}
                required
                ariaLabel="Event start date and time"
              />
            </FormField>
            <FormField label="Ends (optional)">
              <DateTimeField
                value={endAt}
                onChange={setEndAt}
                min={startAt}
                ariaLabel="Event end date and time"
              />
            </FormField>
          </FormFieldRow>
          <FormField label="Venue">
            <PartnerVenueControl
              orgId={orgId}
              venues={venues}
              value={venueId}
              onChange={setVenueId}
              onVenueKnown={addVenueOption}
              disabled={!orgId}
              readOnlyReason={!orgId ? 'Choose an organization first.' : null}
            />
          </FormField>
          <FormFieldRow>
            <FormField label="Price from ($)">
              <FormInput type="number" min="0" step="0.01" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} />
            </FormField>
            <FormField label="Price to ($)">
              <FormInput type="number" min="0" step="0.01" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} placeholder="free or same" />
            </FormField>
            <FormField label="Ages">
              <FormSelect value={age} onChange={(e) => setAge(e.target.value)} options={[...AGE_OPTIONS]} />
            </FormField>
          </FormFieldRow>
          <FormField label="Ticket link">
            <FormInput type="url" value={ticketUrl} onChange={(e) => setTicketUrl(e.target.value)} placeholder="https://…" />
          </FormField>
          <FormFieldRow>
            <FormField label="Event page link">
              <FormInput type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" />
            </FormField>
            <FormField label="Image link">
              <FormInput type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" />
            </FormField>
          </FormFieldRow>
        </div>

        <div className="ashell-pform-foot">
          {error && <p className="ashell-row-error" role="alert">{error}</p>}
          <div className="ashell-dactions">
            <button type="submit" className="ashell-btn ashell-btn--primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create event'}
            </button>
            <Link className="ashell-edit-link" to="/admin/events">Back to your events</Link>
          </div>
        </div>
      </form>
    </div>
  )
}
