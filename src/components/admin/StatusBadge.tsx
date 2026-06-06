import { STATUS_COLORS } from '@/lib/admin/constants'

export default function StatusBadge({ status }: { status?: string | null }) {
  return (
    <span className={`admin-status-badge ${(status && STATUS_COLORS[status]) ?? ''}`}>
      {status?.replace('_', ' ')}
    </span>
  )
}
