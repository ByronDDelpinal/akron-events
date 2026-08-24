-- 063_partner_metrics_rpc.sql
--
-- DO NOT APPLY THIS MIGRATION. Byron applies migrations himself.
--
-- Partner-facing analytics: one read RPC over the metrics tables 062 created,
-- and nothing else.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────
--
-- 062's ACCESS section says a partner-facing surface over these tables gets
-- "its own narrow VIEW with its own grant, not a blanket grant on these
-- tables." This is that surface, built as a function rather than a view. It
-- adds NO grant and NO policy on site_metrics_daily, page_metrics_daily or
-- embed_metrics_daily. After this migration a partner still gets zero rows
-- from a direct `select * from page_metrics_daily`, and
-- supabase/tests/org_analytics_rls.test.sql asserts exactly that.
--
-- ── WHY A FUNCTION AND NOT A VIEW ───────────────────────────────────────────
--
-- 1. A view cannot express the admin-passes-an-org-id half. An RLS predicate
--    is evaluated per row against the caller, so letting an admin scope to ONE
--    org means exposing organization_id with a predicate that is true for
--    every org when is_admin(), and letting the client filter with .eq(). That
--    puts scope selection in the client on a surface that also serves
--    partners. Here p_org is a claim the server verifies, which is the idiom
--    061 already uses in all six write RPCs.
-- 2. Either kind of view reopens what 062 closed. security_invoker = true
--    needs `grant select on page_metrics_daily to authenticated`, which 062
--    forbids in writing. security_invoker = false is a security definer by
--    another name with nowhere to put argument validation.
-- 3. Zero rows is an ambiguous refusal HERE, and that is the decisive one. A
--    partner with no measured traffic legitimately gets zero rows, so a view
--    that returned zero rows to a partner asking for someone else's org would
--    be indistinguishable from the truth. A function can raise. The refusal
--    has to be loud precisely because the honest empty state is quiet.
--
-- ── CO-HOSTED EVENTS COUNT IN FULL FOR EVERY HOST, ON PURPOSE ───────────────
--
-- 13 events currently carry two organizations. A click on one of them counts
-- in full for both. That is correct and it is not a double-count bug: 061's
-- read model is any-of (if you co-host it, you can see it), a view of a
-- co-hosted event genuinely is a view of both orgs' event, and splitting a
-- click in half would invent a number GA never measured. The consequence is
-- that two partners' dashboards do not sum to a site total, which is why
-- nothing in this feature rolls up across orgs. Do not "fix" this later.
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────
--
-- This migration creates no policy and touches no table, so unlike 059 and 061
-- it takes no ACCESS EXCLUSIVE on events and is safe to apply during the
-- nightly scrape window. Do not copy 059/061's scheduling constraint here.

begin;

set local lock_timeout = '5s';

