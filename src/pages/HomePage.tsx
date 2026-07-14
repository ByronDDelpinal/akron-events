import { useState, useEffect, useMemo, useRef, useCallback, type ChangeEvent, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import EventsBrowser from '@/components/EventsBrowser'
import HeroRotator from '@/components/HeroRotator'
import { useEventFilters } from '@/hooks/useEventFilters'
import type { AppEvent } from '@/hooks/useEvents'
import { INTENTS, SEARCH_SUGGESTIONS } from '@/lib/intents'
import { CITIES, REGIONS } from '@/lib/cities'
import { NEIGHBORHOODS } from '@/lib/neighborhoods'
import {
  SEO,
  homeTitle,
  homeDescription,
  ENABLED_CATEGORY_HUBS,
  ENABLED_NEIGHBORHOOD_HUBS,
  buildGraph,
  itemListSchema,
} from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import './HomePage.css'

// Hero headline cycles through Akron, its neighborhoods, and the other Summit
// County communities (Green, Stow, …). "Akron" leads so first paint (and the
// <h1> aria-label) reads "What's happening in Akron?". Deduped (CITIES also
// contains Akron); the long regional rollups are intentionally left out.
const HERO_PLACES = Array.from(
  new Set(['Akron', ...NEIGHBORHOODS.map((n) => n.label), ...CITIES.map((c) => c.label)]),
)
import { SearchIcon } from '@/components/icons'

// ── localStorage key for persisting card view mode (density) ──
const VIEW_MODE_KEY = 'akronpulse_card_view_mode'
const LEGACY_VIEW_MODE_KEY = 'turnout_card_view_mode'

function getStoredViewMode(): string {
  try {
    // Rebrand migration: move pre-rebrand value into the new key on first read.
    const legacy = localStorage.getItem(LEGACY_VIEW_MODE_KEY)
    if (legacy && !localStorage.getItem(VIEW_MODE_KEY)) {
      localStorage.setItem(VIEW_MODE_KEY, legacy)
      localStorage.removeItem(LEGACY_VIEW_MODE_KEY)
    }
    const v = localStorage.getItem(VIEW_MODE_KEY)
    return v === 'efficient' ? 'efficient' : 'comfortable'
  } catch { return 'comfortable' }
}

export default function HomePage() {
  // All filter state is URL-backed (shared hook), owned here and passed down.
  const filters = useEventFilters()

  const navigate = useNavigate()

  // ── View + density (controlled, passed to EventsBrowser) ──────────────
  // View is URL-backed (?view=) so it survives navigating to an event page and
  // pressing Back; local state would reset to 'list' on remount.
  const [viewParams, setViewParams] = useSearchParams()
  const view = (() => {
    const v = viewParams.get('view')
    return v === 'map' || v === 'calendar' ? v : 'list'
  })()
  const setView = useCallback((v: string) => {
    setViewParams((prev) => {
      const p = new URLSearchParams(prev)
      if (v === 'list') p.delete('view')
      else p.set('view', v)
      return p
    }, { replace: true })
  }, [setViewParams])
  const [cardViewMode, setCardViewMode] = useState(getStoredViewMode)
  const handleCardViewMode = (mode: string) => {
    setCardViewMode(mode)
    try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* ignore */ }
  }

  // ── Hero video: deferred until the first page of events has loaded ─────
  // Desktop-only: the mp4 (~1.7 MB) was the single largest payload on
  // mobile Lighthouse runs and the poster underneath it looks identical
  // on a phone-sized hero. Also skipped for users on data-saver or with
  // reduced-motion enabled. Eligibility is checked at unlock time, not
  // mount, so an SSR/hydration mismatch is impossible.
  const [videoUnlocked, setVideoUnlocked] = useState(false)
  const handleFirstPageLoad = useCallback(() => {
    type NetInfo = { saveData?: boolean }
    const conn = (navigator as Navigator & { connection?: NetInfo }).connection
    const eligible =
      window.matchMedia('(min-width: 768px)').matches &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
      !conn?.saveData
    if (eligible) setVideoUnlocked(true)
  }, [])

  // ── First page of events (reported up from EventsBrowser) for JSON-LD ──
  const [seoEvents, setSeoEvents] = useState<AppEvent[]>([])
  const handleItemsChange = useCallback((events: AppEvent[]) => setSeoEvents(events), [])

  // ── Search draft (committed query lives in the URL via filters.search) ─
  const [searchInput, setSearchInput] = useState(filters.search)
  const [searchFocused, setSearchFocused] = useState(false)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  // Anchor for the results grid so committing a search can scroll to it.
  const resultsRef = useRef<HTMLDivElement>(null)

  // Keep the <input> in sync when ?q= changes externally (e.g. Back button).
  useEffect(() => { setSearchInput(filters.search) }, [filters.search])

  // Close suggestion dropdown on outside click.
  useEffect(() => {
    if (!searchFocused) return
    function onDown(e: MouseEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setSearchFocused(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [searchFocused])

  // ── Popular-searches pill order ────────────────────────────────────────
  // Homepage-only reorder: "Free Events" is deliberately demoted a few
  // slots (3rd → 7th). Price-data confidence is mixed across sources, so
  // it shouldn't be one of the first pills people see. The canonical hub
  // order in seo/categories.js is unchanged (footer, sitemaps, etc.).
  const popularSearchHubs = useMemo(() => {
    const hubs = [...ENABLED_CATEGORY_HUBS]
    const i = hubs.findIndex((h) => h.slug === 'free')
    if (i !== -1) {
      const [free] = hubs.splice(i, 1)
      hubs.splice(Math.min(i + 4, hubs.length), 0, free)
    }
    return hubs
  }, [])

  // ── Hub slug resolver ─────────────────────────────────────────────────
  const ALL_HUB_ENTRIES = useMemo(() => [
    ...NEIGHBORHOODS,
    ...CITIES,
    ...REGIONS,
  ], [])

  const resolveHubSlug = useCallback((query: string): string | null => {
    const normalise = (s: string) => s.replace(/[\s\-_]+/g, '').toLowerCase()
    const needle = normalise(query)
    if (!needle) return null
    return ALL_HUB_ENTRIES.find((h) => normalise(h.label) === needle || normalise(h.slug) === needle)?.slug ?? null
  }, [ALL_HUB_ENTRIES])

  // Smooth-scroll to the results grid, unless the visitor prefers reduced
  // motion (mirrors the hero-video / HeroRotator reduced-motion guards).
  const scrollToResults = useCallback(() => {
    const el = resultsRef.current
    if (!el) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }, [])

  const handleSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    const hubSlug = resolveHubSlug(searchInput)
    if (hubSlug) {
      setSearchInput('')
      navigate(`/events/${hubSlug}`)
      return
    }
    filters.setSearch(searchInput)
    // Collapse the suggestion tray, drop focus, then scroll down to the
    // results once the committed query has re-rendered the grid.
    setSearchFocused(false)
    e.currentTarget.blur()
    requestAnimationFrame(scrollToResults)
  }

  const handleLocationChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const slug = e.target.value
    if (slug) navigate(`/events/${slug}`)
  }

  // ── Last-updated label (from most recent scraper run) ─────────────────
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  useEffect(() => {
    supabase
      .from('scraper_runs')
      .select('ran_at')
      .order('ran_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (data?.[0]?.ran_at) {
          const hours = (Date.now() - new Date(data[0].ran_at).getTime()) / 3.6e6
          if (hours < 1)       setLastUpdated('< 1 hour ago')
          else if (hours < 24) setLastUpdated(`${Math.round(hours)}h ago`)
          else                 setLastUpdated(`${Math.round(hours / 24)}d ago`)
        }
      })
  }, [])

  // ── JSON-LD ItemList of the next ~12 upcoming events ──────────────────
  const homepageItemList = useMemo(() => {
    if (!seoEvents || seoEvents.length === 0) return null
    return itemListSchema(
      seoEvents.slice(0, 12).map((e) => ({
        name: e.title,
        url: eventPath(e),
      })),
    )
  }, [seoEvents])
  const homeGraph = homepageItemList ? buildGraph(homepageItemList) : null

  return (
    <>
      <SEO
        title={homeTitle()}
        description={homeDescription()}
        path="/"
        jsonLd={homeGraph}
      />

      {/* ── HERO ── */}
      <div className="hero">
        <div className="hero-bg" aria-hidden="true">
          <div className="hero-bg-poster" />
          {videoUnlocked && (
            <video
              className="hero-bg-video"
              autoPlay
              muted
              loop
              playsInline
              disablePictureInPicture
              src="/video/akron-pulse-banner.mp4"
            />
          )}
          <div className="hero-bg-scrim" />
        </div>
        <div className="hero-glow" />
        <p className="hero-eyebrow">Summit County, Ohio</p>
        <h1 aria-label="What's happening in Akron?">
          <span aria-hidden="true">
            What's happening<br />
            in <span className="hero-place"><HeroRotator words={HERO_PLACES} intervalMs={5000} />?</span>
          </span>
        </h1>
        <p className="hero-sub">Concerts, galas, art shows, markets, and more, happening right now in Akron.</p>
        <div className="search-wrap" ref={searchWrapRef}>
          <SearchIcon className="search-icon" />
          <input
            className={[
              'search-input',
              searchFocused && !searchInput ? 'search-input--open' : '',
              !searchFocused && filters.search ? 'search-input--active' : '',
            ].filter(Boolean).join(' ')}
            type="text"
            placeholder="Search events, venues, organizers…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => { if (!searchInput) filters.setSearch('') }}
          />
          {filters.search && (
            <button
              className="search-clear"
              aria-label="Clear search"
              onMouseDown={(e) => {
                e.preventDefault()
                setSearchInput('')
                filters.setSearch('')
                setSearchFocused(false)
              }}
            >
              ×
            </button>
          )}

          {searchFocused && !searchInput && (
            <div className="search-suggestions">
              <p className="search-suggestions-label">What are you looking for?</p>
              {SEARCH_SUGGESTIONS.map((s, i) => {
                const intent = INTENTS.find((it) => it.id === s.intentId)
                return (
                  <button
                    key={i}
                    className="search-suggestion-item"
                    onMouseDown={() => {
                      filters.setActiveIntentId(s.intentId)
                      if (s.datePreset) filters.setDateRange(s.datePreset)
                      setSearchFocused(false)
                    }}
                  >
                    <span className="suggestion-emoji">{intent?.emoji ?? '✨'}</span>
                    <span className="suggestion-text">
                      <span className="suggestion-label">{s.label}</span>
                      {intent?.tagline && (
                        <span className="suggestion-tagline">{intent.tagline}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── STAT BAR ── */}
      <div className="stat-bar">
        <div className="stat-bar-inner">
          {lastUpdated && (
            <div className="stat-pill">Updated <strong>{lastUpdated}</strong></div>
          )}

          <div className="location-jump">
            <LocationIcon />
            <select
              className="location-jump-select"
              value=""
              onChange={handleLocationChange}
              aria-label="Choose a city or community"
            >
              <option value="" disabled>Choose a city or community</option>
              <optgroup label="Cities">
                {CITIES.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.label}</option>
                ))}
              </optgroup>
              <optgroup label="Akron Communities">
                {NEIGHBORHOODS.map((n) => (
                  <option key={n.slug} value={n.slug}>{n.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
      </div>

      {/* ── HUB STRIP ── */}
      {(ENABLED_CATEGORY_HUBS.length + ENABLED_NEIGHBORHOOD_HUBS.length) > 0 && (
        <nav className="home-hub-strip" aria-label="Browse Akron events by category and community">
          <p className="home-hub-strip-label">Popular searches</p>
          <div className="home-hub-strip-scroll-wrap">
          <ul className="home-hub-strip-list">
            {popularSearchHubs.map((h) => (
              <li key={`cat-${h.slug}`}>
                <Link to={`/events/${h.slug}`}>{h.label}</Link>
              </li>
            ))}
            {ENABLED_NEIGHBORHOOD_HUBS.slice(0, 3).map((h) => (
              <li key={`nb-${h.slug}`}>
                <Link to={`/events/${h.slug}`}>{h.label}</Link>
              </li>
            ))}
          </ul>
          </div>
        </nav>
      )}

      {/* ── BROWSING SURFACE (shared with the embed) ── */}
      <div ref={resultsRef}>
        <EventsBrowser
          filters={filters}
          view={view}            onView={setView}
          density={cardViewMode} onDensity={handleCardViewMode}
          renderPromoMid={() => <GridPromo />}
          renderPromoEnd={() => <GridPromo />}
          onFirstPageLoad={handleFirstPageLoad}
          onItemsChange={handleItemsChange}
        />
      </div>
    </>
  )
}

function GridPromo() {
  const [copied, setCopied] = useState(false)

  const handleShare = async () => {
    const shareData = {
      title: 'Akron Pulse | Akron Events',
      text: "Check out Akron Pulse. It's where I find everything happening in Akron & Summit County.",
      url: window.location.origin,
    }
    if (navigator.share) {
      try { await navigator.share(shareData) } catch { /* dismissed */ }
    } else {
      try {
        await navigator.clipboard.writeText(window.location.origin)
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      } catch { /* clipboard unavailable */ }
    }
  }

  return (
    <div className="grid-promo">
      <div className="grid-promo-inner">
        <div className="grid-promo-col">
          <span className="grid-promo-icon">✉️</span>
          <div className="grid-promo-text">
            <strong>Never miss an event</strong>
            <p>Get a personalized digest delivered to your inbox.</p>
          </div>
          <Link to="/subscribe" className="grid-promo-btn grid-promo-btn--subscribe">Subscribe →</Link>
        </div>
        <div className="grid-promo-divider" />
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📤</span>
          <div className="grid-promo-text">
            <strong>Know an organizer?</strong>
            <p>The more events on here, the better. Send them the link.</p>
          </div>
          <button className="grid-promo-btn" onClick={handleShare}>
            {copied ? '✓ Link copied!' : 'Share Akron Pulse →'}
          </button>
        </div>
        <div className="grid-promo-divider" />
        <div className="grid-promo-col">
          <span className="grid-promo-icon">📣</span>
          <div className="grid-promo-text">
            <strong>Got an event?</strong>
            <p>
              Submit it manually, or just email it to{' '}
              <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a>
            </p>
          </div>
          <Link to="/submit" className="grid-promo-btn">Submit an event →</Link>
        </div>
      </div>
    </div>
  )
}



function LocationIcon() {
  return (
    <svg className="location-jump-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}
