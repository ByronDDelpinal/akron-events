/**
 * PartnerVenueControl (design §4.5): the venue affordance shared by the
 * partner drawer and the create flow. Single-select over the venues the
 * public can already read, plus an inline "Add a new venue" mini-form that
 * mints through `partner_mint_venue` -- the RPC resolves to an existing
 * venue when it can (a partner can never create a duplicate of a venue we
 * have) and the mint-time guard refuses junk and address-shaped names with
 * a human-readable reason this control shows verbatim under the field.
 */

import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { EntityMultiSelect, FormInput } from '@/components/admin'
import { isGuardRefusal, rpcFriendlyMessage } from '@/lib/admin/partnerShared'

export interface VenueOption {
  id: string
  name: string
  // Index signature so the option satisfies SearchableMultiSelect's Entity.
  [key: string]: unknown
}

interface MintResult {
  venue_id: string
  created: boolean
  name: string
}

interface PartnerVenueControlProps {
  /** The org to mint as; any live membership qualifies server-side. */
  orgId: string
  venues: VenueOption[]
  /** Currently selected venue id, or null for "no venue". */
  value: string | null
  onChange: (venueId: string | null) => void
  /** A mint resolved or created a venue: add it to the caller's list. */
  onVenueKnown: (venue: VenueOption) => void
  disabled?: boolean
  /** Set when the control is read-only, e.g. the multi-venue guard. */
  readOnlyReason?: string | null
}

export default function PartnerVenueControl({
  orgId, venues, value, onChange, onVenueKnown, disabled = false, readOnlyReason = null,
}: PartnerVenueControlProps) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [minting, setMinting] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [mintNote, setMintNote] = useState<string | null>(null)

  const mint = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setMintError('Type the venue’s name first.')
      return
    }
    setMinting(true)
    setMintError(null)
    setMintNote(null)
    const { data, error } = await supabase.rpc('partner_mint_venue', {
      p_org: orgId,
      p_name: name.trim(),
      p_address: address.trim(),
      ...(city.trim() ? { p_city: city.trim() } : {}),
    })
    setMinting(false)
    if (error) {
      // The guard's reason is written for humans; show it verbatim
      // (design §3.4). Other failures get the honest fallback.
      setMintError(
        isGuardRefusal(error)
          ? error.message
          : rpcFriendlyMessage(error, 'Could not add that venue.'),
      )
      return
    }
    const result = data as unknown as MintResult
    onVenueKnown({ id: result.venue_id, name: result.name })
    onChange(result.venue_id)
    setMintNote(
      result.created
        ? 'Venue added. Akron Pulse reviews new venues, but your event can use it right away.'
        : `We already know that venue, so we linked the existing entry: ${result.name}.`,
    )
    setAdding(false)
    setName('')
    setAddress('')
    setCity('')
  }

  if (readOnlyReason) {
    return (
      <div className="ashell-pvenue">
        <p className="admin-hint">{readOnlyReason}</p>
        {venues.length > 0 && value && (
          <p className="ashell-pvenue-current">
            {venues.find((v) => v.id === value)?.name ?? 'Linked venue'}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="ashell-pvenue">
      <EntityMultiSelect
        allEntities={venues}
        selectedIds={value ? [value] : []}
        onChange={(ids) => {
          if (disabled) return
          // Single-select semantics over the shared multi-select: the most
          // recently picked id wins; clearing the pill clears the venue.
          onChange(ids.length === 0 ? null : ids[ids.length - 1])
        }}
        maxItems={1}
        placeholder="Search venues…"
      />
      {!adding ? (
        <button
          type="button"
          className="ashell-linkbtn"
          onClick={() => { setAdding(true); setMintNote(null) }}
          disabled={disabled}
        >
          Add a new venue
        </button>
      ) : (
        <form className="ashell-pmint" onSubmit={mint} aria-label="Add a new venue">
          <FormInput
            value={name}
            onChange={(e) => { setName(e.target.value); setMintError(null) }}
            placeholder="Venue name (not the address)"
            aria-label="Venue name"
            disabled={minting}
          />
          <FormInput
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Street address"
            aria-label="Venue address"
            disabled={minting}
          />
          <FormInput
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="City (Akron if blank)"
            aria-label="Venue city"
            disabled={minting}
          />
          <div className="ashell-pmint-actions">
            <button type="submit" className="ashell-btn ashell-btn--primary" disabled={minting}>
              {minting ? 'Adding…' : 'Add venue'}
            </button>
            <button
              type="button"
              className="ashell-btn"
              onClick={() => { setAdding(false); setMintError(null) }}
              disabled={minting}
            >
              Never mind
            </button>
          </div>
        </form>
      )}
      {mintError && <p className="ashell-row-error" role="alert">{mintError}</p>}
      {mintNote && <p className="admin-hint" role="status">{mintNote}</p>}
    </div>
  )
}
