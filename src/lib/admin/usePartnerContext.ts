/**
 * usePartnerContext.ts
 *
 * The org context every partner surface reads (design §4.4/§4.5): a thin
 * view over the cached role probe (useAdminRole.ts) exposing the
 * partner_org_context rows and the derived scope ids. UX only -- RLS is
 * what actually decides which rows can arrive; the scope ids exist so the
 * partner list filters to the partner's OWN orgs (published events of other
 * orgs are publicly readable by design, hence the explicit filter).
 */

import { useMemo } from 'react'
import { useAdminRole } from '@/lib/admin/useAdminRole'
import type { PartnerOrg } from '@/lib/admin/partnerShared'

export interface PartnerContextValue {
  orgs: PartnerOrg[]
  /** organization_id of every org in context, stable order. */
  scopeIds: string[]
}

export function usePartnerContext(): PartnerContextValue {
  const { orgs } = useAdminRole()
  return useMemo(
    () => ({ orgs, scopeIds: orgs.map((o) => o.organization_id) }),
    [orgs],
  )
}
