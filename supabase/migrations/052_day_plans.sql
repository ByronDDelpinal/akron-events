-- ════════════════════════════════════════════════════════════════════════════
-- 052_day_plans.sql
--
-- Backs the collaborative day planner: /day (local draft) and /d/<code>
-- (shared, DB-backed). No accounts exist on this site and none are planned,
-- so possession of the 60-bit code IS the authorization. Anyone with the link
-- can edit. That is a deliberate product decision (maintainer, 2026-08-08),
-- taken with the leaked-link risk understood and accepted.
--
-- ACCESS MODEL — READ THIS BEFORE ADDING A POLICY.
-- Both tables have RLS enabled and ZERO policies for anon and ZERO for
-- authenticated-write. Anon reaches them ONLY through the SECURITY DEFINER
-- functions at the bottom of this file, every one of which takes the plan
-- code (or, for create, a fresh id) as an argument.
--
-- The alternative -- a normal anon SELECT policy -- cannot work here. A
-- policy's USING clause cannot see the client's WHERE clause, so the only
-- expressible policy is `using (true)`, which lets any holder of the anon key
-- do `select * from day_plans` and walk every plan on the site. The code would
-- stop being a secret the moment the table existed. Function-gated access is
-- not defensive decoration; it is the only shape that makes the code mean
-- anything.
--
-- ADDING `create policy ... on day_plans for select to anon using (true)`
-- HERE WOULD TURN THIS FEATURE INTO A PUBLIC DUMP OF EVERY PLAN ON THE SITE,
-- INCLUDING WHATEVER FREE TEXT PEOPLE PUT IN TITLES. Read the paragraph
-- above again before you do it. `day_plan_rls.test.sql` §1 fails loudly if
-- this ever happens -- treat that test as production code.
--
-- Anon has NO DELETE anywhere in this migration. A "remove" is an UPDATE that
-- sets removed_at. The only hard delete is purge_expired_day_plans(), which
-- anon cannot execute. This is what makes a malicious wipe recoverable with
-- one UPDATE statement. Recovery recipe (restated here because docs/ is
-- gitignored project-wide and will not exist at 11pm when this is needed):
--
--   -- Undo a wipe: restore every item removed from this plan in the last hour.
--   update day_plan_items
--      set removed_at = null
--    where plan_id = (select id from day_plans where code = '<the code>')
--      and removed_at > now() - interval '1 hour';
--
-- D7 (migration number): 052. 047 is reserved by the unlanded
-- agents/digest-delivery-truth branch -- do not reuse it.
-- D3 (30-item cap), D4 (pg_cron reaper scheduled inside this migration),
-- D9 (assume 2h DTEND client-side when end_at is null, disclosed in
-- DESCRIPTION -- see src/lib/ics.js) are all implemented per the design.
-- D6 (get_day_plan is SECURITY DEFINER and narrowly returns
-- cancelled/unpublished rows already saved in that plan) is APPROVED by the
-- maintainer 2026-08-08 -- see get_day_plan's own comment below.
-- D10 (no visitor-facing plan delete, ever) -- there is no DELETE grant
-- anywhere in this file, on purpose. Do not add one later without
-- revisiting the whole leaked-link threat model.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- gen_random_bytes (used by gen_day_plan_code below) is pgcrypto.
-- gen_random_uuid() used throughout this schema is Postgres-core since v13
-- and does NOT itself prove pgcrypto is installed, so this is created
-- defensively rather than assumed. Idempotent -- a no-op if already present.
--
-- CRITICAL, learned the hard way on 2026-08-08: on Supabase this statement is
-- a NO-OP, because pgcrypto is preinstalled into the `extensions` schema, not
-- `public`. Every function below pins `set search_path = public`, so an
-- unqualified gen_random_bytes() resolves to nothing and create_day_plan
-- fails at runtime with "function gen_random_bytes(integer) does not exist" --
-- i.e. the feature is completely broken while the migration still applies
-- cleanly. gen_day_plan_code therefore sets `search_path = public, extensions`.
-- Do not "simplify" it back to `public`.
create extension if not exists pgcrypto;

