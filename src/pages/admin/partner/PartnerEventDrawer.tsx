/**
 * PartnerEventDrawer (design §4.5): the slide-out editor for one partner
 * event, under the drawer standard. Every write leaves through a 061 RPC,
 * never a direct table write:
 *   - fields   -> partner_upsert_event (update branch, server-side
 *                 override merge)
 *   - tags     -> auto-save on published rows via the surface's pipeline;
 *                 committed with Update on unpublished rows
 *   - venue    -> partner_set_event_venue (set semantics; the multi-venue
 *                 guard renders the control read-only)
 *   - status   -> the surface's Publish/Cancel confirms
 * A row readable (any-of) but not writable (all-of fails) opens with every
 * control disabled and one honest line naming the co-hosts outside scope.
 */

import type { LooseRow } from '@/types'
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { eventPath } from '@/lib/slug.js'
import { supabase } from '@/lib/supabase'
import { CATEGORIES, AGE_OPTIONS } from '@/lib/admin/constants'
import { toDatetimeLocalValue, fromDatetimeLocalValue } from '@/lib/datetimeLocal'
import DateTimeField from '@/components/DateTimeField'
import { deriveEndForStart } from '@/lib/eventTimes'
import { ChipSelector, FormField, FormFieldRow, FormInput, FormSelect, FormTextarea } from '@/components/admin'
import {
  diffPartnerPatch, rpcFriendlyMessage, isImportedSource, reviewOutcomeCopy,
  CANCELLED_FINAL_COPY,
  type PartnerPatch,
} from '@/lib/admin/partnerShared'
import PartnerVenueControl, { type VenueOption } from '@/pages/admin/partner/PartnerVenueControl'
import PartnerShareDialog from '@/pages/admin/partner/PartnerShareDialog'
import type { ShareEvent } from '@/lib/admin/shareShared'

// Same reassignment options as the admin drawer: everything except 'other'.
const TAG_OPTIONS = CATEGORIES.filter((c) => c.value !== 'other')

interface RpcResult {
  id: string
  status: string
  review_required_by: string | null
}

interface DrawerForm {
  title: string
  description: string
  start_at: string
  end_at: string
  price_min: string
  price_max: string
  age_restriction: string
  ticket_url: string
  source_url: string
  image_url: string
}

function formFromRow(ev: LooseRow): DrawerForm {
  return {
    title: ev.title ?? '',
    description: ev.description ?? '',
    start_at: toDatetimeLocalValue(ev.start_at),
    end_at: toDatetimeLocalValue(ev.end_at),
    price_min: ev.price_min != null ? String(ev.price_min) : '0',
    price_max: ev.price_max != null ? String(ev.price_max) : '',
    age_restriction: ev.age_restriction ?? 'not_specified',
    ticket_url: ev.ticket_url ?? '',
    source_url: ev.source_url ?? '',
    image_url: ev.image_url ?? '',
  }
}

