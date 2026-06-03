/**
 * themes.js
 *
 * Single source of truth for theme options. Every theme is a CSS class
 * (.theme-<id>) defined in themes.css that overrides the brand-coupled
 * tokens. The useTheme hook always applies a class so DEFAULT_THEME can
 * be swapped freely without touching globals.css.
 *
 * Storage: localStorage only. The user's choice persists across
 * sessions but never leaves the device — zero backend cost. If/when
 * we want the choice tied to an account, move the persistence into
 * Supabase (the picker UI doesn't need to change).
 */

export const THEMES = [
  // ── New Akron Pulse rebrand palettes (top of the list) ──
  {
    id: 'akron-pulse',
    name: 'Civic Teal',
    description: 'Petrol teal with warm coral — the new default.',
  },
  {
    id: 'grand-piano',
    name: 'Grand Piano',
    description: 'Concert hall monochrome — ivory, black, and warm charcoal.',
  },
  {
    id: 'pulse-red',
    name: 'Pulse Red',
    description: 'Vermilion heartbeat on cream.',
  },
  {
    id: 'twilight-plum',
    name: 'Twilight Plum',
    description: 'Deep plum lifted by dusty gold.',
  },
  {
    id: 'forest-amber',
    name: 'Forest & Amber',
    description: 'Grounded forest green with honey amber.',
  },
  // ── Original Turnout-era palettes (preserved) ──
  {
    id: 'civic-classic',
    name: 'Civic Classic',
    description: 'The original — warm amber on cream.',
  },
  {
    id: 'harbor-civic',
    name: 'Harbor Civic',
    description: 'Editorial navy with terracotta.',
  },
  {
    id: 'violet-hour',
    name: 'Violet Hour',
    description: 'Rebeccapurple and jewel teal.',
  },
  {
    id: 'boardwalk',
    name: 'Boardwalk',
    description: 'Teal shore with tomato sunset.',
  },
  {
    id: 'olive-grove',
    name: 'Olive Grove',
    description: 'Muted olives on sand dune.',
  },
  {
    id: 'arcade-night',
    name: 'Arcade Night',
    description: 'Hot pink and sapphire on shadow grey.',
  },
  {
    id: 'stargazer',
    name: 'Stargazer',
    description: 'Twilight indigo with dusty lavender.',
  },
  {
    id: 'prime-time',
    name: 'Prime Time',
    description: 'Primary colors on oxford navy.',
  },
]

export const DEFAULT_THEME = 'akron-pulse'
export const THEME_STORAGE_KEY = 'akronpulse.theme'
// Pre-rebrand key. useTheme migrates this into THEME_STORAGE_KEY on first
// load so users' saved palette survives the rename. Safe to remove after
// enough time has passed that no live user still has the old key.
export const LEGACY_THEME_STORAGE_KEY = 'turnout.theme'

export const isValidTheme = (id) => THEMES.some((t) => t.id === id)

/**
 * Per-theme logo image paths (served from public/theme-logos/).
 * Files are named AkronPulse_<Theme-Name>.png.
 */
const THEME_LOGOS = {
  'akron-pulse':   '/theme-logos/AkronPulse_Civic-Teal.png',
  'grand-piano':   '/theme-logos/AkronPulse_Grand-Piano.png',
  'pulse-red':     '/theme-logos/AkronPulse_Pulse-Red.png',
  'twilight-plum': '/theme-logos/AkronPulse_Twilight-Plum.png',
  'forest-amber':  '/theme-logos/AkronPulse_Forest-Amber.png',
  'civic-classic': '/theme-logos/AkronPulse_Civic-Classic.png',
  'harbor-civic':  '/theme-logos/AkronPulse_Harbor-Civic.png',
  'violet-hour':   '/theme-logos/AkronPulse_Violet-Hour.png',
  'boardwalk':     '/theme-logos/AkronPulse_Boardwalk.png',
  'olive-grove':   '/theme-logos/AkronPulse_Olive-Grove.png',
  'arcade-night':  '/theme-logos/AkronPulse_Arcade-Night.png',
  'stargazer':     '/theme-logos/AkronPulse_Stargazer.png',
  'prime-time':    '/theme-logos/AkronPulse_Prime-Time.png',
}

