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
    relatedSlugs: ['family', 'this-weekend', 'free'],
    categoryFilter: ['nature', 'sports', 'fitness'],
  },
]

// ── Neighborhood / Area hub pages ───────────────────────────────────
//
// All 24 City-of-Akron neighborhoods get a registry entry. Three
// non-Akron city hubs (Cuyahoga Falls, Stow, Fairlawn & Copley)
// follow at the bottom — they're separate municipalities, not Akron
// neighborhoods, and match by venue.city rather than the polygon
// slug (see CategoryPage's eventMatchesNeighborhood).
//
// Status today (June 2026):
//   Every Akron neighborhood hub is `disabled: true, preview: true`.
//   - `disabled: true` keeps the hub out of the sitemap, footer,
//     related-hub strips, and homepage chips — i.e. unlisted.
//   - `preview: true` makes CategoryPage skip the redirect, so the
//     URL itself resolves and the page renders. Anyone with the URL
//     can browse it; nobody else finds it.
//
//   This is the audit mode the project sits in while we backfill
//   venue.neighborhood_slug coverage. Once a neighborhood has enough
//   classified venues to fill a real event list, flip its hub by
//   dropping the `preview` and `disabled` flags in lockstep.
//
// Matching:
//   For Akron-neighborhood hubs, CategoryPage matches events whose
//   venue.neighborhood_slug === hub.slug. That column is populated
//   by:
//     - admin venue editor (manual)
//     - scripts/classify-venues-by-polygon.js (one-time backfill)
//     - scripts/lib/normalize.js ensureVenue (auto on scrape)
//   See docs/neighborhoods.md for the full pipeline.

