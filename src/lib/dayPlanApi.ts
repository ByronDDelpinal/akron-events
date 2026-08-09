/**
 * dayPlanApi.ts
 *
 * Thin wrapper around the five SECURITY DEFINER RPC functions migration 052
 * grants to anon (create_day_plan, get_day_plan, day_plan_add_event,
 * day_plan_remove_event, day_plan_set_title). See that migration's header
 * for why every anon write to day_plans/day_plan_items goes through a
 * function instead of a normal insert/update: RLS is enabled on both tables
 * with ZERO anon policies, on purpose — the code (bearer secret) is the only
 * thing standing between the anon key and the whole plan.
 *
 * TODO(remove after Supabase regenerates src/lib/database.types.ts following
 * migration 052): day_plans/day_plan_items/the five RPC functions are not in
 * the generated Database type yet, so the typed client's `.rpc()` rejects
 * these names at compile time. Same pattern as EmbedRequestForm.tsx's
 * `untypedSupabase` (see that file's own TODO) — narrow the cast to exactly
 * this module's calls, drop it once regenerated.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'

const untypedSupabase = supabase as unknown as SupabaseClient

export type RotStatus = 'ok' | 'moved' | 'cancelled' | 'merged' | 'merged_duplicate' | 'gone'

export interface DayPlanVenue {
  name: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  lat: number | null
  lng: number | null
}

/**
 * One resolved day-plan item, exactly the jsonb shape get_day_plan()
 * returns (see 052's own comment on that function for the full resolution
 * order). `id`/`title`/`start_at`/etc. are the LIVE (or canonical, for
 * `merged`) event's fields and are null when rot_status is `gone` — render
 * from `snap_*` in that case. `snap_*` is ALWAYS present regardless of
 * rot_status; it's the add-time record.
 */
export interface DayPlanItem {
  event_id: string
  added_at: string
  resolved_event_id: string | null
  rot_status: RotStatus
  id: string | null
  title: string | null
  start_at: string | null
  end_at: string | null
  status: string | null
  event_status: string | null
  description: string | null
  ticket_url: string | null
  source_url: string | null
  price_min: number | null
  price_max: number | null
  category_slugs: string[] | null
  venue: DayPlanVenue | null
  snap_title: string
  snap_start_at: string
  snap_end_at: string | null
  snap_venue: string | null
}

export interface DayPlan {
  code: string
  title: string | null
  created_at: string
  updated_at: string
  expires_at: string
  item_count: number
  items: DayPlanItem[]
}

async function callPlanRpc(fn: string, args: Record<string, unknown>): Promise<DayPlan | null> {
  const { data, error } = await untypedSupabase.rpc(fn, args)
  if (error) throw error
  return (data as DayPlan | null) ?? null
}

/**
 * Creates the plan and every starting item in one round trip, returning the
 * new code. `planId` is CLIENT-GENERATED (crypto.randomUUID()) so a retry
 * after a timed-out request is idempotent (052's create_day_plan detects the
 * same id and returns the already-allocated code instead of erroring).
 */
export async function createDayPlan(
  planId: string,
  title: string | null,
  eventIds: string[],
): Promise<string> {
  const { data, error } = await untypedSupabase.rpc('create_day_plan', {
    p_plan_id: planId,
    p_title: title,
    p_event_ids: eventIds,
  })
  if (error) throw error
  return data as string
}

/** Returns null for an unknown code — not an error, not an empty object. */
export function getDayPlan(code: string): Promise<DayPlan | null> {
  return callPlanRpc('get_day_plan', { p_code: code })
}

export function addEventToPlan(code: string, eventId: string): Promise<DayPlan | null> {
  return callPlanRpc('day_plan_add_event', { p_code: code, p_event_id: eventId })
}

/** A "remove" is a server-side tombstone (removed_at), never a delete. */
export function removeEventFromPlan(code: string, eventId: string): Promise<DayPlan | null> {
  return callPlanRpc('day_plan_remove_event', { p_code: code, p_event_id: eventId })
}

export function setPlanTitle(code: string, title: string | null): Promise<DayPlan | null> {
  return callPlanRpc('day_plan_set_title', { p_code: code, p_title: title })
}