-- ── 1. Plans ────────────────────────────────────────────────────────────────
--
-- `id` is CLIENT-GENERATED (crypto.randomUUID()), matching 051. Here it buys
-- idempotency rather than readback: a create that times out client-side can be
-- retried with the same id and will conflict rather than create a second plan
-- -- create_day_plan() detects this and returns the already-allocated code
-- instead of erroring (see that function below).
--
-- `code` is the bearer secret and is generated SERVER-SIDE inside
-- create_day_plan() (section 6). It is deliberately NOT the primary key: it is
-- a credential, and keeping it out of every foreign key means it never appears
-- in a join, a constraint name, or a FK-violation error message.
create table day_plans (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique
                   check (code ~ '^[0-9a-hjkmnp-tv-z]{12}$'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Free text, shown as the plan heading and as X-WR-CALNAME in the .ics.
  -- Screened by the 030 moderation trigger (attached in section 4 below) --
  -- an open-edit shared page is a graffiti surface and must not be exempt.
  title          text check (title is null or char_length(title) between 1 and 80),

  -- Maintained by trg_day_plan_rollup. Drives the reaper's index scan.
  -- Floor is created_at + 7 days so an empty plan still expires.
  expires_at     timestamptz not null default (now() + interval '7 days'),

  -- Maintained by trg_day_plan_rollup. The CHECK is the real size cap: it
  -- binds service-role writes too, not just the RPC's own guard (D3).
  item_count     int not null default 0 check (item_count between 0 and 30),

  -- Per-plan velocity window (section 3.4 of the design; see
  -- day_plan_mutation_gate below). Two scalar columns instead of a ledger
  -- table: no extra rows, no extra index, no extra purge path.
  mut_window_at  timestamptz not null default now(),
  mut_count      int not null default 0
);

comment on table day_plans is
  'Shareable day plans. `code` is a 60-bit bearer secret; possession of it is '
  'the only authorization. Reachable by anon ONLY via the SECURITY DEFINER '
  'functions in this migration -- there are deliberately no anon RLS policies. '
  'Adding one turns this table into a public dump of every plan on the site.';

create index day_plans_expires_at_idx on day_plans (expires_at);

-- ── 2. Items ────────────────────────────────────────────────────────────────
--
-- NO FOREIGN KEY ON event_id. THIS IS DELIBERATE AND LOAD-BEARING.
--
-- The cross-source dedupe pipeline (scripts/dedupe-cross-source.js) DELETES a
-- duplicate event row and records the merge in event_aliases keyed on
-- (duplicate_source, duplicate_source_id) -- NOT on the deleted row's UUID
-- (see buildAliasRow in that script, and _resolveAliasCanonical in
-- scripts/lib/normalize.js). So a saved event_id can and will stop resolving.
--
--   * `references events(id) on delete cascade` would make the item silently
--     vanish -- exactly the "a plan that quietly loses an event" failure the
--     product decision forbids.
--   * `on delete restrict` would make a live day plan block the nightly
--     dedupe run. Unacceptable.
--
-- Instead the item carries a SNAPSHOT taken at add time. The snapshot does
-- three jobs: it renders a struck-through row when the event is gone, it lets
-- the reaper compute expiry without joining events, and -- via snap_source /
-- snap_source_id -- it is the ONLY key that can resolve the merge through
-- event_aliases (see get_day_plan below). Dropping those two columns silently
-- breaks alias resolution. THEY LOOK LIKE DECORATIVE DENORMALIZATION AND ARE
-- NOT -- do not "clean them up".
create table day_plan_items (
  plan_id        uuid not null references day_plans(id) on delete cascade,
  event_id       uuid not null,
  primary key (plan_id, event_id),

  added_at       timestamptz not null default now(),
  -- Tombstone. NULL = live. A "remove" sets this; a re-add clears it and
  -- preserves the original added_at (see day_plan_insert_item's ON CONFLICT).
  removed_at     timestamptz,

  -- Add-time snapshot. Written by day_plan_insert_item() from the live row.
  snap_title     text not null check (char_length(snap_title) between 1 and 300),
  snap_start_at  timestamptz not null,
  snap_end_at    timestamptz,
  snap_venue     text check (snap_venue is null or char_length(snap_venue) <= 200),
  -- snap_source / snap_source_id: NOT decorative. event_aliases is keyed on
  -- (duplicate_source, duplicate_source_id), never on a UUID, and the
  -- duplicate event row is hard-deleted on merge. These two columns are the
  -- ONLY surviving key that can run the same alias lookup ingest itself runs
  -- (_resolveAliasCanonical in scripts/lib/normalize.js:2006). Drop them and
  -- a merged event becomes permanently unresolvable ("gone") instead of
  -- correctly rendering as "merged".
  snap_source    text check (snap_source is null or char_length(snap_source) <= 80),
  snap_source_id text check (snap_source_id is null or char_length(snap_source_id) <= 400)
);

comment on column day_plan_items.event_id is
  'Intentionally NOT a foreign key: cross-source dedupe deletes duplicate '
  'event rows (cascade would silently vanish the item; restrict would block '
  'the nightly dedupe run). Resolution order at render (get_day_plan) is '
  '(1) events.id, (2) event_aliases on (snap_source, snap_source_id), '
  '(3) the snapshot columns on this row.';

create index day_plan_items_live_idx
  on day_plan_items (plan_id, snap_start_at) where removed_at is null;

-- ── 3. Rollup trigger: item_count + expires_at ──────────────────────────────
--
-- expires_at = (latest live item's end) + 7 days, floored at created_at + 7d.
-- "End" falls back to start + 4h when snap_end_at is null -- generous on
-- purpose, because deleting a plan a visitor still wants is unrecoverable and
-- keeping one an extra few hours costs nothing.
--
-- Computed from the SNAPSHOT, so a rescheduled event does not move expiry
-- here. purge_expired_day_plans() re-checks against LIVE event rows before
-- deleting anything, which covers the reschedule-later case (section 5).
create or replace function day_plan_rollup()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  p uuid := coalesce(NEW.plan_id, OLD.plan_id);
begin
  update day_plans d
     set item_count = (
           select count(*) from day_plan_items i
            where i.plan_id = p and i.removed_at is null),
         expires_at = greatest(
           d.created_at + interval '7 days',
           coalesce((
             select max(coalesce(i.snap_end_at, i.snap_start_at + interval '4 hours'))
               from day_plan_items i
              where i.plan_id = p and i.removed_at is null
           ), d.created_at) + interval '7 days'),
         updated_at = now()
   where d.id = p;
  return null;
end; $$;

drop trigger if exists trg_day_plan_rollup on day_plan_items;
create trigger trg_day_plan_rollup
  after insert or update or delete on day_plan_items
  for each row execute function day_plan_rollup();

-- ── 4. Moderation on the plan title ─────────────────────────────────────────
-- Reuses the 030 screener. An open-edit page that renders free text to
-- everyone with the link is exactly the surface that trigger exists for.
-- (See 030_content_moderation.sql for moderation_severity / the anon gate.)
create or replace function moderation_screen_day_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  if NEW.title is not null and moderation_severity(NEW.title) is not null then
    NEW.title := null;   -- drop the title, keep the plan; never lose the items
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_day_plan_moderation on day_plans;
create trigger trg_day_plan_moderation
  before insert or update of title on day_plans
  for each row execute function moderation_screen_day_plan();

-- ── 5. RLS: enabled, and deliberately empty ─────────────────────────────────
alter table day_plans      enable row level security;
alter table day_plan_items enable row level security;

-- NO anon policies of any kind. NO authenticated write policies. Access is
-- exclusively through the functions below (and service_role, which bypasses
-- RLS). Adding a policy here re-opens enumeration -- see this file's header.

-- Admin read-only, matching the boundary set by 051 for embed_requests and by
-- 038 for subscribers/email_sends. This is the maintainer's forensics and
-- recovery path.
create policy "Authenticated can read day_plans"
  on day_plans for select to authenticated using (true);
create policy "Authenticated can read day_plan_items"
  on day_plan_items for select to authenticated using (true);

-- ── 6. Short-code generation ─────────────────────────────────────────────────
--
-- Crockford base32, lowercase, minus i/l/o/u (D2). 12 chars = 60 bits.
-- get_byte gives 0..255; 256 is an exact multiple of 32, so `% 32` introduces
-- NO modulo bias -- worth the comment, because the instinct is to assume one.
-- search_path includes `extensions` ON PURPOSE: pgcrypto's gen_random_bytes
-- lives there on Supabase, not in public. See the header note by the
-- `create extension` statement above -- with `public` alone this function
-- raises at runtime and no plan can ever be created.
create or replace function gen_day_plan_code()
returns text language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  out text := '';
  b bytea := gen_random_bytes(12);
  i int;
begin
  for i in 0 .. 11 loop
    out := out || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return out;
end; $$;

revoke all on function gen_day_plan_code() from public, anon, authenticated;

-- ── 7. Per-plan mutation velocity gate (§3.4) ───────────────────────────────
--
-- 120 mutations / 10 minutes per plan, via mut_window_at + mut_count on the
-- plan row -- the anti-wipe throttle. A human clearing a 30-item plan uses 30
-- mutations; a script trying to churn a plan into uselessness hits the wall.
-- `for update` locks the plan row for the duration of the caller's
-- transaction so two concurrent mutations on the same plan serialize instead
-- of both reading a stale count.
create or replace function day_plan_mutation_gate(p_plan_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_window_at timestamptz;
  v_count     int;
begin
  select mut_window_at, mut_count into v_window_at, v_count
    from day_plans where id = p_plan_id for update;

  if v_window_at is null or v_window_at < now() - interval '10 minutes' then
    update day_plans set mut_window_at = now(), mut_count = 1 where id = p_plan_id;
    return;
  end if;

  if v_count >= 120 then
    raise exception 'this plan has hit its mutation rate limit; try again shortly'
      using errcode = 'check_violation';
  end if;

  update day_plans set mut_count = mut_count + 1 where id = p_plan_id;
end; $$;

revoke all on function day_plan_mutation_gate(uuid) from public, anon, authenticated;

-- ── 8. Shared item-insert helper (used by create_day_plan + day_plan_add_event) ─
--
-- Add-time gate: an event must exist AND be status='published' right now, or
-- this raises (§3.3 -- "cannot add an event that does not exist, or one that
-- is not published at add time"). Once added, a LATER transition away from
-- published is shown via rot_status, never silently hidden (§4.3) -- the gate
-- is on the add, not the render.
--
-- ON CONFLICT preserves added_at (a re-add after a remove keeps the original
-- add time -- test case 9 in day_plan_rls.test.sql) and refreshes the
-- snapshot columns from the current live row.
--
-- Not granted to anon/authenticated: only reachable through the two
-- SECURITY DEFINER callers below, which run as this function's owner.
create or replace function day_plan_insert_item(p_plan_id uuid, p_event_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  ev record;
begin
  -- SCHEMA NOTE: `events` has NO venue_id column. Venues attach through the
  -- `event_venues` junction. The lateral+limit-1 shape (rather than a plain
  -- join) keeps this single-row even if an event is ever linked to more than
  -- one venue, which the junction permits.
  select e.title, e.start_at, e.end_at, e.source, e.source_id, v.name as venue_name
    into ev
    from events e
    left join lateral (
      select vv.name
        from event_venues ev2
        join venues vv on vv.id = ev2.venue_id
       where ev2.event_id = e.id
       limit 1
    ) v on true
   where e.id = p_event_id and e.status = 'published';

  if not found then
    raise exception 'event % is not available to add to a plan (not found or not published)', p_event_id
      using errcode = 'check_violation';
  end if;

  insert into day_plan_items (
    plan_id, event_id, snap_title, snap_start_at, snap_end_at, snap_venue, snap_source, snap_source_id
  ) values (
    p_plan_id, p_event_id, ev.title, ev.start_at, ev.end_at, ev.venue_name, ev.source, ev.source_id
  )
  on conflict (plan_id, event_id) do update
    set removed_at     = null,
        snap_title     = excluded.snap_title,
        snap_start_at  = excluded.snap_start_at,
        snap_end_at    = excluded.snap_end_at,
        snap_venue     = excluded.snap_venue,
        snap_source    = excluded.snap_source,
        snap_source_id = excluded.snap_source_id;
        -- added_at is deliberately NOT in the SET list -- a re-add preserves it.
end; $$;

revoke all on function day_plan_insert_item(uuid, uuid) from public, anon, authenticated;

-- ── 9. create_day_plan ───────────────────────────────────────────────────────
--
-- One transaction, one round trip: inserts the plan and every starting item,
-- and returns the code. A single failing item (not found / not published, or
-- the 31st item) aborts the WHOLE function -- there is no partial plan,
-- because a PL/pgSQL function body is one implicit transaction.
--
-- Idempotent on p_plan_id: a client that timed out and retries with the same
-- client-generated id gets the already-allocated code back with no second
-- attempt to insert items (see day_plans.id's comment above).
create or replace function create_day_plan(
  p_plan_id   uuid,
  p_title     text,
  p_event_ids uuid[]
)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_code     text;
  v_attempt  int := 0;
  v_count    int;
  v_event_id uuid;
begin
  select code into v_code from day_plans where id = p_plan_id;
  if v_code is not null then
    return v_code;
  end if;

  if p_event_ids is not null and array_length(p_event_ids, 1) > 30 then
    raise exception 'a day plan may hold at most 30 items' using errcode = 'check_violation';
  end if;

  -- Global creation cap (§3.4): 60 plans/hour, site-wide, counted by this
  -- function -- direct copy of 051's embed_request_rate_limit shape.
  select count(*) into v_count from day_plans where created_at > now() - interval '1 hour';
  if v_count >= 60 then
    raise exception 'day plan creation rate limit exceeded' using errcode = 'check_violation';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := gen_day_plan_code();
    begin
      insert into day_plans (id, code, title) values (p_plan_id, v_code, nullif(trim(p_title), ''));
      exit;
    exception when unique_violation then
      -- At 60 bits, reaching attempt two is a once-in-the-project-lifetime
      -- event (§2.3); the loop exists so that if it ever happens it is a
      -- retry, not a 500.
      if v_attempt >= 5 then
        raise exception 'could not allocate a unique day plan code';
      end if;
    end;
  end loop;

  if p_event_ids is not null then
    foreach v_event_id in array p_event_ids loop
      perform day_plan_insert_item(p_plan_id, v_event_id);
    end loop;
  end if;

  return v_code;
end; $$;

-- ── 10. get_day_plan — the read path, and the only place event rot resolves ──
--
-- D6 (APPROVED by the maintainer 2026-08-08): SECURITY DEFINER, so it
-- bypasses the anon `events` policy (status = 'published', 001/038) and CAN
-- return a cancelled or unpublished row. This is a deliberate, NARROW
-- widening:
--   * only rows whose id is already a day_plan_items row of the plan whose
--     code was supplied -- there is no way to ask for an arbitrary event;
--   * only a fixed 12-column subset (id, title, start_at, end_at, status,
--     event_status, description, ticket_url, source_url, price_min,
--     price_max, category_slugs) plus venue name/address/city/state/zip/
--     lat/lng -- never manual_overrides, needs_review, source_id, or any
--     *_normalized column;
--   * description is truncated to 500 chars (only needed for the .ics
--     DESCRIPTION line; an unpublished draft's full body has no business in
--     the response).
-- Without this, a cancelled event in a plan is INDISTINGUISHABLE from a
-- deleted one to anon through PostgREST -- the client gets nothing back
-- either way -- which renders every rot case as the most severe one. This is
-- materially narrower than 031_anon_read_all_events (which 038 revoked for
-- good reason): that was `for select to anon using (true)` over every column
-- of every row.
--
-- Resolution order per live item (removed_at is null; tombstoned items are
-- never returned here -- they exist only for the maintainer's recovery
-- query):
--   1. events.id = item.event_id, found -> 'ok' | 'moved' | 'cancelled'.
--   2. miss -> event_aliases on (snap_source, snap_source_id) ->
--      canonical_event_id, load THAT event -> 'merged' (render canonical's
--      live data, item stays keyed on the original event_id).
--   3. miss, or the canonical is itself gone -> 'gone' (render from
--      snap_* only).
-- If two items resolve to the SAME underlying event (a merge caused the
-- item added under the duplicate id to point at an event already in the
-- plan under its own id), the item with the LATER added_at is marked
-- 'merged_duplicate' -- never tombstoned, just hidden by the frontend/`.ics`
-- (a future un-merge should bring it back into view on its own).
--
-- rot_status is NEVER filtered out of the response -- the frontend decides
-- what to render/export per status (§4.3 of the design). Returns null (not
-- an error, not an empty object) when the code doesn't resolve to a plan.
create or replace function get_day_plan(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan     day_plans%rowtype;
  v_items    jsonb;
  v_item     record;
  v_ev       record;
  v_ev_found boolean;
  v_canon_id uuid;
  v_rstat    text;
  v_resolved uuid;
  v_sort_at  timestamptz;
  v_json     jsonb;
begin
  select * into v_plan from day_plans where code = p_code;
  if not found then
    return null;
  end if;

  create temporary table if not exists _dp_resolved (
    event_id           uuid,
    added_at           timestamptz,
    resolved_event_id  uuid,
    rot_status         text,
    sort_at            timestamptz,
    item_json          jsonb
  ) on commit drop;
  -- Session-scoped temp table reused across calls in the same connection --
  -- clear any residue from a prior call before this one writes to it.
  --
  -- `where true` is LOAD-BEARING, not noise. Supabase preloads the
  -- `safeupdate` extension for the PostgREST API role, which rejects any
  -- UPDATE or DELETE without a WHERE clause with SQLSTATE 21000
  -- ("DELETE requires a WHERE clause"). A bare `delete from _dp_resolved;`
  -- therefore works in psql and via the service role, but fails for every
  -- real anon request through the API -- which is exactly how this shipped
  -- broken on 2026-08-09: every /d/<code> page rendered "We couldn't find
  -- that plan" while the row sat healthy in the table. Do not remove it.
  delete from _dp_resolved where true;

  for v_item in
    select * from day_plan_items where plan_id = v_plan.id and removed_at is null
  loop
    -- Attempt 1: the event still exists under its own id.
    select e.id, e.title, e.start_at, e.end_at, e.status, e.event_status,
           left(coalesce(e.description, ''), 500) as description,
           e.ticket_url, e.source_url, e.price_min, e.price_max, e.category_slugs,
           v.name as v_name, v.address as v_address, v.city as v_city,
           v.state as v_state, v.zip as v_zip, v.lat as v_lat, v.lng as v_lng
      into v_ev
      from events e
      left join lateral (
        select vv.name, vv.address, vv.city, vv.state, vv.zip, vv.lat, vv.lng
          from event_venues ev2
          join venues vv on vv.id = ev2.venue_id
         where ev2.event_id = e.id
         limit 1
      ) v on true
     where e.id = v_item.event_id;
    v_ev_found := found;

    if v_ev_found then
      if v_ev.status <> 'published' or v_ev.event_status in ('cancelled', 'postponed') then
        v_rstat := 'cancelled';
      elsif v_ev.start_at <> v_item.snap_start_at then
        v_rstat := 'moved';
      else
        v_rstat := 'ok';
      end if;
      v_resolved := v_ev.id;
      v_sort_at  := v_ev.start_at;
      v_json := jsonb_build_object(
        'event_id', v_item.event_id, 'added_at', v_item.added_at,
        'resolved_event_id', v_ev.id,
        'id', v_ev.id, 'title', v_ev.title, 'start_at', v_ev.start_at, 'end_at', v_ev.end_at,
        'status', v_ev.status, 'event_status', v_ev.event_status, 'description', v_ev.description,
        'ticket_url', v_ev.ticket_url, 'source_url', v_ev.source_url,
        'price_min', v_ev.price_min, 'price_max', v_ev.price_max, 'category_slugs', v_ev.category_slugs,
        'venue', case when v_ev.v_name is not null then jsonb_build_object(
                   'name', v_ev.v_name, 'address', v_ev.v_address, 'city', v_ev.v_city,
                   'state', v_ev.v_state, 'zip', v_ev.v_zip, 'lat', v_ev.v_lat, 'lng', v_ev.v_lng
                 ) else null end,
        'snap_title', v_item.snap_title, 'snap_start_at', v_item.snap_start_at,
        'snap_end_at', v_item.snap_end_at, 'snap_venue', v_item.snap_venue
      );
    else
      -- Attempt 2: alias resolution via the add-time snapshot key.
      v_canon_id := null;
      if v_item.snap_source is not null and v_item.snap_source_id is not null then
        select canonical_event_id into v_canon_id
          from event_aliases
         where duplicate_source = v_item.snap_source
           and duplicate_source_id = v_item.snap_source_id;
      end if;

      v_ev_found := false;
      if v_canon_id is not null then
        select e.id, e.title, e.start_at, e.end_at, e.status, e.event_status,
               left(coalesce(e.description, ''), 500) as description,
               e.ticket_url, e.source_url, e.price_min, e.price_max, e.category_slugs,
               v.name as v_name, v.address as v_address, v.city as v_city,
               v.state as v_state, v.zip as v_zip, v.lat as v_lat, v.lng as v_lng
          into v_ev
          from events e
          left join lateral (
            select vv.name, vv.address, vv.city, vv.state, vv.zip, vv.lat, vv.lng
              from event_venues ev2
              join venues vv on vv.id = ev2.venue_id
             where ev2.event_id = e.id
             limit 1
          ) v on true
         where e.id = v_canon_id;
        v_ev_found := found;
      end if;

      if v_ev_found then
        v_rstat    := 'merged';
        v_resolved := v_ev.id;
        v_sort_at  := v_ev.start_at;
        v_json := jsonb_build_object(
          'event_id', v_item.event_id, 'added_at', v_item.added_at,
          'resolved_event_id', v_ev.id,
          'id', v_ev.id, 'title', v_ev.title, 'start_at', v_ev.start_at, 'end_at', v_ev.end_at,
          'status', v_ev.status, 'event_status', v_ev.event_status, 'description', v_ev.description,
          'ticket_url', v_ev.ticket_url, 'source_url', v_ev.source_url,
          'price_min', v_ev.price_min, 'price_max', v_ev.price_max, 'category_slugs', v_ev.category_slugs,
          'venue', case when v_ev.v_name is not null then jsonb_build_object(
                     'name', v_ev.v_name, 'address', v_ev.v_address, 'city', v_ev.v_city,
                     'state', v_ev.v_state, 'zip', v_ev.v_zip, 'lat', v_ev.v_lat, 'lng', v_ev.v_lng
                   ) else null end,
          'snap_title', v_item.snap_title, 'snap_start_at', v_item.snap_start_at,
          'snap_end_at', v_item.snap_end_at, 'snap_venue', v_item.snap_venue
        );
      else
        v_rstat    := 'gone';
        v_resolved := null;
        v_sort_at  := v_item.snap_start_at;
        v_json := jsonb_build_object(
          'event_id', v_item.event_id, 'added_at', v_item.added_at,
          'resolved_event_id', null,
          'id', null, 'title', null, 'start_at', null, 'end_at', null,
          'status', null, 'event_status', null, 'description', null,
          'ticket_url', null, 'source_url', null, 'price_min', null, 'price_max', null,
          'category_slugs', null, 'venue', null,
          'snap_title', v_item.snap_title, 'snap_start_at', v_item.snap_start_at,
          'snap_end_at', v_item.snap_end_at, 'snap_venue', v_item.snap_venue
        );
      end if;
    end if;

    insert into _dp_resolved (event_id, added_at, resolved_event_id, rot_status, sort_at, item_json)
    values (v_item.event_id, v_item.added_at, v_resolved, v_rstat, v_sort_at, v_json);
  end loop;

  -- merged_duplicate pass: when two items resolve to the same underlying
  -- event, the later-added_at one is hidden (§4.1). Never applied to NULL
  -- resolved_event_id ('gone' items never collide with each other this way).
  update _dp_resolved r
     set rot_status = 'merged_duplicate'
    from (
      select event_id, added_at,
             row_number() over (partition by resolved_event_id order by added_at asc) as rn
        from _dp_resolved
       where resolved_event_id is not null
    ) d
   where r.event_id = d.event_id and r.added_at = d.added_at and d.rn > 1;

  select jsonb_agg(t.item_json order by t.sort_at asc) into v_items
    from (
      select (item_json || jsonb_build_object('rot_status', rot_status)) as item_json, sort_at
        from _dp_resolved
    ) t;

  return jsonb_build_object(
    'code', v_plan.code,
    'title', v_plan.title,
    'created_at', v_plan.created_at,
    'updated_at', v_plan.updated_at,
    'expires_at', v_plan.expires_at,
    'item_count', v_plan.item_count,
    'items', coalesce(v_items, '[]'::jsonb)
  );
end; $$;

-- ── 11. day_plan_add_event / day_plan_remove_event / day_plan_set_title ─────
--
-- Every mutation RPC returns the same shape get_day_plan does -- a mutation
-- IS a refresh, so the frontend never needs a second call after one (§6.2).
--
-- Item-count guard (added post-QA, 2026-08-08): create_day_plan checks
-- array_length(p_event_ids, 1) up front for the BULK path (section 9 above),
-- but this single-item SEQUENTIAL path had no equivalent guard -- it relied
-- solely on day_plans.item_count's table CHECK (bound via
-- trg_day_plan_rollup's post-insert UPDATE) to reject a 31st item. That CHECK
-- still fires and is still correct on its own -- nothing here was ever
-- exploitable -- but it means the RPC's only failure mode for a 31st
-- sequential add was a raw Postgres constraint-violation message ("new row
-- for relation day_plans violates check constraint ...") instead of one a
-- frontend can show a visitor. The guard below exists ONLY to raise a
-- friendly message earlier; it is NOT the source of truth for the cap -- do
-- not remove the CHECK, and a direct service-role write still has only the
-- CHECK to rely on.
--
-- Race-safety: day_plan_mutation_gate (above) already takes
-- `select ... for update` on this same day_plans row and holds that lock for
-- the rest of this transaction, so the plain SELECT of item_count below is
-- safe against a concurrent add on the SAME plan -- it cannot read a stale
-- count out from under a racing transaction (that transaction is blocked on
-- the same row lock until this one commits).
--
-- Re-adding an event already LIVE in this plan (day_plan_insert_item's ON
-- CONFLICT branch, e.g. a duplicate click) never changes item_count, so it
-- must never be blocked here regardless of the current count -- the
-- `not exists (... removed_at is null)` clause exempts exactly that case. A
-- previously-removed (tombstoned) item being re-added DOES increase
-- item_count and is correctly subject to the cap.
create or replace function day_plan_add_event(p_code text, p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan_id    uuid;
  v_item_count int;
begin
  select id into v_plan_id from day_plans where code = p_code;
  if v_plan_id is null then
    raise exception 'no day plan found for that code' using errcode = 'check_violation';
  end if;

  perform day_plan_mutation_gate(v_plan_id);

  select item_count into v_item_count from day_plans where id = v_plan_id;
  if v_item_count >= 30
     and not exists (
       select 1 from day_plan_items
        where plan_id = v_plan_id and event_id = p_event_id and removed_at is null
     )
  then
    raise exception 'this plan already has the maximum of 30 items' using errcode = 'check_violation';
  end if;

  perform day_plan_insert_item(v_plan_id, p_event_id);

  return get_day_plan(p_code);
end; $$;

-- Anon has NO DELETE grant on day_plan_items. This is an UPDATE that sets
-- removed_at -- the row stays in place forever until the reaper drops the
-- whole plan (D10). `assert exists` in the test suite is the guard.
create or replace function day_plan_remove_event(p_code text, p_event_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan_id uuid;
begin
  select id into v_plan_id from day_plans where code = p_code;
  if v_plan_id is null then
    raise exception 'no day plan found for that code' using errcode = 'check_violation';
  end if;

  perform day_plan_mutation_gate(v_plan_id);

  update day_plan_items
     set removed_at = now()
   where plan_id = v_plan_id and event_id = p_event_id and removed_at is null;

  return get_day_plan(p_code);
end; $$;

create or replace function day_plan_set_title(p_code text, p_title text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_plan_id uuid;
begin
  select id into v_plan_id from day_plans where code = p_code;
  if v_plan_id is null then
    raise exception 'no day plan found for that code' using errcode = 'check_violation';
  end if;

  perform day_plan_mutation_gate(v_plan_id);

  -- moderation_screen_day_plan (section 4) fires on this UPDATE OF title.
  update day_plans set title = nullif(trim(p_title), '') where id = v_plan_id;

  return get_day_plan(p_code);
end; $$;

-- ── 12. Grants (§3.1) ────────────────────────────────────────────────────────
revoke all on function create_day_plan(uuid, text, uuid[])   from public;
revoke all on function get_day_plan(text)                    from public;
revoke all on function day_plan_add_event(text, uuid)        from public;
revoke all on function day_plan_remove_event(text, uuid)     from public;
revoke all on function day_plan_set_title(text, text)        from public;
grant execute on function create_day_plan(uuid, text, uuid[]) to anon, authenticated;
grant execute on function get_day_plan(text)                  to anon, authenticated;
grant execute on function day_plan_add_event(text, uuid)      to anon, authenticated;
grant execute on function day_plan_remove_event(text, uuid)   to anon, authenticated;
grant execute on function day_plan_set_title(text, text)      to anon, authenticated;

-- ── 13. The reaper (D4) ──────────────────────────────────────────────────────
--
-- Rule: delete a plan one week after its last event has ended. NOT granted to
-- anon -- service role / pg_cron only.
create or replace function purge_expired_day_plans()
returns int language plpgsql security definer set search_path = public as $$
declare deleted int;
begin
  with candidates as (
    -- Fast index scan on the trigger-maintained snapshot-derived column.
    select d.id from day_plans d where d.expires_at < now()
  ),
  -- Re-check against LIVE events: an event rescheduled LATER must extend the
  -- plan's life. expires_at is derived from add-time snapshots and cannot
  -- know about a reschedule, so the snapshot column is a candidate FILTER,
  -- never the final authority. This join is the authority.
  safe as (
    select c.id from candidates c
     where not exists (
       select 1
         from day_plan_items i
         join events e on e.id = i.event_id
        where i.plan_id = c.id
          and i.removed_at is null
          and coalesce(e.end_at, e.start_at + interval '4 hours')
              > now() - interval '7 days'
     )
  )
  delete from day_plans d using safe s where d.id = s.id;
  get diagnostics deleted = row_count;
  return deleted;
end; $$;

revoke all on function purge_expired_day_plans() from public, anon, authenticated;

-- pg_cron schedule lives HERE, in the migration, not only in the live
-- cron.job table -- explicitly better than jobid 1 (the digest), whose
-- schedule exists nowhere in the repo. Wrapped so re-running this migration
-- (branch reset, local `supabase db reset`) is safe -- cron.schedule is
-- idempotent on the job name in recent pg_cron, but do not rely on it.
select cron.unschedule('purge-expired-day-plans')
 where exists (select 1 from cron.job where jobname = 'purge-expired-day-plans');

select cron.schedule(
  'purge-expired-day-plans',
  '15 8 * * *',                       -- 08:15 UTC = 4:15am ET (3:15am EST)
  $$select purge_expired_day_plans()$$
);

-- DST CAVEAT, stated because the digest (pg_cron jobid 1) already has this
-- open bug: '15 8 * * *' is UTC, so this runs 4:15am EDT / 3:15am EST. For a
-- purge job that is irrelevant -- the same unsolved winter drift that matters
-- for an 8:30am email does not matter for a 4am delete. Do not "fix" it here
-- and do not let it be cited as a precedent for the digest's own bug.
--
-- VERIFICATION QUERIES for the maintainer, after this migration lands:
--   select jobid, jobname, schedule, active, command from cron.job order by jobid;
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'purge-expired-day-plans')
--    order by start_time desc limit 7;
--
-- FOLLOW-UP, not v1: the reaper is unmonitored. Cheapest monitor is a line in
-- the existing morning briefing:
--   select count(*) from day_plans where expires_at < now() - interval '2 days';
-- Non-zero means the job is dead. Recommend adding once the feature has real
-- traffic.

commit;