-- ── partner_event_metrics(p_org, p_from, p_to) ──────────────────────────────
--
-- Per-event totals for one organization over a date window, aggregated from
-- page_metrics_daily. Returns one row per event: everything measured in the
-- window, plus everything starting on or after p_from so an event with no
-- measured traffic still appears. That LEFT JOIN is deliberate. "We have no
-- events" and "we have events and nobody has been counted looking at them"
-- are different facts and the UI renders them differently.
create or replace function partner_event_metrics(
  p_org  uuid,
  p_from date,
  p_to   date
)
returns table (
  event_id         uuid,
  title            text,
  start_at         timestamptz,
  status           text,
  page_views       bigint,
  visitor_days     bigint,
  outbound_clicks  bigint,
  outbound_tickets bigint,
  outbound_source  bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- p_org is a CLAIM, verified here, in the only place it can be. RAISE,
  -- never "return zero rows": zero rows is this feature's legitimate empty
  -- state, so a silent refusal would render as an honest-looking dashboard
  -- and nobody would ever find out.
  --
  -- partner_scope() is called, never re-derived by hand. Its `p.active` filter
  -- is load-bearing, and a hand-rolled join through partner_memberships would
  -- drop it silently and un-suspend a suspended tenant's analytics.
  --
  -- The null check comes FIRST and is not folded into the gate below, because
  -- three-valued logic would swallow it: `null = any(scope)` is NULL, not
  -- false, so `not (NULL or is_admin())` is NULL for any caller with a
  -- non-empty scope, and `if NULL then` takes the ELSE branch. The raise would
  -- not fire, the org filter would match nothing, and the caller would get
  -- zero rows: precisely the silent refusal this function exists to avoid.
  if p_org is null then
    raise exception 'organization is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if not (p_org = any (partner_scope()) or is_admin()) then
    raise exception 'not your organization'
      using errcode = 'insufficient_privilege';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid date window'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A window wider than any plausible UI request. The UI offers 7, 30 and 90
  -- days; this only stops a hand-rolled call from asking for a decade.
  if (p_to - p_from) > 400 then
    raise exception 'date window too wide'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with scoped_events as (
    -- event_organizations' primary key is (event_id, organization_id) and this
    -- filters to ONE org, so an event appears at most once and no DISTINCT is
    -- needed. This is where co-host fan-out would happen if the filter were
    -- ever widened to an array of orgs. Do not widen it.
    select e.id, e.title, e.start_at, e.status
    from events e
    join event_organizations eo on eo.event_id = e.id
    where eo.organization_id = p_org
  ),
  agg as (
    -- GROUP BY event_id is load-bearing, not tidiness. Renaming an event
    -- changes the date-suffixed display slug in its URL, so GA reports two
    -- different page_paths for the same uuid on the same day; production
    -- currently has 97 such (date, event_id) pairs. One row per event-day is
    -- an assumption the data already violates.
    select p.event_id,
           sum(p.page_views)::bigint       as page_views,
           sum(p.users)::bigint            as visitor_days,
           sum(p.outbound_clicks)::bigint  as outbound_clicks,
           sum(p.outbound_tickets)::bigint as outbound_tickets,
           sum(p.outbound_source)::bigint  as outbound_source
    from page_metrics_daily p
    where p.event_id is not null
      and p.metric_date between p_from and p_to
      and p.event_id in (select id from scoped_events)
    group by p.event_id
  )
  -- Dangling event_ids (GA paths for events since merged or deleted, which 062
  -- stores on purpose) match no scoped event and drop out here. They cannot be
  -- attributed to any org because the events row is gone, so they are one more
  -- reason every figure on this surface is a floor. Do not try to recover them
  -- through event_aliases.
  select s.id, s.title, s.start_at, s.status,
         coalesce(a.page_views, 0),
         coalesce(a.visitor_days, 0),
         coalesce(a.outbound_clicks, 0),
         coalesce(a.outbound_tickets, 0),
         coalesce(a.outbound_source, 0)
  from scoped_events s
  left join agg a on a.event_id = s.id
  -- Both sides of this OR are bounded. The start_at branch used to have no
  -- upper bound, which quietly returned every future event the org had ever
  -- scheduled no matter what window was asked for: measured against the
  -- largest org in prod that was 1,763 rows for a 30-day window, 95% of them
  -- zero-filled. The window buttons looked like they scoped the table and did
  -- not.
  --
  -- The bounds are Eastern, not UTC. A bare p_from::timestamptz resolves at
  -- UTC midnight, which is 8pm the PREVIOUS Eastern evening, so the window
  -- would quietly pull in the night before it claims to start.
  where a.event_id is not null
     or (s.start_at >= (p_from::timestamp at time zone 'America/New_York')
     and s.start_at <  ((p_to + 1)::timestamp at time zone 'America/New_York'))
  order by coalesce(a.outbound_clicks, 0) desc,
           coalesce(a.page_views, 0)      desc,
           s.start_at desc;
end;
$$;

comment on function partner_event_metrics(uuid, date, date) is
  'Per-event GA totals for ONE organization over a date window. p_org is a '
  'claim verified against partner_scope() or is_admin(); an unauthorized org '
  'raises insufficient_privilege rather than returning zero rows, because '
  'zero rows is a legitimate answer here. Grants nothing on the underlying '
  'metrics tables. Every figure it returns is a floor, not a count: GA is '
  'blocked for a meaningful share of visitors, and any UI must say so.';

-- Grants: the 061 section 6 shape. Supabase's default privileges grant EXECUTE
-- to anon and authenticated directly, so `from public` alone would leave anon
-- holding it. Name anon explicitly.
revoke all on function partner_event_metrics(uuid, date, date) from public, anon;
grant execute on function partner_event_metrics(uuid, date, date) to authenticated;

commit;
