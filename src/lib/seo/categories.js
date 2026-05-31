/**
 * Category & neighborhood landing-page registry.
 *
 * Each entry is a "topical authority" hub page targeting a specific
 * head-keyword Google associates with Akron-area events (e.g. "free
 * events in Akron", "concerts in Akron", "downtown Akron events").
 *
 * The page component in /src/pages/CategoryPage.jsx consumes this
 * registry to render unique title, meta description, intro copy,
 * FAQ JSON-LD, and a filtered event list. Each page has at minimum
 * ~120 words of unique introductory copy — required for Google to
 * treat them as distinct hubs rather than thin doorway duplicates of
 * the homepage.
 *
 * Adding a new category? Add an entry here, then register the route
 * in App.jsx and include the path in the sitemap (api/sitemap.xml.js
 * already reads STATIC_HUB_PATHS from this module).
 */

// ── Category hub pages ──────────────────────────────────────────────
// `categoryFilter` is the comma-separated list of DB `events.category`
// values the page filters on (mirrors the homepage `categories=` URL
// param). `freeOnly` enables the price=0 filter. `dateRange` mirrors
// the homepage `dateRange` filter ('today', 'this_weekend', ...).

export const CATEGORY_HUBS = [
  {
    slug: 'this-weekend',
    label: 'This Weekend',
    title: 'Events in Akron This Weekend',
    metaDescription:
      'Find all the events happening in Akron, OH this weekend — concerts, festivals, family activities, food events, and more. Updated daily.',
    h1: 'Events in Akron This Weekend',
    intro:
      "Looking for something to do in Akron this weekend? You're in the right place. Every Saturday and Sunday in Summit County brings a fresh lineup of concerts, festivals, art openings, farmers markets, family activities, and community gatherings. Akron Pulse pulls together every published event happening Friday night through Sunday evening in one place — no scrolling between half a dozen venue calendars, no missing the great free thing happening four blocks away. Browse by category below, or jump straight into the full weekend list. Listings update throughout the day as new events get added by venues, organizations, and community submissions.",
    faqs: [
      {
        question: 'What free events are happening in Akron this weekend?',
        answer:
          "Akron Pulse lists every free event happening in Akron each weekend, sourced from Lock 3, the Akron Art Museum, Summit Metro Parks, Highland Square, Stan Hywet, the Akron-Summit County Public Library, and community-submitted events. Use the Free filter on the homepage to see only free events.",
      },
      {
        question: 'Where is the best place to find Akron events this weekend?',
        answer:
          "Akron Pulse is a free local events directory covering all of Akron and Summit County. We aggregate listings from city venues, museums, parks, theaters, organizations, and community submissions so you can see everything happening in one place — no scrolling between separate venue calendars.",
      },
      {
        question: 'Are there family-friendly events in Akron this weekend?',
        answer:
          "Yes — Akron's family-friendly weekend lineup typically includes events at Lock 3, the Akron Zoo, the Akron Children's Museum, Summit Metro Parks, and the Akron-Summit County Public Library. Filter by the Family Fun preset on the homepage to see only kid-friendly events.",
      },
    ],
    relatedSlugs: ['today', 'free', 'concerts', 'family'],
    dateRange: 'this_weekend',
  },
  {
    slug: 'today',
    label: 'Today',
    title: 'Things to Do in Akron Today',
    metaDescription:
      'Live list of every event happening today in Akron, OH and Summit County — concerts, art, food, fitness, family activities, and more.',
    h1: 'Things to Do in Akron Today',
    intro:
      "Need plans tonight? This page lists every event happening in Akron, OH today — pulled live from local venues, community organizations, the City of Akron's Lock 3 calendar, the Akron Art Museum, Summit Metro Parks, and dozens of other published sources. Whether you're after a free outdoor concert, a gallery opening, a fitness class, a fundraiser, or a kid-friendly daytime activity, this is the one page worth checking before you head out. Listings auto-refresh throughout the day as new events go live and as today's earlier events conclude.",
    faqs: [
      {
        question: 'What is there to do in Akron tonight?',
        answer:
          "Akron Pulse lists every event happening tonight across Akron and Summit County — concerts, art shows, food events, sports, community gatherings, and more. Filter by Free or by category to narrow the list to what fits your evening.",
      },
      {
        question: 'Are there any free events in Akron today?',
        answer:
          "Yes — Akron typically has multiple free events every day, especially at Lock 3, Summit Metro Parks, the Akron-Summit County Public Library, and various community venues. Use the Free filter to see only free events happening today.",
      },
    ],
    relatedSlugs: ['this-weekend', 'free', 'concerts'],
    dateRange: 'today',
  },
  {
    slug: 'free',
    label: 'Free Events',
    title: 'Free Events in Akron, OH',
    metaDescription:
      'A complete list of free events in Akron, OH — concerts at Lock 3, art exhibitions, library events, festivals, and community gatherings. Updated daily.',
    h1: 'Free Events in Akron, OH',
    intro:
      "Akron has one of the best free events scenes in northeast Ohio. Between the City of Akron's Lock 3 summer programming, free admission days at the Akron Art Museum, weekly events at the Akron-Summit County Public Library, programs in Summit Metro Parks, and community festivals across Highland Square, North Hill, Cuyahoga Falls, and downtown, there's almost always something happening that costs nothing. This page collects every free event currently scheduled in Akron Pulse. Free here means an event with a published price of zero — concerts, art openings, library programs, outdoor festivals, fitness classes, lectures, fundraisers with no entry fee, and community gatherings.",
    faqs: [
      {
        question: 'Are there free concerts in Akron?',
        answer:
          "Yes — Lock 3 in downtown Akron hosts a free outdoor concert series throughout the summer, and many community festivals, library events, and venue showcases throughout the year include free live music. Check the Free Events page on Akron Pulse for the current list.",
      },
      {
        question: 'What free events does the City of Akron host?',
        answer:
          "The City of Akron hosts a long-running free events program at Lock 3 in downtown Akron, including outdoor concerts, family movie nights, holiday celebrations, festivals, and the holiday ice rink. Akron Pulse ingests the official Lock 3 calendar so all of these events appear on the Free Events page.",
      },
      {
        question: 'Is the Akron Art Museum free?',
        answer:
          "The Akron Art Museum offers Free Thursdays and various free admission days throughout the year. Special exhibitions and member events may carry a ticket price — check the individual event page for details.",
      },
    ],
    relatedSlugs: ['this-weekend', 'concerts', 'family', 'art'],
    freeOnly: true,
  },
  {
    slug: 'concerts',
    label: 'Concerts',
    title: 'Concerts & Live Music in Akron, OH',
    metaDescription:
      "Live music in Akron — every upcoming concert at Akron's venues, theaters, bars, parks, and outdoor stages. Updated daily.",
    h1: 'Concerts & Live Music in Akron, OH',
    intro:
      "Akron's live music scene runs deep — from the Akron Civic Theatre and the Akron Symphony at E.J. Thomas Hall to the rotating bookings at Jilly's Music Room, Blu Jazz+, The Nightlight, Musica, Missing Falls Brewery, and the City of Akron's free Lock 3 outdoor concert series. This page lists every upcoming concert and live music event currently scheduled in Akron and across Summit County. Jazz, indie, classical, country, blues, hip-hop, tribute acts, college shows, and community festivals — they're all here. Use the price filter to narrow down to free concerts only, or pair the concerts filter with the This Weekend or Today date filters to see what's playing right now.",
    faqs: [
      {
        question: "What concerts are coming up in Akron?",
        answer:
          "Akron Pulse aggregates every upcoming concert and live music event from local venues including the Akron Civic Theatre, E.J. Thomas Hall, Lock 3, Jilly's Music Room, Blu Jazz+, The Nightlight, Musica, and Missing Falls Brewery. Browse the full concert listings on this page.",
      },
      {
        question: 'Are there free concerts at Lock 3 in Akron?',
        answer:
          "Yes — the City of Akron's Lock 3 outdoor stage hosts a free summer concert series each year, plus free seasonal events. All published Lock 3 concerts appear on Akron Pulse.",
      },
      {
        question: 'Where is the Akron Civic Theatre?',
        answer:
          "The Akron Civic Theatre is at 182 S Main St, Akron, OH 44308 in downtown Akron. Akron Pulse links directly to its full event calendar.",
      },
    ],
    relatedSlugs: ['this-weekend', 'free', 'downtown-akron'],
    categoryFilter: ['music'],
  },
  {
    slug: 'family',
    label: 'Family',
    title: 'Family-Friendly Events in Akron, OH',
    metaDescription:
      "Kid-friendly and family events in Akron and Summit County — Akron Zoo, Children's Museum, library programs, festivals, and free outdoor activities.",
    h1: 'Family-Friendly Events in Akron, OH',
    intro:
      "Family-friendly Akron is bigger than most parents realize. Beyond the obvious go-tos — the Akron Zoo, the Akron Children's Museum, Lock 3, and Summit Metro Parks — there's an active calendar of library programs, free outdoor concerts, kid-friendly festivals, fall and winter holiday events, and community days that work for a stroller, a kindergartener, and a tween at the same time. This page filters Akron Pulse to events that are explicitly family-friendly or community-focused: library storytimes, zoo events, parks programs, free outdoor activities, kid-focused workshops, and all-ages community festivals. Pair it with the Free filter to see free family events only, or combine it with the This Weekend filter for weekend plans.",
    faqs: [
      {
        question: 'What family events are happening in Akron this weekend?',
        answer:
          "Akron Pulse filters family-friendly events including the Akron Zoo, Children's Museum, Summit Metro Parks programs, library events, and community festivals. Combine the Family page with the This Weekend filter to see this weekend's lineup.",
      },
      {
        question: 'Are Summit Metro Parks events free?',
        answer:
          "Most Summit Metro Parks programs and events are free. Akron Pulse ingests the parks calendar so every published park program appears alongside other family-friendly events.",
      },
      {
        question: 'How much does the Akron Children’s Museum cost?',
        answer:
          "Check the individual event page for the current admission cost — Akron Pulse links directly to each event's listing where the museum publishes up-to-date pricing.",
      },
    ],
    relatedSlugs: ['free', 'this-weekend', 'today', 'outdoor'],
    categoryFilter: ['education', 'community'],
  },
  {
    slug: 'art',
    label: 'Art',
    title: 'Art Shows & Gallery Events in Akron, OH',
    metaDescription:
      "Art exhibitions, gallery openings, museum events, and creative workshops in Akron and Summit County. Updated daily.",
    h1: 'Art Shows & Gallery Events in Akron, OH',
    intro:
      "Akron's visual art scene anchors around the Akron Art Museum and Summit Artspace, but spreads across a network of galleries, studios, pop-ups, and event spaces. From the Free Thursday programming at the Art Museum to rotating exhibitions at Summit Artspace, the Akron Soul Train artist residencies, the Akronym Brewing taproom shows, and the larger Highland Square and downtown art walks, the city sustains a working calendar of openings, talks, classes, and immersive shows. This page lists every art-related event currently in Akron Pulse — exhibition openings, gallery shows, museum talks, art classes, and creative workshops.",
    faqs: [
      {
        question: 'When does the Akron Art Museum have free admission?',
        answer:
          "The Akron Art Museum offers Free Thursdays. Specific exhibitions and member events may have separate ticketing. Always check the individual event listing for the most current information.",
      },
      {
        question: 'What is the Akron Art Walk?',
        answer:
          "The Akron Art Walk is a recurring downtown event where galleries and artist spaces open their doors for free public viewing. Listings appear on Akron Pulse whenever the next walk is scheduled.",
      },
    ],
    relatedSlugs: ['free', 'downtown-akron', 'this-weekend'],
    categoryFilter: ['art'],
  },
  {
    slug: 'food-drink',
    label: 'Food & Drink',
    title: 'Food & Drink Events in Akron, OH',
    metaDescription:
      "Food festivals, beer releases, tastings, farmers markets, restaurant events, and pop-ups across Akron and Summit County.",
    h1: 'Food & Drink Events in Akron, OH',
    intro:
      "Akron's food and drink calendar covers a lot of ground: weekly farmers markets in Highland Square, Cuyahoga Falls, and Stow; tap takeovers and beer releases at Akronym Brewing, Hoppin' Frog, R. Shea, Missing Falls, and the rest of Akron's brewery row; restaurant-week-style events; pop-up dinners; food truck rallies at Lock 3; and seasonal events like festivals, holiday markets, and brewery anniversaries. This page collects every food-and-drink event currently in Akron Pulse so you can plan around them. Filter by date or pair with the Downtown Akron page to focus on events in a specific area.",
    faqs: [
      {
        question: 'Where can I find a farmers market in Akron?',
        answer:
          "Akron has multiple seasonal farmers markets, including Highland Square Farmers Market and markets in Cuyahoga Falls and Stow. Akron Pulse lists every market currently in season.",
      },
      {
        question: 'What food events are at Lock 3?',
        answer:
          "Lock 3 hosts food truck rallies, festivals, and free community food events throughout the year. The City of Akron Lock 3 calendar feeds directly into Akron Pulse.",
      },
    ],
    relatedSlugs: ['free', 'downtown-akron', 'highland-square', 'this-weekend'],
    categoryFilter: ['food'],
  },
  {
    slug: 'outdoor',
    label: 'Outdoor & Festivals',
    title: 'Outdoor & Festival Events in Akron',
    metaDescription:
      "Outdoor events, festivals, hikes, runs, and park programs in Akron, OH and Summit County — including Summit Metro Parks and CVNP.",
    h1: 'Outdoor & Festival Events in Akron',
    intro:
      "Akron sits at the gateway to Cuyahoga Valley National Park and is wrapped in the Summit Metro Parks system — which means the outdoor and festival calendar is unusually deep for a city this size. Hikes, guided walks, running events, riverfront festivals, outdoor concerts at Lock 3, neighborhood block parties, conservancy events at CVNP, and seasonal gatherings in Cuyahoga Falls and downtown all show up here. This page filters Akron Pulse to outdoor, festival, fitness, and nature events so you can plan something that gets you outside.",
    faqs: [
      {
        question: 'What outdoor events are at Cuyahoga Valley National Park?',
        answer:
          "Akron Pulse ingests the CVNP Conservancy event calendar, so every published Cuyahoga Valley National Park event appears here — hikes, guided walks, photography events, and conservation programs.",
      },
      {
        question: 'Are Summit Metro Parks events free?',
        answer:
          "Most Summit Metro Parks programs are free. Akron Pulse lists every published parks program.",
      },
    ],
    relatedSlugs: ['family', 'this-weekend', 'free'],
    categoryFilter: ['nature', 'sports', 'fitness'],
  },
]