/** Returns the logo URL for a theme id, falling back to the default. */
export const getThemeLogo = (id) =>
  THEME_LOGOS[id] || THEME_LOGOS[DEFAULT_THEME]

/**
 * Per-theme typography.
 *
 * Each entry contributes:
 *   - display / body : CSS font-family stacks fed to --font-display
 *     and --font-body. Quoted family names are required; the
 *     system-ui fallback keeps the page readable if Google Fonts
 *     fails to load.
 *   - googleFontsHref : the exact Google Fonts CSS2 URL the loader
 *     swaps into <link id="theme-fonts"> when the theme activates.
 *
 * Why per-theme fonts: each palette has a vibe (concert-hall,
 * arcade, harbor-editorial) that color alone can only carry so far.
 * Typography finishes the job.
 *
 * Why lazy-load: 13 themes × 2 families ≈ a lot of weight if loaded
 * up front. Only one theme is active at a time, so we fetch its
 * families on switch (see hooks/useTheme.jsx). The default theme's
 * families stay preloaded in index.html so cold-load first paint is
 * still correct — the rest stream in as the user picks them.
 *
 * Weight pinning: each URL only requests weights actually used by
 * the design system (400 body, 500 regular, 700 bold). Adding a
 * weight here is free; loading every weight isn't.
 */
export const THEME_FONTS = {
  'akron-pulse': {
    display: "'Sora', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Sora:wght@500;700&family=Inter:wght@400;500;700&display=swap',
  },
  'grand-piano': {
    display: "'Playfair Display', Georgia, serif",
    body: "'Source Sans 3', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,700;1,700&family=Source+Sans+3:wght@400;500;700&display=swap',
  },
  'pulse-red': {
    display: "'Fraunces', Georgia, serif",
    body: "'Inter', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;700&display=swap',
  },
  'twilight-plum': {
    display: "'Cormorant Garamond', Georgia, serif",
    body: "'Spectral', Georgia, serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;700&family=Spectral:wght@400;500;700&display=swap',
  },
  'forest-amber': {
    display: "'Domine', Georgia, serif",
    body: "'Lato', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Domine:wght@500;700&family=Lato:wght@400;700&display=swap',
  },
  'civic-classic': {
    display: "'Libre Caslon Text', Georgia, serif",
    body: "'Lato', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&family=Lato:wght@400;700&display=swap',
  },
  'harbor-civic': {
    display: "'Playfair Display', Georgia, serif",
    body: "'Inter', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700&family=Inter:wght@400;500;700&display=swap',
  },
  'violet-hour': {
    display: "'DM Serif Display', Georgia, serif",
    body: "'Manrope', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Manrope:wght@400;500;700&display=swap',
  },
  'boardwalk': {
    display: "'Recursive', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Recursive:wght,CASL@500,1;700,1&family=Inter:wght@400;500;700&display=swap',
  },
  'olive-grove': {
    display: "'Libre Baskerville', Georgia, serif",
    body: "'Karla', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Karla:wght@400;500;700&display=swap',
  },
  'arcade-night': {
    display: "'Unbounded', system-ui, sans-serif",
    body: "'JetBrains Mono', ui-monospace, monospace",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
  },
  'stargazer': {
    display: "'Fraunces', Georgia, serif",
    body: "'Inter', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT@9..144,500,100;9..144,700,100&family=Inter:wght@400;500;700&display=swap',
  },
  'prime-time': {
    display: "'Oswald', system-ui, sans-serif",
    body: "'Archivo', system-ui, sans-serif",
    googleFontsHref: 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&family=Archivo:wght@400;500;700&display=swap',
  },
}

/** Resolve the font config for a theme id, falling back to the default. */
export const getThemeFonts = (id) =>
  THEME_FONTS[id] || THEME_FONTS[DEFAULT_THEME]
