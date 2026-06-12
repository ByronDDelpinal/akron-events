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
    .gte('start_at', new Date(Date.now() - 3 * 3600_000).toISOString())
    .order('start_at', { ascending: true })
    .range(0, limit - 1)
}
