/**
 * PartnersPage (design §4.6, deviation D7): the Partners management section
 * of Pulse Control, admins only. The roster is DATA (the admin_users
 * precedent): everything here is rows in partner_orgs / partner_memberships
 * over PostgREST under the 061 admin policies -- no migration is ever
 * needed to onboard or offboard a partner.
 *
 * Structural safety, by construction:
 *  - Revoke writes `revoked_at` on ONE membership row by composite PK, so
 *    the ADR §6.7 unscoped-revoke footgun cannot happen from this UI.
 *  - There is no delete anywhere: revocation keeps the audit trail, tenant
 *    shutdown is `active = false` (confirmed, with its blast radius named).
 *  - New auth users are NOT minted here: admin_lookup_auth_user only
 *    bridges an email to an existing auth user; a miss tells the admin to
 *    create the user in the Supabase dashboard first (invite flow, ADR
 *    §6.7 step 1 -- public sign-up stays off, permanently).
 */

import type { LooseRow } from '@/types'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { ConfirmDialog, EntityMultiSelect, FormInput } from '@/components/admin'
import { isValidPartnerSlug } from '@/lib/admin/partnerShared'

type Row = LooseRow

interface ConfirmState {
  tenant: Row
}

export default function PartnersPage() {
  const [tenants, setTenants] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [openOrg, setOpenOrg] = useState<string | null>(null)
  const [confirmSuspend, setConfirmSuspend] = useState<ConfirmState | null>(null)

  // Add-tenant panel
  const [adding, setAdding] = useState(false)
  const [allOrgs, setAllOrgs] = useState<Row[]>([])
  const [newOrgIds, setNewOrgIds] = useState<string[]>([])
  const [newSlug, setNewSlug] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [addBusy, setAddBusy] = useState(false)

  // The signed-in admin, stamped as created_by on new memberships.
  const [adminId, setAdminId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setAdminId(data.user?.id ?? null))
  }, [])

  const fetchTenants = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('partner_orgs')
      .select(`
        organization_id, slug, active, auto_publish, created_at,
        organization:organizations ( id, name ),
        partner_memberships ( user_id, organization_id, email, role, created_at, created_by, revoked_at )
      `)
      .order('created_at', { ascending: true })
    if (error) {
      setTenants([])
      setFetchError(error.message)
      setLoading(false)
      return
    }
    setTenants((data ?? []) as Row[])
    setFetchError(null)
    setLoading(false)
  }, [])
  useEffect(() => { fetchTenants() }, [fetchTenants])

  const patchTenant = (orgId: string, patch: Partial<Row>) =>
    setTenants((prev) => prev.map((t) => (t.organization_id === orgId ? { ...t, ...patch } : t)))

  const openAddPanel = async () => {
    setAdding(true)
    setAddError(null)
    if (allOrgs.length === 0) {
      const { data, error } = await supabase.from('organizations').select('id, name').order('name')
      if (!error) setAllOrgs((data ?? []) as Row[])
    }
  }

  const handleAddTenant = async (e: FormEvent) => {
    e.preventDefault()
    const orgId = newOrgIds[0]
    if (!orgId) {
      setAddError('Pick the organization this partner represents.')
      return
    }
    if (!isValidPartnerSlug(newSlug)) {
      setAddError('Slug must be 2 to 63 characters of lowercase letters, digits, and hyphens, starting with a letter or digit.')
      return
    }
    setAddBusy(true)
    setAddError(null)
    const { error } = await supabase
      .from('partner_orgs')
      .insert({ organization_id: orgId, slug: newSlug })
    setAddBusy(false)
    if (error) {
      setAddError(
        error.code === '23505'
          ? 'That organization is already a partner, or the slug is taken.'
          : `Could not add the partner: ${error.message}`,
      )
      return
    }
    setAdding(false)
    setNewOrgIds([])
    setNewSlug('')
    fetchTenants()
  }

  const setAutoPublish = async (tenant: Row, next: boolean) => {
    const { error } = await supabase
      .from('partner_orgs')
      .update({ auto_publish: next })
      .eq('organization_id', tenant.organization_id)
    if (error) {
      patchTenant(tenant.organization_id, { rowError: `Could not change publishing: ${error.message}` })
      return
    }
    patchTenant(tenant.organization_id, { auto_publish: next, rowError: null })
  }

  const setActive = async (tenant: Row, next: boolean) => {
    const { error } = await supabase
      .from('partner_orgs')
      .update({ active: next })
      .eq('organization_id', tenant.organization_id)
    if (error) {
      patchTenant(tenant.organization_id, { rowError: `Could not change the tenant: ${error.message}` })
      return
    }
    patchTenant(tenant.organization_id, { active: next, rowError: null })
  }

  const tenantIds = new Set(tenants.map((t) => t.organization_id))

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Partners</h2>
        <span className="admin-section-count">{tenants.length}</span>
      </div>

      <div className="admin-toolbar">
        <p className="admin-hint">
          Partner organizations manage their own events through a scoped
          Pulse Control. Grants are per membership; changes take effect on
          the partner&apos;s next request, no re-login needed.
        </p>
        <button className="btn-admin-primary btn-admin-create" onClick={openAddPanel}>
          + Add partner org
        </button>
      </div>

      {adding && (
        <form className="admin-add-area-form ashell-tenant-add" onSubmit={handleAddTenant}>
          <div className="admin-field">
            <label>Organization</label>
            <EntityMultiSelect
              allEntities={allOrgs as { id: string; name: string }[]}
              selectedIds={newOrgIds}
              onChange={(ids) => { setNewOrgIds(ids.slice(-1)); setAddError(null) }}
              maxItems={1}
              placeholder="Search organizations…"
              disabledLabel={(o) => (tenantIds.has(o.id) ? 'already a partner' : null)}
            />
          </div>
          <div className="admin-field">
            <label>Slug</label>
            <FormInput
              value={newSlug}
              onChange={(e) => { setNewSlug(e.target.value.trim()); setAddError(null) }}
              placeholder="north-hill-cdc"
            />
            <p className="admin-hint">
              The slug is PERMANENT. It becomes the source label on every
              event this partner creates; changing it later strands
              attribution.
            </p>
          </div>
          {addError && <p className="ashell-row-error" role="alert">{addError}</p>}
          <div className="admin-add-area-actions">
            <button type="submit" className="btn-admin-primary" disabled={addBusy}>
              {addBusy ? 'Adding…' : 'Add partner'}
            </button>
            <button type="button" className="btn-admin-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading && <div className="admin-loading">Loading partners…</div>}

      {!loading && fetchError && (
        <div className="admin-review-error" role="alert">
          <p>Could not load the partner roster. This is a fetch failure, not an empty roster.</p>
          <p className="admin-review-error-detail">{fetchError}</p>
          <button className="btn-admin-ghost btn-admin-sm" onClick={fetchTenants}>Retry</button>
        </div>
      )}

      {!loading && !fetchError && tenants.length === 0 && (
        <div className="admin-empty">
          <p>No partner organizations yet. Add one to hand an organization
            scoped control of its own events.</p>
        </div>
      )}

      {!loading && !fetchError && tenants.map((tenant) => (
        <TenantCard
          key={tenant.organization_id}
          tenant={tenant}
          adminId={adminId}
          isOpen={openOrg === tenant.organization_id}
          onToggleOpen={() =>
            setOpenOrg((prev) => (prev === tenant.organization_id ? null : tenant.organization_id))}
          onToggleAutoPublish={() => setAutoPublish(tenant, !tenant.auto_publish)}
          onToggleActive={() => {
            if (tenant.active) setConfirmSuspend({ tenant })
            else setActive(tenant, true)
          }}
          onMembershipsChanged={fetchTenants}
        />
      ))}

      {!loading && !fetchError && (
        <p className="admin-hint ashell-roster-foot">
          Suspending or revoking takes effect on the partner&apos;s next
          request; scope is read per query, never cached in a login.
          Deleting an auth user is a dashboard action that erases the audit
          trail with it; prefer revoking the membership instead.
        </p>
      )}

      {confirmSuspend && (
        <ConfirmDialog
          message={`Suspend ${confirmSuspend.tenant.organization?.name ?? confirmSuspend.tenant.slug}? This suspends the tenant for ALL its members immediately. Their other organizations keep working.`}
          confirmLabel="Suspend"
          onCancel={() => setConfirmSuspend(null)}
          onConfirm={() => {
            const t = confirmSuspend.tenant
            setConfirmSuspend(null)
            setActive(t, false)
          }}
        />
      )}
    </div>
  )
}

