/**
 * Domain type aliases.
 *
 * Thin, human-friendly names over the generated Supabase row/insert/update
 * types in `@/lib/database.types`. Import these in app code rather than the
 * raw `Tables<'events'>` helper so the call sites read cleanly and there is a
 * single place to layer on app-only refinements later.
 *
 * Regenerate `database.types.ts` after a migration and these stay correct.
 */

import type { Tables, TablesInsert, TablesUpdate } from '@/lib/database.types'

// ── Row types (what you read back from the DB) ───────────────────────────────
export type Event = Tables<'events'>
export type Venue = Tables<'venues'>
export type Organization = Tables<'organizations'>
export type Area = Tables<'areas'>
export type Subscriber = Tables<'subscribers'>
export type FeedbackPost = Tables<'feedback_posts'>
export type ScraperRun = Tables<'scraper_runs'>

/** The `scraper_health` view that powers the Technical page + `npm run health`. */
export type ScraperHealth = Tables<'scraper_health'>

// ── Insert / update payloads ─────────────────────────────────────────────────
export type EventInsert = TablesInsert<'events'>
export type EventUpdate = TablesUpdate<'events'>
export type VenueInsert = TablesInsert<'venues'>
export type OrganizationInsert = TablesInsert<'organizations'>

/**
 * Event joined with the related rows the UI usually needs. Supabase returns
 * these as nested arrays when you select through the junction tables, e.g.
 * `*, venues(*), organizations(*)`.
 */
export interface EventWithRelations extends Event {
  venues?: Venue[]
  organizations?: Organization[]
  areas?: Area[]
  event_categories?: { category: string }[]
}
