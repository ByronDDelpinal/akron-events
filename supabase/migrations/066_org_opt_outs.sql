-- ════════════════════════════════════════════════════════════════════════════
-- 066_org_opt_outs.sql
--
-- ORG OPT-OUT: a named organization asks to not appear on Akron Pulse, and
-- that decision must (a) take effect immediately on rows already in the DB,
-- (b) survive every subsequent nightly re-scrape without a human re-touching
-- anything, and (c) be reversible by flipping one boolean.
--
-- WHY A SIDE TABLE, NOT manual_overrides. The obvious "just pin status" is
-- exactly the trap 060 documents. Writing status into an org/venue/event
-- manual_overrides marker weaponizes the live, unversioned
-- trg_enforce_manual_overrides_events trigger into a PERMANENT pin that the
-- admin UI itself cannot clear, and it makes active=false impossible to honor
-- (the pin outlives the opt-out). So the opt-out lives in its own table,
-- org_opt_outs, and NOTHING here ever writes into any manual_overrides column.
-- The org_opt_outs row IS the audit trail.
--
-- MATCHING IS BY FOLDED NAME, NOT ONLY id. A scraper re-mints an org row under
-- a fresh uuid on most nights, so an id-only opt-out would leak the org back in
-- the moment its id churns. Matching is on org_name_match_key(name) (the SQL
-- twin of src/lib/sourceTiers.js orgNameMatchKey) OR on a captured
-- organization_id, so a re-mint under the same folded name is caught on sight.
--
-- ── DECISION B (co-hosted events) ───────────────────────────────────────────
-- An event can have several host orgs. When ONE host opts out but the event
-- has at least one OTHER, non-opted-out host, the opted-out org simply never
-- appears as a host (its event_organizations link is dropped/deleted) and the
-- event STAYS LIVE under its remaining host. Only when EVERY host of an event
-- is opted out is the event itself cancelled.
--
-- DECISION B IS INSERTION-ORDER-PROOF. Links arrive one at a time and the
-- BEFORE guard only sees co-hosts that already exist, so two triggers cooperate
-- on event_organizations: trg_opt_out_event_org_guard (BEFORE INSERT) drops an
-- opted-out link when a clean co-host is already present, and
-- trg_opt_out_event_org_reconcile (AFTER INSERT) drops any opted-out link once a
-- clean co-host is added LATER. Either order ends with the opted-out org
-- unlinked and the event live under its clean host.
--
-- SELF-HEALING WINDOW (documented, deliberate). If the opted-out host is linked
-- FIRST and is momentarily the only host, the event is cancelled and its link is
-- KEPT (so the events backstop can re-cancel a re-publish -- see the guard). A
-- clean co-host added afterward unlinks the opted-out org but does NOT
-- auto-un-cancel the event: cancel reasons (opt-out, geo, moderation, manual)
-- are indistinguishable on the row, so auto-resurrection in a trigger is unsafe.
-- The event self-heals on the next scrape -- upsertEventSafe upserts it back to
-- 'published' and trg_opt_out_events_cancel then ALLOWS it because a live
-- co-host exists -- a roughly one-day window for this rare link order. An
-- aged-out one-off may need a manual admin re-publish.
--
-- ── TRIGGER NAMES ARE LOAD-BEARING ──────────────────────────────────────────
-- All three guard triggers are named trg_opt_out_* on purpose. Postgres fires
-- same-timing triggers in trigger-NAME alphabetical order, and 'trg_o' sorts
-- AFTER 'trg_enf...' (enforce_manual_overrides), 'trg_eve...' (reopen_review,
-- updated_at) and 'trg_m...' (moderation). So the opt-out cancel is the LAST
-- BEFORE trigger to run and its NEW.status = 'cancelled' wins over any
-- re-publish those earlier triggers performed. If you rename these, the
-- "opt-out beats enforce" guarantee is silently lost.
--
-- ── DEPLOY PREREQ (do this BEFORE applying) ─────────────────────────────────
-- The correctness of "opt-out fires last" depends on trigger-name ordering,
-- and trg_enforce_manual_overrides_events is a LIVE, unversioned trigger that
-- exists only in the database (no migration file defines it). Before applying,
-- dump the live trigger set and confirm nothing sorts AFTER trg_opt_out_*:
--
--   select tgrelid::regclass as tbl, tgname
--     from pg_trigger
--    where not tgisinternal
--      and tgrelid in ('public.events'::regclass,
--                      'public.organizations'::regclass,
--                      'public.event_organizations'::regclass)
--    order by tbl, tgname;
--
-- Every existing tgname on events/organizations MUST sort strictly before
-- 'trg_opt_out_...'. If a live or drifted trigger sorts after it, that trigger
-- could re-publish a row after the opt-out cancel and the guard fails open.
--
-- ── DEPLOY NOTES ────────────────────────────────────────────────────────────
--   * Byron applies migrations himself via `supabase db push`. DO NOT APPLY
--     THIS MIGRATION, do not commit it, do not run it against prod.
--   * Do NOT apply during the nightly scrape window. The run holds row locks on
--     events/organizations; avoid 01:30-04:00 UTC.
--   * lock_timeout is set to 5s inside the transaction so this fails fast
--     rather than queueing behind a scrape.
--   * Rollback lives in supabase/rollbacks/066_org_opt_outs_rollback.sql.
--     Rollback scripts NEVER live in supabase/migrations/ - `supabase db push`
--     would apply them as migrations and instantly undo the change.
--   * The ledger `version` MUST match this file's `066` prefix.
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ── 1. org_name_match_key(text): the SQL twin of JS orgNameMatchKey ─────────
-- SINGLE SOURCE OF TRUTH in JS is src/lib/sourceTiers.js orgNameMatchKey:
--   String(name ?? '')
--     .trim()
--     .replace(/^the\s+/i, '')
--     .replace(/\s+/g, ' ')
--     .trim()
--     .toLowerCase()
-- No punctuation stripping - folding only the The/case/whitespace axes.
--
-- WHITESPACE CLASS. JS `\s` (and String.trim) also match some NON-ASCII
-- whitespace, notably NBSP (U+00A0). Postgres `\s` is POSIX [[:space:]] =
-- [ \t\n\r\f\v] and does NOT include NBSP. We pin the SQL class explicitly to
-- [ \t\n\r\f\v] so it matches JS `\s` on the ASCII whitespace that scraped org
-- names actually contain. A name carrying a literal NBSP would fold differently
-- in JS than here; that does not occur in scraped ASCII names, and because the
-- table CHECK and both guard functions all route through THIS function, the
-- database stays internally consistent regardless.
--
-- IMMUTABLE (btrim/regexp_replace/lower are all immutable) so it is legal in
-- the CHECK constraint below.
create or replace function org_name_match_key(name text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(
    btrim(
      regexp_replace(
        regexp_replace(
          btrim(coalesce(name, ''), E' \t\n\r\f\v'),
          '^the[ \t\n\r\f\v]+', '', 'i'
        ),
        '[ \t\n\r\f\v]+', ' ', 'g'
      ),
      E' \t\n\r\f\v'
    )
  )
$$;

comment on function org_name_match_key(text) is
  'Folded org-name match key: SQL twin of orgNameMatchKey in '
  'src/lib/sourceTiers.js (trim, drop leading "The ", collapse whitespace, '
  'lower). ASCII whitespace class only; see 066 header on NBSP.';

-- ── 2. org_opt_outs ─────────────────────────────────────────────────────────
create table if not exists org_opt_outs (
  id              uuid        primary key default gen_random_uuid(),

  -- Folded match key. UNIQUE so one org cannot be opted out twice, and so a
  -- writer that recomputes the key collides instead of duplicating.
  name_key        text        not null unique,

  -- The name as the requester spelled it, for the admin UI and the audit trail.
  display_name    text        not null,

  website         text,
  contact_email   text,

  -- Optional captured id of the org row at opt-out time. Matched in ADDITION to
  -- name_key so an id churn OR a rename is still caught. ON DELETE SET NULL: if
  -- the org row is hard-deleted the opt-out survives on its name_key.
  organization_id uuid        references organizations(id) on delete set null,

  reason          text,
  requested_by    text,
  created_by      text,

  -- The reversibility switch. active=false stops all enforcement; a re-scrape
  -- then republishes the org normally.
  active          boolean     not null default true,

  created_at      timestamptz not null default now(),

  -- name_key must always be the fold of display_name. org_name_match_key is
  -- IMMUTABLE, so this CHECK is legal.
  constraint org_opt_outs_name_key_matches
    check (name_key = org_name_match_key(display_name))
);

-- Powers the per-write early-out `exists (select 1 ... where active)`: a
-- partial index over just the active rows keeps that probe O(1)-ish and, when
-- there are zero active opt-outs, effectively free.
create index if not exists org_opt_outs_active_idx
  on org_opt_outs (id) where active;

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
-- Enabled, NOT forced (the guard functions below are SECURITY DEFINER and are
-- owned by a superuser that bypasses RLS; forcing would break them for no gain,
-- same reasoning as 059 on admin_users). Belt-and-braces revoke so the table is
-- unreachable through PostgREST for anon even if a policy is later added by
-- accident. authenticated admins manage it; NO delete grant (opt-outs are
-- deactivated via active=false, never removed). service_role bypasses RLS.
alter table org_opt_outs enable row level security;

revoke all on org_opt_outs from anon, authenticated;
grant select, insert, update on org_opt_outs to authenticated;

drop policy if exists "Admins manage org_opt_outs" on org_opt_outs;
create policy "Admins manage org_opt_outs"
  on org_opt_outs for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── 4. Guard predicates ─────────────────────────────────────────────────────
-- SECURITY DEFINER is LOAD-BEARING, not stylistic. The writers these guards
-- protect against (the nightly service_role scraper, an admin re-publishing)
-- do not all have RLS read access to org_opt_outs. Without definer rights the
-- exists() would return zero rows for such a writer and the guard would FAIL
-- OPEN - the opted-out org would sail through. Definer rights let the guard
-- read the table as its owner. `set search_path = public` is the mandatory
-- counterweight against search-path hijack (same pattern as is_admin in 059).
create or replace function is_org_opted_out(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from organizations o
      join org_opt_outs oo
        on oo.active
       and (oo.name_key = org_name_match_key(o.name)
            or oo.organization_id = o.id)
     where o.id = org_id
  )
$$;

-- Name-only variant for the organizations trigger, where the incoming NEW.name
-- is the thing to test and there may be no persisted org row to join to yet.
create or replace function is_name_opted_out(org_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from org_opt_outs oo
     where oo.active
       and oo.name_key = org_name_match_key(org_name)
  )
$$;

-- Granted to authenticated only, NOT anon. Triggers run as the definer and need
-- no caller grant; exposing these over PostgREST /rpc to anon would be a boolean
-- oracle over the admin-only opt-out list (who has opted out) for anonymous
-- users. authenticated keeps them callable by an admin frontend if ever needed.
revoke all on function is_org_opted_out(uuid)  from public;
revoke all on function is_name_opted_out(text) from public;
grant execute on function is_org_opted_out(uuid)  to authenticated;
grant execute on function is_name_opted_out(text) to authenticated;

-- ── 5. Guard trigger functions ──────────────────────────────────────────────
-- Each opens with the zero-opt-out early-out so that, in the overwhelmingly
-- common case of no active opt-outs, a normal write pays only one indexed
-- exists() probe and returns untouched. All are SECURITY DEFINER for the same
-- fail-open reason as the predicates above.

-- (a) organizations: born/kept cancelled while opted out. Matches on folded
--     name OR on a captured organization_id = NEW.id. Deliberately writes
--     NOTHING into manual_overrides (see header) - the org_opt_outs row is the
--     record, and leaving manual_overrides untouched is what lets active=false
--     restore the org on the next scrape.
create or replace function opt_out_organizations_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_opt_outs where active limit 1) then
    return NEW;
  end if;

  if is_name_opted_out(NEW.name)
     or exists (select 1 from org_opt_outs
                 where active and organization_id = NEW.id) then
    NEW.status := 'cancelled';
  end if;

  return NEW;
