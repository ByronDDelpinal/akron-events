-- 064_partner_metrics_upcoming.sql
--
-- DO NOT APPLY THIS MIGRATION. Byron applies migrations himself.
--
-- Supersedes 063's partner_event_metrics. Everything 063's header says about
-- WHY this is a function and not a view, about co-hosted events counting in
-- full for every host, and about the refusal having to be loud because the
-- honest empty state is quiet, still stands. Read 063 first; this file only
-- explains what changed.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- 063 listed an event only if it had measured traffic in the window or started
-- inside the window. Both branches look BACKWARD, so an event three weeks from
-- now with no views yet appeared nowhere at all. Measured 2026-08-24, that is
-- most of what a partner has: 62% of published events in a 30-day window have
-- no measured view, the median event that IS measured has 3 views, and both
-- live tenants have zero measured rows across every event they have ever run.
-- A partner opening this block saw an empty table and no sign that the events
-- they just added were even known to us.
--
-- So the function now answers two questions in one pass:
--
--   past    -- events that started inside [p_from, p_to], the measurement window
--   upcoming -- events starting from today through p_upcoming_days out
--
-- plus, as before, anything with measured traffic in the window whenever it
-- started. The UI renders them as two sections, upcoming first. Nothing is
-- hidden: an event with nothing measured still appears, carrying zeros.
--
-- ── THE THIRD BRANCH IS BOUNDED, LIKE THE OTHER TWO ─────────────────────────
--
-- 063 fixed an unbounded start_at branch that returned every future event an
-- org had ever scheduled (1,763 rows for a 30-day window). Do not reintroduce
-- that here. p_upcoming_days is capped at 400 and today's largest orgs measure,
-- for a 90-day window in both directions:
--
--   Akron-Summit County Public Library  1,279 upcoming + 1,220 past
--   Stow-Munroe Falls Public Library      250 upcoming +   107 past
--   the two live partner tenants            2 upcoming +     0 past
--
-- Nothing is truncated, on purpose: the UI totals the rows it is handed, so a
-- server-side row cap would silently shrink the headline figures. If a library
-- sized tenant ever signs up, move the totals into their own RPC FIRST and only
-- then cap the row list. A capped list with client-side totals is a wrong
-- number, and a wrong number is worse than a slow one on this surface.
--
-- ── THE WINDOW CAP MOVED 400 -> 1200 ────────────────────────────────────────
--
-- The UI now offers an all-time option, which asks for TRACKING_START
-- (2026-05-27) through yesterday. That range grows by a day every day and would
-- have crossed the old 400-day cap in mid-2027, surfacing as a load error long
-- after anybody remembered this line existed. 1200 days buys until 2029.
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────
--
-- Creates no policy and touches no table, so like 063 it takes no ACCESS
-- EXCLUSIVE on events and is safe to apply during the nightly scrape window.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
--
-- Apply this migration BEFORE deploying the frontend. The return type gained a
-- column and the argument list gained a defaulted one, so the old three-argument
-- signature is dropped here; PostgREST resolves a three-named-argument call to
-- this function through the default, and the extra column is ignored by the
-- deployed frontend, so the gap between migration and deploy degrades to "no
-- upcoming section" rather than to an error.

begin;

set local lock_timeout = '5s';

-- A returns-table change cannot go through create or replace, and the argument
-- list changed, so the 063 signature is dropped by name rather than shadowed.
-- Leaving both would make every call ambiguous.
drop function if exists partner_event_metrics(uuid, date, date);

