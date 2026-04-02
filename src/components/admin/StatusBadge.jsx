import { STATUS_COLORS } from '@/lib/admin/constants'

export default function StatusBadge({ status }) {
  return (
    <span className={`admin-status-badge ${STATUS_COLORS[status] ?? ''}`}>
      {status?.replace('_', ' ')}
    </span>
  )
}