export const NEIGHBORHOOD_HUBS = [
  // ── Downtown ─────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'downtown-akron',
    label: 'Downtown Akron',
    title: 'Downtown Akron Events',
    metaDescription:
      'Events happening in downtown Akron, OH — concerts at Lock 3 and the Civic Theatre, gallery openings, festivals, food events, and more.',
    h1: 'Downtown Akron Events',
    intro:
      "Downtown is anchored by the 1929 Akron Civic Theatre — the \"Jewel on Main Street\" — and its newer 200-seat Knight Stage that opened in 2021. Across the way, Lock 3's Maynard Performance Pavilion holds up to 3,500 people and runs free outdoor concerts every weekend from May through September, plus year-round ice rinks and food. The Akron Art Museum, Musica, E.J. Thomas Performing Arts Hall, the John S. Knight Center, and Canal Park (home of the RubberDucks) sit within walking distance, alongside a dense block of restaurants and breweries. Downtown was also the site of the 1851 Ohio Women's Rights Convention where Sojourner Truth delivered her \"Ain't I A Woman?\" speech — historical weight that still threads through the calendar.",
    relatedSlugs: ['west-hill', 'university-park', 'cascade-valley', 'concerts', 'free'],
    cityMatch: ['Akron'],
  },

  // ── Central-west cluster (Highland Square + neighbors) ───────────
  {
    disabled: true, preview: true,
    slug: 'highland-square',
    label: 'Highland Square',
    title: 'Highland Square Events & Things To Do',
    metaDescription:
      'Events in the Highland Square neighborhood of Akron, OH — farmers market, The Nightlight, gallery shows, community gatherings, and more.',
    h1: 'Highland Square Events & Things To Do',
    intro:
      "Akron's walkable arts-and-coffee neighborhood, with deep roots — more than half its homes were built before 1940, and past residents include publisher John S. Knight, presidential candidate Wendell Willkie, industrialist Paul W. Litchfield, and Alcoholics Anonymous co-founder Dr. Bob Smith. The Nightlight indie cinema at 30 N. High St., the Highland Square Farmers Market, the Mustard Seed Market & Café, and a tight cluster of bars, restaurants, and shops give the Square its distinct year-round calendar. The Portage Path — the Native American canoe portage between the Cuyahoga and Tuscarawas Rivers that served as the western boundary of white and Native lands from 1785 to 1805 — still runs straight through the neighborhood.",
    relatedSlugs: ['wallhaven', 'west-hill', 'west-akron', 'food-drink', 'art'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'wallhaven',
    label: 'Wallhaven',
    title: 'Wallhaven Events',
    metaDescription:
      'Events in the Wallhaven neighborhood of Akron, OH — community programs, small-business pop-ups, and gatherings along West Market Street.',
    h1: 'Wallhaven Events',
    intro:
      "About four miles northwest of downtown at the busy crossroads of West Market Street, West Exchange Street, and Hawkins Avenue, Wallhaven is the commercial heart of Akron's western neighborhoods. Roughly 5,000 residents share two square miles of dense retail and dining — Swensons Drive-In, Ken Stewart's Grille, the Eye Opener diner, Graf's Garden Shop, Whole Foods, and Acme Fresh Market all sit within a few blocks of each other. Hardesty Park hosts the annual Akron Arts Expo every July, drawing artists from across the region. The neighborhood pulls a steady calendar of library programs at the Wallhaven branch, neighborhood-association gatherings, and West Market storefront events.",
    relatedSlugs: ['highland-square', 'west-akron', 'northwest-akron'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'west-hill',
    label: 'West Hill',
    title: 'West Hill Events',
    metaDescription:
      'Events in the West Hill neighborhood of Akron, OH — between downtown and Highland Square. Community gatherings, historic-district programs, and more.',
    h1: 'West Hill Events',
    intro:
      "The historic residential ridge climbing west out of downtown that filled in as middle-class residents fled the smoke of East Side rubber plants in the early 20th century. The Hall Park Allotment Historic District is the centerpiece — American Foursquare, Craftsman, Colonial, and Medieval Revival homes developed by Philander Hall between 1902 and 1919 at the height of Akron's rubber boom. Glendale Cemetery (founded 1839, on the National Register since 2001) sits on the western edge with its Gothic Revival Civil War Memorial Chapel, and the WPA-built Glendale Steps — 242 hand-laid sandstone steps from 1936–37 — descend the hillside as a Depression-era monument to stonecraft. Expect community gatherings, historic-home programs, and outdoor events on the steps.",
    relatedSlugs: ['downtown-akron', 'highland-square', 'cascade-valley'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'west-akron',
    label: 'West Akron',
    title: 'West Akron Events',
    metaDescription:
      'Events in West Akron — community programs, neighborhood gatherings, school events, and family activities west of downtown.',
    h1: 'West Akron Events',
    intro:
      "A sprawling residential grid about three miles west of downtown, with tree-lined streets and one of Akron's most deliberate civic histories. West Side Neighbors, Inc. ran one of the city's most successful integration efforts here from 1967 to 1990 — a biracial and interfaith project to demonstrate that an integrated neighborhood could thrive with full services and engaged residents. Anchors today include the Maple Valley Branch Library, the John Brown home (preserved by the Summit County Historical Society), and the Dr. Bob house — boyhood home of one of the co-founders of Alcoholics Anonymous. The calendar runs on library programs, school events, neighborhood-association gatherings, and faith-community events.",
    relatedSlugs: ['highland-square', 'wallhaven', 'sherbondy-hill', 'kenmore'],
    cityMatch: ['Akron'],
  },

  // ── Northern arc ─────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'north-hill',
    label: 'North Hill',
    title: 'North Hill Community Events',
    metaDescription:
      'Events in the North Hill neighborhood of Akron, OH — community festivals, cultural events, food, and gatherings.',
    h1: 'North Hill Community Events',
    intro:
      "One of Akron's most culturally rich neighborhoods and home to the second-largest Nepali-Bhutanese community in the United States — more than 5,000 refugees have resettled here since the first family arrived in 2008. The North Hill Community Development Corporation and the Exchange House (a multicultural gathering space opened by the Better Block Foundation in February 2017) anchor a calendar of ESL classes, health workshops, concerts by the Nepali Druk Fusion band, a community garden, and multicultural festivals. North High School is roughly half South Asian and fields one of the region's strongest soccer teams; storefronts that sat empty for years have filled with immigrant-owned small businesses.",
    relatedSlugs: ['chapel-hill', 'merriman-hills', 'cascade-valley', 'family', 'free'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'chapel-hill',
    label: 'Chapel Hill',
    title: 'Chapel Hill Events',
    metaDescription:
      'Events in the Chapel Hill neighborhood of northeast Akron — community gatherings, parks programs, and family activities.',
    h1: 'Chapel Hill Events',
    intro:
      "In northeast Akron, named after the Chapel Hill Mall that opened in 1967 and shaped the neighborhood for more than fifty years before closing and converting into a business park. The neighborhood's character is in transition — about 5,600 residents, 60% non-white, and a third Asian, making Chapel Hill the Akron neighborhood with the highest percentage of Asian residents. Roughly 70% of housing is rental, and the area sits at a junction of national retailers and a major highway with strong transit access. Expect a calendar of community gatherings, library events, and immigrant-led cultural programs.",
    relatedSlugs: ['north-hill', 'goodyear-heights', 'merriman-hills'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'cascade-valley',
    label: 'Cascade Valley',
    title: 'Cascade Valley Events',
    metaDescription:
      'Events in the Cascade Valley neighborhood of Akron — Little Cuyahoga River corridor, Cascade Locks Park, outdoor programs.',
    h1: 'Cascade Valley Events',
    intro:
      "Until recently called Elizabeth Park Valley, Cascade Valley fills the Little Cuyahoga River corridor between downtown Akron and the northern neighborhoods. It grew up around the Ohio & Erie Canal in the mid-19th century, and that history shapes its calendar today: Cascade Locks Park (locks 10–16 of the canal), the restored Mustill House & Store (a general store that served canal traffic from the 1820s onward), the Cascade Locks Historic District, and the Towpath Trail running north–south through the neighborhood. Cascade Valley Metro Park sits just upstream. Expect outdoor events, towpath programs, conservation gatherings, and Akron-history walks.",
    relatedSlugs: ['downtown-akron', 'north-hill', 'west-hill', 'outdoor'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'merriman-hills',
    label: 'Merriman Hills',
    title: 'Merriman Hills Events',
    metaDescription:
      'Events in the Merriman Hills neighborhood of Akron, OH — community programs and family gatherings in the city’s northern hills.',
    h1: 'Merriman Hills Events',
    intro:
      "A small residential neighborhood in the northern hills, between Merriman Valley to the north and Wallhaven / Northwest Akron to the south. Merriman Hills is one of the three neighborhoods added in the 2017 redesign of Akron's neighborhood map, and current rankings list it as the city's safest neighborhood with a median household income above $120,000. The calendar is quiet by Akron standards, leaning on neighborhood-association programs, parks events, and family gatherings.",
    relatedSlugs: ['merriman-valley', 'northwest-akron', 'fairlawn-heights'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'merriman-valley',
    label: 'Merriman Valley',
    title: 'Merriman Valley Events',
    metaDescription:
      'Events in the Merriman Valley neighborhood of Akron, OH — outdoor recreation, parks events, and Cuyahoga Valley access.',
    h1: 'Merriman Valley Events',
    intro:
      "Lines the Cuyahoga River northwest of downtown and serves as Akron's main gateway into Cuyahoga Valley National Park. Liberty Commons anchors the dining and retail strip — about twenty restaurants and bars (The Blue Door, Sushi Katsu, Vasili's Greek, Portal West Coffee, Sal's Gelato, Blimp City Bike & Hike, The Merchant Tavern, Merriman Valley Pizza) with shops covering everything from holistic stones to handmade tacos. Sand Run Metro Park sits just over the line. Expect a calendar weighted toward outdoor events, dining-district pop-ups, river programs, and seasonal markets, with a steady nightlife scene threaded through.",
    relatedSlugs: ['high-hampton', 'merriman-hills', 'cascade-valley', 'outdoor'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'high-hampton',
    label: 'High Hampton',
    title: 'High Hampton Events',
    metaDescription:
      'Events in the High Hampton neighborhood at the northern edge of Akron, OH — community programs and parks events.',
    h1: 'High Hampton Events',
    intro:
      "One of the three neighborhoods added in the 2017 redesign of Akron's map, High Hampton sits on the city's northern edge against the Cuyahoga Falls line. Rolling hills, large homes, and spacious lawns give it a quieter character than the dense central neighborhoods — and some residents even carry Cuyahoga Falls mailing addresses. The events calendar is small and residential, built around neighborhood-association programs and family gatherings.",
    relatedSlugs: ['merriman-valley', 'chapel-hill'],
    cityMatch: ['Akron'],
  },

  // ── Northwest ───────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'northwest-akron',
    label: 'Northwest Akron',
    title: 'Northwest Akron Events',
    metaDescription:
      'Events in Northwest Akron — Stan Hywet Hall & Gardens, Sand Run Metro Park, community programs, and family activities.',
    h1: 'Northwest Akron Events',
    intro:
      "Anchored by Stan Hywet Hall & Gardens — the 70-acre Tudor Revival estate of Goodyear co-founder F.A. Seiberling, with a name that means \"stone quarry\" in Old English — and Sand Run Metro Park's nearly 1,000 acres of trails, picnic shelters, and the Sand Run Lodge. Portage Country Club rounds out the green space. Most homes were built in the 1920s as smaller variations on the Stan Hywet workers' housing pattern. The calendar runs heavily on Stan Hywet's year-round programming (the Ohio Mart, Murder Mystery weekends, Deck the Hall during the holidays), outdoor events in the metro parks, and neighborhood-association gatherings.",
    relatedSlugs: ['fairlawn-heights', 'merriman-hills', 'wallhaven', 'outdoor'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'fairlawn-heights',
    label: 'Fairlawn Heights',
    title: 'Fairlawn Heights Events',
    metaDescription:
      'Events in the Fairlawn Heights neighborhood of Akron, OH — community gatherings and family activities just inside the western city line.',
    h1: 'Fairlawn Heights Events',
    intro:
      "Built in the 1910s by F.A. Seiberling's Fairlawn Heights Company as a home neighborhood for Goodyear executives, planned by Boston landscape architect Harold S. Wagner alongside a 150-acre country club. Akron annexed the area in 1932 when residents needed city water; the bones of the original plan — winding hillside streets, mature trees, and a thoughtful mix of Tudor, Georgian, French Norman, Chateaux, and later Bauhaus and ranch homes ranging from 3,000 to 10,000 square feet — are still visible everywhere. Bordered by West Market, I-77, Miller Road, and Frank Boulevard. The calendar centers on neighborhood-association programs and small West Market events. Not to be confused with the separate city of Fairlawn just to the west — those events live on the Fairlawn & Copley page.",
    relatedSlugs: ['northwest-akron', 'merriman-hills', 'wallhaven', 'fairlawn'],
    cityMatch: ['Akron'],
  },

  // ── Eastern arc ─────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'goodyear-heights',
    label: 'Goodyear Heights',
    title: 'Goodyear Heights Events',
    metaDescription:
      'Events in the Goodyear Heights neighborhood of Akron, OH — Goodyear Heights Metro Park, community gatherings, and family programs.',
    h1: 'Goodyear Heights Events',
    intro:
      "Akron's most nationally recognized historic neighborhood, designed in 1912–13 by landscape architect Warren Manning as a Garden City model for Goodyear factory workers. The plan favored sweeping curves over a street grid and wove in churches, schools, parks, and shops within walking distance — a state-of-the-art example of company-town planning that turned up in books and architecture journals nationwide. Goodyear Heights Metro Park sits at its core. Housing styles range across American Foursquare, Craftsman, Colonial, and Medieval Revival, with mature trees lining brick streets and hilly topography giving the neighborhood its name. Expect a calendar of park programs, historic-home events, and tight-knit community gatherings.",
    relatedSlugs: ['east-akron', 'chapel-hill', 'ellet', 'outdoor'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'east-akron',
    label: 'East Akron',
    title: 'East Akron Events',
    metaDescription:
      'Events in the East Akron neighborhood — community programs, church gatherings, school events, and family activities east of downtown.',
    h1: 'East Akron Events',
    intro:
      "Stretches east of downtown between Middlebury and Goodyear Heights with deep ties to the rubber industry. The intersection of Goodyear Boulevard and East Market Street was the commercial anchor for East Akron through most of the 20th century, with the old Goodyear buildings holding a company school, multiple recreation facilities, a theater, a bank, and storefronts. That historic Goodyear campus has been redeveloped as The East End — a 1.4-million-square-foot mixed-use district that now includes more than 100 loft apartments and a Hilton Garden Inn — and the corner is filling back in as a hub again. The calendar pulls from community-association programs, faith-community gatherings, school events, and East End commercial events.",
    relatedSlugs: ['middlebury', 'goodyear-heights', 'ellet'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'middlebury',
    label: 'Middlebury',
    title: 'Middlebury Events',
    metaDescription:
      'Events in the historic Middlebury neighborhood of Akron, OH — community programs and gatherings east of downtown.',
    h1: 'Middlebury Events',
    intro:
      "The oldest neighborhood in Akron — its own community until officially merging with the city in 1872, and founded by sea captain Joseph Hart and miller Aaron Norton in 1807 when they built a grist mill on the Little Cuyahoga. The Merrill family started Middlebury's pottery industry in 1847; in 1898 the Seiberling brothers founded Goodyear Tire & Rubber Company here, and Mohawk, Phoenix, and Kelly-Springfield followed by 1921. Today the neighborhood borders the University of Akron, the former Goodyear HQ (now The East End), and Summa Hospital, and it's a focus of active community revitalization efforts. Expect a calendar of community-association programs, small-venue events, and history walks.",
    relatedSlugs: ['downtown-akron', 'east-akron', 'university-park'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'ellet',
    label: 'Ellet',
    title: 'Ellet Events',
    metaDescription:
      'Events in the Ellet neighborhood of east Akron, OH — community gatherings, parks programs, and family activities.',
    h1: 'Ellet Events',
    intro:
      "Akron's largest neighborhood — more than 19,000 residents spread across seven square miles in the city's southeast corner — and arguably its most independent in character, often described as a small town within the city. Englishman Samuel Elliott (sometimes spelled Ellet) bought 500-plus acres here from Col. Simon Perkins in the early 1800s, and the neighborhood wasn't annexed by Akron until 1929. Derby Downs sits in Ellet — the WPA-built three-lane asphalt track that has hosted the All-American Soap Box Derby World Championship every July since 1934 — alongside the Goodyear Airdock, whose eleven 211-foot steel parabolic arches enclose one of the largest open interiors in the world. Expect family events, parks programs, school events, and Derby Downs racing weeks each summer.",
    relatedSlugs: ['east-akron', 'goodyear-heights'],
    cityMatch: ['Akron'],
  },

  // ── University / center-south ───────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'university-park',
    label: 'University Park',
    title: 'University Park Events',
    metaDescription:
      'Events in the University Park neighborhood of Akron, OH — University of Akron campus events, E.J. Thomas Hall performances, and student gatherings.',
    h1: 'University Park Events',
    intro:
      "Built around the University of Akron's main campus and the working-class neighborhood that wraps around it. Over 90% of residents are under 45, and the several blocks immediately around campus may be the most-walked stretch in Akron. E.J. Thomas Performing Arts Hall, the John S. Knight Center, university lectures, Zips athletics, performances, the Goodyear Polymer Center, and student-organization events drive a calendar that's busy year-round and especially dense during the academic year. South and east of campus the working-class character holds steady, with a significant mix of student rental housing folded in.",
    relatedSlugs: ['downtown-akron', 'middlebury', 'south-akron'],
    cityMatch: ['Akron'],
  },

  // ── Southern arc ────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'south-akron',
    label: 'South Akron',
    title: 'South Akron Events',
    metaDescription:
      'Events in the South Akron neighborhood — community gatherings, parks programs, and family activities south of downtown.',
    h1: 'South Akron Events',
    intro:
      "Laid out in December 1825, when Irish laborers building the Ohio & Erie Canal threw up roughly 100 cabins along the right-of-way. It was called \"South\" because Eliakim Crosby founded \"North Akron\" (today's Cascade) in 1833, and the two villages merged and incorporated together in 1836 — making South Akron's bones older than the city itself. Modern South Akron mixes residential blocks with light industry along the South Main Street corridor between downtown and Firestone Park. The calendar pulls from community-association programs, faith-community events, and parks programming.",
    relatedSlugs: ['firestone-park', 'university-park', 'summit-lake'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'firestone-park',
    label: 'Firestone Park',
    title: 'Firestone Park Events',
    metaDescription:
      'Events in the historic Firestone Park neighborhood of Akron, OH — Derby Downs (All-American Soap Box Derby), Firestone Park itself, and family events.',
    h1: 'Firestone Park Events',
    intro:
      "Planned over a century ago by Harvey S. Firestone as a model neighborhood for his tire-company workers, with landscape architect Alling S. DeForest laying out tree-lined boulevards that curve around the central Firestone Park itself — a public park literally shaped like the Firestone shield emblem. The original concept was families of different income levels living together in varied housing styles, with churches, schools, and shops all within walking distance — and that walkability still defines the neighborhood. Three neighborhood parks, charming early-20th-century architecture, and a calendar weighted toward family events, parks programming, and historic-home gatherings.",
    relatedSlugs: ['south-akron', 'kenmore', 'coventry-crossing'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'kenmore',
    label: 'Kenmore',
    title: 'Kenmore Events',
    metaDescription:
      'Events in the Kenmore neighborhood of southwest Akron, OH — Kenmore Boulevard music district, community gatherings, and small-business events.',
    h1: 'Kenmore Events',
    intro:
      "Was its own city before being annexed by Akron in 1929, with a commercial spine along Kenmore Boulevard that became the first Akron neighborhood business district added to the National Register of Historic Places (2019). The Better Kenmore CDC has driven a deep revitalization since 2016: at last count there were a dozen music-related businesses inside a three-block radius — two guitar shops, six recording studios, two live music venues, plus music schools — earning the corridor the nickname Akron's \"Music Row.\" Most of the new businesses are owned by Kenmore residents, and more than half are female- or minority-owned. Expect a calendar of independent music shows, neighborhood pop-ups, business-district events, and community-development programs.",
    relatedSlugs: ['firestone-park', 'sherbondy-hill', 'west-akron', 'coventry-crossing'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'sherbondy-hill',
    label: 'Sherbondy Hill',
    title: 'Sherbondy Hill Events',
    metaDescription:
      'Events in the Sherbondy Hill neighborhood of Akron, OH — community programs and gatherings southwest of downtown.',
    h1: 'Sherbondy Hill Events',
    intro:
      "Adjacent to downtown and bordered by Kenmore, West Akron, and Highland Square. The name traces back to Melcher Sherbondy, who bought 368 acres here around 1816; the neighborhood was briefly renamed Lane-Wooster before being restored to Sherbondy Hill in 2017 in recognition of its history as one of Akron's most historically Black neighborhoods (87% of residents identify as Black, the largest such concentration in the city) and its early ties to Akron's Jewish community. NBA star LeBron James grew up here. Anchors include Perkins Woods pool, Miller South School for the Visual and Performing Arts, the Akron Zoo, the Odom Branch Library, the Helen Arnold CLC, the Akron Urban League, and Cleveland Clinic Akron General just over the line — and the corridor is one of the city's \"Great Streets\" investment targets.",
    relatedSlugs: ['west-akron', 'kenmore', 'summit-lake'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'summit-lake',
    label: 'Summit Lake',
    title: 'Summit Lake Events',
    metaDescription:
      'Events around Summit Lake in Akron, OH — Summit Lake Nature Center, Reach Akron programs, towpath access, and outdoor events.',
    h1: 'Summit Lake Events',
    intro:
      "Built around Summit Lake itself in southern Akron, and one of the city's most ambitious civic-revitalization sites — Reimagining the Civic Commons has poured years of investment in alongside the Knight Foundation, Summit Metro Parks, the Ohio & Erie Canalway Coalition, and the City of Akron. The Summit Lake Nature Center now occupies a former tire-factory pump house with lakefront views, interpretive exhibits, and a community garden. The 2.25-mile Ohio & Erie Canal Summit Lake Trail (completed in 2023, with new bridges at Kenmore Boulevard and the North Shore) ties the lake's east and west sides into the Towpath Trail. The Reach Opportunity Center runs sports, after-school, and adult-services programming. Expect outdoor events, nature programs, and community gatherings on and around the lake.",
    relatedSlugs: ['sherbondy-hill', 'south-akron', 'kenmore', 'outdoor'],
    cityMatch: ['Akron'],
  },
  {
    disabled: true, preview: true,
    slug: 'coventry-crossing',
    label: 'Coventry Crossing',
    title: 'Coventry Crossing Events',
    metaDescription:
      'Events in the Coventry Crossing neighborhood at the southern edge of Akron, OH — community programs and family activities.',
    h1: 'Coventry Crossing Events',
    intro:
      "One of the three neighborhoods added in the 2017 redesign of Akron's neighborhood map, Coventry Crossing sits at the city's far southern edge against the Coventry Township line. The neighborhood was built as a planned community — new traditional homes with colonial influences put up between the 1980s and the early 2000s, organized around an HOA, with a small neighborhood park (including a splash pad) and direct access to Firestone Metro Park's 258 acres. The calendar is quiet by Akron standards and skews toward family activities and parks programming.",
    relatedSlugs: ['firestone-park', 'kenmore'],
    cityMatch: ['Akron'],
  },
]

// ── Summit County city hubs ─────────────────────────────────────────
//
// One hub per major Summit County, OH municipality. All match by
// `venue.city` since they're separate cities (or city-functioning
// townships), not Akron neighborhoods. The Akron entry here is the
// city-level rollup — the 24 Akron-neighborhood hubs above are its
// children, reachable through the NeighborhoodMap drill-down.
//
// Same disabled+preview status as the neighborhood hubs: URLs resolve,
// nothing in the sitemap / footer / homepage chips / related strips
// surfaces them yet. Flip per-hub by dropping both flags together
// once coverage is good enough to ship.

export const CITY_HUBS = [
  // ── Akron (city-level — has neighborhood drill-down) ──────────────
  {
    disabled: true, preview: true,
    slug: 'akron',
    label: 'Akron',
    title: 'Akron, OH Events',
    metaDescription:
      'Every event happening across Akron, OH — concerts, festivals, art shows, community gatherings, fitness, family activities, and more, drilled down by neighborhood when you want it.',
    h1: 'Akron, OH Events',
    intro:
      "Akron is the largest city in Summit County and the only one with a neighborhood drill-down on Akron Pulse — 24 City-recognized neighborhoods stretching from Merriman Valley in the north to Coventry Crossing in the south, anchored by downtown's Civic Theatre / Lock 3 / Knight Center cluster. Built by the rubber industry between 1910 and 1920 (Goodyear, Firestone, BFGoodrich, General Tire all started here) and reshaped over the last decade by the University of Akron, Cleveland Clinic Akron General, Bridgestone Americas, and a renewed Reach Akron / Civic Commons investment in the southern lakefront. This page lists every event happening anywhere in Akron — tap a neighborhood on the map below to narrow further.",
    relatedSlugs: ['cuyahoga-falls', 'stow', 'concerts', 'free', 'this-weekend'],
    cityMatch: ['Akron'],
  },

  // ── Cuyahoga Falls (Falls) ────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'cuyahoga-falls',
    label: 'Cuyahoga Falls',
    title: 'Cuyahoga Falls, OH Events',
    metaDescription:
      'Events in Cuyahoga Falls, OH — Front Street festivals, riverfront concerts, Blossom Music Center shows, parks programs, and community events north of Akron.',
    h1: 'Cuyahoga Falls, OH Events',
    intro:
      "Cuyahoga Falls — \"the Falls\" to locals — is Summit County's second-largest city, hugging the Cuyahoga River just north of Akron. The walkable historic Front Street district anchors downtown with restaurants, bars, and a year-round event calendar; the city's Riverfront Centre and Water Works Park host concerts and festivals through the warm months. Blossom Music Center, the summer home of the Cleveland Orchestra and a major touring-act venue, sits on the city's edge. The 1932 Sheraton Suites at the Falls and the restored Falls Theatre add to the downtown scene. Expect a calendar weighted toward concerts, Front Street festivals, parks programming, and riverfront community events.",
    relatedSlugs: ['stow', 'munroe-falls', 'concerts', 'outdoor'],
    cityMatch: ['Cuyahoga Falls'],
  },

  // ── Stow ─────────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'stow',
    label: 'Stow',
    title: 'Stow, OH Events',
    metaDescription:
      'Events in Stow, OH — Stow Farmers Market, Silver Springs Park concerts, community programs, and family activities in northern Summit County.',
    h1: 'Stow, OH Events',
    intro:
      "Stow is a residential city of about 35,000 in northern Summit County, sharing a high-performing school district with Munroe Falls. The events calendar centers on Silver Springs Park — site of summer concerts in the park, the city's outdoor pool, and the Bow Wow Beach off-leash dog area — plus the Stow Farmers Market that runs Saturday mornings in season at the Stow City Hall lot. The Stow City Center library branch programs community events year-round, and downtown Stow has been quietly rebuilding around restaurant openings on Darrow Road. Expect a calendar of parks programs, farmers markets, library events, and family-friendly community gatherings.",
    relatedSlugs: ['cuyahoga-falls', 'munroe-falls', 'hudson', 'family'],
    cityMatch: ['Stow'],
  },

  // ── Hudson ───────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'hudson',
    label: 'Hudson',
    title: 'Hudson, OH Events',
    metaDescription:
      'Events in Hudson, OH — First & Main district, historic Hudson Green, concerts on the Green, and community programs in northern Summit County.',
    h1: 'Hudson, OH Events',
    intro:
      "Hudson is a small, historic city in the northeast corner of Summit County, anchored by the Hudson Green and the surrounding First & Main mixed-use district. The Hudson Clock Tower (1912) marks the center of a downtown that runs an unusually full event calendar for its size: weekly concerts on the Green through the summer, the Taste of Hudson festival, Light Up Hudson during the holidays, and a steady cadence of farmers markets, art walks, and library programs. The Hudson Library & Historical Society sits on the Green and runs author events, history programs, and exhibitions year-round. Expect a calendar weighted toward outdoor concerts, downtown festivals, and community gatherings.",
    relatedSlugs: ['stow', 'twinsburg', 'concerts', 'this-weekend'],
    cityMatch: ['Hudson'],
  },

  // ── Green ────────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'green',
    label: 'Green',
    title: 'Green, OH Events',
    metaDescription:
      'Events in Green, OH — Central Park concerts, community festivals, parks programs, and family activities in southern Summit County.',
    h1: 'Green, OH Events',
    intro:
      "Green is a city of about 26,000 in southern Summit County, formed in 1992 from former Green Township and now mostly suburban with a sizable commercial spine along Massillon and Wadsworth Roads. The Green Central Park complex hosts an outdoor amphitheater that runs a summer concert series, plus festivals like the Green Music & Arts Festival, food truck rallies, and movies in the park. Akron-Canton Airport (CAK) sits at the city's edge and runs occasional public events at its terminal. Green Local Schools host concerts and athletics throughout the year. Expect a calendar centered on Central Park events, school programs, and family-oriented community festivals.",
    relatedSlugs: ['new-franklin', 'norton', 'family', 'outdoor'],
    cityMatch: ['Green'],
  },

  // ── Fairlawn ─────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'fairlawn',
    label: 'Fairlawn',
    title: 'Fairlawn, OH Events',
    metaDescription:
      'Events in Fairlawn, OH — Summit Mall, restaurant district, community programs, and family activities just west of Akron.',
    h1: 'Fairlawn, OH Events',
    intro:
      "Fairlawn is a small city of about 7,000 directly west of Akron, but it punches well above its weight as a regional commercial center. Summit Mall, the West Market Street restaurant corridor, and a cluster of hotels make Fairlawn a frequent destination from across Summit County for shopping, dining, and conferences. The city government's parks system runs a quiet but steady program of community events, and the Fairlawn-Bath Branch of the Akron-Summit County Public Library hosts year-round programming. Not to be confused with the separate Akron neighborhood of Fairlawn Heights, which sits inside the Akron city line.",
    relatedSlugs: ['copley', 'fairlawn-heights', 'akron'],
    cityMatch: ['Fairlawn'],
  },

  // ── Copley ───────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'copley',
    label: 'Copley',
    title: 'Copley, OH Events',
    metaDescription:
      'Events in Copley, OH — community programs, school events, parks gatherings, and shopping-district events just west of Akron.',
    h1: 'Copley, OH Events',
    intro:
      "Copley is technically a township but functions as a suburban community of about 17,000 west of Akron, anchored by the Cleveland-Massillon Road commercial corridor and the highly regarded Copley-Fairlawn City Schools. The calendar runs on parks programming, school athletic and music events, and a recurring lineup of community-association gatherings. Copley Community Park hosts movies in the park, food truck nights, and a small concert series in the summer months. The Fairlawn-Bath Branch of the library on West Market Street serves Copley families as well.",
    relatedSlugs: ['fairlawn', 'norton', 'akron'],
    cityMatch: ['Copley'],
  },

  // ── Tallmadge ────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'tallmadge',
    label: 'Tallmadge',
    title: 'Tallmadge, OH Events',
    metaDescription:
      'Events in Tallmadge, OH — Tallmadge Circle concerts, historic district programs, parks events, and family activities northeast of Akron.',
    h1: 'Tallmadge, OH Events',
    intro:
      "Tallmadge is a small city of about 18,000 northeast of Akron, organized around one of the most photographed traffic circles in Ohio — the Tallmadge Circle, a historic green space anchored by the 1825 Tallmadge Church and surrounded by Greek Revival buildings on the National Register. Concerts on the Circle run through the summer along with the Tallmadge Memorial Day Parade and the Holidays on the Circle tree lighting. The Tallmadge Community Centre runs year-round programming, and Tallmadge Schools host concerts and athletics throughout the academic year. Expect a calendar of Circle events, parks programs, school events, and community gatherings.",
    relatedSlugs: ['stow', 'cuyahoga-falls', 'concerts'],
    cityMatch: ['Tallmadge'],
  },

  // ── Barberton ────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'barberton',
    label: 'Barberton',
    title: 'Barberton, OH Events',
    metaDescription:
      'Events in Barberton, OH — Lake Anna Park concerts, Magic City Mile, downtown festivals, and community events southwest of Akron.',
    h1: 'Barberton, OH Events',
    intro:
      "Barberton — the \"Magic City\" — is a historic industrial city of about 25,000 southwest of Akron, founded in 1891 by O.C. Barber and reshaped by the matchstick, boiler, and rubber industries. Lake Anna sits at the heart of downtown and hosts Lake Anna Park concerts, Mum Fest in October, and seasonal festivals year-round. Barberton is also legendary for its Serbian-American \"Barberton chicken\" houses — Belgrade Gardens, Hopocan Gardens, White House Chicken, and Milich's Village Inn have been frying chicken in the city for decades. Expect a calendar weighted toward downtown festivals, Lake Anna programming, and Barberton Public Library events.",
    relatedSlugs: ['norton', 'akron', 'food-drink', 'concerts'],
    cityMatch: ['Barberton'],
  },

  // ── Twinsburg ────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'twinsburg',
    label: 'Twinsburg',
    title: 'Twinsburg, OH Events',
    metaDescription:
      'Events in Twinsburg, OH — Twins Days Festival, Liberty Park, community programs, and family activities in northeast Summit County.',
    h1: 'Twinsburg, OH Events',
    intro:
      "Twinsburg is a city of about 19,000 in northeast Summit County, internationally famous for the Twins Days Festival — the world's largest annual gathering of twins, held the first weekend of August every year since 1976. Outside that one weekend, the calendar runs on Liberty Park (a Cleveland Metroparks-anchored complex shared with Solon), the Twinsburg Square commercial district, and Twinsburg City Schools events. The Twinsburg Community Center programs concerts, dance and fitness classes, and a year-round event series. Expect a calendar centered on Liberty Park programs, school events, and the unmistakable Twins Days weekend.",
    relatedSlugs: ['macedonia', 'hudson', 'family'],
    cityMatch: ['Twinsburg'],
  },

  // ── Macedonia ────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'macedonia',
    label: 'Macedonia',
    title: 'Macedonia, OH Events',
    metaDescription:
      'Events in Macedonia, OH — Macedonia City Park, Longwood Park concerts, family activities, and community events in northeast Summit County.',
    h1: 'Macedonia, OH Events',
    intro:
      "Macedonia is a city of about 12,000 in the far northeast corner of Summit County, next to Twinsburg and adjacent to Cuyahoga County's Bedford Heights and Solon. The Macedonia Family Recreation Center anchors community programming, Longwood Park hosts summer concert and movie series, and the I-271 / Route 8 corridor brings shopping center events at Macedonia Commons. Nordonia Hills City Schools — Macedonia plus neighboring Northfield Center, Sagamore Hills, and Northfield Village — host concerts, athletics, and academic events throughout the year. Expect a calendar of parks events, family activities, and school programs.",
    relatedSlugs: ['twinsburg', 'hudson'],
    cityMatch: ['Macedonia'],
  },

  // ── Norton ───────────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'norton',
    label: 'Norton',
    title: 'Norton, OH Events',
    metaDescription:
      'Events in Norton, OH — Loyal Oak Park, Wolf Creek Environmental Center, community programs, and family activities west of Akron.',
    h1: 'Norton, OH Events',
    intro:
      "Norton is a city of about 12,000 west of Akron, mostly residential with rolling hills and a calendar driven by parks and community programs. The Wolf Creek Environmental Center runs nature programs year-round and Loyal Oak Park hosts community events through the warmer months. Norton City Schools hold a steady lineup of concerts, athletics, and academic events. The Norton Branch of the Akron-Summit County Public Library is a hub for library programming. Expect a calendar of parks events, nature programs, library events, and family-oriented community gatherings.",
    relatedSlugs: ['barberton', 'copley', 'outdoor'],
    cityMatch: ['Norton'],
  },

  // ── Munroe Falls ─────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'munroe-falls',
    label: 'Munroe Falls',
    title: 'Munroe Falls, OH Events',
    metaDescription:
      'Events in Munroe Falls, OH — Munroe Falls Metro Park, Cuyahoga River programs, community gatherings, and family activities just east of Cuyahoga Falls.',
    h1: 'Munroe Falls, OH Events',
    intro:
      "Munroe Falls is a small city of about 5,000 on the Cuyahoga River between Cuyahoga Falls and Stow, sharing the well-regarded Stow-Munroe Falls City Schools with its larger neighbor. Munroe Falls Metro Park — part of the Summit Metro Parks system, with kayak access on the river and trails through restored wetland — is the centerpiece of the local event calendar. The city itself runs concerts and movies in the park during summer and a small holiday tree-lighting in winter. Expect a calendar weighted toward parks programs, school events, and small-city community gatherings.",
    relatedSlugs: ['cuyahoga-falls', 'stow', 'outdoor'],
    cityMatch: ['Munroe Falls'],
  },

  // ── New Franklin ─────────────────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'new-franklin',
    label: 'New Franklin',
    title: 'New Franklin, OH Events',
    metaDescription:
      'Events in New Franklin, OH — Portage Lakes State Park, community programs, parks events, and family activities at the southern edge of Summit County.',
    h1: 'New Franklin, OH Events',
    intro:
      "New Franklin is the largest city by area in Summit County, formed in 2003 from the former Franklin Township and the villages of Clinton and Manchester. The city wraps around much of the Portage Lakes — Turkeyfoot, Long, East Reservoir, Nimisila — which together anchor the local event calendar through Portage Lakes State Park and the lakefront restaurants and marinas. The Portage Lakes Polar Bear Jump (every February since 1981) is the city's signature event, drawing thousands. Expect a calendar weighted toward lakefront events, parks programs, and seasonal community gatherings.",
    relatedSlugs: ['green', 'akron', 'outdoor'],
    cityMatch: ['New Franklin'],
  },

  // ── Regional rollups ────────────────────────────────────────────
  // Three quadrants that aggregate every Summit County
  // township/village without its own dedicated hub. They render on
  // the SummitCountyMap as MultiPolygon features so the map shows
  // the complete county shape, not islands of incorporated places.
  // See REGIONS in src/lib/cities.js + TOWNSHIP_REGION /
  // VILLAGE_REGION in scripts/convert-summit-cities.js for the
  // geographic assignments.

  // ── Northwest Summit County ─────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'northwest-summit-county',
    label: 'Northwest Summit County',
    title: 'Northwest Summit County Events',
    metaDescription:
      'Events in northwest Summit County — Bath Township, Richfield Township and Village, Boston Township and the village of Peninsula. Cuyahoga Valley National Park access, rural townships, outdoor calendars.',
    h1: 'Northwest Summit County Events',
    intro:
      "The Cuyahoga Valley side of Summit County: Bath Township west of Akron (where most of Stan Hywet's quieter side fades into rolling country), Richfield Village and Richfield Township at the Cuyahoga County line, Boston Township along the river, and the village of Peninsula in the heart of Cuyahoga Valley National Park. The calendar leans heavily on CVNP — Conservancy programs at the Boston Store and Stanford House, Cuyahoga Valley Scenic Railroad excursions, hikes, ski events at Boston Mills / Brandywine in winter — plus Peninsula's tight downtown event scene (Peninsula Foundry music nights, the village arts events) and small-town festivals across Richfield and Bath. This page lists every Akron Pulse event in the northwest quadrant.",
    relatedSlugs: ['cuyahoga-falls', 'hudson', 'akron', 'outdoor'],
    cityMatch: ['Bath', 'Boston', 'Boston Township', 'Richfield', 'Peninsula'],
  },

  // ── Northeast Summit County ─────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'northeast-summit-county',
    label: 'Northeast Summit County',
    title: 'Northeast Summit County Events',
    metaDescription:
      'Events in northeast Summit County — Sagamore Hills Township, Northfield Center Township and Northfield Village, Boston Heights, Reminderville, Twinsburg Township, and Silver Lake.',
    h1: 'Northeast Summit County Events',
    intro:
      "Northeast Summit County wraps from Macedonia and Twinsburg up against the Cuyahoga County line: Sagamore Hills Township, Northfield Center Township and the village of Northfield, the small villages of Boston Heights and Reminderville, Twinsburg Township just east of the city, and the unusual little village of Silver Lake nestled between Cuyahoga Falls and Stow. The calendar runs heavily on Nordonia Hills programming (the school district that ties Macedonia / Northfield Center / Sagamore Hills together), the Hard Rock Rocksino events bringing concerts into Northfield, Liberty Park's shared-with-Cleveland-Metroparks events, and small-village festivals. This page lists every Akron Pulse event in the northeast quadrant.",
    relatedSlugs: ['macedonia', 'twinsburg', 'hudson', 'cuyahoga-falls'],
    cityMatch: ['Sagamore Hills', 'Northfield', 'Northfield Center', 'Boston Heights', 'Reminderville', 'Silver Lake'],
  },

  // ── Southeast Summit County ─────────────────────────────────────
  {
    disabled: true, preview: true,
    slug: 'southeast-summit-county',
    label: 'Southeast Summit County',
    title: 'Southeast Summit County Events',
    metaDescription:
      'Events in southeast Summit County — Springfield Township, Lakemore Village, the Summit-County portion of Mogadore. Lakefront events, parks programs, school events.',
    h1: 'Southeast Summit County Events',
    intro:
      "Southeast Summit County stretches from Akron's eastern edge down toward the Portage County line: Springfield Township just east of Akron (home to Akron Fulton International Airport and the Derby Downs corridor that flows up into Ellet), Lakemore Village on Springfield Lake, and the Summit-County portion of Mogadore Village along the Portage line. The calendar is weighted toward the lakes — Springfield Lake events, Lakemore's summer festivals — plus Springfield Local Schools events and the Springfield-Lake fire-and-ambulance community gatherings that anchor neighborhood life. This page lists every Akron Pulse event in the southeast quadrant.",
    relatedSlugs: ['akron', 'tallmadge', 'new-franklin', 'outdoor'],
    cityMatch: ['Springfield', 'Springfield Township', 'Lakemore', 'Mogadore'],
  },
]

