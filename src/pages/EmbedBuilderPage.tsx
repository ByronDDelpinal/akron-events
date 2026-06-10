import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { SEO } from '@/lib/seo'
import { THEMES } from '@/lib/themes'
import { FILTERABLE_CATEGORIES } from '@/lib/categories.js'
import type { EmbedFeature, EmbedPrice, EmbedDate, EmbedView, EmbedDensity, EmbedTarget } from '@/lib/embedConfig'
import './EmbedBuilderPage.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BuilderState {
  title: string
  theme: string
  categories: string[]
  price: EmbedPrice | ''
  date: EmbedDate | ''
  family: boolean
  features: Record<EmbedFeature, boolean>
  view: EmbedView
  density: EmbedDensity
  target: EmbedTarget
}

// Minimum preview width — narrower than this the embed layout breaks down.
const MIN_PREVIEW_WIDTH = 320

// ── Constants ─────────────────────────────────────────────────────────────────

const ALL_FEATURES: { key: EmbedFeature; label: string; description: string }[] = [
  { key: 'filter',  label: 'Filter & Sort', description: 'Filter tray entry point' },
  { key: 'map',     label: 'Map view',       description: 'List / Map toggle' },
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

const DATE_OPTIONS: { value: EmbedDate | ''; label: string }[] = [
  { value: '',             label: 'All dates (no lock)' },
  { value: 'today',        label: 'Today' },
  { value: 'this_weekend', label: 'This weekend' },
  { value: 'this_week',    label: 'This week' },
  { value: 'this_month',   label: 'This month' },
]

const DEFAULT_STATE: BuilderState = {
  title: '',
  theme: 'akron-pulse',
  categories: [],
  price: '',
  date: '',
  family: false,
  features: { filter: true, map: true, density: true, price: true, tags: true },
  view: 'list',
  density: 'comfortable',
  target: 'inline',
}

// ── Query-string builder ──────────────────────────────────────────────────────

function buildEmbedParams(state: BuilderState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.theme !== 'akron-pulse') p.set('theme', state.theme)
  if (state.title.trim()) p.set('title', state.title.trim())
  if (state.categories.length) p.set('categories', state.categories.join(','))
  if (state.price) p.set('price', state.price)
  if (state.date) p.set('date', state.date)
  if (state.family) p.set('family', '1')

  // Features: only emit if any are disabled (default = all on)
  const allOn = Object.values(state.features).every(Boolean)
  if (!allOn) {
    const enabled = ALL_FEATURES.filter((f) => state.features[f.key]).map((f) => f.key)
    if (enabled.length) p.set('features', enabled.join(','))
  }

  if (state.view !== 'list') p.set('view', state.view)
  if (state.density !== 'comfortable') p.set('density', state.density)
  if (state.target !== 'inline') p.set('target', state.target)
  return p
}

function buildEmbedSrc(state: BuilderState): string {
  const params = buildEmbedParams(state)
  const qs = params.toString()
  return `${window.location.origin}/embed${qs ? `?${qs}` : ''}`
}

function buildIframeSnippet(state: BuilderState): string {
  const src = buildEmbedSrc(state)
  const title = state.title.trim() || 'Upcoming Events'
  return `<iframe
  src="${src}"
  data-akron-pulse-embed
  title="${title}"
  style="width:100%; border:0; height:900px"
  loading="lazy"></iframe>

<!-- Auto-resize (recommended) -->
<script src="${window.location.origin}/akron-pulse-embed.js" async></script>`
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function EmbedBuilderPage() {
  const [state, setState] = useState<BuilderState>(DEFAULT_STATE)
  const [copied, setCopied] = useState(false)
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

  // Live src — recomputed on every state change (drives the snippet textarea).
  const embedSrc = useMemo(() => buildEmbedSrc(state), [state])
  const snippet = useMemo(() => buildIframeSnippet(state), [state])

  // Debounced src — the iframe only reloads after the user pauses for 600 ms.
  // Without this, every keypress in the title field triggers a full iframe reload.
  const [iframeSrc, setIframeSrc] = useState(embedSrc)
  useEffect(() => {
    const id = setTimeout(() => setIframeSrc(embedSrc), 600)
    return () => clearTimeout(id)
  }, [embedSrc])

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

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the textarea
      const ta = document.querySelector<HTMLTextAreaElement>('.builder-code-textarea')
      ta?.select()
    }
  }, [snippet])

  const handleRefresh = useCallback(() => {
    setPreviewKey((k) => k + 1)
  }, [])

  return (
    <>
      <SEO
        title="Embed Builder | Akron Pulse"
        description="Configure and preview a white-label Akron Pulse events calendar for your website. Copy the iframe snippet and drop it into any page."
      />

      <div className="builder-hero">
        <div className="builder-hero-inner">
          <h1>Embed Builder</h1>
          <p>Configure a live Akron Pulse calendar for your website. Copy the snippet below and drop it anywhere.</p>
        </div>
      </div>

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
                  {(['list', 'map'] as EmbedView[]).map((v) => (
                    <label key={v} className="builder-radio">
                      <input
                        type="radio"
                        name="eb-view"
                        value={v}
                        checked={state.view === v}
                        onChange={() => set('view', v)}
                      />
                      <span>{v === 'list' ? 'List' : 'Map'}</span>
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

        {/* ── Right: preview + code ───────────────────────────────────── */}
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

          <div className="builder-code-block">
            <div className="builder-code-header">
              <span className="builder-code-label">Copy this snippet</span>
              <button type="button" className="builder-copy-btn" onClick={handleCopy}>
                {copied ? '✓ Copied!' : 'Copy'}
              </button>
            </div>
            <textarea
              className="builder-code-textarea"
              readOnly
              value={snippet}
              rows={8}
              spellCheck={false}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          </div>

        </div>
      </div>
    </>
  )
}