end;
$$;

-- (b) event_organizations: the link-time guard. Decision B lives here.
create or replace function opt_out_event_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_opt_outs where active limit 1) then
    return NEW;
  end if;

  -- Linking a non-opted-out org: nothing to do.
  if not is_org_opted_out(NEW.organization_id) then
    return NEW;
  end if;

  -- The org being linked IS opted out. If the event already has at least one
  -- OTHER host that is NOT opted out, drop only THIS link and leave the event
  -- live under its clean co-host (Decision B).
  if exists (
    select 1
      from event_organizations eo
     where eo.event_id = NEW.event_id
       and eo.organization_id <> NEW.organization_id
       and not is_org_opted_out(eo.organization_id)
  ) then
    return null;
  end if;

  -- No clean co-host: this opted-out org would be the event's only visible
  -- host. Cancel the event but KEEP the link (return NEW), NOT drop it. A
  -- hostless cancelled event slips past trg_opt_out_events_cancel (which only
  -- cancels events that HAVE hosts), so an admin/enforce re-publish of it would
  -- STICK and re-expose the opted-out org. Keeping the link leaves the event
  -- with a host so the events backstop re-cancels every future re-publish. The
  -- org never appears publicly because the event is cancelled; if a clean
  -- co-host is later linked, trg_opt_out_event_org_reconcile drops this link.
  update events
     set status = 'cancelled'
   where id = NEW.event_id
     and status <> 'cancelled';

  return NEW;
