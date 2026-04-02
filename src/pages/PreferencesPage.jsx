import { useState } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
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
  { id: 'sports',     label: 'Sports',     emoji: '⚽' },
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

  // Placeholder venues (will be fetched from Supabase)
  const [allVenues] = useState([
    { id: '1', name: 'Jilly\'s Music Room', address: 'Kenmore Blvd' },
    { id: '2', name: 'Akron Civic Theatre', address: 'Main St' },
    { id: '3', name: 'Akron Art Museum', address: 'E Market St' },
    { id: '4', name: 'Summit Artspace', address: 'E Market St' },
    { id: '5', name: 'Akron Zoo', address: 'Edgewood Ave' },
    { id: '6', name: 'Nightlight Cinema', address: 'N Main St' },
    { id: '7', name: 'Lock 3', address: 'S Main St' },
    { id: '8', name: 'Goodyear Theater', address: 'E Market St' },
  ])

  // Placeholder organizations (will be fetched from Supabase)
  const [allOrgs] = useState([
    { id: '1', name: 'Akron Art Museum' },
    { id: '2', name: 'Summit Metro Parks' },
    { id: '3', name: 'Akron-Summit County Public Library' },
    { id: '4', name: 'Downtown Akron Partnership' },
    { id: '5', name: 'Leadership Akron' },
    { id: '6', name: 'Akron Civic Theatre' },
    { id: '7', name: 'Summit Artspace' },
    { id: '8', name: 'Cuyahoga Valley National Park' },
  ])

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

  /* ── Save (stub) ── */
  const handleSave = async () => {
    setStatus('saving')
    // TODO: Wire to Supabase update via Edge Function with token
    await new Promise(r => setTimeout(r, 600))
    setStatus('saved')
    setTimeout(() => setStatus(null), 2500)
  }

  /* ── No token state ── */
  /* TODO: Re-enable token gate when wiring to Supabase
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
  */

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
        {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved!' : 'Save preferences'}
      </button>
      {status === 'saved' && (
        <p className="prefs-saved-msg">
          Your preferences have been updated. Your next email will reflect these changes.
        </p>
      )}
    </div>
  )
}
