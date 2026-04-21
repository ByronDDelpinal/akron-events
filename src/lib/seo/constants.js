/**
 * Site-level SEO constants. Single source of truth for brand name, base
 * URL, default descriptions, default social images, and locale. Imported
 * by every SEO utility and every page that sets meta.
 */

export const SITE = {
  name: 'Turnout',
  tagline: 'Everything happening in Akron & Summit County',
  // Base URL with no trailing slash; used to build canonicals + sitemap.
  baseUrl: 'https://events.supportlocalakron.com',
  // Written long-form for AI citations — what Turnout IS, in one line.
  description:
    'Turnout is a free directory of local events in Akron, Ohio and Summit County — concerts, art shows, community gatherings, fundraisers, farmers markets, sports, and more, all in one place.',
  locale: 'en_US',
  country: 'US',
  region: 'OH',
  city: 'Akron',
  // Default social share image (static fallback until per-page OG is built).
  defaultOgImage: 'https://events.supportlocalakron.com/og-default.jpg',
}

/**
 * Build an absolute canonical URL from a pathname. All canonicals should
 * be absolute — this helper enforces that without every caller having to
 * think about it.
 */
export function canonicalUrl(pathname) {
  if (!pathname || pathname === '/') return SITE.baseUrl
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`
  return `${SITE.baseUrl}${p}`
}