/** The form as an RPC patch shape, normalized so diffs compare cleanly. */
function formToPatch(form: DrawerForm): PartnerPatch {
  return {
    title: form.title.trim() || null,
    description: form.description.trim() || null,
    start_at: fromDatetimeLocalValue(form.start_at),
    end_at: fromDatetimeLocalValue(form.end_at),
    price_min: form.price_min.trim() === '' ? 0 : Number(form.price_min),
    price_max: form.price_max.trim() === '' ? null : Number(form.price_max),
    age_restriction: form.age_restriction,
    ticket_url: form.ticket_url.trim() || null,
    source_url: form.source_url.trim() || null,
    image_url: form.image_url.trim() || null,
  }
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

interface PartnerEventDrawerProps {
  ev: LooseRow
  /** The p_org every RPC verifies; null when the row is not writable. */
  writeOrg: string | null
  canWrite: boolean
  /** Co-host org names outside the partner's scope, for the honest line. */
  unwritableNames: string[]
  venues: VenueOption[]
  onVenueKnown: (v: VenueOption) => void
  selection: string[]
  onSelectionChange: (ids: string[]) => void
  isAutoSaving: boolean
  onPublish: () => void
  onCancelEvent: () => void
  onApplied: (patch: Partial<LooseRow>) => void
  showToast: (message: string) => void
}

export default function PartnerEventDrawer({
  ev, writeOrg, canWrite, unwritableNames, venues, onVenueKnown,
  selection, onSelectionChange, isAutoSaving,
  onPublish, onCancelEvent, onApplied, showToast,
}: PartnerEventDrawerProps) {
  const [form, setForm] = useState<DrawerForm>(() => formFromRow(ev))
  const [baseline, setBaseline] = useState<PartnerPatch>(() => formToPatch(formFromRow(ev)))
  const initialVenueId: string | null =
    ((ev.event_venues ?? []) as LooseRow[])[0]?.venue?.id ?? null
  const [venueId, setVenueId] = useState<string | null>(initialVenueId)
  const [savedVenueId, setSavedVenueId] = useState<string | null>(initialVenueId)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)

  const published = ev.status === 'published'
  const multiVenue = ((ev.event_venues ?? []) as LooseRow[]).length > 1
  const committedCats = useMemo(
    () => ((ev.event_categories ?? []) as LooseRow[])
      .map((ec) => ec.category)
      .filter((c: string) => c && c !== 'other')
      .slice(0, 2),
    [ev.event_categories],
  )

  const patch = diffPartnerPatch(baseline, formToPatch(form))
  // Tags ride on Update only for unpublished rows; published rows auto-save.
  const catsChanged = !published && !sameSet(selection, committedCats)
  const venueChanged = !multiVenue && venueId !== savedVenueId
  const dirty = Object.keys(patch).length > 0 || catsChanged || venueChanged

  const set = (key: keyof DrawerForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    setSaveError(null)
  }

  const handleUpdate = async () => {
    if (!writeOrg) return
    if (form.title.trim() === '') {
      setSaveError('The event needs a title.')
      return
    }
    if (catsChanged && selection.length === 0) {
      setSaveError('Choose one or two categories.')
      return
    }
    setSaving(true)
    setSaveError(null)
    const applied: Partial<LooseRow> = {}
    let statusAfter: string | null = null

    if (Object.keys(patch).length > 0 || catsChanged) {
      const { data, error } = await supabase.rpc('partner_upsert_event', {
        p_org: writeOrg,
        p_event: ev.id,
        p_patch: patch,
        ...(catsChanged ? { p_categories: selection } : {}),
      })
      if (error) {
        setSaving(false)
        setSaveError(rpcFriendlyMessage(error, 'Could not save the update.'))
        return
      }
      const result = data as unknown as RpcResult
      statusAfter = result.status
      Object.assign(applied, patch, { status: result.status })
      if (catsChanged) {
        applied.event_categories = selection.map((category) => ({ category }))
      }
    }

    if (venueChanged) {
      const { error } = await supabase.rpc('partner_set_event_venue', {
        p_org: writeOrg,
        p_event: ev.id,
        // The RPC accepts null for "no venue"; the codegen-style types
        // cannot express a nullable arg, hence the cast.
        p_venue: (venueId ?? null) as unknown as string,
      })
      if (error) {
        setSaving(false)
        // Field edits above may have landed; sync them before reporting.
        if (Object.keys(applied).length > 0) onApplied(applied)
        setSaveError(rpcFriendlyMessage(error, 'Could not change the venue.'))
        return
      }
      const venueName = venues.find((v) => v.id === venueId)?.name ?? null
      applied.event_venues = venueId ? [{ venue: { id: venueId, name: venueName } }] : []
      setSavedVenueId(venueId)
    }

    setSaving(false)
    setBaseline(formToPatch(form))
    if (Object.keys(applied).length > 0) onApplied(applied)
    if (statusAfter && statusAfter !== ev.status && statusAfter === 'pending_review') {
      // Moderation can demote an edited row; say so plainly, never silently.
      showToast('Saved. Back to Akron Pulse for review.')
    } else {
      showToast('Saved.')
    }
  }

  /**
   * The row, projected into the pure shape the share kit reads. Built from
   * the SAVED row rather than the form: a caption promising an 8pm start
   * that is still sitting unsaved in the drawer would be a caption about an
   * event the public page does not describe.
   */
  const shareEvent: ShareEvent = useMemo(() => ({
    id: String(ev.id),
    title: ev.title ?? 'Event',
    path: eventPath({ id: ev.id, title: ev.title, start_at: ev.start_at }),
    startAt: ev.start_at ?? null,
    venueName: ((ev.event_venues ?? []) as LooseRow[])[0]?.venue?.name ?? null,
    priceMin: typeof ev.price_min === 'number' ? ev.price_min : null,
    priceMax: typeof ev.price_max === 'number' ? ev.price_max : null,
    categories: ((ev.event_categories ?? []) as LooseRow[])
      .map((ec) => ec.category)
      .filter(Boolean) as string[],
  }), [ev.id, ev.title, ev.start_at, ev.event_venues, ev.price_min, ev.price_max, ev.event_categories])

  const orgNames = ((ev.event_organizations ?? []) as LooseRow[])
    .map((eo) => eo.organization?.name)
    .filter(Boolean) as string[]
  const importedFrom = isImportedSource(ev.source) ? (orgNames[0] ?? 'this organization') : null
  const disabled = !canWrite || saving

  return (
    <div className="ashell-drawer-in">
      <div className="ashell-dcol ashell-dcol--why">
        <h4>About this event</h4>
        <p className="ashell-why-p">{drawerNarrative(ev)}</p>
        {!canWrite && (
          <p className="ashell-why-p ashell-pro-note" role="note">
            Co-hosted with {unwritableNames.length > 0 ? unwritableNames.join(', ') : 'another organization'}.
            Contact Akron Pulse to edit it.
          </p>
        )}
        {canWrite && importedFrom && (
          <p className="ashell-why-p ashell-pro-note" role="note">
            Imported from {importedFrom}&apos;s feed. Your edits win over future imports.
          </p>
        )}
        <dl className="ashell-kv">
          <dt>Status</dt>
          <dd>{String(ev.status ?? '').replace('_', ' ')}</dd>
          <dt>Organizations</dt>
          <dd>{orgNames.length > 0 ? orgNames.join(' · ') : 'none linked'}</dd>
          <dt>Starts</dt>
          <dd>{ev.start_at ? format(new Date(ev.start_at), 'MMM d, yyyy · h:mm a') : 'not set'}</dd>
          <dt>Ends</dt>
          <dd>{ev.end_at ? format(new Date(ev.end_at), 'MMM d, yyyy · h:mm a') : 'not set'}</dd>
          {ev.source_url && (
            <>
              <dt>Source page</dt>
              <dd>
                <a href={ev.source_url} target="_blank" rel="noopener noreferrer">view original ↗</a>
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className="ashell-dcol ashell-dcol--fix">
        <h4>{canWrite ? 'Edit' : 'Details'}</h4>

        {/* Tag picker in EVERY drawer, always editable when writable
            (drawer standard 1.1). Published rows auto-save on toggle. */}
        <div className="ashell-catpick" aria-busy={isAutoSaving || undefined}>
          <ChipSelector
            label="Categories"
            items={TAG_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
            selectedIds={selection}
            onChange={canWrite ? onSelectionChange : () => {}}
            max={2}
            maxHint="Two at a time"
          />
          {isAutoSaving && <span className="ashell-autosave" role="status">Saving…</span>}
        </div>

        <div className="ashell-pfields">
          <FormField label="Title">
            <FormInput value={form.title} onChange={(e) => set('title')(e.target.value)} disabled={disabled} maxLength={200} />
          </FormField>
          <FormField label="Description">
            <FormTextarea value={form.description} onChange={(e) => set('description')(e.target.value)} disabled={disabled} rows={4} />
          </FormField>
          <FormFieldRow>
            <FormField label="Starts">
              <DateTimeField
                value={form.start_at}
                onChange={(v) => { setForm((f) => ({ ...f, start_at: v, end_at: deriveEndForStart(v, f.end_at) })); setSaveError(null) }}
                disabled={disabled}
                ariaLabel="Event start date and time"
              />
            </FormField>
            <FormField label="Ends">
              <DateTimeField
                value={form.end_at}
                onChange={(v) => set('end_at')(v)}
                min={form.start_at}
                disabled={disabled}
                ariaLabel="Event end date and time"
              />
            </FormField>
          </FormFieldRow>
          <FormFieldRow>
            <FormField label="Price from ($)">
              <FormInput type="number" min="0" step="0.01" value={form.price_min} onChange={(e) => set('price_min')(e.target.value)} disabled={disabled} />
            </FormField>
            <FormField label="Price to ($)">
              <FormInput type="number" min="0" step="0.01" value={form.price_max} onChange={(e) => set('price_max')(e.target.value)} disabled={disabled} placeholder="free or same" />
            </FormField>
            <FormField label="Ages">
              <FormSelect value={form.age_restriction} onChange={(e) => set('age_restriction')(e.target.value)} options={[...AGE_OPTIONS]} disabled={disabled} />
            </FormField>
          </FormFieldRow>
          <FormField label="Ticket link">
            <FormInput type="url" value={form.ticket_url} onChange={(e) => set('ticket_url')(e.target.value)} disabled={disabled} placeholder="https://…" />
          </FormField>
          <FormFieldRow>
            <FormField label="Event page link">
              <FormInput type="url" value={form.source_url} onChange={(e) => set('source_url')(e.target.value)} disabled={disabled} placeholder="https://…" />
            </FormField>
            <FormField label="Image link">
              <FormInput type="url" value={form.image_url} onChange={(e) => set('image_url')(e.target.value)} disabled={disabled} placeholder="https://…" />
            </FormField>
          </FormFieldRow>
          <FormField label="Venue">
            <PartnerVenueControl
              orgId={writeOrg ?? ''}
              venues={venues}
              value={venueId}
              onChange={(id) => { setVenueId(id); setSaveError(null) }}
              onVenueKnown={onVenueKnown}
              disabled={disabled}
              readOnlyReason={
                multiVenue
                  ? 'Multiple venues. Contact Akron Pulse to change them.'
                  : !canWrite ? 'Venue changes need write access.' : null
              }
            />
          </FormField>
        </div>

        {saveError && <p className="ashell-row-error" role="alert">{saveError}</p>}

        {canWrite && (
          <div className="ashell-dactions">
            {/* Publish/Cancel is ALWAYS the leftmost button (drawer
                standard 2.1); both go through a confirm upstream. Partners
                get no Unpublish-to-pending (admin triage, ADR §6.4) and NO
                republish affordance on cancelled rows: cancellation is
                permanent for partners, restoring is admin-only (fix-pass
                finding 5; the RPC refuses server-side too). */}
            {published ? (
              <button
                type="button"
                className="ashell-btn ashell-btn--danger-ghost"
                onClick={onCancelEvent}
                disabled={saving}
                title="Cancel this event. Permanent; a confirm follows"
              >
                Cancel event…
              </button>
            ) : ev.status === 'cancelled' ? (
              <span className="ashell-pro-note ashell-cancel-final" role="note">
                {CANCELLED_FINAL_COPY}
              </span>
            ) : (
              <button
                type="button"
                className="ashell-btn ashell-btn--primary"
                onClick={onPublish}
                disabled={saving}
                title="Publish this event. A confirm follows"
              >
                Publish…
              </button>
            )}
            <button
              type="button"
              className="ashell-btn"
              onClick={handleUpdate}
              disabled={saving || !dirty}
            >
              {saving ? 'Saving…' : 'Update'}
            </button>
            {/* Published rows only. An unpublished event has no public page,
                so every link in the kit would 404 and the image would render
                over a row the crawler cannot read. */}
            {published && (
              <button
                type="button"
                className="ashell-btn"
                onClick={() => setSharing(true)}
                title="Get an image and caption for Facebook or Instagram"
              >
                Share…
              </button>
            )}
          </div>
        )}

        {sharing && (
          <PartnerShareDialog
            ev={shareEvent}
            onClose={() => setSharing(false)}
            showToast={showToast}
          />
        )}
      </div>
    </div>
  )
}

function drawerNarrative(ev: LooseRow): string {
  if (ev.status === 'pending_review') {
    return reviewOutcomeCopy(null)
  }
  if (ev.status === 'cancelled') {
    // Cancelled is final for partners; restoring is admin-only.
    return `${CANCELLED_FINAL_COPY} It is off the public site.`
  }
  return 'Live on the public site.'
}
