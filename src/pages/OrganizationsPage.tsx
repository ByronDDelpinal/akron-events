import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useOrganizations } from '@/hooks/useEvents'
import { SEO, buildGraph, itemListSchema, breadcrumbSchema } from '@/lib/seo'
import './OrganizationsPage.css'
import { SearchIcon } from '@/components/icons'

type Row = Record<string, any>

export default function OrganizationsPage() {
  const { organizations, loading, error } = useOrganizations()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return organizations
    return organizations.filter((o) =>
      o.name.toLowerCase().includes(q) ||
      (o.city ?? '').toLowerCase().includes(q) ||
      (o.description ?? '').toLowerCase().includes(q)
    )
  }, [organizations, search])

  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home',          url: '/' },
      { name: 'Organizations', url: '/organizations' },
    ]),
    itemListSchema(
      (filtered || []).slice(0, 50).map((o) => ({
        name: o.name,
        url:  `/organizations/${o.id}`,
      }))
    ),
  )

  return (
    <>
      <SEO
        title="Organizations — Nonprofits & Event Hosts in Akron, OH"
        description="The people and groups making things happen in Akron — nonprofits, arts councils, community groups, and local businesses putting on events in Summit County."
        path="/organizations"
        jsonLd={seoGraph}
      />
      {/* ── HERO ── */}
      <div className="orgs-hero">
        <div className="orgs-hero-inner">
          <p className="orgs-hero-eyebrow">Akron &amp; Summit County</p>
          <h1 className="orgs-hero-title">Organizations</h1>
          <p className="orgs-hero-sub">
            The people and groups that make things happen — nonprofits, arts councils,
            community groups, and local businesses putting on events.
          </p>
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="orgs-body">

        {/* Search */}
        <div className="orgs-search-row">
          <div className="orgs-search-wrap">
            <SearchIcon />
            <input
              className="orgs-search"
              type="text"
              placeholder="Search organizations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search organizations"
            />
            {search && (
              <button className="orgs-search-clear" onClick={() => setSearch('')} aria-label="Clear">✕</button>
            )}
          </div>
          {!loading && (
            <p className="orgs-count">
              {filtered.length} {filtered.length === 1 ? 'organization' : 'organizations'}
            </p>
          )}
        </div>

        {/* States */}
        {loading && (
          <div className="orgs-state">
            <div className="orgs-spinner" />
            <p>Loading organizations…</p>
          </div>
        )}

        {error && (
          <div className="orgs-state orgs-error">
            <p>Could not load organizations.</p>
            <p className="orgs-state-sub">{error}</p>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="orgs-state">
            <p>No organizations match "{search}"</p>
            <button className="orgs-clear-btn" onClick={() => setSearch('')}>Clear search</button>
          </div>
        )}

        {/* Grid */}
        {!loading && !error && filtered.length > 0 && (
          <div className="orgs-grid">
            {filtered.map((org) => (
              <OrgCard key={org.id} org={org} />
            ))}
          </div>
        )}

        {/* CTA */}
        <div className="orgs-cta-section">
          <div className="orgs-cta-card">
            <h3 className="orgs-cta-title">Run an organization in Akron?</h3>
            <p className="orgs-cta-sub">Add your organization to Akron Pulse so people can discover your events.</p>
            <Link to="/organizations/submit" className="orgs-cta-btn">Register Your Organization</Link>
          </div>
        </div>
      </div>
    </>
  )
}

function OrgCard({ org }: { org: Row }) {
  const hasImage = org.image_url && /^https?:\/\//i.test(org.image_url)

  return (
    <Link to={`/organizations/${org.id}`} className="org-card">
      <div className="org-card-top">
        {hasImage
          ? <img src={org.image_url} alt={org.name} className="org-card-img" referrerPolicy="no-referrer" loading="lazy" decoding="async" />
          : <div className="org-card-placeholder">
              <span className="org-card-initial">{org.name?.charAt(0)?.toUpperCase()}</span>
            </div>
        }
      </div>
      <div className="org-card-body">
        <h2 className="org-card-name">{org.name}</h2>
        {org.city && (
          <p className="org-card-location">{[org.city, org.state].filter(Boolean).join(', ')}</p>
        )}
        {org.description && (
          <p className="org-card-desc">{org.description.slice(0, 120)}{org.description.length > 120 ? '…' : ''}</p>
        )}
        <div className="org-card-stats">
          {org.eventCount > 0 && (
            <span className="org-stat">{org.eventCount} event{org.eventCount !== 1 ? 's' : ''}</span>
          )}
          {org.venueCount > 0 && (
            <span className="org-stat">{org.venueCount} venue{org.venueCount !== 1 ? 's' : ''}</span>
          )}
        </div>
      </div>
    </Link>
  )
}


