import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { INTENTS } from '@/lib/intents'
import { EMAIL_THEME } from '@/lib/emailTheme'
import SearchableMultiSelect from '@/components/SearchableMultiSelect'
import './PreferencesPage.css'

const CATEGORIES = [
  { id: 'music',      label: 'Music',      emoji: '🎵' },
  { id: 'art',        label: 'Art',        emoji: '🎨' },
  { id: 'community',  label: 'Community',  emoji: '🏘' },
  { id: 'nonprofit',  label: 'Nonprofit',  emoji: '💛' },
  { id: 'food',       label: 'Food',       emoji: '🍽' },
  { id: 'sports',     label: 'Sports',     emoji: '🏟' },
  { id: 'fitness',    label: 'Fitness',    emoji: '🏃' },
  { id: 'education',  label: 'Education',  emoji: '📚' },
  { id: 'other',      label: 'Other',      emoji: '📌' },
]

const PRICE_OPTIONS = [
  { value: null,  label: 'Any price' },
  { value: 0,     label: 'Free only' },
  { value: 10,    label: 'Under $10' },
  { value: 25,    label: 'Under $25' },
]

const AGE_OPTIONS = [
  { value: null,         label: 'No preference' },
  { value: 'all_ages',   label: 'All ages' },
  { value: '18_plus',    label: '18+' },
  { value: '21_plus',    label: '21+' },
]

const FREQUENCIES = [
  { id: 'daily',   label: 'Daily'   },
  { id: 'weekly',  label: 'Weekly'  },
  { id: 'monthly', label: 'Monthly' },
]

const LOOKAHEADS = [
  { days: 1,  label: 'Next Day'   },
  { days: 7,  label: 'Next Week'  },
  { days: 30, label: 'Next Month' },
]

const DAYS_OF_WEEK = [
  { value: 0, label: 'Sunday'    },
  { value: 1, label: 'Monday'    },
  { value: 2, label: 'Tuesday'   },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday'  },
  { value: 5, label: 'Friday'    },
  { value: 6, label: 'Saturday'  },
]

/* ── Event day-of-week filter ── */
const EVENT_DAYS = [
  { value: 0, label: 'Sun', full: 'Sunday'    },
  { value: 1, label: 'Mon', full: 'Monday'    },
  { value: 2, label: 'Tue', full: 'Tuesday'   },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday'  },
  { value: 5, label: 'Fri', full: 'Friday'    },
  { value: 6, label: 'Sat', full: 'Saturday'  },
]

const DAY_SHORTCUTS = [
  { label: 'All days',  days: [0,1,2,3,4,5,6] },
  { label: 'Weekends',  days: [0,6]            },
  { label: 'Weekdays',  days: [1,2,3,4,5]      },
]

/* ── Location presets ── */
const AREA_PRESETS = [
  { id: 'downtown',      label: 'Downtown Akron',   lat: 41.0814, lng: -81.5190 },
  { id: 'highland-sq',   label: 'Highland Square',  lat: 41.0870, lng: -81.5380 },
  { id: 'north-hill',    label: 'North Hill',       lat: 41.1020, lng: -81.5130 },
  { id: 'kenmore',       label: 'Kenmore',          lat: 41.0530, lng: -81.5370 },
  { id: 'cuyahoga-falls',label: 'Cuyahoga Falls',   lat: 41.1340, lng: -81.4845 },
  { id: 'hudson',        label: 'Hudson',            lat: 41.2400, lng: -81.4407 },
  { id: 'stow',          label: 'Stow',              lat: 41.1595, lng: -81.4404 },
  { id: 'barberton',     label: 'Barberton',         lat: 41.0128, lng: -81.6051 },
]

const RADIUS_OPTIONS = [
  { miles: 5,    label: '5 miles'   },
  { miles: 10,   label: '10 miles'  },
  { miles: 25,   label: '25 miles'  },
  { miles: null,  label: 'Anywhere' },
]

