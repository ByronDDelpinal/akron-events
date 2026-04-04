import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import { Pagination } from '@/components/admin'

const PAGE_SIZE = 50

const CATEGORIES = [
  { id: 'all',      label: 'All' },
  { id: 'bug',      label: 'Bug',          icon: '🐛' },
  { id: 'love',     label: 'Love It',      icon: '🔥' },
  { id: 'wish',     label: 'Wish List',    icon: '✨' },
  { id: 'confusing',label: 'Confusing',    icon: '🤔' },
  { id: 'idea',      label: 'Roadmap Idea', icon: '💡' },
  { id: 'datasource',label: 'Data Source',  icon: '📡' },
  { id: 'general',   label: 'General',      icon: '💬' },
]

const VISIBILITY = [
  { id: 'all',     label: 'All' },
  { id: 'public',  label: 'Public' },
  { id: 'private', label: 'Private' },
]

export default function AdminFeedbackPage() {
  const [posts,      setPosts]      = useState([])
  const [total,      setTotal]      = useState(0)
  const [page,       setPage]       = useState(0)
  const [loading,    setLoading]    = useState(true)
  const [catFilter,  setCatFilter]  = useState('all')
  const [visFilter,  setVisFilter]  = useState('all')

  const fetchPosts = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE

    let query = supabase
      .from('feedback_posts')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (catFilter !== 'all') query = query.eq('category', catFilter)
    if (visFilter === 'public')  query = query.eq('is_private', false)
    if (visFilter === 'private') query = query.eq('is_private', true)

    const { data, count } = await query
    setPosts(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page, catFilter, visFilter])

  useEffect(() => { fetchPosts() }, [fetchPosts])

  // Reset to first page when filters change
  useEffect(() => { setPage(0) }, [catFilter, visFilter])

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this feedback post?')) return
    await supabase.from('feedback_posts').delete().eq('id', id)
    fetchPosts()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Feedback</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      {/* ── Filters ────────────────────────────────────────────────── */}
      <div className="admin-feedback-filters">
        <div className="admin-feedback-filter-group">
          <span className="admin-feedback-filter-label">Category</span>
          <div className="admin-feedback-chips">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                className={`admin-feedback-chip ${catFilter === c.id ? 'active' : ''}`}
                onClick={() => setCatFilter(c.id)}
              >
                {c.icon && <span>{c.icon}</span>} {c.label}
              </button>
            ))}
          </div>
        </div>
        <div className="admin-feedback-filter-group">
          <span className="admin-feedback-filter-label">Visibility</span>
          <div className="admin-feedback-chips">
            {VISIBILITY.map(v => (
              <button
                key={v.id}
                className={`admin-feedback-chip ${visFilter === v.id ? 'active' : ''}`}
                onClick={() => setVisFilter(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && posts.length === 0 && (
        <div className="admin-empty">No feedback found.</div>
      )}

      {!loading && posts.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Category</th>
                <th>Feedback</th>
                <th>Author</th>
                <th>Votes</th>
                <th>Visibility</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {posts.map(p => {
                const cat = CATEGORIES.find(c => c.id === p.category)
                return (
                  <tr key={p.id}>
                    <td>
                      <span className={`admin-status-badge status-${p.category}`}>
                        {cat?.icon} {cat?.label || p.category}
                      </span>
                    </td>
                    <td className="admin-td-title admin-feedback-body">{p.body}</td>
                    <td>{p.author_name}</td>
                    <td style={{ textAlign: 'center' }}>{p.votes}</td>
                    <td>
                      {p.is_private
                        ? <span className="admin-status-badge status-cancelled">Private</span>
                        : <span className="admin-status-badge status-published">Public</span>
                      }
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {format(new Date(p.created_at), 'MMM d, yyyy h:mm a')}
                    </td>
                    <td>
                      <button
                        className="btn-admin-ghost btn-admin-sm"
                        onClick={() => handleDelete(p.id)}
                        title="Delete"
                      >×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <Pagination
          page={page}
          pageSize={PAGE_SIZE}
          total={total}
          onChange={setPage}
        />
      )}
    </div>
  )
}
