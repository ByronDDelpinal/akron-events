-- 064_partner_metrics_upcoming_rollback.sql
--
-- Restores the 063 definition of partner_event_metrics: three arguments, nine
-- columns, no upcoming branch, 400-day window cap.
--
-- This restores the 400-day window cap along with everything else. The 064
-- frontend offers an all-time window that starts at TRACKING_START and grows a
-- day each day, so it crosses 400 days around 2027-07-01: after that date this
-- rollback turns the all-time button into a load error rather than a narrower
-- range. Raise the cap here too if you are ever rolling back that late.
--
-- Run this ONLY with a frontend that predates the 064 deploy. The 064 frontend
-- sends p_upcoming_days and reads is_upcoming, so against this definition it
-- gets a PGRST202 and renders its load-error state, which is the correct loud
-- failure but is not a place to leave production sitting.

begin;

set local lock_timeout = '5s';

drop function if exists partner_event_metrics(uuid, date, date, int);

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

  if (p_to - p_from) > 400 then
    raise exception 'date window too wide'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with scoped_events as (
    select e.id, e.title, e.start_at, e.status
    from events e
    join event_organizations eo on eo.event_id = e.id
    where eo.organization_id = p_org
  ),
  agg as (
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
  select s.id, s.title, s.start_at, s.status,
         coalesce(a.page_views, 0),
         coalesce(a.visitor_days, 0),
         coalesce(a.outbound_clicks, 0),
         coalesce(a.outbound_tickets, 0),
         coalesce(a.outbound_source, 0)
  from scoped_events s
  left join agg a on a.event_id = s.id
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

revoke all on function partner_event_metrics(uuid, date, date) from public, anon;
grant execute on function partner_event_metrics(uuid, date, date) to authenticated;

commit;