end;
$$;

-- (b2) event_organizations AFTER INSERT: Decision B, insertion-order-proof.
-- The BEFORE guard (b) can only see co-hosts that exist WHEN a link is inserted,
-- so if the opted-out host is linked FIRST and a clean co-host SECOND, (b)
-- cancels the event and keeps the opted-out link, and nothing yet removes it.
-- This AFTER trigger closes that gap: when the row just linked is itself a LIVE
-- (non-opted-out) co-host, it deletes any opted-out links now sitting on the
-- same event. The opted-out org is therefore unlinked as soon as ANY clean
-- co-host exists, whatever the link order (Decision B: it never appears). It
-- deliberately does NOT un-cancel the event -- see the header self-heal note.
create or replace function opt_out_event_org_reconcile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_opt_outs where active limit 1) then
    return null;
  end if;

  -- Only act when the row just linked is itself a live co-host.
  if is_org_opted_out(NEW.organization_id) then
    return null;
  end if;

  delete from event_organizations eo
   where eo.event_id = NEW.event_id
     and is_org_opted_out(eo.organization_id);

  return null;
end;
$$;

-- (c) events: on any insert/update, if the event HAS hosts and EVERY host is
--     opted out, force cancelled. This is the re-publish backstop: when enforce
--     or an admin flips an all-opted-out event back to published, this fires
--     LAST (trg_o... sorts after trg_enf.../trg_eve.../trg_m...) and re-cancels
--     it. Only ever sets cancelled; never un-cancels.
create or replace function opt_out_events_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from org_opt_outs where active limit 1) then
    return NEW;
  end if;

  if exists (select 1 from event_organizations eo where eo.event_id = NEW.id)
     and not exists (
       select 1
         from event_organizations eo
        where eo.event_id = NEW.id
          and not is_org_opted_out(eo.organization_id)
     )
  then
    NEW.status := 'cancelled';
  end if;

  return NEW;