export default function PreferencesPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  // Loading & page state
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState(null)

  // Preference state
  const [intents, setIntents]         = useState(['all'])
  const [categories, setCategories]   = useState([])
  const [selectedVenueIds, setSelectedVenueIds] = useState([])
  const [selectedOrgIds, setSelectedOrgIds] = useState([])
  const [keywords, setKeywords]       = useState([])
  const [keywordsTitleOnly, setKeywordsTitleOnly] = useState(false)
  const [priceMax, setPriceMax]       = useState(null)
  const [ageRestriction, setAgeRestriction] = useState(null)
  const [frequency, setFrequency]     = useState('weekly')
  const [lookahead, setLookahead]     = useState(7)
  const [sendDay, setSendDay]         = useState(4) // Thursday
  const [eventDays, setEventDays]     = useState([0,1,2,3,4,5,6]) // all days
  const [locationMode, setLocationMode] = useState('anywhere') // 'anywhere' | 'area' | 'zipcode'
  const [selectedArea, setSelectedArea] = useState(null)
  const [zipcode, setZipcode]         = useState('')
  const [radius, setRadius]           = useState(10)
  const [status, setStatus]           = useState(null) // null | 'saving' | 'saved' | 'error'

  // Entity lists (fetched from Supabase)
  const [allVenues, setAllVenues] = useState([])
  const [allOrgs, setAllOrgs]     = useState([])

  /* ── Load preferences + entity lists on mount ── */
  useEffect(() => {
    if (!token) { setLoading(false); return }

    const load = async () => {
      try {
        // Fetch preferences from Edge Function, venues, and orgs in parallel
        const [prefsRes, venuesRes, orgsRes] = await Promise.all([
          supabase.functions.invoke('preferences', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            body: null,
            // Edge Functions don't support query params via invoke, so we use fetch
          }).catch(() => null),
          supabase.from('venues').select('id, name, address').order('name'),
          supabase.from('organizations').select('id, name').order('name'),
        ])

        // Venues & orgs — these are public reads
        if (venuesRes.data) setAllVenues(venuesRes.data)
        if (orgsRes.data) setAllOrgs(orgsRes.data)

        // Preferences — call via fetch since we need query params
        const baseUrl = import.meta.env.VITE_SUPABASE_URL
        const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
        const prefsResp = await fetch(
          `${baseUrl}/functions/v1/preferences?token=${token}`,
          { headers: { Authorization: `Bearer ${anonKey}`, apikey: anonKey } }
        )
        const prefsData = await prefsResp.json()

        if (prefsData.ok && prefsData.preferences) {
          const p = prefsData.preferences
          if (p.intents?.length) setIntents(p.intents)
          if (p.categories?.length) setCategories(p.categories)
          if (p.venue_ids?.length) setSelectedVenueIds(p.venue_ids)
          if (p.org_ids?.length) setSelectedOrgIds(p.org_ids)
          if (p.keywords?.length) setKeywords(p.keywords)
          if (p.keywords_title_only) setKeywordsTitleOnly(true)
          if (p.price_max !== null && p.price_max !== undefined) setPriceMax(p.price_max)
          if (p.age_restriction) setAgeRestriction(p.age_restriction)
          if (p.event_days?.length && p.event_days.length < 7) setEventDays(p.event_days)
          if (p.location) {
            if (p.location.mode === 'area') {
              setLocationMode('area')
              const match = AREA_PRESETS.find(a =>
                Math.abs(a.lat - p.location.lat) < 0.01 && Math.abs(a.lng - p.location.lng) < 0.01
              )
              if (match) setSelectedArea(match)
            } else if (p.location.mode === 'zipcode') {
              setLocationMode('zipcode')
              setZipcode(p.location.label || '')
            }
            if (p.location.radius_miles) setRadius(p.location.radius_miles)
          }
        }
        if (prefsData.frequency) setFrequency(prefsData.frequency)
        if (prefsData.lookahead_days) setLookahead(prefsData.lookahead_days)
        if (prefsData.send_day !== null && prefsData.send_day !== undefined) setSendDay(prefsData.send_day)

        setLoading(false)
      } catch (err) {
        console.error('Load preferences error:', err)
        setLoadError('Could not load your preferences. The link may be invalid or expired.')
        setLoading(false)
      }
    }

    load()
  }, [token])

  /* ── Intent selection ── */
  const toggleIntent = (id) => {
    if (id === 'all') {
      setIntents(['all'])
      setCategories([])
      return
    }
    const without = intents.filter(i => i !== 'all' && i !== id)
    const next = intents.includes(id) ? without : [...without, id]
    if (next.length === 0) {
      setIntents(['all'])
      setCategories([])
    } else {
      setIntents(next)
      // Auto-populate categories from selected intents
      const intentCats = next.flatMap(iid => {
        const found = INTENTS.find(i => i.id === iid)
        return found ? found.categories : []
      })
      setCategories([...new Set(intentCats)])
    }
  }

  /* ── Category toggle ── */
  const toggleCategory = (catId) => {
    setCategories(prev =>
      prev.includes(catId)
        ? prev.filter(c => c !== catId)
        : [...prev, catId]
    )
    // If manually toggling categories, deselect "all" intent
    if (intents.includes('all')) {
      setIntents([])
    }
  }

  /* ── Event day toggle ── */
  const toggleEventDay = (day) => {
    setEventDays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
      return next.length === 0 ? [0,1,2,3,4,5,6] : next.sort((a,b) => a - b)
    })
  }

  const applyDayShortcut = (days) => {
    setEventDays([...days].sort((a,b) => a - b))
  }

  const isDayShortcutActive = (shortcutDays) => {
    return shortcutDays.length === eventDays.length &&
      shortcutDays.every(d => eventDays.includes(d))
  }

  /* ── Location helpers ── */
  const selectArea = (area) => {
    setSelectedArea(area)
    setLocationMode('area')
    setZipcode('')
  }

  const clearLocation = () => {
    setLocationMode('anywhere')
    setSelectedArea(null)
    setZipcode('')
  }

  /* ── Save preferences ── */
  const handleSave = async () => {
    setStatus('saving')

    // Build location object
    let location = null
    if (locationMode === 'area' && selectedArea) {
      location = {
        mode: 'area',
        lat: selectedArea.lat,
        lng: selectedArea.lng,
        radius_miles: radius,
        label: selectedArea.label,
      }
    } else if (locationMode === 'zipcode' && zipcode.length === 5) {
      // Geocode would go here in the future; for now store the zipcode
      location = {
        mode: 'zipcode',
        lat: null,
        lng: null,
        radius_miles: radius,
        label: zipcode,
      }
    }

    const preferences = {
      intents,
      categories,
      venue_ids: selectedVenueIds,
      org_ids: selectedOrgIds,
      price_max: priceMax,
      age_restriction: ageRestriction,
      event_days: eventDays,
      location,
      keywords,
      keywords_title_only: keywordsTitleOnly,
    }

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('preferences', {
        body: {
          token,
          preferences,
          frequency,
          lookahead_days: lookahead,
          send_day: frequency === 'weekly' ? sendDay : null,
        },
      })

      if (fnErr) throw fnErr
      if (data?.error) throw new Error(data.error)

      setStatus('saved')
      setTimeout(() => setStatus(null), 2500)
    } catch (err) {
      console.error('Save preferences error:', err)
      setStatus('error')
      setTimeout(() => setStatus(null), 3000)
    }
  }

  /* ── No token state ── */
  if (!token) {
    return (
      <div className="page-shell prefs-shell">
        <div className="prefs-no-token">
          <h1 className="page-title">Preference Center</h1>
          <p className="page-sub">
            You need a valid link to access your preferences.
            Every email we send includes a direct link, or you can request one from the{' '}
            <Link to="/subscribe" className="amber-link">subscribe page</Link>.
          </p>
        </div>
      </div>
    )
  }

  /* ── Loading state ── */
  if (loading) {
    return (
      <div className="page-shell prefs-shell">
        <p className="prefs-loading">Loading your preferences…</p>
      </div>
    )
  }

  /* ── Load error state ── */
  if (loadError) {
    return (
      <div className="page-shell prefs-shell">
        <div className="prefs-no-token">
          <h1 className="page-title">Preference Center</h1>
          <p className="page-sub">{loadError}</p>
          <Link to="/subscribe" className="amber-link">Go to subscribe page</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell prefs-shell">
      <h1 className="page-title">Your Preferences</h1>
      <p className="page-sub prefs-sub">
        This is your preference center. Tweak anything below and hit save.
        Every email we send has a link right back here, so you can change your
        mind whenever you want.
      </p>

      {/* ── Intents ── */}
      <div className="form-section-label">What are you into?</div>
      <div className="intent-grid">
        <button
          type="button"
          className={`intent-card ${intents.includes('all') ? 'intent-active' : ''}`}
          onClick={() => toggleIntent('all')}
        >
          <span className="intent-emoji">✨</span>
          <span className="intent-label">All Events</span>
        </button>
        {INTENTS.map(intent => (
          <button
            key={intent.id}
            type="button"
            className={`intent-card ${intents.includes(intent.id) ? 'intent-active' : ''}`}
            onClick={() => toggleIntent(intent.id)}
          >
            <span className="intent-emoji">{intent.emoji}</span>
            <span className="intent-label">{intent.label}</span>
          </button>
        ))}
      </div>

      {/* ── Categories ── */}
      <div className="form-section-label">Fine-tune categories</div>
      <p className="form-hint prefs-hint">
        {intents.includes('all')
          ? 'You\'re getting all categories. Deselect "All Events" above to pick specific ones.'
          : 'Based on your interests above. Add or remove individual categories here.'
        }
      </p>
      <div className="cat-grid">
        {CATEGORIES.map(cat => {
          const isActive = intents.includes('all') || categories.includes(cat.id)
          const isFromIntent = !intents.includes('all') && INTENTS.some(
            i => intents.includes(i.id) && i.categories.includes(cat.id)
          )
          return (
            <button
              key={cat.id}
              type="button"
              className={`cat-chip ${isActive ? 'cat-active' : ''} ${isFromIntent ? 'cat-from-intent' : ''}`}
              onClick={() => !intents.includes('all') && toggleCategory(cat.id)}
              disabled={intents.includes('all')}
            >
              <span className="cat-emoji">{cat.emoji}</span>
              {cat.label}
            </button>
          )
        })}
      </div>

      {/* ── Organizations ── */}
      <div className="form-section-label">Favorite organizations</div>
      <p className="form-hint prefs-hint">
        No selection means all organizations. Only add organizations here if you want to filter to specific ones.
      </p>
      <SearchableMultiSelect
        allEntities={allOrgs}
        selectedIds={selectedOrgIds}
        onChange={setSelectedOrgIds}
        placeholder="Search organizations…"
      />

      {/* ── Venues ── */}
      <div className="form-section-label">Favorite venues</div>
      <p className="form-hint prefs-hint">
        No selection means all venues. Only add venues here if you want to filter to specific ones.
      </p>
      <SearchableMultiSelect
        allEntities={allVenues}
        selectedIds={selectedVenueIds}
        onChange={setSelectedVenueIds}
        placeholder="Search venues…"
        renderSubtitle={v => v.address}
      />

      {/* ── Keyword alerts ── */}
      <div className="form-section-label">Keyword alerts</div>
      <p className="form-hint prefs-hint">
        Get notified about any event that matches these terms, even if it
        doesn't match your other preference settings. Up to 5 terms.
      </p>
      <SearchableMultiSelect
        selectedIds={keywords}
        onChange={setKeywords}
        placeholder="Type a term and press Enter…"
        freeform
        maxItems={5}
      />
      <label className="prefs-checkbox">
        <input
          type="checkbox"
          checked={keywordsTitleOnly}
          onChange={e => setKeywordsTitleOnly(e.target.checked)}
        />
        <span>Match title only</span>
      </label>

      {/* ── Event days ── */}
      <div className="form-section-label">Which days?</div>
      <p className="form-hint prefs-hint">
        Only include events happening on these days.
      </p>
      <div className="day-shortcuts">
        {DAY_SHORTCUTS.map(s => (
          <button
            key={s.label}
            type="button"
            className={`pill pill-sm ${isDayShortcutActive(s.days) ? 'pill-active' : ''}`}
            onClick={() => applyDayShortcut(s.days)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="day-grid">
        {EVENT_DAYS.map(d => (
          <button
            key={d.value}
            type="button"
            className={`day-chip ${eventDays.includes(d.value) ? 'day-active' : ''}`}
            onClick={() => toggleEventDay(d.value)}
            title={d.full}
          >
            {d.label}
          </button>
        ))}
      </div>

      {/* ── Location ── */}
      <div className="form-section-label">Location</div>
      <p className="form-hint prefs-hint">
        Only include events near a specific area, or leave as "Anywhere" for all of Summit County.
      </p>
      <div className="location-section">
        <div className="location-mode-row">
          <button
            type="button"
            className={`pill pill-sm ${locationMode === 'anywhere' ? 'pill-active' : ''}`}
            onClick={clearLocation}
          >
            Anywhere
          </button>
          <button
            type="button"
            className={`pill pill-sm ${locationMode === 'zipcode' ? 'pill-active' : ''}`}
            onClick={() => { setLocationMode('zipcode'); setSelectedArea(null) }}
          >
            Zipcode
          </button>
          <button
            type="button"
            className={`pill pill-sm ${locationMode === 'area' ? 'pill-active' : ''}`}
            onClick={() => { setLocationMode('area'); setZipcode('') }}
          >
            Neighborhood
          </button>
        </div>

        {locationMode === 'area' && (
          <div className="area-grid">
            {AREA_PRESETS.map(area => (
              <button
                key={area.id}
                type="button"
                className={`area-chip ${selectedArea?.id === area.id ? 'area-active' : ''}`}
                onClick={() => selectArea(area)}
              >
                {area.label}
              </button>
            ))}
          </div>
        )}

        {locationMode === 'zipcode' && (
          <div className="zipcode-row">
            <input
              className="form-input zipcode-input"
              type="text"
              placeholder="e.g. 44304"
              value={zipcode}
              onChange={e => setZipcode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              maxLength={5}
              inputMode="numeric"
            />
          </div>
        )}

        {locationMode !== 'anywhere' && (
          <div className="form-group radius-group">
            <label className="form-label">Within</label>
            <div className="pill-group pill-group-sm">
              {RADIUS_OPTIONS.filter(r => r.miles !== null).map(r => (
                <button
                  key={r.miles}
                  type="button"
                  className={`pill pill-sm ${radius === r.miles ? 'pill-active' : ''}`}
                  onClick={() => setRadius(r.miles)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Price & Age ── */}
      <div className="form-section-label">Price & age</div>
      <div className="form-row prefs-row">
        <div className="form-group">
          <label className="form-label">Price range</label>
          <div className="pill-group pill-group-sm">
            {PRICE_OPTIONS.map(p => (
              <button
                key={String(p.value)}
                type="button"
                className={`pill pill-sm ${priceMax === p.value ? 'pill-active' : ''}`}
                onClick={() => setPriceMax(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Age restriction</label>
          <div className="pill-group pill-group-sm">
            {AGE_OPTIONS.map(a => (
              <button
                key={String(a.value)}
                type="button"
                className={`pill pill-sm ${ageRestriction === a.value ? 'pill-active' : ''}`}
                onClick={() => setAgeRestriction(a.value)}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Delivery ── */}
      <div className="form-section-label">Delivery</div>
      <div className="form-group">
        <label className="form-label">Frequency</label>
        <div className="pill-group">
          {FREQUENCIES.map(f => (
            <button
              key={f.id}
              type="button"
              className={`pill ${frequency === f.id ? 'pill-active' : ''}`}
              onClick={() => setFrequency(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-row prefs-row">
        <div className="form-group">
          <label className="form-label">How far ahead?</label>
          <div className="pill-group pill-group-sm">
            {LOOKAHEADS.map(l => (
              <button
                key={l.days}
                type="button"
                className={`pill pill-sm ${lookahead === l.days ? 'pill-active' : ''}`}
                onClick={() => setLookahead(l.days)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {frequency === 'weekly' && (
          <div className="form-group">
            <label className="form-label">Delivery day</label>
            <select
              className="form-select"
              value={sendDay}
              onChange={e => setSendDay(Number(e.target.value))}
            >
              {DAYS_OF_WEEK.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* ── Save ── */}
      <button
        type="button"
        className="btn-submit-form prefs-save-btn"
        onClick={handleSave}
        disabled={status === 'saving'}
      >
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved!' : status === 'error' ? 'Try again' : 'Save preferences'}
      </button>
      {status === 'saved' && (
        <p className="prefs-saved-msg">
          Your preferences have been updated. Your next email will reflect these changes.
        </p>
      )}
      {status === 'error' && (
        <p className="prefs-error-msg">
          Something went wrong saving your preferences. Please try again.
        </p>
      )}
    </div>
  )
}
