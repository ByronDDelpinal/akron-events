/**
 * Fixture HTML for Nightlight Cinema scraper tests.
 *
 * HTML is simplified to just what the scraper parses — tag-stripped text
 * order for the home page, and schema.org JSON-LD for movie pages.
 */

// ── Home page — two "Standard Screening" blocks on today's schedule ─────────
export const HOME_HTML = `
<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"MovieTheater","name":"Nightlight | The Nightlight"}
</script>
</head><body>
<div class="q-page">
  <h2>What's Playing</h2>
  <a href="/movie/the-christophers/">The Christophers</a>
  <a href="/movie/exit-8/">Exit 8</a>

  <div class="screening-card">
    <div>Standard Screening</div>
    <div>play_arrow</div>
    <div>Screen 2</div>
    <div>The Christophers</div>
    <div>1 hr 40 min · Crime</div>
    <div>5:50 PM</div>
  </div>

  <div class="screening-card">
    <div>Standard Screening</div>
    <div>play_arrow</div>
    <div>Screen 1</div>
    <div>Exit 8</div>
    <div>1 hr 35 min · Horror</div>
    <div>8:00 PM</div>
  </div>
</div>
</body></html>
`

// ── Home page — edge cases we want to not crash on ──────────────────────────
export const HOME_HTML_EMPTY = `
<!doctype html><html><body>
<div>No screenings today</div>
</body></html>
`

export const HOME_HTML_MISSING_SCREEN_LINE = `
<!doctype html><html><body>
<div>Standard Screening</div>
<div>Silence of the Lambs 35th Anniversary</div>
<div>2 hr 3 min · Crime</div>
<div>7:00 PM</div>
</body></html>
`

// ── Movie detail page with full JSON-LD ─────────────────────────────────────
export const MOVIE_PAGE_HTML = `
<!doctype html><html><head>
<meta property="og:title" content="The Silence Of The Lambs 35th Anniversary">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"MovieTheater","name":"Nightlight | The Nightlight","address":{"@type":"PostalAddress","streetAddress":"30 N High St","addressLocality":"Akron"}}
</script>
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"Movie",
  "name":"The Silence Of The Lambs 35th Anniversary",
  "description":"A young FBI trainee seeks out a jailed psychiatrist-serial-killer to gain insight into the mind of another predator.",
  "duration":"PT2H3M",
  "genre":"Crime",
  "contentRating":"R",
  "image":"https://indy-systems.imgix.net/sample123?max-w=1000&fit=fill",
  "director":{"@type":"Person","name":"Jonathan Demme"},
  "keywords":"thriller, crime, classic"
}
</script>
</head><body><h1>The Silence Of The Lambs</h1></body></html>
`

// ── Movie detail page with no JSON-LD at all ────────────────────────────────
export const MOVIE_PAGE_NO_LD = `
<!doctype html><html><body><h1>Coming Soon</h1></body></html>
`

// ── Movie page with @graph wrapper ──────────────────────────────────────────
export const MOVIE_PAGE_GRAPH = `
<!doctype html><html><head>
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@graph":[
    {"@type":"MovieTheater","name":"Nightlight"},
    {"@type":"Movie","name":"Kiki's Delivery Service","duration":"PT1H43M","genre":["Animation","Family"],"contentRating":"G","image":{"@type":"ImageObject","url":"https://indy-systems.imgix.net/kiki"}}
  ]
}
</script>
</head><body></body></html>
`

// ── Sitemap with movie URLs ─────────────────────────────────────────────────
export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://nightlightcinema.com/</loc></url>
  <url><loc>https://nightlightcinema.com/full-calendar/</loc></url>
  <url><loc>https://nightlightcinema.com/movie/the-christophers/</loc><lastmod>2026-04-10</lastmod></url>
  <url><loc>https://nightlightcinema.com/movie/exit-8/</loc></url>
  <url><loc>https://nightlightcinema.com/movie/city-wide-fever/</loc></url>
  <url><loc>https://nightlightcinema.com/movie/the-silence-of-the-lambs-35th-anniversary/</loc></url>
</urlset>
`