end;
$$;

-- ── 6. Reconciliation ───────────────────────────────────────────────────────
-- Makes an opt-out effective IMMEDIATELY on rows already in the DB, not just on
-- the next scrape. Fires AFTER a row becomes active (insert of an active row,
-- or an update that sets active). It is a trigger function (returns trigger)
-- and its work is a global idempotent sweep, so re-running it is harmless.
create or replace function reconcile_org_opt_outs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (1) Cancel any org that is now opted out.
  update organizations o
     set status = 'cancelled'
   where o.status <> 'cancelled'
     and is_org_opted_out(o.id);

  -- (2) Cancel published events whose EVERY host is opted out.
  update events e
     set status = 'cancelled'
   where e.status = 'published'
     and exists (select 1 from event_organizations eo where eo.event_id = e.id)
     and not exists (
       select 1
         from event_organizations eo
        where eo.event_id = e.id
          and not is_org_opted_out(eo.organization_id)
     );

  -- (3) Decision B for PRE-EXISTING links: delete the opted-out org's link from
  --     any event that still has a non-opted-out co-host, so the event stays
  --     live and the opted-out org simply disappears from it.
  delete from event_organizations eo
   where is_org_opted_out(eo.organization_id)
     and exists (
       select 1
         from event_organizations other
        where other.event_id = eo.event_id
          and other.organization_id <> eo.organization_id
          and not is_org_opted_out(other.organization_id)
     );

  return null;
end;
$$;

-- ── 7. Triggers ─────────────────────────────────────────────────────────────
-- Names chosen so 'trg_opt_out_*' sorts LAST among same-timing triggers; see
-- header. No column lists on the org/event cancel triggers: an opt-out landing
-- between scrapes must be able to catch ANY write, not only writes that happen
-- to touch a named column.
drop trigger if exists trg_opt_out_organizations_cancel on organizations;
create trigger trg_opt_out_organizations_cancel
  before insert or update on organizations
  for each row execute function opt_out_organizations_cancel();

drop trigger if exists trg_opt_out_event_org_guard on event_organizations;
create trigger trg_opt_out_event_org_guard
  before insert on event_organizations
  for each row execute function opt_out_event_org_guard();

drop trigger if exists trg_opt_out_event_org_reconcile on event_organizations;
create trigger trg_opt_out_event_org_reconcile
  after insert on event_organizations
  for each row execute function opt_out_event_org_reconcile();

drop trigger if exists trg_opt_out_events_cancel on events;
create trigger trg_opt_out_events_cancel
  before insert or update on events
  for each row execute function opt_out_events_cancel();

-- Reconcile only when the row is (or becomes) active.
drop trigger if exists trg_opt_out_reconcile on org_opt_outs;
create trigger trg_opt_out_reconcile
  after insert or update of active on org_opt_outs
  for each row when (NEW.active)
  execute function reconcile_org_opt_outs();

commit;
