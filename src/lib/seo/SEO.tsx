import { Helmet } from 'react-helmet-async'
import { SITE, canonicalUrl } from './constants'

interface SEOProps {
  /** page title (wrapped as "{title} | Akron Pulse" unless titleExact) */
  title?: string
  /** use the title as-is, no suffix */
  titleExact?: boolean
  /** meta description (155 char soft cap) */
  description?: string
  /** the canonical path for this page (e.g., "/events/abc") */
  path?: string
  /** OG/Twitter image URL (defaults to site default) */
  image?: string
  /** og:type (default "website"; events use "event", roundups use "article") */
  type?: string
  /** emit <meta name="robots" content="noindex"> */
  noindex?: boolean
  /** a single object or array of objects to emit as JSON-LD */
  jsonLd?: object | object[] | null
}

/**
 * <SEO /> — one component, every SEO-relevant tag a page needs (title,
 * description, canonical, Open Graph, Twitter card, optional JSON-LD).
 * Every page that renders user-facing content should render exactly one.
 */
export default function SEO({
  title,
  titleExact = false,
  description = SITE.description,
  path = '/',
  image = SITE.defaultOgImage,
  type = 'website',
  noindex = false,
  jsonLd = null,
}: SEOProps) {
  const fullTitle = !title
    ? `${SITE.name} — ${SITE.tagline}`
    : titleExact
      ? title
      : `${title} | ${SITE.name}`

  const url = canonicalUrl(path)
  // Social crawlers reject relative og:image URLs — resolve relative paths
  // to absolute via the site origin; http(s) URLs pass through unchanged.
  const absoluteImage = image && image.startsWith('/')
    ? `${SITE.baseUrl}${image}`
    : image
  const ldArray: object[] = Array.isArray(jsonLd)
    ? jsonLd.filter(Boolean)
    : jsonLd ? [jsonLd] : []

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {noindex && <meta name="robots" content="noindex,nofollow" />}

      {/* Open Graph — all our OG images resolve to 1200×630. */}
      <meta property="og:site_name"    content={SITE.name} />
      <meta property="og:title"        content={fullTitle} />
      <meta property="og:description"  content={description} />
      <meta property="og:url"          content={url} />
      <meta property="og:type"         content={type} />
      <meta property="og:locale"       content={SITE.locale} />
      <meta property="og:image"        content={absoluteImage} />
      <meta property="og:image:width"  content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt"    content={fullTitle} />

      {/* Twitter */}
      <meta name="twitter:card"        content="summary_large_image" />
      <meta name="twitter:title"       content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image"       content={absoluteImage} />
      <meta name="twitter:image:alt"   content={fullTitle} />

      {/* JSON-LD. Each fragment becomes its own <script> so a bad one
          doesn't break the others. */}
      {ldArray.map((ld, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(ld)}
        </script>
      ))}
    </Helmet>
  )
}
