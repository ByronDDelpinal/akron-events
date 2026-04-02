import { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { StatusBadge, SearchBar, ConfirmDialog, Pagination } from '@/components/admin'

const PAGE_SIZE = 50

export default function OrganizationsListPage() {
  const navigate = useNavigate()
  const [orgs, setOrgs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState(null)

  const fetchOrgs = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('organizations')
      .select('*, venues ( id, name ), event_organizations ( event_id )', { count: 'exact' })
      .order('name')

    if (search.trim()) query = query.ilike('name', `%${search.trim()}%`)

    const from = page * PAGE_SIZE
    query = query.range(from, from + PAGE_SIZE - 1)

    const { data, count } = await query
    setOrgs(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page, search])

  useEffect(() => { fetchOrgs() }, [fetchOrgs])
  useEffect(() => { setPage(0) }, [search])

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('organizations').delete().eq('id', deleting.id)
    setDeleting(null)
    fetchOrgs()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Organizations</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      <div className="admin-toolbar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search organizations…" />
        <button className="btn-admin-primary btn-admin-create" onClick={() => navigate('/admin/organizations/new')}>
          + New Organization
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
                <th>Venues</th>
                <th>Events</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map(o => (
                <tr key={o.id}>
                  <td className="admin-td-title">
                    <Link to={`/admin/organizations/${o.id}/edit`} className="admin-td-link">{o.name}</Link>
                  </td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>{o.city ?? '—'}</td>
                  <td>{o.venues?.length ?? 0}</td>
                  <td>{o.event_organizations?.length ?? 0}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => navigate(`/admin/organizations/${o.id}/edit`)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(o)}>Del</button>
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
          message={`Delete "${deleting.name}"?`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
