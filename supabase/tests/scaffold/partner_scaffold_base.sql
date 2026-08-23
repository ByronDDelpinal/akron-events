-- ════════════════════════════════════════════════════════════════════════════
-- partner_scaffold_base.sql
--
-- ⚠️  TEST HARNESS ONLY. This file recreates, on STOCK PostgreSQL 16, the
--     minimal faithful PRE-059 state that migrations 059/060/061 and the two
--     RLS test files touch. It is NOT a schema source of truth, it must NEVER
--     be applied to any Supabase project, and it must NEVER be moved into
--     supabase/migrations/ (`supabase db push` applies anything there).
--
-- WHY IT EXISTS (design §6 / D9): a clean replay of 001-058 is known broken --
-- event_aliases / venue_aliases have no create-table migration, so branch
-- replay fails at 041 -- and a full replay would need pg_net / pg_cron /
-- gateway shims (045, 052, 057) whose divergence from Supabase is exactly the
-- false-green CONTRIBUTING.md warns about. This scaffold makes a NARROWER,
-- provable claim instead: it recreates the pre-059 objects those migrations
-- and tests interact with, BY NAME, and then real 059 -> 060 -> 061 apply on
-- top.
--
-- SCAFFOLD FIDELITY IS VERIFIED BY 059 ITSELF: 059 section 4b runs three
-- `alter policy` statements, and `alter policy` has no IF EXISTS form -- if
-- any pre-059 policy name below were missing or misspelled, 059 aborts. The
-- fifteen policies 059 drops, the five anon INSERT policies (two widened,
-- three dropped), and the moderation machinery 059 replaces are all created
-- here exactly as their source migrations wrote them.
--
-- RUN AS A NON-SUPERUSER OWNER (app_owner). A superuser bypasses RLS and the
-- whole exercise; and the FORCE-RLS lockout landmine 059's header documents
-- only reproduces with a non-superuser owner, which is what prod's owner is.
-- See supabase/tests/scaffold/README.md (or scripts/dev/run-partner-sql-harness.sh)
-- for the exact bootstrap + run recipe.
--
-- OUT-OF-BAND PROD OBJECTS carried here:
--   • enforce_manual_overrides() + trg_enforce_manual_overrides_events:
--     VERBATIM from the production dump of 2026-08-23 (prod-scaffold-facts,
--     project hadipeqtzikxxsvtqdma). This is the D10 trigger that exists in NO
--     migration. If the runbook's step-0 dump ever shows a different body,
--     update this copy and the dump date.
--   • event_aliases / venue_aliases: column shapes from the same 2026-08-23
--     prod dump (the 041 gap -- no migration creates them).
--   • events slug machinery (turnout_*): RECONSTRUCTION from the documented
--     contract (database.types.ts lists the functions; no migration carries
--     them). Marked below. The tests do not assert slug VALUES, only that
--     inserts survive the trigger.
--
-- KNOWN CAVEATS, stated rather than discovered:
--   • A green run here does NOT exercise PostgREST role selection, JWT
--     minting, or the gateway -- exactly the 054-class blindness. The
--     post-apply API runbook (V1-V14) covers that layer.
--   • Three pre-existing red test files (day_plan_rls, embed_request_rls,
--     feedback_orb_rls -- red for documented non-059 reasons) are NOT in the
--     harness chain; day-plan / pg_cron machinery is deliberately absent.
--   • scraper_runs / day_plans / storage are not scaffolded: nothing in the
--     059/060/061 chain or the two chained test files touches them.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 0. Roles + default privileges (the Supabase grant regime) ────────────────
-- anon / authenticated / service_role exist cluster-wide on Supabase; the
-- bootstrap script creates them (nologin) before this file runs. Supabase's
-- default privileges grant ALL on tables/sequences/functions to the three
-- roles DIRECTLY (not via PUBLIC) -- which is why house revokes name the
-- roles explicitly (030's moderation_severity precedent) -- so the same
-- default privileges are declared here for the owner creating everything
-- below AND for the objects 059/060/061 create later in the chain.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;

-- Extensions the chain needs. unaccent + pg_trgm are TRUSTED in PG 13+, so
-- the non-superuser database owner may create them (they live in -contrib).
create extension if not exists unaccent;
create extension if not exists pg_trgm;

-- ── 0b. The auth schema shim ─────────────────────────────────────────────────
-- The same GUC contract the test files already drive: auth.uid() reads
-- request.jwt.claims ->> 'sub', auth.role() reads ->> 'role'. auth.users
-- carries the columns the migrations FK against and the tests insert.
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- PROD GROUND TRUTH (2026-08-23, design D3): exactly two auth users exist and
-- both are admins. 059 section 2 seeds admin_users with FK checks against
-- these ids, so they must exist here or 059 aborts (which would be the
-- correct failure -- see 059's header).
insert into auth.users (id, email) values
  ('c5b809ab-8ad0-4e2e-a985-cc709726c12b', 'byronddelpinal@gmail.com'),
  ('5c30e2be-fb56-4b29-923d-71cce9722d80', 'mac@artxlove.com');

-- ── 1. Core tables (net state after 001..058) ────────────────────────────────
-- Column lists cribbed from src/lib/database.types.ts (the pre-059 codegen
-- state) plus the CHECK constraints / defaults from their source migrations.

-- 001 + 006 + 028 + 040 (+ out-of-band slug)
create table venues (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  address           text,
  city              text not null default 'Akron',
  state             text not null default 'OH',
  zip               text,
  lat               numeric(9,6),
  lng               numeric(9,6),
  parking_type      text check (parking_type in ('street','lot','garage','none','unknown')) default 'unknown',
  parking_notes     text,
  website           text,
  description       text,
  image_url         text,
  organization_id   uuid,  -- FK added after organizations exists
  status            text not null default 'published'
                      check (status in ('pending_review','published','cancelled')),
  tags              text[] not null default '{}',
  manual_overrides  jsonb not null default '{}',
  neighborhood_slug text,
  listed            boolean not null default true,
  slug              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- 035: enforce at the database what ensureVenue assumes (name is identity).
create unique index venues_name_unique_idx on venues (name);
create index venues_listed_idx on venues (listed) where listed = true;

-- 006 (rename of 001's organizers) + out-of-band slug/photos
create table organizations (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  website          text,
  contact_email    text,
  description      text,
  image_url        text,
  address          text,
  city             text not null default 'Akron',
  state            text not null default 'OH',
  zip              text,
  status           text not null default 'published'
                     check (status in ('pending_review','published','cancelled')),
  manual_overrides jsonb not null default '{}',
  photos           text[] not null default '{}',
  slug             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table venues
  add constraint venues_organization_id_fkey
  foreign key (organization_id) references organizations(id) on delete set null;
create index idx_venues_organization on venues (organization_id);

-- 001 + 005/019/021/022/023/024/026/029/034/039/056 net shape.
-- (categories moved to event_categories at 029; the single `category` column
-- is dropped there and so never exists here.)
create table events (
  id                     uuid primary key default gen_random_uuid(),
  title                  text not null,
  description            text,
  start_at               timestamptz not null,
  end_at                 timestamptz,
  tags                   text[] not null default '{}',
  price_min              numeric(8,2) not null default 0,
  price_max              numeric(8,2),
  age_restriction        text not null default 'not_specified' check (age_restriction in (
                           'not_specified','all_ages','18_plus','21_plus'
                         )),
  image_url              text,
  ticket_url             text,
  source_url             text,
  source                 text not null default 'manual',
  source_id              text,
  featured               boolean not null default false,
  status                 text not null default 'pending_review' check (status in (
                           'pending_review','published','cancelled'
                         )),
  needs_review           boolean not null default false,
  banner_eligible        boolean,
  image_width            integer,
  image_height           integer,
  image_file_size        integer,
  is_family              boolean not null default false,
  is_fundraiser          boolean not null default false,
  is_accessible_for_free boolean not null default false,
  event_attendance_mode  text not null default 'offline'
                           check (event_attendance_mode in ('offline','online','hybrid')),
  event_status           text not null default 'scheduled'
                           check (event_status in (
                             'scheduled','rescheduled','postponed','cancelled','moved_online')),
  manual_overrides       jsonb not null default '{}',
  title_normalized       text,
  description_normalized text,
  category_slugs         text[] not null default '{}',
  start_hour_et          smallint,
  slug                   text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (source, source_id)
);
create index idx_events_start_at on events (start_at) where status = 'published';
create index idx_events_source   on events (source, source_id);
create index events_start_hour_et_idx on events (start_hour_et);
create index events_category_slugs_gin on events using gin (category_slugs);

-- 060 adds reviewed_at / reviewed_by via `add column if not exists`; the
-- chain runs real 060, so they are deliberately NOT pre-created here.

-- 006
create table areas (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,
  description text,
  capacity    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_areas_venue on areas (venue_id);

create table event_venues (
  event_id uuid not null references events(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  primary key (event_id, venue_id)
);
create index idx_event_venues_venue on event_venues (venue_id);

create table event_areas (
  event_id uuid not null references events(id) on delete cascade,
  area_id  uuid not null references areas(id) on delete cascade,
  primary key (event_id, area_id)
);
create index idx_event_areas_area on event_areas (area_id);

create table event_organizations (
  event_id        uuid not null references events(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  primary key (event_id, organization_id)
);
-- The index the ADR's perf measurements name (006:149): the partner read
-- policy's EXISTS is served by this.
create index idx_event_organizations_org on event_organizations (organization_id);

-- 029 + 037 (games added to the CHECK)
create table event_categories (
  event_id uuid not null references events(id) on delete cascade,
  category text not null,
  primary key (event_id, category),
  constraint event_categories_category_check check (category in (
    'music','theater','film','comedy','visual-art','food','sports',
    'fitness','outdoors','learning','festival','market','civic','games','other'
  ))
);
create index idx_event_categories_category on event_categories (category);
create index idx_event_categories_event    on event_categories (event_id);

-- 012 + 014/015/016 + 030 (status) + 043 (orb) + 058 (email) net shape
create table feedback_posts (
  id          bigint generated always as identity primary key,
  category    text not null check (category in
                ('bug','love','wish','confusing','idea','datasource','general','orb')),
  body        text not null,
  author_name text not null default 'Anonymous',
  is_private  boolean not null default false,
  votes       int not null default 0,
  image_url   text,
  resolved_at timestamptz,
  page_path   text,
  email       text,
  status      text not null default 'published'
                check (status in ('published','pending_review','cancelled')),
  created_at  timestamptz not null default now()
);

-- 009 net shape
create table subscribers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  token           text not null default replace(gen_random_uuid()::text, '-', ''),
  frequency       text not null default 'weekly',
  lookahead_days  int not null default 7,
  send_day        int,
  preferences     jsonb not null default '{}',
  confirmed       boolean not null default false,
  auth_user_id    uuid,
  unsubscribed_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table email_sends (
  id              uuid primary key default gen_random_uuid(),
  subscriber_id   uuid not null references subscribers(id) on delete cascade,
  sent_at         timestamptz not null default now(),
  status          text not null default 'sent',
  event_count     int not null default 0,
  error_message   text,
  idempotency_key text,
  created_at      timestamptz not null default now()
);

-- 044
create table slack_notifications (
  id           bigint generated always as identity primary key,
  dedupe_key   text not null unique,
  kind         text not null check (kind in ('feedback','subscriber_signup','subscriber_confirmed')),
  channel_key  text not null,
  status       text not null default 'claimed' check (status in ('claimed','sent','failed','skipped')),
  slack_ts     text,
  thread_ts    text,
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- 051 (checks kept: the tests insert through the anon policy)
create table embed_requests (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  name         text not null check (char_length(name) between 1 and 120),
  email        text not null check (char_length(email) between 3 and 254
                                    and position('@' in email) > 1),
  organization text not null check (char_length(organization) between 1 and 160),
  website      text check (website is null or char_length(website) between 1 and 300),
  note         text check (note is null or char_length(note) <= 1000),
  config       jsonb not null check (jsonb_typeof(config) = 'object'
                                     and pg_column_size(config) <= 4096),
  embed_path   text check (embed_path is null or char_length(embed_path) <= 2000),
  status       text not null default 'new'
                 check (status in ('new','approved','sent','declined','spam')),
  notified_at  timestamptz
);

-- UNTRACKED PROD TABLES (no create-table migration exists anywhere -- the 041
-- replay gap). Column shapes VERBATIM from the 2026-08-23 prod dump.
create table event_aliases (
  duplicate_source    text not null,
  duplicate_source_id text not null,
  canonical_event_id  uuid references events(id),
  reason              text,
  created_at          timestamptz not null default now(),
  primary key (duplicate_source, duplicate_source_id)
);

create table venue_aliases (
  alias_venue_id     uuid not null unique references venues(id),
  canonical_venue_id uuid not null references venues(id),
  alias_name         text,
  reason             text,
  created_at         timestamptz not null default now(),
  check (alias_venue_id <> canonical_venue_id)
);

-- 030 term storage
create table moderation_terms (
  term     text primary key,
  severity text not null check (severity in ('contextual','high','extreme')),
  kind     text not null default 'word' check (kind in ('word','phrase'))
);
create table moderation_allowlist (
  phrase text primary key
);

-- ── 2. Functions (net state after 001..058) ──────────────────────────────────

-- 001
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 030
create or replace function moderation_request_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- 049 body (which replaced 030's) -- VERBATIM from
-- 049_moderation_evasion_scoped_runs.sql.
create or replace function moderation_severity(input text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base   text;
  leet   text;
  base_c text;
  leet_c text;
  runs   text[];
  run    text;
  condensed_run text;
  rec    record;
  rx     text;
  best   text := null;
  best_rank int := 0;
  this_rank int;
begin
  if input is null or btrim(input) = '' then
    return null;
  end if;

  base   := regexp_replace(lower(unaccent(input)), '\s+', ' ', 'g');
  leet   := translate(base, '013457@$!', 'oieastasi');
  base_c := regexp_replace(base, '(.)\1{2,}', '\1', 'g');
  leet_c := regexp_replace(leet, '(.)\1{2,}', '\1', 'g');

  runs := array(
    select m[1]
    from regexp_matches(leet, '((?:[a-z0-9][^a-z0-9]){2,}[a-z0-9])', 'g') as m
  );

  for rec in select term, severity, kind from moderation_terms loop
    rx := '\m' || regexp_replace(rec.term, '[^a-z0-9]+', '[^a-z0-9]*', 'g') || '\M';

    if base ~ rx or base_c ~ rx or leet ~ rx or leet_c ~ rx then
      if not exists (
        select 1
        from moderation_allowlist a
        where strpos(base, regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g')) > 0
          and strpos(regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g'), rec.term) > 0
      ) then
        this_rank := case rec.severity when 'extreme' then 3 when 'high' then 2 else 1 end;
        if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
      end if;

    elsif rec.kind = 'word'
          and rec.severity in ('high','extreme')
          and length(rec.term) >= 5 then
      foreach run in array coalesce(runs, '{}'::text[]) loop
        condensed_run := regexp_replace(run, '[^a-z0-9]', '', 'g');
        if strpos(condensed_run, rec.term) > 0 then
          this_rank := case rec.severity when 'extreme' then 3 else 2 end;
          if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
          exit;
        end if;
      end loop;
    end if;

    exit when best_rank = 3;
  end loop;

  return best;
end;
$$;

revoke all on function moderation_severity(text) from public, anon, authenticated;

-- The four moderation screens AS 030 WROTE THEM (the anon-only gate). 059
-- REPLACES all four with the widened gate -- that replacement happening on
-- top of these is part of what the chain verifies.
create or replace function moderation_screen_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.title, NEW.description, array_to_string(NEW.tags, ' ')));
  if sev is null then return NEW; end if;
  NEW.needs_review := true;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_venue()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.body, NEW.author_name));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

-- 043
create or replace function feedback_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare recent int;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  select count(*) into recent
    from feedback_posts
    where created_at > now() - interval '1 minute';
  if recent >= 20 then
    raise exception 'feedback rate limit exceeded' using errcode = 'check_violation';
  end if;
  return NEW;
end; $$;

-- 038
create or replace function event_is_pending_review(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from events e
    where e.id = p_event_id and e.status = 'pending_review'
  )
$$;
revoke all on function event_is_pending_review(uuid) from public;
grant execute on function event_is_pending_review(uuid) to anon, authenticated;

-- 029
create or replace function enforce_max_two_categories()
returns trigger language plpgsql as $$
begin
  if (select count(*) from event_categories where event_id = new.event_id) > 2 then
    raise exception 'event % would exceed 2 content categories', new.event_id;
  end if;
  return new;
end;
$$;

-- 039
create or replace function sync_event_category_slugs(p_event_id uuid)
returns void language sql as $$
  update events e
  set category_slugs = coalesce(
    (select array_agg(ec.category order by ec.category)
       from event_categories ec
      where ec.event_id = p_event_id),
    '{}'
  )
  where e.id = p_event_id;
$$;

create or replace function trg_sync_event_category_slugs()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'DELETE') then
    perform sync_event_category_slugs(old.event_id);
    return old;
  end if;
  perform sync_event_category_slugs(new.event_id);
  if (tg_op = 'UPDATE' and new.event_id is distinct from old.event_id) then
    perform sync_event_category_slugs(old.event_id);
  end if;
  return new;
end;
$$;

-- 024/034
create or replace function sync_event_search_normalized()
returns trigger language plpgsql as $$
begin
  new.title_normalized := unaccent(lower(new.title));
  new.description_normalized := unaccent(lower(
    coalesce(new.description, '') || ' ' || coalesce(array_to_string(new.tags, ' '), '')
  ));
  return new;
end;
$$;

-- 056
create or replace function sync_event_start_hour_et()
returns trigger language plpgsql as $$
begin
  new.start_hour_et := extract(hour from (new.start_at at time zone 'America/New_York'))::smallint;
  return new;
end;
$$;

-- RECONSTRUCTION: the out-of-band turnout slug machinery (present in prod --
-- database.types.ts lists turnout_slugify / turnout_unique_slug and the
-- events_slug_set_trigger trigger is live -- but in no migration). Faithful
-- to the observable contract: slug is set on INSERT when null, from the
-- title, unique-ified. Nothing in the chain asserts slug VALUES.
create or replace function turnout_slugify(input text)
returns text language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(unaccent(input), '')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function turnout_event_slug_trigger()
returns trigger language plpgsql as $$
begin
  if new.slug is null or new.slug = '' then
    new.slug := left(turnout_slugify(new.title), 60) || '-' || left(new.id::text, 8);
  end if;
  return new;
end;
$$;

-- VERBATIM PROD DUMP 2026-08-23 (prod-scaffold-facts): the untracked D10
-- trigger function. Do not edit this body except from a fresh dump.
CREATE OR REPLACE FUNCTION public.enforce_manual_overrides()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  k text;
  protected jsonb := '{}'::jsonb;
BEGIN
  IF coalesce(current_setting('app.bypass_overrides', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.manual_overrides IS NULL OR OLD.manual_overrides = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  -- Override entries may be added or re-stamped, but never silently dropped
  NEW.manual_overrides := OLD.manual_overrides || coalesce(NEW.manual_overrides, '{}'::jsonb);

  FOR k IN SELECT jsonb_object_keys(OLD.manual_overrides) LOOP
    -- Entry unchanged => override not re-stamped => keep the old column value
    IF NEW.manual_overrides -> k = OLD.manual_overrides -> k THEN
      protected := protected || jsonb_build_object(k, to_jsonb(OLD) -> k);
    END IF;
  END LOOP;

  IF protected <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, protected);
  END IF;

  RETURN NEW;
END;
$function$;

-- 050
create or replace function public.venue_aliases_forbid_chains()
returns trigger
language plpgsql
as $$
begin
  if new.alias_venue_id = new.canonical_venue_id then
    raise exception
      'venue_aliases: % cannot alias itself', new.alias_venue_id;
  end if;

  if exists (
    select 1 from public.venue_aliases
    where alias_venue_id = new.canonical_venue_id
  ) then
    raise exception
      'venue_aliases: canonical % is itself an alias row — point directly at its canonical instead',
      new.canonical_venue_id;
  end if;

  if exists (
    select 1 from public.venue_aliases
    where canonical_venue_id = new.alias_venue_id
  ) then
    raise exception
      'venue_aliases: % is canonical for existing aliases — re-point them before aliasing it away',
      new.alias_venue_id;
  end if;

  return new;
end;
$$;

-- ── 3. Triggers ──────────────────────────────────────────────────────────────
-- The seven live prod triggers on events (prod dump 2026-08-23), minus
-- trg_events_reopen_review which real migration 060 creates in the chain.
-- NAME ORDER IS LOAD-BEARING for the 060 trigger: same-timing triggers fire
-- in name order and trg_enforce... must fire before trg_events_reopen_review
-- ('trg_enf' < 'trg_eve', see 060's header).
create trigger events_search_normalized_sync
  before insert or update of title, description, tags on events
  for each row execute function sync_event_search_normalized();

create trigger events_slug_set_trigger
  before insert on events
  for each row execute function turnout_event_slug_trigger();

create trigger events_start_hour_et_sync
  before insert or update of start_at on events
  for each row execute function sync_event_start_hour_et();

create trigger trg_enforce_manual_overrides_events
  before update on events
  for each row execute function enforce_manual_overrides();

create trigger trg_events_updated_at
  before update on events
  for each row execute function set_updated_at();

create trigger trg_moderation_events
  before insert or update of title, description, tags on events
  for each row execute function moderation_screen_event();

create trigger trg_venues_updated_at
  before update on venues
  for each row execute function set_updated_at();

create trigger trg_moderation_venues
  before insert or update of name, description on venues
  for each row execute function moderation_screen_venue();

create trigger trg_organizations_updated_at
  before update on organizations
  for each row execute function set_updated_at();

create trigger trg_moderation_organizations
  before insert or update of name, description on organizations
  for each row execute function moderation_screen_organization();

create trigger trg_areas_updated_at
  before update on areas
  for each row execute function set_updated_at();

create trigger trg_subscribers_updated_at
  before update on subscribers
  for each row execute function set_updated_at();

create trigger trg_moderation_feedback
  before insert or update of body, author_name, status on feedback_posts
  for each row execute function moderation_screen_feedback();

create trigger trg_feedback_rate_limit
  before insert on feedback_posts
  for each row execute function feedback_rate_limit();

create trigger trg_event_categories_max2
  after insert or update on event_categories
  for each row execute function enforce_max_two_categories();

create trigger event_categories_sync_slugs
  after insert or update or delete on event_categories
  for each row execute function trg_sync_event_category_slugs();

create trigger venue_aliases_forbid_chains
  before insert or update of alias_venue_id, canonical_venue_id
  on public.venue_aliases
  for each row
  execute function public.venue_aliases_forbid_chains();

-- ── 4. RLS: enable + the PRE-059 policy set, BY NAME ─────────────────────────
-- Every name below is load-bearing: 059 drops the fifteen god-mode policies
-- by these names and `alter policy`s three others (no IF EXISTS exists for
-- alter policy, so a wrong name aborts 059 -- the fidelity check).
alter table events              enable row level security;
alter table venues              enable row level security;
alter table organizations       enable row level security;
alter table areas               enable row level security;
alter table event_venues        enable row level security;
alter table event_areas         enable row level security;
alter table event_organizations enable row level security;
alter table event_categories    enable row level security;
alter table feedback_posts      enable row level security;
alter table subscribers         enable row level security;
alter table email_sends         enable row level security;
alter table slack_notifications enable row level security;
alter table embed_requests      enable row level security;
alter table event_aliases       enable row level security;
alter table venue_aliases       enable row level security;
alter table moderation_terms     enable row level security;
alter table moderation_allowlist enable row level security;

-- 030: the term list is never exposed through PostgREST.
revoke all on moderation_terms     from anon, authenticated;
revoke all on moderation_allowlist from anon, authenticated;

-- Public reads (001 / 006 / 008 / 029; no TO clause = PUBLIC role)
create policy "Public can read published events"
  on events for select
  using (status = 'published');
create policy "Public can read venues"
  on venues for select using (true);
create policy "Public can read published organizations"
  on organizations for select
  using (status = 'published');
create policy "Public can read areas"
  on areas for select using (true);
create policy "Public can read event_venues"
  on event_venues for select using (true);
create policy "Public can read event_areas"
  on event_areas for select using (true);
create policy "Public can read event_organizations"
  on event_organizations for select using (true);
create policy "public reads categories of published events"
  on event_categories for select
  using (exists (
    select 1 from events e
    where e.id = event_categories.event_id and e.status = 'published'
  ));

-- The fifteen policies 059 narrows, verbatim shapes (001/006/038/041/044/050/051)
create policy "Authenticated users have full event access"
  on events for all
  to authenticated
  using (true) with check (true);
create policy "Authenticated users have full venue access"
  on venues for all
  to authenticated
  using (true) with check (true);
create policy "Authenticated users have full organization access"
  on organizations for all
  to authenticated
  using (true) with check (true);
create policy "Authenticated users have full area access"
  on areas for all
  to authenticated
  using (true) with check (true);
create policy "Authenticated users have full event_venues access"
  on event_venues for all to authenticated
  using (true) with check (true);
create policy "Authenticated users have full event_areas access"
  on event_areas for all to authenticated
  using (true) with check (true);
create policy "Authenticated users have full event_organizations access"
  on event_organizations for all to authenticated
  using (true) with check (true);
create policy "Authenticated full access event_categories"
  on event_categories for all to authenticated
  using (true) with check (true);
create policy "Authenticated full access feedback_posts"
  on feedback_posts for all to authenticated
  using (true) with check (true);
create policy "Authenticated can read subscribers"
  on subscribers for select to authenticated
  using (true);
create policy "Authenticated can read email_sends"
  on email_sends for select to authenticated
  using (true);
create policy "Authenticated can read embed_requests"
  on embed_requests for select to authenticated
  using (true);
create policy "Authenticated can read slack_notifications"
  on slack_notifications for select to authenticated
  using (true);
create policy "Authenticated can read event_aliases"
  on public.event_aliases for select to authenticated
  using (true);
create policy "Authenticated can read venue_aliases"
  on public.venue_aliases
  for select
  to authenticated
  using (true);

-- The public write surface, post-054 net state (054 widened six INSERT
-- policies to anon, authenticated)
create policy "Anon can insert pending events"
  on events for insert to anon, authenticated
  with check (
    status in ('pending_review', 'cancelled')
    and source = 'manual'
    and coalesce(featured, false) = false
  );
create policy "Anon can insert pending venues"
  on venues for insert
  to anon, authenticated
  with check (status = 'pending_review');
create policy "Anon can insert pending organizations"
  on organizations for insert
  to anon, authenticated
  with check (status = 'pending_review');
create policy "Anon can subscribe"
  on subscribers for insert to anon, authenticated
  with check (true);
create policy "Anon can insert feedback"
  on feedback_posts for insert to anon, authenticated
  with check (
    is_private = true
    and coalesce(votes, 0) = 0
    and image_url is null
    and category = 'orb'
    and char_length(body) between 1 and 1000
    and status in ('published','pending_review','cancelled')
  );
create policy "Anon can request an embed"
  on embed_requests for insert to anon, authenticated
  with check (
    status = 'new'
    and notified_at is null
    and embed_path is null
  );

-- The FIVE anon-only INSERT policies 054 left standing. 059 widens the first
-- two (by ALTER POLICY, name-sensitive) and drops the last three (audit M1).
create policy "Anon can insert areas for pending venues"
  on areas for insert
  to anon
  with check (true);
create policy "Anon can insert event_categories for pending events"
  on event_categories for insert to anon
  with check (event_is_pending_review(event_id));
create policy "Anon can insert event_venues"
  on event_venues for insert
  to anon
  with check (true);
create policy "Anon can insert event_organizations"
  on event_organizations for insert
  to anon
  with check (true);
create policy "Anon can insert event_areas"
  on event_areas for insert
  to anon
  with check (true);

-- 038, altered by 059 section 4b (name-sensitive)
create policy "Public read published non-private feedback"
  on feedback_posts for select to anon
  using (status = 'published' and is_private = false);

commit;
