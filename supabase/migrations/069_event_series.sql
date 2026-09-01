-- ════════════════════════════════════════════════════════════════════════════
-- 069_event_series.sql
--
-- RECURRING EVENTS, SLICE 1 (ADR-069): the event_series table and the
-- events.series_id back-reference. Nothing here expands a series; the
-- expansion engine is src/lib/recurrence.js and the nightly extender lands
-- in a later slice. This migration only gives the occurrences a parent row.
--
-- WHAT A SERIES IS. One event_series row holds the RRULE plus the calendar
-- date and wall-clock time of the first occurrence. Occurrences are ORDINARY
-- events rows with series_id set and source_id = 'series:<id>:<YYYY-MM-DD>',
-- so every existing surface (public read, admin review, partner scope,
-- moderation, opt-outs, digests) sees them as the events they are. There is
-- no template column on purpose: the newest non-cancelled occurrence IS the
-- template for extension, so an admin edit to the latest occurrence carries
-- forward without a second copy of every field to keep in sync.
--
-- WHY DATE + TIME, NOT A TIMESTAMPTZ. A series that spans a DST change must
-- keep its wall-clock time. Storing one instant and adding 7 days would
-- drift by an hour twice a year, so the instant is minted per occurrence
-- from (dtstart_date + n steps, start_time) in America/New_York. The tz
-- column is pinned to that one zone by CHECK: this site is Summit County
-- only, and a free-text tz would be a source of subtle wrong instants.
--
-- ACCESS (mirrors events, by design):
--   * anon / authenticated INSERT of source='manual', non-cancelled rows: the
--     submit form (042 + 054 shape). No anon SELECT policy, so INSERT ...
--     RETURNING is refused exactly as it is on events; the form mints the
--     uuid client-side and inserts without RETURNING.
--   * Admin: is_admin() (059), never bare `authenticated` (062's trap).
--   * Partner: SELECT a series when any of its occurrences is in
--     partner_scope() (061). Writes stay RPC-only per 061: there is NO
--     partner INSERT / UPDATE / DELETE policy on this table, ever.
--   * Public: nothing. The site reads occurrences, and events.series_id is
--     visible through the published-only events policy, which is enough for
--     the "recurring" badge and the "next occurrence" query.
--
-- PREREQUISITES: is_admin() from 059 and partner_scope() from 061 must be
-- live (both are referenced by the policies below and `create policy` fails
-- if either is missing). set_updated_at() is from 001.
--
-- ── DEPLOY NOTES ────────────────────────────────────────────────────────────
--   * DO NOT APPLY unattended. Byron applies migrations himself via
--     `supabase db push`; do not run this against prod from an agent.
--   * Do NOT apply during the nightly scrape window. `alter table events add
--     column` and `create policy` take ACCESS EXCLUSIVE on events, and the
--     nightly run holds row locks on it; avoid 01:30-04:00 UTC (059/061 rule).
--   * lock_timeout is set to 5s inside the transaction so this fails fast
--     rather than queueing behind a scrape upsert and stalling the site.
--   * Rollback lives in supabase/rollbacks/069_event_series_rollback.sql.
--     Rollback scripts NEVER live in supabase/migrations/ (`supabase db push`
--     would apply them as migrations and undo the change; the 059 incident).
--   * The ledger `version` MUST match this file's `069` prefix.
--   * TYPES: src/lib/database.types.ts was hand-edited alongside this file
--     (event_series block, events.series_id, the FK relationship). After
--     apply, `npm run types:gen` must produce an identical file; any diff
--     means the hand edit and the schema disagree and the generated output
--     wins.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Fail fast instead of stalling the site behind a scrape writer (059's rule).
set local lock_timeout = '5s';

-- ── 1. event_series ─────────────────────────────────────────────────────────
create table event_series (
  id            uuid primary key default gen_random_uuid(),
  -- RFC 5545 RRULE value (no "RRULE:" prefix). Organizer subset only; the
  -- shape check below is a guard, the semantic validator is
  -- validateOrganizerRule in src/lib/recurrence.js.
  rrule         text not null
                check (char_length(rrule) <= 200
                       and rrule ~ '^FREQ=(WEEKLY|MONTHLY)(;[A-Z]+=[A-Z0-9,+-]+)*$'),
  -- First occurrence, as an America/New_York calendar date and wall-clock
  -- time. Instants are minted per occurrence (DST-correct), never stored here.
  dtstart_date  date not null,
  start_time    time not null,
  duration_min  integer check (duration_min is null or duration_min between 1 and 1440),
  tz            text not null default 'America/New_York'
                check (tz = 'America/New_York'),
  -- Cancelled single dates. Re-expansion must never re-mint these.
  exdates       date[] not null default '{}',
  -- Whole-series cancel. Extension stops; rows are cancelled by the caller.
  cancelled_at  timestamptz,
  -- Provenance: same values the occurrences carry, so RLS can mirror events.
  source        text not null default 'manual',
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_event_series_updated_at
  before update on event_series
  for each row execute function set_updated_at();

comment on table event_series is
  'One row per recurring series. Occurrences are ordinary events rows with '
  'series_id set and source_id = ''series:<id>:<YYYY-MM-DD>''. The newest '
  'non-cancelled occurrence is the template for extension; there is no '
  'template column on purpose (ADR-069).';

-- ── 2. events.series_id ─────────────────────────────────────────────────────
-- SET NULL, not CASCADE: deleting a series must never delete the events the
-- public has already seen. Orphaned occurrences stay identifiable by their
-- 'series:' source_id prefix.
alter table events
  add column series_id uuid references event_series(id) on delete set null;

-- Partial: the overwhelming majority of events rows are scraped one-offs
-- with no series, and every series query starts from series_id.
create index idx_events_series_id on events (series_id) where series_id is not null;
-- The extender's scan is "every series that is still running".
create index idx_event_series_active on event_series (cancelled_at) where cancelled_at is null;

-- ── 3. RLS and grants ───────────────────────────────────────────────────────
alter table event_series enable row level security;

-- PostgREST needs the GRANT as well as the policy (062). Explicit rather than
-- inherited from default privileges: anon gets INSERT only (no SELECT grant,
-- so RETURNING is refused at the grant layer as well as the policy layer),
-- authenticated gets the four verbs the admin policy narrows.
revoke all on event_series from anon, authenticated;
grant insert on event_series to anon;
grant select, insert, update, delete on event_series to authenticated;

-- Public: nothing. Occurrences are what the site reads; events.series_id is
-- readable through the published-only events policy and is enough for the
-- badge and the "next occurrence" query.

-- Submit form: mirrors 042 + 054. anon must be able to INSERT and must NOT be
-- able to read it back (INSERT ... RETURNING is refused, same as events; the
-- form mints the uuid client-side). created_by is either unset or the
-- caller's own auth.uid(): a submitter cannot stamp someone else's identity
-- onto a series.
create policy "Anon can insert manual series"
  on event_series for insert to anon, authenticated
  with check (
    source = 'manual'
    and cancelled_at is null
    and (created_by is null or created_by = auth.uid())
  );

-- Admin: is_admin() (059), never bare `authenticated`.
create policy "Admin full access event_series"
  on event_series for all to authenticated
  using (is_admin()) with check (is_admin());

-- Partner: read a series if any of its occurrences is in scope (061).
-- Writes stay RPC-only (061 rule: no partner INSERT/UPDATE/DELETE policy).
create policy "Partner reads own org series"
  on event_series for select to authenticated
  using (exists (
    select 1 from events e
    join event_organizations eo on eo.event_id = e.id
    where e.series_id = event_series.id
      and eo.organization_id = any (partner_scope())
  ));

commit;
