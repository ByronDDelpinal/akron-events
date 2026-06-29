/**
 * firstPageQuery.js — single source of truth for the "default homepage
 * page one" events query, shared by:
 *
 *   • api/events-first-page.js — the edge-cached endpoint
 *   • src/hooks/useEvents.ts   — imports EVENT_LIST_COLUMNS for its
 *     dynamic builder, and detects when a request matches this default
 *     so it can use the cached endpoint instead of hitting PostgREST.
 *
 * Plain JS (not TS) so the Vercel function can import it directly,
 * mirroring how api/feed.xml.js imports src/lib/slug.js.
 */

/**
 * Columns the list surfaces actually render. Deliberately excludes
 * `description` and the *_normalized search columns — they roughly
 * double the payload and nothing in a card reads them. Detail pages
 * (useEvent) select * for the full record.
 */
export const EVENT_LIST_COLUMNS = `
            id, title, start_at, end_at, status, source, source_url,
            featured, tags, banner_eligible, created_at,
            image_url, image_width, image_height, ticket_url,
            price_min, price_max, age_restriction, is_family, is_fundraiser`

/**
 * Apply the default first-page query (no user filters, soonest-first,
 * page one) to a supabase client. Must stay behaviorally identical to
 * useEvents' builder with default options — if you change one, change
 * the other.
 */
export function buildFirstPageQuery(supabase, limit) {
  return supabase
    .from('events')
    .select(`
      ${EVENT_LIST_COLUMNS},
      event_categories ( category ),
      event_venues ( venue:venues ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website, image_url, neighborhood_slug ) ),
      event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
    `, { count: 'exact' })
    .eq('status', 'published')
    // Drop events the moment their start time passes — no in-progress grace window.
    .gte('start_at', new Date().toISOString())
    .order('start_at', { ascending: true })
    .range(0, limit - 1)
}

/**
 * Build the PRISTINE first-page query for a category / neighborhood / city
 * hub — i.e. the hub with only its own locked filters applied and no user
 * filters, default soonest-first sort. This is the hub equivalent of
 * buildFirstPageQuery, shared by api/events-hub.js (edge-cached) and kept
 * behaviorally identical to useEvents' builder for the same inputs so the
 * cached page and the live fallback can't drift.
 *
 * `opts` are the resolved, hub-locked filters (NOT raw registry entries):
 *   { categories?: string[], facets?: string[], freeOnly?: boolean,
 *     neighborhoodSlug?: string|null, cityMatch?: string[] }
 *
 * Date-range hubs (This Weekend / Today) are intentionally NOT served from
 * here: their window is time-relative and must not be long-cached.
 */
export function buildHubFirstPageQuery(supabase, opts, limit) {
  const categories   = Array.isArray(opts.categories) ? opts.categories : []
  const facets       = Array.isArray(opts.facets) ? opts.facets : []
  const cityMatch    = Array.isArray(opts.cityMatch) ? opts.cityMatch : []
  const neighborhood = opts.neighborhoodSlug || null

  // A geo scope (neighborhood or city) forces an inner join so events
  // without a matching venue drop out — mirrors useEvents exactly.
  const useInnerVenue = !!neighborhood || cityMatch.length > 0
  const venueJoin = useInnerVenue ? 'event_venues!inner' : 'event_venues'
  const venueTbl  = useInnerVenue ? 'venues!inner'      : 'venues'
  // Aliased INNER embed to filter the parent down to events that have at
  // least one of the requested categories (the badge list still comes from
  // the plain event_categories embed below).
  const catFilterEmbed = categories.length > 0
    ? '_catfilter:event_categories!inner ( category ),'
    : ''

  let query = supabase
    .from('events')
    .select(`
      ${EVENT_LIST_COLUMNS},
      ${catFilterEmbed} event_categories ( category ),
      ${venueJoin} ( venue:${venueTbl} ( id, name, address, city, state, zip, lat, lng, parking_type, parking_notes, website, image_url, neighborhood_slug ) ),
      event_organizations ( organization:organizations ( id, name, website, description, image_url ) )
    `, { count: 'exact' })
    .eq('status', 'published')
    .gte('start_at', new Date().toISOString())

  if (categories.length > 0)  query = query.in('_catfilter.category', categories)
  if (neighborhood)           query = query.eq('event_venues.venues.neighborhood_slug', neighborhood)
  if (cityMatch.length > 0)   query = query.in('event_venues.venues.city', cityMatch)
  if (facets.includes('family'))     query = query.eq('is_family', true)
  if (facets.includes('fundraiser')) query = query.eq('is_fundraiser', true)
  if (opts.freeOnly)          query = query.eq('price_min', 0).or('price_max.is.null,price_max.eq.0')

  return query.order('start_at', { ascending: true }).range(0, limit - 1)
}