// ── Neighborhood / Area hub pages ───────────────────────────────────
//
// IMPORTANT: every entry below is currently `disabled: true`.
//
// The original venue-keyword matching (`venueIncludes`) was authored
// from memory without verified data — see docs/neighborhoods.md for
// the full story. Until the City of Akron's official 24-neighborhood
// polygon set is ingested (PostGIS + `ST_Contains` against
// `venues.lat`/`lng`), these hubs filter to wrong results, so they
// are hidden from:
//   - the sitemap (api/sitemap.xml.js reads ENABLED_HUB_PATHS)
//   - the footer (src/components/Footer.jsx)
//   - the homepage chip strip (src/pages/HomePage.jsx)
//   - related-hub strips on category pages
// Hub URLs themselves still resolve — CategoryPage redirects disabled
// hubs to the homepage so any previously-shared link stays useful.
//
// When polygons land:
//   1. Drop the `disabled` flag.
//   2. Replace `venueIncludes` with the polygon lookup (the page
//      already filters by venue when a hub is a neighborhood — only
//      the matcher needs to change).
//   3. Verify each hub renders a sensible event list before letting
//      the sitemap rebuild include them.

export const NEIGHBORHOOD_HUBS = [
  {
    disabled: true, // see header note — venue matcher is unverified
    slug: 'downtown-akron',
    label: 'Downtown Akron',
    title: 'Downtown Akron Events',
    metaDescription:
      'Events happening in downtown Akron, OH — concerts at Lock 3 and the Civic Theatre, gallery openings, festivals, food events, and more.',
    h1: 'Downtown Akron Events',
    intro:
      "Downtown Akron is the gravitational center of the city's events scene. The Akron Civic Theatre, Lock 3, the Akron Art Museum, Musica, E.J. Thomas Performing Arts Hall, the John S. Knight Center, Canal Park, and a dense cluster of restaurants and breweries all sit within a few blocks of each other. That density means downtown anchors most weekend nights in Akron: a Civic Theatre show, a Lock 3 concert, a brewery tap takeover, and a museum opening can all happen within walking distance on the same night. This page filters Akron Pulse to events in downtown Akron venues so you can see everything happening downtown in one place. Pair it with the Free filter to see only free downtown events.",
    faqs: [
      {
        question: 'What is happening at Lock 3 this weekend?',
        answer:
          "Lock 3 is a City of Akron-owned outdoor venue in downtown Akron that hosts free concerts, festivals, food truck rallies, family movies, and seasonal events. Akron Pulse ingests the official Lock 3 calendar — see the current Lock 3 events on the Downtown Akron page.",
      },
      {
        question: 'Where is the Akron Civic Theatre?',
        answer:
          "The Akron Civic Theatre is at 182 S Main St, Akron, OH 44308 in downtown Akron.",
      },
      {
        question: 'What free events are happening downtown?',
        answer:
          "Downtown Akron hosts many free events, especially at Lock 3 and the Akron Art Museum's Free Thursdays. Combine the Downtown Akron page with the Free filter to see them all.",
      },
    ],
    relatedSlugs: ['concerts', 'free', 'this-weekend'],
    cityMatch: ['Akron'],
    venueIncludes: [
      'Lock 3',
      'Akron Civic',
      'Akron Art Museum',
      'Musica',
      'E.J. Thomas',
      'EJ Thomas',
      'John S. Knight',
      'Canal Park',
      'Summit Artspace',
      'Akronym',
      'Blu Jazz',
      "Jilly's",
      'Akron-Summit County Public Library Main',
    ],
  },
  {
    disabled: true, // see header note — venue matcher is unverified
    slug: 'highland-square',
    label: 'Highland Square',
    title: 'Highland Square Events & Things To Do',
    metaDescription:
      'Events in the Highland Square neighborhood of Akron, OH — farmers market, The Nightlight, gallery shows, community gatherings, and more.',
    h1: 'Highland Square Events & Things To Do',
    intro:
      "Highland Square is Akron's walkable arts-and-coffee neighborhood. The Nightlight indie cinema, the Highland Square Farmers Market, several boutique shops, neighborhood bars, and a cluster of restaurants and cafés give the Square its own distinct, year-round event calendar. This page lists every Akron Pulse event happening in or around Highland Square — film screenings, the weekly farmers market in season, gallery and shop events, community gatherings, and neighborhood festivals.",
    faqs: [
      {
        question: 'What movies are playing at The Nightlight in Akron?',
        answer:
          "The Nightlight is an indie cinema in Highland Square at 30 N High St, Akron, OH. Akron Pulse links to upcoming Nightlight screenings on the Highland Square page.",
      },
      {
        question: 'When is the Highland Square Farmers Market?',
        answer:
          "The Highland Square Farmers Market runs on a recurring weekly schedule during market season. Specific dates and times appear on Akron Pulse when each upcoming market is published.",
      },
    ],
    relatedSlugs: ['food-drink', 'art', 'this-weekend'],
    cityMatch: ['Akron'],
    venueIncludes: ['Nightlight', 'Highland Square', 'Mustard Seed Market'],
  },
  {
    disabled: true, // see header note — venue matcher is unverified
    slug: 'north-hill',
    label: 'North Hill',
    title: 'North Hill Community Events',
    metaDescription:
      'Events in the North Hill neighborhood of Akron, OH — community festivals, cultural events, food, and gatherings.',
    h1: 'North Hill Community Events',
    intro:
      "North Hill is one of Akron's most culturally rich neighborhoods, anchored by the North Hill Community Development Corporation and the Exchange House. The neighborhood hosts community festivals, multicultural events, food gatherings, and youth programs reflecting North Hill's deep immigrant and refugee community. This page filters Akron Pulse to North Hill events so the neighborhood's calendar is easy to surface in one place.",
    faqs: [
      {
        question: 'What is the North Hill Community Development Corporation?',
        answer:
          "The North Hill CDC is a neighborhood-focused organization that runs community events, supports local entrepreneurship, and operates the Exchange House. Akron Pulse ingests their event calendar.",
      },
    ],
    relatedSlugs: ['family', 'free', 'this-weekend'],
    cityMatch: ['Akron'],
    venueIncludes: ['North Hill', 'Exchange House'],
  },
  {
    disabled: true, // see header note — also, these are separate cities, not Akron neighborhoods
    slug: 'fairlawn-copley',
    label: 'Fairlawn & Copley',
    title: 'Fairlawn & Copley Events',
    metaDescription:
      'Events in Fairlawn and Copley, OH — community programs, shopping events, family activities, and more, just west of Akron.',
    h1: 'Fairlawn & Copley Events',
    intro:
      "Fairlawn and Copley sit just west of Akron and run their own active event calendars, especially around community programs, shopping center events at Summit Mall, and family activities. This page lists every Akron Pulse event happening in Fairlawn or Copley.",
    faqs: [],
    relatedSlugs: ['family', 'free', 'this-weekend'],
    cityMatch: ['Fairlawn', 'Copley'],
  },
  {
    disabled: true, // see header note — also, Cuyahoga Falls is a separate city, not an Akron neighborhood
    slug: 'cuyahoga-falls',
    label: 'Cuyahoga Falls',
    title: 'Cuyahoga Falls Events',
    metaDescription:
      'Events in Cuyahoga Falls, OH and the Cuyahoga Valley — Blossom Music Center, riverfront festivals, parks events, and more.',
    h1: 'Cuyahoga Falls Events',
    intro:
      "Cuyahoga Falls is a riverfront city in Summit County north of Akron, home to a long list of seasonal events on Front Street, riverfront festivals, parks programs, and Blossom Music Center shows on the city's edge. This page lists every Akron Pulse event happening in Cuyahoga Falls.",
    faqs: [
      {
        question: 'What is happening at Blossom Music Center?',
        answer:
          "Blossom Music Center is the summer home of the Cleveland Orchestra and a major outdoor concert venue near Cuyahoga Falls. Akron Pulse links to upcoming Blossom shows whenever they are published.",
      },
    ],
    relatedSlugs: ['concerts', 'outdoor', 'this-weekend'],
    cityMatch: ['Cuyahoga Falls'],
  },
  {
    disabled: true, // see header note — also, Stow is a separate city, not an Akron neighborhood
    slug: 'stow',
    label: 'Stow',
    title: 'Stow, OH Events',
    metaDescription:
      'Events in Stow, OH — community programs, farmers market, parks events, and family activities in Summit County.',
    h1: 'Stow, OH Events',
    intro:
      "Stow is a Summit County city just north of Akron with a steady year-round calendar of community programs, the Stow Farmers Market in season, parks events, and family-friendly activities. This page filters Akron Pulse to Stow events.",
    faqs: [],
    relatedSlugs: ['family', 'this-weekend'],
    cityMatch: ['Stow'],
  },
]