create or replace function partner_event_metrics(
  p_org           uuid,
  p_from          date,
  p_to            date,
  p_upcoming_days int default 90
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
  outbound_source  bigint,
  is_upcoming      boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Eastern, never UTC. A UTC "today" rolls over at 8pm the previous Eastern
  -- evening, which would move an event from upcoming to past four hours early.
  v_today    date;
  v_today_ts timestamptz;
  v_up_ts    timestamptz;
begin
  -- p_org is a CLAIM, verified here. RAISE, never "return zero rows": zero rows
  -- is this feature's legitimate empty state, so a silent refusal would render
  -- as an honest-looking dashboard and nobody would ever find out.
  --
  -- The null check comes FIRST and is not folded into the gate below, because
  -- three-valued logic swallows it: `null = any(scope)` is NULL, not false, so
  -- `not (NULL or is_admin())` is NULL and `if NULL then` takes the ELSE
  -- branch. See feedback_null_arg_defeats_security_gate.
  if p_org is null then
    raise exception 'organization is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- partner_scope() is called, never re-derived. Its p.active filter is what
  -- keeps a suspended tenant suspended.
  if not (p_org = any (partner_scope()) or is_admin()) then
    raise exception 'not your organization'
      using errcode = 'insufficient_privilege';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid date window'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Wider than any plausible UI request, including all-time. This only stops a
  -- hand-rolled call from asking for a decade.
  if (p_to - p_from) > 1200 then
    raise exception 'date window too wide'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Explicitly null is not the same as omitted: the default only applies when
  -- the argument is absent, so a caller passing null must be refused rather
  -- than silently given an unbounded forward branch.
  if p_upcoming_days is null or p_upcoming_days < 0 or p_upcoming_days > 400 then
    raise exception 'invalid upcoming window'
      using errcode = 'invalid_parameter_value';
  end if;

  v_today    := (now() at time zone 'America/New_York')::date;
  v_today_ts := (v_today::timestamp at time zone 'America/New_York');
  v_up_ts    := ((v_today + p_upcoming_days)::timestamp at time zone 'America/New_York');

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
    -- page_paths for the same uuid on the same day.
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
  ),
  -- Short aliases here rather than the output column names. `page_views`,
  -- `title`, `status` and friends are also plpgsql variables inside a
  -- returns-table function, and an unqualified reference to one of them
  -- resolves to the variable. Qualified references are safe, but not reusing
  -- the names at all is safer.
  listed as (
    select s.id                             as ev,
           s.title                          as ti,
           s.start_at                       as st,
           s.status                         as sx,
           coalesce(a.page_views, 0)        as pv,
           coalesce(a.visitor_days, 0)      as vd,
           coalesce(a.outbound_clicks, 0)   as oc,
           coalesce(a.outbound_tickets, 0)  as ot,
           coalesce(a.outbound_source, 0)   as os,
           -- "has not happened yet", NOT "inside the forward window". The
           -- flag is deliberately unbounded above while the third branch below
           -- is bounded: an event 300 days out that people are ALREADY looking
           -- at arrives through the first branch, and calling it "already
           -- happened" to keep the flag inside 90 days would be a plain lie
           -- about time. The section copy carries the horizon instead, and
           -- says both halves of what it lists. Do not "fix" this by adding
           -- `and s.start_at < v_up_ts` here without also changing that copy.
           coalesce(s.start_at >= v_today_ts, false) as up
    from scoped_events s
    left join agg a on a.event_id = s.id
    -- Three bounded branches. Dangling event_ids (GA paths for events since
    -- merged or deleted, which 062 stores on purpose) match no scoped event and
    -- drop out at the join: they cannot be attributed to any org, which is one
    -- more reason every figure here is a floor.
    where a.event_id is not null
       or (s.start_at >= (p_from::timestamp at time zone 'America/New_York')
       and  s.start_at <  ((p_to + 1)::timestamp at time zone 'America/New_York'))
       or (s.start_at >= v_today_ts and s.start_at < v_up_ts)
  )
  select l.ev, l.ti, l.st, l.sx, l.pv, l.vd, l.oc, l.ot, l.os, l.up
  from listed l
  -- Upcoming first, soonest first, because a partner reads this page to find
  -- out how the thing they are about to run is doing. Past falls back to the
  -- busiest first. The client re-sorts each section independently; this order
  -- is what survives underneath a stable sort.
  order by (case when l.up then 0 else 1 end),
           (case when l.up then l.st end) asc nulls last,
           l.pv desc,
           l.st desc nulls last;
end;
$$;

comment on function partner_event_metrics(uuid, date, date, int) is
  'Per-event GA totals for ONE organization. Lists events measured inside '
  '[p_from, p_to], events that started inside it, and events starting from '
  'today through p_upcoming_days out, flagged by is_upcoming. p_org is a claim '
  'verified against partner_scope() or is_admin(); an unauthorized org raises '
  'insufficient_privilege rather than returning zero rows, because zero rows is '
  'a legitimate answer here. Grants nothing on the underlying metrics tables. '
  'Nothing is truncated: the caller totals these rows, so a row cap would '
  'silently shrink the headline. Every figure is a floor, not a count.';

-- Grants: the 061 section 6 shape. Supabase's default privileges grant EXECUTE
-- to anon and authenticated directly, so `from public` alone would leave anon
-- holding it. Name anon explicitly.
revoke all on function partner_event_metrics(uuid, date, date, int) from public, anon;
grant execute on function partner_event_metrics(uuid, date, date, int) to authenticated;

commit;
