import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { trackEvent, EVENTS } from '@/lib/analytics'
import { SEO } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import { THEMES } from '@/lib/themes'
import { FILTERABLE_CATEGORIES } from '@/lib/categories.js'
import { CITIES } from '@/lib/cities'
import { NEIGHBORHOODS } from '@/lib/neighborhoods'
import type { EmbedFeature, EmbedPrice, EmbedDate, EmbedView, EmbedDensity } from '@/lib/embedConfig'
import { buildEmbedSrc, type BuilderState } from '@/lib/embedParams'
import EmbedRequestForm from '@/components/EmbedRequestForm'
import './EmbedBuilderPage.css'

// ── Types ─────────────────────────────────────────────────────────────────────
//
// BuilderState, buildEmbedParams, and buildEmbedSrc live in
// src/lib/embedParams.ts now (see docs/embed-request-capture.md §6.1) — this
// page imports them rather than defining its own copy, so the edge functions'
// snippet generator (supabase/functions/_shared/embedSnippet.ts) can import
// the same buildEmbedParams via the root `@/` Deno import map instead of
// reimplementing it.

// Minimum preview width — narrower than this the embed layout breaks down.
const MIN_PREVIEW_WIDTH = 320

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_FEATURES: { key: EmbedFeature; label: string; description: string }[] = [
  { key: 'filter',  label: 'Filter & Sort', description: 'Filter tray entry point' },
  { key: 'map',      label: 'Map view',      description: 'List / Map toggle' },
  { key: 'calendar', label: 'Calendar view', description: 'List / Calendar toggle' },
  { key: 'density', label: 'Density toggle', description: 'Comfortable / Compact switch' },
  { key: 'price',   label: 'Price labels',   description: 'Price shown on event cards' },
  { key: 'tags',    label: 'Category tags',  description: 'Category badges on cards' },
]

const PRICE_OPTIONS: { value: EmbedPrice | ''; label: string }[] = [
  { value: '',         label: 'Any price (no lock)' },
  { value: 'free',     label: '🎉 Free events only' },
  { value: 'under10',  label: 'Under $10' },
  { value: 'under25',  label: 'Under $25' },
]

// `this_week` is deliberately NOT offered here — it's a compatibility ghost
// kept alive only so embeds minted before 2026-08-10 keep resolving (see
// embedConfig.ts's EmbedDate). Do not add it back to this list; a partner
// building a NEW embed gets `next_7_days` instead.
const DATE_OPTIONS: { value: EmbedDate | ''; label: string }[] = [
  { value: '',             label: 'All dates (no lock)' },
  { value: 'today',        label: 'Today' },
  { value: 'tomorrow',     label: 'Tomorrow' },
  { value: 'this_weekend', label: 'This weekend' },
  { value: 'next_7_days',  label: 'Next 7 days' },
  { value: 'this_month',   label: 'This month' },
]

