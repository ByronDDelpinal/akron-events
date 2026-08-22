import ReviewQueueSurface from './ReviewQueueSurface'

/**
 * /admin/review -- a thin wrapper. The queue itself lives in
 * ReviewQueueSurface so the admin home surface can embed the exact same
 * component; two renderings, one implementation, zero drift.
 */
export default function ReviewQueuePage() {
  return <ReviewQueueSurface />
}