// ── Tenant card ───────────────────────────────────────────────────────────

interface TenantCardProps {
  tenant: Row
  adminId: string | null
  isOpen: boolean
  onToggleOpen: () => void
  onToggleAutoPublish: () => void
  onToggleActive: () => void
  onMembershipsChanged: () => void
}

function TenantCard({
  tenant, adminId, isOpen, onToggleOpen,
  onToggleAutoPublish, onToggleActive, onMembershipsChanged,
}: TenantCardProps) {
  const memberships = (tenant.partner_memberships ?? []) as Row[]
  const liveCount = memberships.filter((m) => m.revoked_at == null).length
  const regionId = `tenant-${tenant.organization_id}`

  const [email, setEmail] = useState('')
  const [memberBusy, setMemberBusy] = useState(false)
  const [memberError, setMemberError] = useState<string | null>(null)
  const [memberNote, setMemberNote] = useState<string | null>(null)

  const addMember = async (e: FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setMemberBusy(true)
    setMemberError(null)
    setMemberNote(null)
    const { data: userId, error: lookupError } = await supabase
      .rpc('admin_lookup_auth_user', { p_email: addr })
    if (lookupError) {
      setMemberBusy(false)
      setMemberError(`Could not look up that address: ${lookupError.message}`)
      return
    }
    if (userId == null) {
      setMemberBusy(false)
      // Public sign-up stays off, permanently; the dashboard step IS the
      // invite flow's step 1 (ADR §6.7).
      setMemberNote(
        'No auth user with that address. Create the user in the Supabase dashboard (Auth, Add user, auto-confirm), then retry here.',
      )
      return
    }
    const { error: insertError } = await supabase.from('partner_memberships').insert({
      user_id: userId,
      organization_id: tenant.organization_id,
      email: addr,
      created_by: adminId,
    })
    setMemberBusy(false)
    if (insertError) {
      setMemberError(
        insertError.code === '23505'
          ? 'That user is already on this roster, possibly revoked. Restore the existing row instead.'
          : `Could not add the member: ${insertError.message}`,
      )
      return
    }
    setEmail('')
    setMemberNote(`Added ${addr}. Access starts on their next request.`)
    onMembershipsChanged()
  }

  const setRevoked = async (m: Row, revokedAt: string | null) => {
    setMemberError(null)
    const { error } = await supabase
      .from('partner_memberships')
      .update({ revoked_at: revokedAt })
      // Composite PK: THIS membership only, never the user's other orgs.
      .eq('user_id', m.user_id)
      .eq('organization_id', m.organization_id)
    if (error) {
      setMemberError(`Could not update the membership: ${error.message}`)
      return
    }
    onMembershipsChanged()
  }

  return (
    <section className={`ashell-tenant ${tenant.active ? '' : 'ashell-tenant--suspended'}`}>
      <div className="ashell-tenant-hd">
        <button
          type="button"
          className="ashell-ev-title ashell-tenant-name"
          aria-expanded={isOpen}
          aria-controls={regionId}
          onClick={onToggleOpen}
        >
          {tenant.organization?.name ?? tenant.slug}
        </button>
        <code className="ashell-tenant-slug">partner:{tenant.slug}</code>
        <span className="ashell-tenant-meta">
          {liveCount} {liveCount === 1 ? 'member' : 'members'}
          {tenant.created_at && <> · since {format(new Date(tenant.created_at), 'MMM d, yyyy')}</>}
        </span>
        <div className="ashell-grow" />
        <button
          type="button"
          role="switch"
          aria-checked={!!tenant.auto_publish}
          className={`admin-toggle ${tenant.auto_publish ? 'admin-toggle--on' : ''}`}
          onClick={onToggleAutoPublish}
          title={tenant.auto_publish
            ? 'Events from this partner publish directly. Click to review them first instead.'
            : 'Events from this partner go to the review queue first. Click to let them publish directly.'}
        >
          {tenant.auto_publish ? 'Publishes directly' : 'Reviewed first'}
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={!!tenant.active}
          className={`admin-toggle ${tenant.active ? 'admin-toggle--on' : ''}`}
          onClick={onToggleActive}
          title={tenant.active
            ? 'Suspend this tenant for all its members; a confirm follows'
            : 'Reactivate this tenant for all its members'}
        >
          {tenant.active ? 'Active' : 'Suspended'}
        </button>
      </div>

      {tenant.rowError && <p className="ashell-row-error" role="alert">{tenant.rowError}</p>}

      <div id={regionId} hidden={!isOpen} className="ashell-tenant-body">
        {isOpen && (
          <>
            {memberships.length === 0 ? (
              <p className="admin-hint">No members yet. Add the partner&apos;s first account below.</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Added</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberships.map((m) => (
                      <tr key={`${m.user_id}-${m.organization_id}`}>
                        <td className={m.revoked_at ? 'ashell-member--revoked' : ''}>{m.email}</td>
                        <td className="admin-td-nowrap">
                          {m.created_at ? format(new Date(m.created_at), 'MMM d, yyyy') : '—'}
                        </td>
                        <td className="admin-td-nowrap">
                          {m.revoked_at
                            ? `revoked ${format(new Date(m.revoked_at), 'MMM d, yyyy')}`
                            : 'live'}
                        </td>
                        <td className="admin-td-actions">
                          {m.revoked_at ? (
                            <button
                              className="btn-admin-sm"
                              onClick={() => setRevoked(m, null)}
                              title="Restore this membership; access resumes on their next request"
                            >
                              Restore
                            </button>
                          ) : (
                            <button
                              className="btn-admin-sm btn-admin-sm-danger"
                              onClick={() => setRevoked(m, new Date().toISOString())}
                              title="Revoke THIS membership only; their other organizations keep working"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form className="ashell-member-add" onSubmit={addMember}>
              <FormInput
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setMemberError(null); setMemberNote(null) }}
                placeholder="person@partner.org"
                aria-label={`Add a member to ${tenant.organization?.name ?? tenant.slug}`}
                disabled={memberBusy}
              />
              <button type="submit" className="btn-admin-primary" disabled={memberBusy || !email.trim()}>
                {memberBusy ? 'Adding…' : 'Add member'}
              </button>
            </form>
            {memberError && <p className="ashell-row-error" role="alert">{memberError}</p>}
            {memberNote && <p className="admin-hint" role="status">{memberNote}</p>}
          </>
        )}
      </div>
    </section>
  )
}
