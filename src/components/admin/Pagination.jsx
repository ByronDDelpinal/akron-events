/**
 * Shared admin pagination controls.
 *
 * @param {number} page       — current page (0-indexed)
 * @param {number} pageSize   — rows per page
 * @param {number} total      — total row count
 * @param {function} onPageChange — receives new page number
 */
export default function Pagination({ page, pageSize, total, onPageChange }) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null

  const start = page * pageSize + 1
  const end = Math.min((page + 1) * pageSize, total)

  return (
    <div className="admin-pagination">
      <span className="admin-pagination-info">
        {start}–{end} of {total}
      </span>
      <div className="admin-pagination-btns">
        <button
          className="btn-admin-sm"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          ← Prev
        </button>
        <button
          className="btn-admin-sm"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
        >
          Next →
        </button>
      </div>
    </div>
  )
}
