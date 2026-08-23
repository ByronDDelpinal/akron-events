/**
 * useAdminRole.ts
 *
 * The role probe behind the role-switched /admin shell (design §4.2). After
 * the session resolves, `is_admin()` and `partner_org_context()` fire in
 * parallel; `resolveRole` (partnerShared.ts) turns the pair into one of
 * admin / partner / none, or an honest error state when the probe itself
 * failed.
 *
 * THIS PROBE IS UX ROUTING ONLY, NEVER SECURITY. RLS and the 061 SECURITY
 * DEFINER RPCs are the enforcement; a tampered client that renders the
 * admin shell for a partner sees empty lists and refused writes. The one
 * rule that IS load-bearing here: never fall back to "show everything" --
 * an empty scope renders NobodyPage, not the admin surface (the ADR's
 * exact warning).
 *
 * Cached in module scope per auth user (the useShellCounts pattern) so
 * section navigation does not refire the two RPCs; cleared and re-run on
 * every auth state change.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { resolveRole, type AdminRole, type PartnerOrg, type RoleResolution } from '@/lib/admin/partnerShared'

export type { AdminRole, PartnerOrg }

export interface AdminRoleState {
  status: 'loading' | 'ready' | 'error'
  role: AdminRole | null
  orgs: PartnerOrg[]
  /** Probe failure message, only in the 'error' status. */
  error: string | null
  /** Re-run a failed probe. */
  retry: () => void
}

let cachedUserId: string | null = null
let cachedResolution: RoleResolution | null = null

async function probe(): Promise<RoleResolution> {
  // Dev-only override so the role-switched shell can be exercised without a
  // live 061 backend (design §7.2): localStorage 'pulse:dev-role' set to
  // 'admin', 'none', or a JSON array of partner_org_context rows. Stripped
  // from production builds by the DEV guard.
  if (import.meta.env.DEV) {
    try {
      const forced = window.localStorage.getItem('pulse:dev-role')
      if (forced === 'admin') return { role: 'admin', orgs: [], error: null }
      if (forced === 'none') return { role: 'none', orgs: [], error: null }
      if (forced) {
        const orgs = JSON.parse(forced) as PartnerOrg[]
        if (Array.isArray(orgs)) return { role: 'partner', orgs, error: null }
      }
    } catch {
      // ignore a malformed override; fall through to the real probe
    }
  }
  const [isAdminRes, contextRes] = await Promise.all([
    supabase.rpc('is_admin'),
    supabase.rpc('partner_org_context'),
  ])
  return resolveRole(
    { data: isAdminRes.data ?? null, error: isAdminRes.error },
    { data: (contextRes.data as PartnerOrg[] | null) ?? null, error: contextRes.error },
  )
}

/**
 * Provider-side hook: AdminLayout calls this once after sign-in and feeds
 * the value into AdminRoleContext.
 */
export function useAdminRoleProvider(signedIn: boolean): AdminRoleState {
  const [state, setState] = useState<Omit<AdminRoleState, 'retry'>>({
    status: 'loading', role: null, orgs: [], error: null,
  })

  const load = useCallback(async (force: boolean) => {
    const { data } = await supabase.auth.getUser()
    const userId = data.user?.id ?? null
    if (!force && userId && userId === cachedUserId && cachedResolution) {
      const r = cachedResolution
      setState(
        r.role == null
          ? { status: 'error', role: null, orgs: [], error: r.error }
          : { status: 'ready', role: r.role, orgs: r.orgs, error: null },
      )
      return
    }
    setState({ status: 'loading', role: null, orgs: [], error: null })
    const resolution = await probe()
    cachedUserId = userId
    cachedResolution = resolution
    setState(
      resolution.role == null
        ? { status: 'error', role: null, orgs: [], error: resolution.error }
        : { status: 'ready', role: resolution.role, orgs: resolution.orgs, error: null },
    )
  }, [])

  useEffect(() => {
    if (!signedIn) return
    load(false)
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      // A different user (or a sign-out/in cycle) invalidates the cache.
      if (event === 'SIGNED_OUT') {
        cachedUserId = null
        cachedResolution = null
      } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        load(true)
      }
    })
    return () => { sub.subscription.unsubscribe() }
  }, [signedIn, load])

  const retry = useCallback(() => { load(true) }, [load])

  return { ...state, retry }
}

export const AdminRoleContext = createContext<AdminRoleState | null>(null)

/** Consumer hook. Throws outside the admin shell -- there is no fallback. */
export function useAdminRole(): AdminRoleState {
  const value = useContext(AdminRoleContext)
  if (!value) throw new Error('useAdminRole must be used inside AdminLayout')
  return value
}
