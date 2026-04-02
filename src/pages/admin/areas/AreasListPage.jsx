import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { ConfirmDialog, Pagination } from '@/components/admin'

const PAGE_SIZE = 50

export default function AreasListPage() {
  const navigate = useNavigate()
  const [areas, setAreas] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(null)

  const fetchAreas = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE
    const { data, count } = await supabase
      .from('areas')
      .select('*, venue:venues ( id, name )', { count: 'exact' })
      .order('name')
      .range(from, from + PAGE_SIZE - 1)
    setAreas(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page])

  useEffect(() => { fetchAreas() }, [fetchAreas])

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('areas').delete().eq('id', deleting.id)
    setDeleting(null)
    fetchAreas()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Areas</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      <div className="admin-toolbar">
        <button className="btn-admin-primary btn-admin-create" onClick={() => navigate('/admin/areas/new')}>
          + New Area
        </button>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Venue</th>
                <th>Capacity</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {areas.map(a => (
                <tr key={a.id}>
                  <td className="admin-td-title">
                    <Link to={`/admin/areas/${a.id}/edit`} className="admin-td-link">{a.name}</Link>
                  </td>
                  <td>
                    {a.venue
                      ? <Link to={`/admin/venues/${a.venue.id}/edit`} className="admin-td-link">{a.venue.name}</Link>
                      : '—'}
                  </td>
                  <td>{a.capacity ?? '—'}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => navigate(`/admin/areas/${a.id}/edit`)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(a)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          message={`Delete area "${deleting.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