// ── Lookup helpers ──────────────────────────────────────────────────

export function getCategoryHub(slug) {
  return CATEGORY_HUBS.find((h) => h.slug === slug)
}

export function getNeighborhoodHub(slug) {
  return NEIGHBORHOOD_HUBS.find((h) => h.slug === slug)
}

export function getCityHub(slug) {
  return CITY_HUBS.find((h) => h.slug === slug)
}

export function getHub(slug) {
  return getCategoryHub(slug) || getNeighborhoodHub(slug) || getCityHub(slug)
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
export const ENABLED_CITY_HUBS         = CITY_HUBS.filter(isEnabled)

/**
 * Every enabled hub path — used by api/sitemap.xml.js. Disabled hubs
 * are deliberately omitted so we don't tell Google to crawl pages
 * that filter to wrong content. (When polygons land, flip
 * `disabled: false` and the sitemap picks them up automatically.)
 */
export const ENABLED_HUB_PATHS = [
  ...ENABLED_CATEGORY_HUBS.map((h) => `/events/${h.slug}`),
  ...ENABLED_NEIGHBORHOOD_HUBS.map((h) => `/events/${h.slug}`),
  ...ENABLED_CITY_HUBS.map((h) => `/events/${h.slug}`),
]

/**
 * @deprecated Use ENABLED_HUB_PATHS instead. Kept for one cycle in
 * case any old import still references it; safe to remove later.
 */
export const ALL_HUB_PATHS = ENABLED_HUB_PATHS