// ── Lookup helpers ──────────────────────────────────────────────────

export function getCategoryHub(slug) {
  return CATEGORY_HUBS.find((h) => h.slug === slug)
}

export function getNeighborhoodHub(slug) {
  return NEIGHBORHOOD_HUBS.find((h) => h.slug === slug)
}

export function getHub(slug) {
  return getCategoryHub(slug) || getNeighborhoodHub(slug)
}

/**
 * `disabled: true` hubs are removed from every user-facing surface
 * (footer, homepage strip, sitemap, related-hub strips). The hub
 * route itself still resolves so previously-shared URLs don't 404 —
 * CategoryPage redirects disabled hubs to the homepage.
 *
 * Filter helpers below all skip disabled hubs.
 */
function isEnabled(hub) {
  return hub && !hub.disabled
}

export const ENABLED_CATEGORY_HUBS     = CATEGORY_HUBS.filter(isEnabled)
export const ENABLED_NEIGHBORHOOD_HUBS = NEIGHBORHOOD_HUBS.filter(isEnabled)

/**
 * Every enabled hub path — used by api/sitemap.xml.js. Disabled hubs
 * are deliberately omitted so we don't tell Google to crawl pages
 * that filter to wrong content. (When polygons land, flip
 * `disabled: false` and the sitemap picks them up automatically.)
 */
export const ENABLED_HUB_PATHS = [
  ...ENABLED_CATEGORY_HUBS.map((h) => `/events/${h.slug}`),
  ...ENABLED_NEIGHBORHOOD_HUBS.map((h) => `/events/${h.slug}`),
]

/**
 * @deprecated Use ENABLED_HUB_PATHS instead. Kept for one cycle in
 * case any old import still references it; safe to remove later.
 */
export const ALL_HUB_PATHS = ENABLED_HUB_PATHS
