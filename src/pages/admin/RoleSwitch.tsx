/**
 * RoleSwitch (design §4.1): swaps a route's element by the resolved shell
 * role while the paths stay identical for both principals. Rendered inside
 * the /admin routes, under AdminLayout's AdminRoleContext provider. A role
 * with no element for the path gets the off-limits NobodyPage -- never a
 * blank and never the other role's surface.
 *
 * Routing convenience only, never security: the RPCs and RLS decide what
 * any surface can actually do.
 */

import type { ReactNode } from 'react'
import { useAdminRole } from '@/lib/admin/useAdminRole'
import NobodyPage from '@/pages/admin/NobodyPage'

interface RoleSwitchProps {
  admin?: ReactNode
  partner?: ReactNode
}

export default function RoleSwitch({ admin, partner }: RoleSwitchProps) {
  const { role } = useAdminRole()
  if (role === 'admin' && admin) return <>{admin}</>
  if (role === 'partner' && partner) return <>{partner}</>
  return <NobodyPage variant="off-limits" />
}
