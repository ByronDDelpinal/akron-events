import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import { STATUSES } from '@/lib/admin/constants'
import { StatusBadge, SearchBar, ConfirmDialog, Pagination } from '@/components/admin'

const PAGE_SIZE = 50

export default function EventsListPage() {
  const navigate = useNavigate()
  const [events, setEvents] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [deleting, setDeleting] = useState(null)

  const fetchEvents = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('events')
      .select(`
        *,
        event_venues ( venue_id, venue:venues ( id, name ) ),
        event_organizations ( organization_id, organization:organizations ( id, name ) ),
        event_areas ( area_id, area:areas ( id, name ) )
      `, { count: 'exact' })
      .order('start_at', { ascending: false })

    if (statusFilter !== 'all') query = query.eq('status', statusFilter)
    if (search.trim()) query = query.ilike('title', `%${search.trim()}%`)

    const from = page * PAGE_SIZE
    query = query.range(from, from + PAGE_SIZE - 1)

    const { data, count } = await query
    setEvents(data ?? [])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page, statusFilter, search])

  useEffect(() => { fetchEvents() }, [fetchEvents])

  // Reset to page 0 when filters change
  useEffect(() => { setPage(0) }, [statusFilter, search])

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('events').delete().eq('id', deleting.id)
    setDeleting(null)
    fetchEvents()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Events</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      <div className="admin-toolbar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search events…" />
        <select className="admin-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button className="btn-admin-primary btn-admin-create" onClick={() => navigate('/admin/events/new')}>
          + New Event
        </button>
      </div>

      {loading && <div className="admin-loading">Loading events…</div>}

      {!loading && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Category</th>
                <th>Date</th>
                <th>Source</th>
                <th>Venues</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map(event => (
                <tr key={event.id}>
                  <td className="admin-td-title">
                    <Link to={`/admin/events/${event.id}/edit`} className="admin-td-link">{event.title}</Link>
                  </td>
                  <td><StatusBadge status={event.status} /></td>
                  <td>{event.category}</td>
                  <td className="admin-td-nowrap">
                    {event.start_at ? format(new Date(event.start_at), 'MMM d, yyyy') : '—'}
                  </td>
                  <td className="admin-td-source">{event.source ?? '—'}</td>
                  <td>
                    {(event.event_venues ?? []).filter(ev => ev.venue).map((ev, i) => (
                      <span key={ev.venue.id}>{i > 0 && ', '}<Link to={`/admin/venues/${ev.venue.id}/edit`} className="admin-td-link">{ev.venue.name}</Link></span>
                    ))}
                    {(event.event_venues ?? []).filter(ev => ev.venue).length === 0 && '—'}
                  </td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => navigate(`/admin/events/${event.id}/edit`)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(event)}>Del</button>
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
          message={`Delete "${deleting.title}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
