import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import SearchableMultiSelect from '@/components/SearchableMultiSelect'
import './AdminPage.css'

// ════════════════════════════════════════════════════════════════════════════
// PASSWORD GATE
// ════════════════════════════════════════════════════════════════════════════

const ADMIN_PW = 'admin'

function useAdminAuth() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('admin_auth') === '1')
  const login = (pw) => {
    if (pw === ADMIN_PW) {
      sessionStorage.setItem('admin_auth', '1')
      setAuthed(true)
      return true
    }
    return false
  }
  const logout = () => { sessionStorage.removeItem('admin_auth'); setAuthed(false) }
  return { authed, login, logout }
}

function LoginGate({ onLogin }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    if (!onLogin(pw)) setErr(true)
  }
  return (
    <div className="admin-login-wrap">
      <form className="admin-login-card" onSubmit={submit}>
        <div className="admin-login-icon">🔒</div>
        <h2 className="admin-login-title">Admin Dashboard</h2>
        <p className="admin-login-sub">Enter the admin password to continue.</p>
        {err && <p className="admin-login-err">Incorrect password</p>}
        <input
          className="form-input"
          type="password"
          value={pw}
          onChange={e => { setPw(e.target.value); setErr(false) }}
          placeholder="Password"
          autoFocus
        />
        <button className="btn-admin-primary" type="submit">Sign In</button>
      </form>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const CATEGORIES = [
  { value: 'music',     label: 'Music' },
  { value: 'art',       label: 'Art' },
  { value: 'nonprofit', label: 'Non-Profit' },
  { value: 'community', label: 'Community' },
  { value: 'food',      label: 'Food & Drink' },
  { value: 'sports',    label: 'Fitness / Sports' },
  { value: 'education', label: 'Education' },
  { value: 'other',     label: 'Other' },
]

const STATUSES = ['pending_review', 'published', 'cancelled']
const AGE_OPTIONS = ['not_specified', 'all_ages', '18_plus', '21_plus']
const PARKING_TYPES = ['street', 'lot', 'garage', 'none', 'unknown']

const STATUS_COLORS = {
  pending_review: 'status-pending',
  published:      'status-published',
  cancelled:      'status-cancelled',
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ADMIN PAGE
// ════════════════════════════════════════════════════════════════════════════

export default function AdminPage() {
  const { authed, login, logout } = useAdminAuth()
  const [tab, setTab] = useState('events')

  if (!authed) return <LoginGate onLogin={login} />

  const tabs = [
    { key: 'events',        label: 'Events',        icon: '📅' },
    { key: 'venues',        label: 'Venues',        icon: '📍' },
    { key: 'organizations', label: 'Organizations', icon: '🏢' },
    { key: 'areas',         label: 'Areas',         icon: '🏟️' },
    { key: 'scraper_runs',  label: 'Scraper Runs',  icon: '🤖' },
  ]

  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <h1 className="admin-topbar-title">Turnout Admin</h1>
        <button className="btn-admin-ghost" onClick={logout}>Log out</button>
      </div>
      <div className="admin-layout">
        <nav className="admin-sidebar">
          {tabs.map(t => (
            <button
              key={t.key}
              className={`admin-nav-btn ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <span className="admin-nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="admin-main">
          {tab === 'events'        && <EventsAdmin />}
          {tab === 'venues'        && <VenuesAdmin />}
          {tab === 'organizations' && <OrganizationsAdmin />}
          {tab === 'areas'         && <AreasAdmin />}
          {tab === 'scraper_runs'  && <ScraperRunsAdmin />}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// GENERIC HELPERS
// ════════════════════════════════════════════════════════════════════════════

function StatusBadge({ status }) {
  return <span className={`admin-status-badge ${STATUS_COLORS[status] ?? ''}`}>{status?.replace('_', ' ')}</span>
}

function OverrideToggle({ field, overrides, onToggle }) {
  const isLocked = !!(overrides && overrides[field])
  return (
    <button
      type="button"
      className={`override-toggle ${isLocked ? 'locked' : ''}`}
      onClick={() => onToggle(field)}
      title={isLocked ? `"${field}" is locked — scrapers will skip this field` : `Lock "${field}" to protect from scraper overwrites`}
    >
      {isLocked ? '🔒' : '🔓'}
    </button>
  )
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="admin-modal-backdrop" onClick={onCancel}>
      <div className="admin-confirm-card" onClick={e => e.stopPropagation()}>
        <p className="admin-confirm-msg">{message}</p>
        <div className="admin-confirm-actions">
          <button className="btn-admin-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn-admin-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// EVENTS ADMIN
// ════════════════════════════════════════════════════════════════════════════

function EventsAdmin() {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [editing, setEditing] = useState(null) // event object or null
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)

  // Venue & org lookups for relationship editing
  const [allVenues, setAllVenues] = useState([])
  const [allOrgs, setAllOrgs] = useState([])
  const [allAreas, setAllAreas] = useState([])

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
      .limit(200)

    const { data, error } = await query
    if (!error) setEvents(data ?? [])
    setLoading(false)
  }, [])

  const fetchRelated = useCallback(async () => {
    const [v, o, a] = await Promise.all([
      supabase.from('venues').select('id, name').order('name'),
      supabase.from('organizations').select('id, name').order('name'),
      supabase.from('areas').select('id, name, venue_id').order('name'),
    ])
    setAllVenues(v.data ?? [])
    setAllOrgs(o.data ?? [])
    setAllAreas(a.data ?? [])
  }, [])

  useEffect(() => { fetchEvents(); fetchRelated() }, [])

  const filtered = useMemo(() => {
    let list = events
    if (statusFilter !== 'all') list = list.filter(e => e.status === statusFilter)
    const q = search.trim().toLowerCase()
    if (q) list = list.filter(e => e.title?.toLowerCase().includes(q) || e.source?.toLowerCase().includes(q))
    return list
  }, [events, statusFilter, search])

  const handleSave = async (updated) => {
    const { _linkedVenueIds, _linkedOrgIds, _linkedAreaIds } = updated
    const isNew = !updated.id

    // Only send writable event columns
    const eventFields = {
      title:           updated.title,
      description:     updated.description ?? null,
      status:          updated.status,
      category:        updated.category ?? null,
      start_at:        updated.start_at,
      end_at:          updated.end_at ?? null,
      price_min:       updated.price_min ?? 0,
      price_max:       updated.price_max ?? null,
      age_restriction: updated.age_restriction ?? 'not_specified',
      ticket_url:      updated.ticket_url ?? null,
      image_url:       updated.image_url ?? null,
      featured:        updated.featured ?? false,
      manual_overrides: updated.manual_overrides ?? {},
    }

    let eventId = updated.id
    if (isNew) {
      const { data, error } = await supabase.from('events').insert(eventFields).select('id').single()
      if (error) { alert('Create failed: ' + error.message); return }
      eventId = data.id
    } else {
      const { error } = await supabase.from('events').update(eventFields).eq('id', updated.id)
      if (error) { alert('Save failed: ' + error.message); return }
    }

    // Update junction tables
    if (_linkedVenueIds) {
      if (!isNew) await supabase.from('event_venues').delete().eq('event_id', eventId)
      if (_linkedVenueIds.length > 0) {
        await supabase.from('event_venues').insert(_linkedVenueIds.map(vid => ({ event_id: eventId, venue_id: vid })))
      }
    }
    if (_linkedOrgIds) {
      if (!isNew) await supabase.from('event_organizations').delete().eq('event_id', eventId)
      if (_linkedOrgIds.length > 0) {
        await supabase.from('event_organizations').insert(_linkedOrgIds.map(oid => ({ event_id: eventId, organization_id: oid })))
      }
    }
    if (_linkedAreaIds) {
      if (!isNew) await supabase.from('event_areas').delete().eq('event_id', eventId)
      if (_linkedAreaIds.length > 0) {
        await supabase.from('event_areas').insert(_linkedAreaIds.map(aid => ({ event_id: eventId, area_id: aid })))
      }
    }

    setEditing(null)
    setCreating(false)
    fetchEvents()
  }

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
        <span className="admin-section-count">{filtered.length}</span>
      </div>

      <div className="admin-toolbar">
        <input className="admin-search" placeholder="Search events…" value={search} onChange={e => setSearch(e.target.value)} />
        <select className="admin-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <button className="btn-admin-primary btn-admin-create" onClick={() => setCreating(true)}>+ New Event</button>
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
              {filtered.map(event => (
                <tr key={event.id}>
                  <td className="admin-td-title">{event.title}</td>
                  <td><StatusBadge status={event.status} /></td>
                  <td>{event.category}</td>
                  <td className="admin-td-nowrap">{event.start_at ? format(new Date(event.start_at), 'MMM d, yyyy') : '—'}</td>
                  <td className="admin-td-source">{event.source ?? '—'}</td>
                  <td>{(event.event_venues ?? []).map(ev => ev.venue?.name).filter(Boolean).join(', ') || '—'}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => setEditing(event)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(event)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <EventEditModal
          event={editing || { status: 'published', category: '', age_restriction: 'not_specified', featured: false, manual_overrides: {} }}
          isNew={creating}
          venues={allVenues}
          organizations={allOrgs}
          areas={allAreas}
          onSave={handleSave}
          onClose={() => { setEditing(null); setCreating(false) }}
        />
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

// ── EVENT EDIT MODAL ──

function EventEditModal({ event, isNew, venues, organizations, areas, onSave, onClose }) {
  const [form, setForm] = useState({ ...event })
  const [linkedVenueIds, setLinkedVenueIds] = useState(
    (event.event_venues ?? []).map(ev => ev.venue_id ?? ev.venue?.id).filter(Boolean)
  )
  const [linkedOrgIds, setLinkedOrgIds] = useState(
    (event.event_organizations ?? []).map(eo => eo.organization_id ?? eo.organization?.id).filter(Boolean)
  )
  const [linkedAreaIds, setLinkedAreaIds] = useState(
    (event.event_areas ?? []).map(ea => ea.area_id ?? ea.area?.id).filter(Boolean)
  )
  const [overrides, setOverrides] = useState(event.manual_overrides ?? {})

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleOverride = (field) => {
    setOverrides(prev => {
      const next = { ...prev }
      if (next[field]) { delete next[field] } else { next[field] = { at: new Date().toISOString() } }
      return next
    })
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onSave({
      ...form,
      manual_overrides: overrides,
      _linkedVenueIds: linkedVenueIds,
      _linkedOrgIds: linkedOrgIds,
      _linkedAreaIds: linkedAreaIds,
    })
  }

  const toggleLink = (id, list, setter) => {
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{isNew ? 'New Event' : 'Edit Event'}</h3>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="admin-modal-body">
          <div className="admin-field">
            <label>Title <OverrideToggle field="title" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.title ?? ''} onChange={e => set('title', e.target.value)} />
          </div>

          <div className="admin-field-row">
            <div className="admin-field">
              <label>Status</label>
              <select className="form-select" value={form.status} onChange={e => set('status', e.target.value)}>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div className="admin-field">
              <label>Category <OverrideToggle field="category" overrides={overrides} onToggle={toggleOverride} /></label>
              <select className="form-select" value={form.category ?? ''} onChange={e => set('category', e.target.value)}>
                <option value="">—</option>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>

          <div className="admin-field-row">
            <div className="admin-field">
              <label>Start <OverrideToggle field="start_at" overrides={overrides} onToggle={toggleOverride} /></label>
              <input className="form-input" type="datetime-local"
                value={form.start_at ? form.start_at.slice(0, 16) : ''}
                onChange={e => set('start_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
              />
            </div>
            <div className="admin-field">
              <label>End <OverrideToggle field="end_at" overrides={overrides} onToggle={toggleOverride} /></label>
              <input className="form-input" type="datetime-local"
                value={form.end_at ? form.end_at.slice(0, 16) : ''}
                onChange={e => set('end_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
              />
            </div>
          </div>

          <div className="admin-field">
            <label>Description <OverrideToggle field="description" overrides={overrides} onToggle={toggleOverride} /></label>
            <textarea className="form-textarea" value={form.description ?? ''} onChange={e => set('description', e.target.value)} rows={4} />
          </div>

          <div className="admin-field-row">
            <div className="admin-field">
              <label>Price Min <OverrideToggle field="price_min" overrides={overrides} onToggle={toggleOverride} /></label>
              <input className="form-input" type="number" min="0" step="0.01" value={form.price_min ?? ''} onChange={e => set('price_min', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </div>
            <div className="admin-field">
              <label>Price Max <OverrideToggle field="price_max" overrides={overrides} onToggle={toggleOverride} /></label>
              <input className="form-input" type="number" min="0" step="0.01" value={form.price_max ?? ''} onChange={e => set('price_max', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </div>
          </div>

          <div className="admin-field-row">
            <div className="admin-field">
              <label>Age Restriction</label>
              <select className="form-select" value={form.age_restriction ?? 'not_specified'} onChange={e => set('age_restriction', e.target.value)}>
                {AGE_OPTIONS.map(a => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div className="admin-field">
              <label>Featured</label>
              <label className="admin-checkbox-label">
                <input type="checkbox" checked={!!form.featured} onChange={e => set('featured', e.target.checked)} />
                Featured event
              </label>
            </div>
          </div>

          <div className="admin-field">
            <label>Ticket URL <OverrideToggle field="ticket_url" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.ticket_url ?? ''} onChange={e => set('ticket_url', e.target.value)} />
          </div>

          <div className="admin-field">
            <label>Image URL <OverrideToggle field="image_url" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.image_url ?? ''} onChange={e => set('image_url', e.target.value)} />
          </div>

          {/* Relationship editors */}
          <div className="admin-section-label">Linked Venues</div>
          <div className="admin-chip-list">
            {venues.map(v => (
              <button key={v.id} type="button"
                className={`admin-chip ${linkedVenueIds.includes(v.id) ? 'active' : ''}`}
                onClick={() => toggleLink(v.id, linkedVenueIds, setLinkedVenueIds)}
              >{v.name}</button>
            ))}
          </div>

          <div className="admin-section-label">Linked Organizations</div>
          <div className="admin-chip-list">
            {organizations.map(o => (
              <button key={o.id} type="button"
                className={`admin-chip ${linkedOrgIds.includes(o.id) ? 'active' : ''}`}
                onClick={() => toggleLink(o.id, linkedOrgIds, setLinkedOrgIds)}
              >{o.name}</button>
            ))}
          </div>

          <div className="admin-section-label">Linked Areas</div>
          <div className="admin-chip-list">
            {areas.map(a => (
              <button key={a.id} type="button"
                className={`admin-chip ${linkedAreaIds.includes(a.id) ? 'active' : ''}`}
                onClick={() => toggleLink(a.id, linkedAreaIds, setLinkedAreaIds)}
              >{a.name}</button>
            ))}
          </div>

          <div className="admin-section-label">Override Locks</div>
          <p className="admin-hint">Locked fields are protected from scraper overwrites. Click the lock icon next to any field above to toggle.</p>
          {Object.keys(overrides).length > 0 && (
            <div className="admin-override-list">
              {Object.entries(overrides).map(([field, val]) => (
                <span key={field} className="admin-override-chip">
                  🔒 {field}
                  <span className="admin-override-date"> (since {format(new Date(val.at), 'MMM d')})</span>
                </span>
              ))}
            </div>
          )}

          <div className="admin-modal-footer">
            <button type="button" className="btn-admin-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-admin-primary">{isNew ? 'Create Event' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// VENUES ADMIN
// ════════════════════════════════════════════════════════════════════════════

function VenuesAdmin() {
  const [venues, setVenues] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [allOrgs, setAllOrgs] = useState([])

  const fetchVenues = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('venues')
      .select('*, organization:organizations ( id, name ), areas ( id, name )')
      .order('name')
    setVenues(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchVenues()
    supabase.from('organizations').select('id, name').order('name').then(({ data }) => setAllOrgs(data ?? []))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return venues
    return venues.filter(v => v.name?.toLowerCase().includes(q) || v.city?.toLowerCase().includes(q))
  }, [venues, search])

  const handleSave = async (updated) => {
    const isNew = !updated.id
    const venueFields = {
      name:             updated.name,
      status:           updated.status ?? 'published',
      address:          updated.address ?? null,
      city:             updated.city ?? null,
      state:            updated.state ?? null,
      zip:              updated.zip ?? null,
      description:      updated.description ?? null,
      website:          updated.website ?? null,
      lat:              updated.lat ?? null,
      lng:              updated.lng ?? null,
      parking_type:     updated.parking_type ?? 'unknown',
      parking_notes:    updated.parking_notes ?? null,
      organization_id:  updated.organization_id ?? null,
      tags:             updated.tags ?? [],
      image_url:        updated.image_url ?? null,
      manual_overrides: updated.manual_overrides ?? {},
    }
    if (isNew) {
      const { error } = await supabase.from('venues').insert(venueFields)
      if (error) { alert('Create failed: ' + error.message); return }
    } else {
      const { error } = await supabase.from('venues').update(venueFields).eq('id', updated.id)
      if (error) { alert('Save failed: ' + error.message); return }
    }
    setEditing(null)
    setCreating(false)
    fetchVenues()
  }

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
        <span className="admin-section-count">{filtered.length}</span>
      </div>

      <div className="admin-toolbar">
        <input className="admin-search" placeholder="Search venues…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn-admin-primary btn-admin-create" onClick={() => setCreating(true)}>+ New Venue</button>
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
              {filtered.map(v => (
                <tr key={v.id}>
                  <td className="admin-td-title">{v.name}</td>
                  <td><StatusBadge status={v.status} /></td>
                  <td>{v.city ?? '—'}</td>
                  <td>{v.organization?.name ?? '—'}</td>
                  <td>{v.areas?.length ?? 0}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => setEditing(v)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(v)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <VenueEditModal
          venue={editing || { status: 'published', parking_type: 'unknown', tags: [], manual_overrides: {} }}
          isNew={creating}
          organizations={allOrgs}
          onSave={handleSave}
          onClose={() => { setEditing(null); setCreating(false) }}
        />
      )}
      {deleting && (
        <ConfirmDialog message={`Delete venue "${deleting.name}"?`} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />
      )}
    </div>
  )
}

function VenueEditModal({ venue, isNew, organizations, onSave, onClose }) {
  const [form, setForm] = useState({ ...venue })
  const [overrides, setOverrides] = useState(venue.manual_overrides ?? {})
  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleOverride = (field) => {
    setOverrides(prev => {
      const next = { ...prev }
      if (next[field]) delete next[field]; else next[field] = { at: new Date().toISOString() }
      return next
    })
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onSave({ ...form, manual_overrides: overrides })
  }

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{isNew ? 'New Venue' : 'Edit Venue'}</h3>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="admin-modal-body">
          <div className="admin-field">
            <label>Name <OverrideToggle field="name" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.name ?? ''} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="admin-field">
            <label>Status</label>
            <select className="form-select" value={form.status ?? 'published'} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label>Address <OverrideToggle field="address" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.address ?? ''} onChange={e => set('address', e.target.value)} />
          </div>
          <div className="admin-field-row">
            <div className="admin-field">
              <label>City</label>
              <input className="form-input" value={form.city ?? ''} onChange={e => set('city', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>State</label>
              <input className="form-input" value={form.state ?? ''} onChange={e => set('state', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Zip</label>
              <input className="form-input" value={form.zip ?? ''} onChange={e => set('zip', e.target.value)} />
            </div>
          </div>
          <div className="admin-field">
            <label>Description</label>
            <textarea className="form-textarea" value={form.description ?? ''} onChange={e => set('description', e.target.value)} rows={3} />
          </div>
          <div className="admin-field-row">
            <div className="admin-field">
              <label>Lat</label>
              <input className="form-input" type="number" step="any" value={form.lat ?? ''} onChange={e => set('lat', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </div>
            <div className="admin-field">
              <label>Lng</label>
              <input className="form-input" type="number" step="any" value={form.lng ?? ''} onChange={e => set('lng', e.target.value === '' ? null : parseFloat(e.target.value))} />
            </div>
          </div>
          <div className="admin-field-row">
            <div className="admin-field">
              <label>Parking Type</label>
              <select className="form-select" value={form.parking_type ?? 'unknown'} onChange={e => set('parking_type', e.target.value)}>
                {PARKING_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="admin-field">
              <label>Website</label>
              <input className="form-input" value={form.website ?? ''} onChange={e => set('website', e.target.value)} />
            </div>
          </div>
          <div className="admin-field">
            <label>Parking Notes</label>
            <input className="form-input" value={form.parking_notes ?? ''} onChange={e => set('parking_notes', e.target.value)} />
          </div>
          <div className="admin-field">
            <label>Organization</label>
            <select className="form-select" value={form.organization_id ?? ''} onChange={e => set('organization_id', e.target.value || null)}>
              <option value="">None</option>
              {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label>Tags (comma-separated)</label>
            <input className="form-input" value={(form.tags ?? []).join(', ')} onChange={e => set('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))} />
          </div>
          <div className="admin-field">
            <label>Image URL</label>
            <input className="form-input" value={form.image_url ?? ''} onChange={e => set('image_url', e.target.value)} />
          </div>

          <div className="admin-modal-footer">
            <button type="button" className="btn-admin-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-admin-primary">{isNew ? 'Create Venue' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS ADMIN
// ════════════════════════════════════════════════════════════════════════════

function OrganizationsAdmin() {
  const [orgs, setOrgs] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [allVenues, setAllVenues] = useState([])
  const [deleting, setDeleting] = useState(null)

  const fetchOrgs = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('organizations')
      .select('*, venues ( id, name ), event_organizations ( event_id )')
      .order('name')
    setOrgs(data ?? [])
    setLoading(false)
  }, [])

  const fetchVenues = useCallback(async () => {
    const { data } = await supabase.from('venues').select('id, name, organization_id').order('name')
    setAllVenues(data ?? [])
  }, [])

  useEffect(() => { fetchOrgs(); fetchVenues() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(o => o.name?.toLowerCase().includes(q))
  }, [orgs, search])

  const handleSave = async (updated) => {
    const isNew = !updated.id
    const orgFields = {
      name:             updated.name,
      status:           updated.status,
      description:      updated.description ?? null,
      website:          updated.website ?? null,
      address:          updated.address ?? null,
      city:             updated.city ?? null,
      state:            updated.state ?? null,
      zip:              updated.zip ?? null,
      contact_email:    updated.contact_email ?? null,
      image_url:        updated.image_url ?? null,
      manual_overrides: updated.manual_overrides ?? {},
    }

    let orgId = updated.id
    if (isNew) {
      const { data, error } = await supabase.from('organizations').insert(orgFields).select('id').single()
      if (error) { alert('Create failed: ' + error.message); return }
      orgId = data.id
    } else {
      const { error } = await supabase.from('organizations').update(orgFields).eq('id', updated.id)
      if (error) { alert('Save failed: ' + error.message); return }
    }

    // Update venue ownership: set organization_id on selected, clear on deselected
    if (updated._ownedVenueIds) {
      const currentlyOwned = allVenues.filter(v => v.organization_id === orgId).map(v => v.id)
      const toAssign = updated._ownedVenueIds.filter(vid => !currentlyOwned.includes(vid))
      const toRemove = currentlyOwned.filter(vid => !updated._ownedVenueIds.includes(vid))

      if (toAssign.length > 0) {
        const { error: assignErr } = await supabase.from('venues').update({ organization_id: orgId }).in('id', toAssign)
        if (assignErr) { alert('Failed to assign venues: ' + assignErr.message); return }
      }
      if (toRemove.length > 0) {
        const { error: removeErr } = await supabase.from('venues').update({ organization_id: null }).in('id', toRemove)
        if (removeErr) { alert('Failed to unassign venues: ' + removeErr.message); return }
      }
    }

    setEditing(null)
    setCreating(false)
    fetchOrgs()
    fetchVenues()
  }

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
        <span className="admin-section-count">{filtered.length}</span>
      </div>

      <div className="admin-toolbar">
        <input className="admin-search" placeholder="Search organizations…" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="btn-admin-primary btn-admin-create" onClick={() => setCreating(true)}>+ New Organization</button>
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
              {filtered.map(o => (
                <tr key={o.id}>
                  <td className="admin-td-title">{o.name}</td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>{o.city ?? '—'}</td>
                  <td>{o.venues?.length ?? 0}</td>
                  <td>{o.event_organizations?.length ?? 0}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => setEditing(o)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(o)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <OrgEditModal
          org={editing || { status: 'published', manual_overrides: {}, venues: [] }}
          isNew={creating}
          allVenues={allVenues}
          onSave={handleSave}
          onClose={() => { setEditing(null); setCreating(false) }}
        />
      )}
      {deleting && (
        <ConfirmDialog message={`Delete "${deleting.name}"?`} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />
      )}
    </div>
  )
}

function OrgEditModal({ org, isNew, allVenues, onSave, onClose }) {
  const [form, setForm] = useState({ ...org })
  const [overrides, setOverrides] = useState(org.manual_overrides ?? {})
  const [ownedVenueIds, setOwnedVenueIds] = useState(
    (org.venues ?? []).map(v => v.id)
  )
  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleOverride = (field) => {
    setOverrides(prev => {
      const next = { ...prev }
      if (next[field]) delete next[field]; else next[field] = { at: new Date().toISOString() }
      return next
    })
  }

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{isNew ? 'New Organization' : 'Edit Organization'}</h3>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={e => { e.preventDefault(); onSave({ ...form, manual_overrides: overrides, _ownedVenueIds: ownedVenueIds }) }} className="admin-modal-body">
          <div className="admin-field">
            <label>Name <OverrideToggle field="name" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.name ?? ''} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="admin-field">
            <label>Status</label>
            <select className="form-select" value={form.status ?? 'published'} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label>Description <OverrideToggle field="description" overrides={overrides} onToggle={toggleOverride} /></label>
            <textarea className="form-textarea" value={form.description ?? ''} onChange={e => set('description', e.target.value)} rows={3} />
          </div>
          <div className="admin-field">
            <label>Website <OverrideToggle field="website" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.website ?? ''} onChange={e => set('website', e.target.value)} />
          </div>
          <div className="admin-field-row">
            <div className="admin-field">
              <label>Address</label>
              <input className="form-input" value={form.address ?? ''} onChange={e => set('address', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>City</label>
              <input className="form-input" value={form.city ?? ''} onChange={e => set('city', e.target.value)} />
            </div>
          </div>
          <div className="admin-field-row">
            <div className="admin-field">
              <label>State</label>
              <input className="form-input" value={form.state ?? ''} onChange={e => set('state', e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Zip</label>
              <input className="form-input" value={form.zip ?? ''} onChange={e => set('zip', e.target.value)} />
            </div>
          </div>
          <div className="admin-field">
            <label>Contact Email</label>
            <input className="form-input" type="email" value={form.contact_email ?? ''} onChange={e => set('contact_email', e.target.value)} />
          </div>
          <div className="admin-field">
            <label>Image URL <OverrideToggle field="image_url" overrides={overrides} onToggle={toggleOverride} /></label>
            <input className="form-input" value={form.image_url ?? ''} onChange={e => set('image_url', e.target.value)} />
          </div>

          <div className="admin-section-label">Owned Venues</div>
          <SearchableMultiSelect
            allEntities={allVenues ?? []}
            selectedIds={ownedVenueIds}
            onChange={setOwnedVenueIds}
            placeholder="Search and select venues…"
            disabledLabel={v => v.organization_id && v.organization_id !== org.id ? 'owned by other org' : null}
          />

          <div className="admin-modal-footer">
            <button type="button" className="btn-admin-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-admin-primary">{isNew ? 'Create Organization' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// AREAS ADMIN
// ════════════════════════════════════════════════════════════════════════════

function AreasAdmin() {
  const [areas, setAreas] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [allVenues, setAllVenues] = useState([])

  const fetchAreas = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('areas')
      .select('*, venue:venues ( id, name )')
      .order('name')
    setAreas(data ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchAreas()
    supabase.from('venues').select('id, name').order('name').then(({ data }) => setAllVenues(data ?? []))
  }, [])

  const handleSave = async (updated) => {
    const isNew = !updated.id
    const areaFields = {
      name:        updated.name,
      venue_id:    updated.venue_id,
      description: updated.description ?? null,
      capacity:    updated.capacity ?? null,
    }
    if (isNew) {
      const { error } = await supabase.from('areas').insert(areaFields)
      if (error) { alert('Create failed: ' + error.message); return }
    } else {
      const { error } = await supabase.from('areas').update(areaFields).eq('id', updated.id)
      if (error) { alert('Save failed: ' + error.message); return }
    }
    setEditing(null)
    setCreating(false)
    fetchAreas()
  }

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
        <span className="admin-section-count">{areas.length}</span>
      </div>

      <div className="admin-toolbar">
        <button className="btn-admin-primary btn-admin-create" onClick={() => setCreating(true)}>+ New Area</button>
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
                  <td className="admin-td-title">{a.name}</td>
                  <td>{a.venue?.name ?? '—'}</td>
                  <td>{a.capacity ?? '—'}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm" onClick={() => setEditing(a)}>Edit</button>
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(a)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <AreaEditModal
          area={editing || {}}
          isNew={creating}
          venues={allVenues}
          onSave={handleSave}
          onClose={() => { setEditing(null); setCreating(false) }}
        />
      )}
      {deleting && (
        <ConfirmDialog message={`Delete area "${deleting.name}"?`} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />
      )}
    </div>
  )
}

function AreaEditModal({ area, isNew, venues, onSave, onClose }) {
  const [form, setForm] = useState({ ...area })
  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  return (
    <div className="admin-modal-backdrop" onClick={onClose}>
      <div className="admin-modal admin-modal--sm" onClick={e => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{isNew ? 'New Area' : 'Edit Area'}</h3>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={e => { e.preventDefault(); onSave(form) }} className="admin-modal-body">
          <div className="admin-field">
            <label>Name</label>
            <input className="form-input" value={form.name ?? ''} onChange={e => set('name', e.target.value)} />
          </div>
          <div className="admin-field">
            <label>Venue</label>
            <select className="form-select" value={form.venue_id ?? ''} onChange={e => set('venue_id', e.target.value || null)}>
              <option value="">Select venue…</option>
              {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div className="admin-field">
            <label>Description</label>
            <textarea className="form-textarea" value={form.description ?? ''} onChange={e => set('description', e.target.value)} rows={2} />
          </div>
          <div className="admin-field">
            <label>Capacity</label>
            <input className="form-input" type="number" value={form.capacity ?? ''} onChange={e => set('capacity', e.target.value === '' ? null : parseInt(e.target.value))} />
          </div>
          <div className="admin-modal-footer">
            <button type="button" className="btn-admin-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-admin-primary">{isNew ? 'Create Area' : 'Save Changes'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// SCRAPER RUNS (read-only health dashboard)
// ════════════════════════════════════════════════════════════════════════════

function ScraperRunsAdmin() {
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('scraper_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      setRuns(data ?? [])
      setLoading(false)
    })()
  }, [])

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Scraper Runs</h2>
        <span className="admin-section-count">{runs.length}</span>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Scraper</th>
                <th>Status</th>
                <th>Found</th>
                <th>New</th>
                <th>Updated</th>
                <th>Skipped</th>
                <th>Duration</th>
                <th>Ran At</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td className="admin-td-title">{r.scraper_name}</td>
                  <td>
                    <span className={`admin-status-badge ${r.status === 'error' ? 'status-cancelled' : 'status-published'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>{r.events_found ?? 0}</td>
                  <td>{r.events_inserted ?? 0}</td>
                  <td>{r.events_updated ?? 0}</td>
                  <td>{r.events_skipped ?? 0}</td>
                  <td>{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="admin-td-nowrap">{r.created_at ? format(new Date(r.created_at), 'MMM d, h:mm a') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