const DEFAULT_STATE: BuilderState = {
  title: '',
  theme: 'akron-pulse',
  place: '',
  categories: [],
  price: '',
  date: '',
  family: false,
  features: { filter: true, map: true, calendar: true, density: true, price: true, tags: true },
  view: 'list',
  density: 'comfortable',
  target: 'inline',
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EmbedBuilderPage() {
  const [state, setState] = useState<BuilderState>(DEFAULT_STATE)
  const [previewKey, setPreviewKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // ── Preview resize ────────────────────────────────────────────────
  // null = fill the column; number = fixed px width (clamped to MIN_PREVIEW_WIDTH).
  const [previewWidth, setPreviewWidth] = useState<number | null>(null)
  // Blocks iframe pointer events while dragging so mousemove isn't swallowed.
  const [isDragging, setIsDragging] = useState(false)
  const previewFrameRef = useRef<HTMLDivElement>(null)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = previewFrameRef.current?.offsetWidth ?? 600
    setIsDragging(true)

    const onMove = (mv: MouseEvent) => {
      const delta = mv.clientX - startX
      setPreviewWidth(Math.max(MIN_PREVIEW_WIDTH, startWidth + delta))
    }
    const onUp = () => {
      setIsDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const resetPreviewWidth = useCallback(() => setPreviewWidth(null), [])

  // Live src — recomputed on every state change (feeds the debounced preview).
  const embedSrc = useMemo(() => buildEmbedSrc(state), [state])

  // Debounced src — the iframe only reloads after the user pauses for 600 ms.
  // Without this, every keypress in the title field triggers a full iframe reload.
  const [iframeSrc, setIframeSrc] = useState(embedSrc)
  useEffect(() => {
    const id = setTimeout(() => setIframeSrc(embedSrc), 600)
    return () => clearTimeout(id)
  }, [embedSrc])

  // Engagement signal: fire once the first time the partner changes anything
  // from the default config. `state` is the same reference as DEFAULT_STATE
  // until the first setState, so an identity check cleanly detects first edit.
  const customizedRef = useRef(false)
  useEffect(() => {
    if (customizedRef.current || state === DEFAULT_STATE) return
    customizedRef.current = true
    trackEvent(EVENTS.EMBED_BUILDER_CUSTOMIZED)
  }, [state])

  const set = useCallback(<K extends keyof BuilderState>(key: K, value: BuilderState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }))
  }, [])

  const toggleCategory = useCallback((slug: string) => {
    setState((prev) => {
      const has = prev.categories.includes(slug)
      return {
        ...prev,
        categories: has
          ? prev.categories.filter((c) => c !== slug)
          : [...prev.categories, slug],
      }
    })
  }, [])

  const toggleFeature = useCallback((key: EmbedFeature) => {
    setState((prev) => ({
      ...prev,
      features: { ...prev.features, [key]: !prev.features[key] },
    }))
  }, [])

  const handleRefresh = useCallback(() => {
    setPreviewKey((k) => k + 1)
  }, [])

  return (
    <>
      <SEO
        title="Embed Builder | Akron Pulse"
        description="Preview a self-updating Akron Pulse events calendar for your website. Scope it to your neighborhood or your kind of events, then reach out and we'll set it up for you."
      />

      <PageHero title="Embed Builder">
        Configure and preview a live Akron Pulse calendar for your website.
        When it looks right, reach out and we'll set it up with you.
      </PageHero>

      <div className="builder-layout">

        {/* ── Left: controls ─────────────────────────────────────────── */}
        <aside className="builder-controls">

          <section className="builder-section">
            <h2 className="builder-section-title">Appearance</h2>

            <div className="builder-field">
              <label className="builder-label" htmlFor="eb-title">Heading</label>
              <input
                id="eb-title"
                className="builder-input"
                type="text"
                maxLength={120}
                placeholder="Upcoming Events"
                value={state.title}
                onChange={(e) => set('title', e.target.value)}
              />
              <span className="builder-hint">Shown above the event grid. Leave blank for the default.</span>
            </div>

            <div className="builder-field">
              <label className="builder-label" htmlFor="eb-theme">Theme</label>
              <select
                id="eb-theme"
                className="builder-select"
                value={state.theme}
                onChange={(e) => set('theme', e.target.value)}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </section>

          <section className="builder-section">
            <h2 className="builder-section-title">Locked Filters</h2>
            <p className="builder-section-desc">Visitors can filter <em>within</em> these, but can't clear them.</p>

            <div className="builder-field">
              <label className="builder-label" htmlFor="eb-place">Location</label>
              <select
                id="eb-place"
                className="builder-select"
                value={state.place}
                onChange={(e) => set('place', e.target.value)}
              >
                <option value="">Everywhere (no lock)</option>
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
              <span className="builder-hint">Scope the calendar to one city or Akron community. Visitors can't change it.</span>
            </div>

            <div className="builder-field">
              <label className="builder-label">Categories</label>
              <div className="builder-chip-grid">
                {(FILTERABLE_CATEGORIES as unknown as { slug: string; label: string; emoji: string }[]).map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    className={`builder-chip${state.categories.includes(c.slug) ? ' builder-chip--on' : ''}`}
                    onClick={() => toggleCategory(c.slug)}
                  >
                    {c.emoji} {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="builder-field builder-row">
              <div className="builder-field-half">
                <label className="builder-label" htmlFor="eb-price">Price</label>
                <select
                  id="eb-price"
                  className="builder-select"
                  value={state.price}
                  onChange={(e) => set('price', e.target.value as EmbedPrice | '')}
                >
                  {PRICE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="builder-field-half">
                <label className="builder-label" htmlFor="eb-date">Date</label>
                <select
                  id="eb-date"
                  className="builder-select"
                  value={state.date}
                  onChange={(e) => set('date', e.target.value as EmbedDate | '')}
                >
                  {DATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="builder-field">
              <label className="builder-toggle">
                <input
                  type="checkbox"
                  checked={state.family}
                  onChange={(e) => set('family', e.target.checked)}
                />
                <span>Family-friendly only</span>
              </label>
            </div>
          </section>

          <section className="builder-section">
            <h2 className="builder-section-title">Features</h2>
            <p className="builder-section-desc">Uncheck to hide UI elements from visitors.</p>
            <div className="builder-feature-list">
              {ALL_FEATURES.map((f) => (
                <label key={f.key} className="builder-toggle">
                  <input
                    type="checkbox"
                    checked={state.features[f.key]}
                    onChange={() => toggleFeature(f.key)}
                  />
                  <span>
                    {f.label}
                    <span className="builder-feature-desc">{f.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="builder-section">
            <h2 className="builder-section-title">Defaults</h2>

            <div className="builder-field builder-row">
              <div className="builder-field-half">
                <label className="builder-label">Initial view</label>
                <div className="builder-radio-group">
                  {(['list', 'calendar', 'map'] as EmbedView[]).map((v) => (
                    <label key={v} className="builder-radio">
                      <input
                        type="radio"
                        name="eb-view"
                        value={v}
                        checked={state.view === v}
                        onChange={() => set('view', v)}
                      />
                      <span>{v === 'list' ? 'List' : v === 'calendar' ? 'Calendar' : 'Map'}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="builder-field-half">
                <label className="builder-label">Card density</label>
                <div className="builder-radio-group">
                  {(['comfortable', 'efficient'] as EmbedDensity[]).map((d) => (
                    <label key={d} className="builder-radio">
                      <input
                        type="radio"
                        name="eb-density"
                        value={d}
                        checked={state.density === d}
                        onChange={() => set('density', d)}
                      />
                      <span>{d === 'comfortable' ? 'Comfortable' : 'Compact'}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="builder-field">
              <label className="builder-label">Event click-through</label>
              <div className="builder-radio-group">
                <label className="builder-radio">
                  <input
                    type="radio"
                    name="eb-target"
                    value="inline"
                    checked={state.target === 'inline'}
                    onChange={() => set('target', 'inline')}
                  />
                  <span>Open inside embed <span className="builder-feature-desc">visitor stays on your page</span></span>
                </label>
                <label className="builder-radio">
                  <input
                    type="radio"
                    name="eb-target"
                    value="blank"
                    checked={state.target === 'blank'}
                    onChange={() => set('target', 'blank')}
                  />
                  <span>Open in new tab <span className="builder-feature-desc">full Akron Pulse detail page</span></span>
                </label>
                <label className="builder-radio">
                  <input
                    type="radio"
                    name="eb-target"
                    value="external"
                    checked={state.target === 'external'}
                    onChange={() => set('target', 'external')}
                  />
                  <span>Go direct to event site <span className="builder-feature-desc">skips detail page, best for sidebars</span></span>
                </label>
              </div>
            </div>
          </section>

        </aside>

        {/* ── Right: preview ──────────────────────────────────────────── */}
        <div className="builder-preview-col">

          <div className="builder-preview-header">
            <span className="builder-preview-label">Live preview</span>
            <div className="builder-preview-header-right">
              {previewWidth !== null && (
                <button
                  type="button"
                  className="builder-width-reset"
                  onClick={resetPreviewWidth}
                  title="Reset to full width"
                >
                  ✕ {previewWidth}px
                </button>
              )}
              <button type="button" className="builder-refresh-btn" onClick={handleRefresh} title="Reload preview">
                ↺ Reload
              </button>
            </div>
          </div>

          {/* Resizable preview — flex row so the handle hugs the frame's right edge */}
          <div className={`builder-preview-wrapper${isDragging ? ' builder-preview-wrapper--dragging' : ''}`}>
            <div
              ref={previewFrameRef}
              className="builder-preview-frame"
              style={previewWidth !== null ? { width: previewWidth, flex: 'none' } : undefined}
            >
              <iframe
                key={previewKey}
                ref={iframeRef}
                src={iframeSrc}
                title="Embed preview"
                className="builder-iframe"
                style={isDragging ? { pointerEvents: 'none' } : undefined}
                loading="lazy"
              />
            </div>
            <div
              className="builder-resize-handle"
              onMouseDown={handleResizeStart}
              onDoubleClick={resetPreviewWidth}
              title={`Drag to resize · double-click to reset\nMinimum: ${MIN_PREVIEW_WIDTH}px`}
            >
              <div className="builder-resize-grip" />
            </div>
          </div>

          <section className="builder-section builder-reach-out">
            <h2 className="builder-section-title">Put Akron Pulse on your site</h2>
            <p>
              Want your neighborhood's events on your own website? We offer a
              self-updating calendar embed for nonprofits and community
              organizations. It can be scoped to just your neighborhood or your
              kind of events. Once it's up, there's nothing to maintain: we
              keep the events current so you don't have to.
            </p>
            <p>
              We set each embed up personally to make sure it fits your site
              and your community, usually within a few days.
            </p>

            <EmbedRequestForm config={state} />

            <p>
              Prefer email? Reach out to{' '}
              <a
                href="mailto:byron@akronpulse.com"
                onClick={() => trackEvent(EVENTS.EMBED_CONTACT_CLICKED)}
              >
                byron@akronpulse.com
              </a>{' '}
              directly.
            </p>
          </section>

        </div>
      </div>
    </>
  )
}
