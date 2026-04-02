import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { StatusBadge, SearchBar, ConfirmDialog, Pagination } from '@/components/admin'

const PAGE_SIZE = 50

export default function VenuesListPage() {
  const navigate = useNavigate()
  const [venues, setVenues] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState(null)

  const fetchVenues = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('venues')
      .select('*, organization:organizations ( id, name ), areas ( id, name )', { count: 'exact' })
      .order('name')

    if (search.trim()) query = query.ilike('name', `%${search.trim()}%`)

    const from = page * PAGE_SIZE
    query = query.range(from, from + PAGE_SIZE - 1)

    const { data, count } = await query
    setVenues(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page, search])

  useEffect(() => { fetchVenues() }, [fetchVenues])
  useEffect(() => { setPage(0) }, [search])

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('venues').delete().eq('id', deleting.id)
    setDeleting(null)
    fetchVenues()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Venues</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      <div className="admin-toolbar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search venues…" />
        <button className="btn-admin-primary btn-admin-create" onClick={() => navigate('/admin/venues/new')}>
          + New Venue
        </button>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>City</th>
                <th>Organization</th>
                <th>Areas</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {venues.map(v => (
                <tr key={v.id}>
                  <td className="admin-td-title">
                    <Link to={`/admin/venues/${v.id}/edit`} className="admin-td-link">{v.name}</Link>
                  </td>
                  <td><StatusBadge status={v.status} /></td>
                  <td>{v.city ?? '—'}</td>
                  <td>
                    {v.organization
                      ? <Link to={`/admin/organizations/${v.organization.id}/edit`} className="admin-td-link">{v.organization.name}</Link>
                      : '—'}
                  </td>
                  <td>{v.areas?.length ?? 0}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => navigate(`/admin/venues/${v.id}/edit`)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(v)}>Del</button>
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
          message={`Delete venue "${deleting.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
