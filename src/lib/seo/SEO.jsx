import { Helmet } from 'react-helmet-async'
import { SITE, canonicalUrl } from './constants'

/**
 * <SEO />
 *
 * One component, every SEO-relevant tag a page needs:
 *   - <title>
 *   - <meta name="description">
 *   - <link rel="canonical">
 *   - Open Graph (og:title / description / url / image / type / site_name)
 *   - Twitter card (summary_large_image)
 *   - Optional <script type="application/ld+json"> for structured data
 *
 * Props:
 *   title       — page title (wrapped as "{title} | Akron Pulse" unless
 *                 `titleExact` is passed; home page uses titleExact)
 *   titleExact  — use the title as-is, no suffix
 *   description — meta description (155 char soft cap)
 *   path        — the canonical path for this page (e.g., "/events/abc")
 *   image       — OG/Twitter image URL (defaults to site default)
 *   type        — og:type (default "website"; events use "event",
 *                 articles/roundups use "article")
 *   noindex     — emit <meta name="robots" content="noindex">
 *   jsonLd      — a single object or array of objects to emit as JSON-LD
 *
 * Every page that renders user-facing content should render exactly one
 * <SEO /> so there is no ambiguity about what meta wins.
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
}) {
  const fullTitle = !title
    ? `${SITE.name} — ${SITE.tagline}`
    : titleExact
      ? title
      : `${title} | ${SITE.name}`

  const url = canonicalUrl(path)
  // Social crawlers reject relative og:image / twitter:image URLs. If a
  // caller passes a relative path (starts with '/'), resolve it to an
  // absolute URL via the site origin. Strings that already start with
  // 'http' pass through unchanged.
  const absoluteImage = image && image.startsWith('/')
    ? `${SITE.baseUrl}${image}`
    : image
  const ldArray = Array.isArray(jsonLd) ? jsonLd.filter(Boolean) : jsonLd ? [jsonLd] : []

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      {noindex && <meta name="robots" content="noindex,nofollow" />}

      {/* Open Graph */}
      <meta property="og:site_name"   content={SITE.name} />
      <meta property="og:title"       content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:url"         content={url} />
      <meta property="og:type"        content={type} />
      <meta property="og:locale"      content={SITE.locale} />
      <meta property="og:image"       content={absoluteImage} />

      {/* Twitter */}
      <meta name="twitter:card"        content="summary_large_image" />
      <meta name="twitter:title"       content={fullTitle} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image"       content={absoluteImage} />

      {/* JSON-LD. Each fragment becomes its own <script> tag so a bad
          one doesn't break the others. */}
      {ldArray.map((ld, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(ld)}
        </script>
      ))}
    </Helmet>
  )
}
