// Sourced from the canonical taxonomy registry (src/lib/categories.js) so the
// admin editor can never drift from the DB / filters again. This list
// previously omitted `nature` entirely, which meant operators could not assign
// the nature category to an event at all.
export { ADMIN_CATEGORIES as CATEGORIES } from '@/lib/categories'

export const STATUSES = ['pending_review', 'published', 'cancelled']
export const AGE_OPTIONS = ['not_specified', 'all_ages', '18_plus', '21_plus']
export const PARKING_TYPES = ['street', 'lot', 'garage', 'none', 'unknown']

export const STATUS_COLORS = {
  pending_review: 'status-pending',
  published:      'status-published',
  cancelled:      'status-cancelled',
}
