export const CATEGORIES = [
  { value: 'music',     label: 'Music' },
  { value: 'art',       label: 'Art' },
  { value: 'nonprofit', label: 'Non-Profit' },
  { value: 'community', label: 'Community' },
  { value: 'food',      label: 'Food & Drink' },
  { value: 'sports',    label: 'Sports' },
  { value: 'fitness',   label: 'Fitness' },
  { value: 'education', label: 'Education' },
  { value: 'other',     label: 'Other' },
]

export const STATUSES = ['pending_review', 'published', 'cancelled']
export const AGE_OPTIONS = ['not_specified', 'all_ages', '18_plus', '21_plus']
export const PARKING_TYPES = ['street', 'lot', 'garage', 'none', 'unknown']

export const STATUS_COLORS = {
  pending_review: 'status-pending',
  published:      'status-published',
  cancelled:      'status-cancelled',
}
