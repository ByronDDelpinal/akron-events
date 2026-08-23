-- ════════════════════════════════════════════════════════════════════════════
-- 061_partner_accounts.sql
--
-- FEATURE: partner accounts (ADR-partner-accounts-2026-08-21 rev 3, Option B
-- Phase 2; implementation design partner-design.md 2026-08-23). Numbered 061,
-- not the ADR's 060, because 060_reviewed_at.sql took the number (design D1).
--
-- WHAT THIS IS. Introduces the second authorization principal: a PARTNER, a
-- Supabase Auth user holding one or more live rows in partner_memberships.
-- Partners READ their orgs' events (any-of over event_organizations, including
-- pending_review rows) through three new scoped SELECT policies, and WRITE
-- exclusively through six SECURITY DEFINER RPCs. There is NO partner INSERT,
-- UPDATE or DELETE policy on any table, ever (ADR §6.3). Read is any-of,
-- write is all-of on co-hosted events, enforced in exactly one function
-- (partner_may_write_event, ADR §6.8). p_org is a claim to be verified, never
-- trusted (ADR §6.9).
--
-- ⚠️  PRECONDITION (ADR §3.3 / design D2): the anon INSERT policies on
--     event_venues / event_organizations / event_areas must be GONE before
--     this applies. 059 shipped the drops and they are verified live, but the
--     scope edge being unwritable is what every check below quantifies over,
--     so re-verify against drift before applying:
--
--       select policyname, roles, cmd from pg_policies
--        where tablename = 'event_organizations';
--
--     Expected: exactly two rows -- the public SELECT (006:152-153) and
--     "Admin full access event_organizations" (059). Any anon INSERT row
--     means STOP: the database has drifted and this migration must not apply.
--
-- ⚠️  LOCKOUT NOTES: none. This migration is INERT on apply: partner_orgs has
--     zero rows, so partner_scope() returns '{}' for every principal, every
--     new policy matches nothing, and every RPC refuses. Admin and public
--     surfaces are untouched (no existing policy is dropped or altered).
--
-- ⚠️  DO NOT APPLY DURING THE NIGHTLY SCRAPE WINDOW. `create policy` takes
--     ACCESS EXCLUSIVE held to commit. This migration creates policies on
--     events, organizations, event_categories, partner_orgs and
--     partner_memberships -- five tables, far fewer than 059's fifteen, but
--     `events` is the hot one and the nightly scrape holds row locks on it
--     (2026-08-21's run finished 03:39 UTC). Apply clear of 01:30-04:00 UTC,
--     same as 059/060. The 5s lock_timeout below fails fast rather than
--     stalling the site behind a scrape upsert.
--
-- ROLLBACK: supabase/rollbacks/061_partner_accounts_rollback.sql, written at
-- the same time as this file. Rollback scripts NEVER live in
-- supabase/migrations/ -- `supabase db push` applies anything in migrations/,
-- and the first 059 push self-undid 059 that way (recovery needed
-- `migration repair --status reverted`). Before reaching for the rollback,
-- note the cheaper lever it documents: `update partner_orgs set active =
-- false` empties every partner's scope on their next query, reversibly.
--
-- DO NOT APPLY THIS MIGRATION. The maintainer applies migrations himself.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Fail fast instead of stalling the site behind a scrape writer (059's rule).
set local lock_timeout = '5s';

-- ── 1. Tables ────────────────────────────────────────────────────────────────
-- ADR §6.2 DDL with two additions (design §2.1): partner_memberships.email
-- (display copy for the Partners UI -- auth.users is not reachable from the
-- admin UI; the admin_users precedent) and a slug format CHECK (the slug
-- becomes a PERMANENT events.source value, 'partner:<slug>', on everything
-- the tenant creates -- see section 5; changing it later strands attribution).

create table partner_orgs (
  organization_id uuid primary key references organizations(id) on delete cascade,
  slug            text not null unique
                    check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  active          boolean not null default true,
  auto_publish    boolean not null default false,  -- per-TENANT lever, ADR §6.9
  created_at      timestamptz not null default now()
);

comment on table partner_orgs is
  'Partner TENANTS: one row per organization managed by partner accounts. '
  'active = false suspends the whole tenant in one UPDATE (every member loses '
  'it from partner_scope() on their next query). auto_publish is the per-tenant '
  'review lever (ADR §6.9): false means partner-created/published events land '
  'in pending_review for admin review.';

create table partner_memberships (
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references partner_orgs(organization_id) on delete cascade,
  email           text not null,           -- display copy for the Partners UI; admin_users precedent
  role            text not null default 'editor' check (role in ('editor')),
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  primary key (user_id, organization_id)   -- N orgs per user, N users per org. Both intended.
);

comment on table partner_memberships is
  'THE UNIT OF GRANT IS A MEMBERSHIP, NOT A USER (ADR §6.7). Revocation is '
  '`set revoked_at = now()` on ONE composite-PK row, never DELETE: the row is '
  'the audit trail of who had access when, and partial revocation ("lost the '
  'Exchange House, kept the CDC") must be a row, not an absence of a row '
  '(ADR §6.2). Takes effect on the principal''s next query; no re-login.';

create index partner_memberships_user_idx
  on partner_memberships (user_id) where revoked_at is null;

alter table partner_orgs        enable row level security;
alter table partner_memberships enable row level security;
revoke all on partner_orgs, partner_memberships from anon, authenticated;

-- ── 2. Helper functions (partner_scope first -- everything reads it) ─────────
-- All bodies are the ADR's verbatim (they carry two independent QA
-- verifications; do not re-derive). All SECURITY DEFINER + set search_path,
-- the is_admin()/052 house pattern. Grants are collected in section 6.

-- 2.1 partner_scope() -- the caller's live, active org set.
--
-- The `p.active` filter is LOAD-BEARING (ADR §6.9 "correct by accident"
-- note): an inactive org simply never appears in the array, and every
-- downstream check -- the read policies, all six RPCs, the co-host rule --
-- inherits that for free. Do not refactor it away while tidying.
--
-- The body is deliberately FLAT. Do NOT refactor it to call
-- partner_org_context() (or vice versa): partner_scope()'s once-per-query
-- InitPlan behaviour is measured for the flat body (ADR §6.2.1, twice,
-- independently), and nesting a set-returning definer function inside it is
-- exactly the kind of change that quietly turns a run-time constant into
-- something the planner re-evaluates. The two functions duplicate one WHERE
-- clause on purpose; test M11 in partner_accounts_rls.test.sql keeps the
-- duplication honest.
create or replace function partner_scope()
returns uuid[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(m.organization_id), '{}'::uuid[])
  from partner_memberships m
  join partner_orgs p on p.organization_id = m.organization_id
  where m.user_id = auth.uid()
    and m.revoked_at is null
    and p.active
$$;

-- 2.2 partner_org_context() -- the partner UI's org list (read RPC, ADR §6.2.2).
--
-- Scoped by auth.uid() inside the definer body, never by a caller argument.
-- The column list is an ALLOWLIST: organizations.contact_email stays off it,
-- deliberately. Duplicates partner_scope()'s WHERE clause -- see the comment
-- there; test M11 asserts the two agree.
create or replace function partner_org_context()
returns table (organization_id uuid, name text, slug text, auto_publish boolean)
language sql stable security definer set search_path = public
as $$
  select o.id, o.name, p.slug, p.auto_publish
  from partner_memberships m
  join partner_orgs   p on p.organization_id = m.organization_id
  join organizations  o on o.id              = m.organization_id
  where m.user_id = auth.uid()
    and m.revoked_at is null
    and p.active
  order by o.name
$$;

-- 2.3 partner_may_write_event() -- THE write rule, in exactly one place.
--
-- Any-of read, ALL-OF write (ADR §6.8). Clause (2) supplies the non-vacuity
-- that clause (3) cannot supply for itself: a bare all-of check is VACUOUSLY
-- TRUE for an event with zero event_organizations rows, and orphan events are
-- reachable (EventEditPage.tsx deletes all links before re-inserting).
-- Clause (2) is also the anti-laundering guard (ADR §6.9 rule 3): without it,
-- p_org's auto_publish would be attacker-selected.
--
-- QA truth table (ADR §6.8, confirmed by two independent implementations --
-- pasted as expected values into partner_accounts_rls.test.sql block 5, do
-- not re-derive). Fixture: P holds orgs A and A2; B is another tenant; C is
-- a tenant with active = false that P is a member of:
--
--       event          | as p_org = A | as p_org = A2
--       ---------------+--------------+---------------
--       A only         | t            | f
--       A+A2 co-host   | t            | t
--       A+B co-host    | f            | f
--       A2 only        | f            | t
--       ORPHAN         | f            | f
--
-- Empty scope fails closed. C's inactivity keeps it out of scope entirely.
--
-- Three-valued-logic note (ADR §6.8): `<> all (partner_scope())` would return
-- NULL, not TRUE, if organization_id were ever NULL -- but
-- event_organizations.organization_id is NOT NULL (006:145). Do not remove
-- that NOT NULL without revisiting this.
--
-- Ordering is the cheap-first ordering: (1) array membership on an
-- already-materialized array, (2) a primary-key probe, (3) an index scan.
create or replace function partner_may_write_event(p_org uuid, p_event uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    -- (1) the caller is a live member of the org they claim to act as
    p_org = any (partner_scope())
    -- (2) that org is actually linked to this event  [anti-laundering, §6.9]
    and exists (select 1 from event_organizations eo
                 where eo.event_id = p_event and eo.organization_id = p_org)
    -- (3) ALL-OF: no co-host sits outside the caller's scope
    and not exists (select 1 from event_organizations eo
                     where eo.event_id = p_event
                       and eo.organization_id <> all (partner_scope()))
$$;

-- 2.4 partner_may_create_for_org() -- clause (1) alone, named, for the create
-- path (ADR §6.3.1). One rule, one home. Empty scope fails closed for free
-- (`p_org = any ('{}')` is false); tests M8/N9 assert it anyway, because
-- "for free" is a property of an expression somebody may later rewrite.
create or replace function partner_may_create_for_org(p_org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_org = any (partner_scope())
$$;

-- 2.5 admin_lookup_auth_user() -- Partners-UI helper (design §2.2 #5, new
-- under deviation D7). Turns "add dana@northhillcdc.org" into a user_id
-- without a dashboard trip. SECURITY DEFINER because it reads the auth
-- schema; the gate is INSIDE (is_admin() or raise), so granting execute to
-- authenticated is what lets the admin's session call it over PostgREST
-- while a non-admin caller gets an exception, never a row. Returns NULL for
-- no-match: the UI then tells the admin to create the auth user in the
-- Supabase dashboard first (invite flow, ADR §6.7 step 1, unchanged --
-- public sign-up stays off, permanently).
create or replace function admin_lookup_auth_user(p_email text)
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare v_id uuid;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;
  select u.id into v_id
    from auth.users u
   where lower(u.email) = lower(trim(p_email));
  return v_id;
end;
$$;

-- ── 3. Partner SELECT policies ───────────────────────────────────────────────
-- Any-of read (ADR §6.8: "if you co-host it, you can see it").
--
-- IDIOM NOTE, load-bearing (ADR §6.2.1, measured twice, independently): the
-- predicate uses the BARE ARRAY form `= any (partner_scope())`. The
-- Supabase-documented `(select auth.uid())` wrapper does NOT apply here --
-- `= any (select partner_scope())` is the SUBQUERY form of ANY and raises
-- `operator does not exist: uuid = uuid[]`; the double-paren variant fails
-- identically. And the wrapper buys nothing: a zero-argument STABLE function
-- is already evaluated once per scan (2 invocations measured across a full
-- RLS-filtered scan of 8,249 events, not 8,249). Do not "fix" this.

-- events: a partner sees every event linked to any org in their scope,
-- INCLUDING their pending_review / cancelled ones. Published events were
-- already visible via "Public can read published events" (001, no TO clause);
-- this policy's marginal grant is exactly the non-published rows in scope.
--
-- RETURNING/refetch note (house rule): partner clients never direct-write, so
-- "DELETE and INSERT...RETURNING require SELECT visibility" bites only inside
-- the RPCs -- which run as definer and bypass RLS. The one place it matters
-- for partners: after partner_upsert_event returns an id, the client
-- re-fetches the row via PostgREST, and THIS policy is what makes that fetch
-- return the pending row. Test M10(e) covers it.
create policy "Partner reads own org events"
  on events for select to authenticated
  using (exists (
    select 1 from event_organizations eo
    where eo.event_id = events.id
      and eo.organization_id = any (partner_scope())
  ));

-- organizations: partner sees their own org rows even when not published.
-- SELECT only. There is NO partner UPDATE policy on organizations in v1
-- (ADR §6.6 ruling, accepted; test N13 pins it): an UPDATE policy would carry
-- status, contact_email and manual_overrides along with name -- RLS has no
-- column granularity. Org-profile editing, if ever wanted, is a seventh RPC
-- with its own allowlist, never a policy.
create policy "Partner reads own org rows"
  on organizations for select to authenticated
  using (id = any (partner_scope()));

-- event_categories: the public policy (029) only covers categories of
-- PUBLISHED events, so without this the partner drawer cannot show the tags
-- on their own pending rows.
create policy "Partner reads categories of own org events"
  on event_categories for select to authenticated
  using (exists (
    select 1 from event_organizations eo
    where eo.event_id = event_categories.event_id
      and eo.organization_id = any (partner_scope())
  ));

-- NO partner policy on event_venues / event_areas / venues is needed, and
-- none should be added later: the 006 public SELECT policies on the junctions
-- and 001's "Public can read venues" (`using (true)`, never narrowed) already
-- cover nested reads for any event the partner can see. A redundant policy
-- here would be one more predicate to keep in sync for zero marginal grant.

-- ── 4. Admin policies + grants on the partner tables (deviation D7) ──────────
-- Deviation from ADR §6.2's blanket revoke, recorded there and here: the
-- Pulse Control Partners section manages this roster over PostgREST (roster
-- is DATA, the admin_users precedent -- onboarding/offboarding must never
-- need a migration), so the admin principal needs table access. anon:
-- nothing. Non-admin authenticated: nothing (the policies below evaluate
-- false). Partners reach their own memberships ONLY through
-- partner_org_context(). The security posture the ADR's revoke was buying is
-- preserved.
grant select, insert, update on partner_orgs        to authenticated;
grant select, insert, update on partner_memberships to authenticated;
-- No DELETE grant on either: revocation is `revoked_at` (audit trail,
-- ADR §6.2), tenant shutdown is `active = false`. Hard deletes are a
-- SQL-editor decision, deliberately not a UI affordance.

create policy "Admin full access partner_orgs"
  on partner_orgs for all to authenticated
  using (is_admin()) with check (is_admin());
create policy "Admin full access partner_memberships"
  on partner_memberships for all to authenticated
  using (is_admin()) with check (is_admin());

-- ── 5. The venue-mint guard, then the six RPCs ───────────────────────────────

-- 5.0a partner_fold_whitespace() -- JS \s parity (review finding, 2026-08-23).
--
-- JavaScript's \s matches Unicode whitespace (NBSP U+00A0, OGHAM U+1680, the
-- U+2000..U+200A spaces, LSEP/PSEP U+2028/29, NNBSP U+202F, MMSP U+205F,
-- IDEOGRAPHIC U+3000, and ZERO WIDTH NO-BREAK SPACE U+FEFF); Postgres's \s
-- matches only ASCII whitespace. Without this fold, "Ohio<nbsp>" slides past
-- the state-name check that isJunkVenueName catches -- a junk venue minted
-- through the exact divergence the shared case table exists to prevent. This
-- helper folds EXACTLY the JS \s set (no more: U+200B zero-width space is NOT
-- JS whitespace, and neither implementation folds it) to a single ASCII
-- space. Used by partner_venue_name_blocked() AND partner_mint_venue()'s name
-- normalization, so the two can never disagree about what a space is. The
-- non-ASCII rows of the shared case table pin the parity from both sides.
-- Definer-internal; no grant.
create or replace function partner_fold_whitespace(p_text text)
returns text
language sql immutable set search_path = public
as $$
  select regexp_replace(p_text,
           '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
           ' ', 'g')
$$;

-- 5.0 partner_venue_name_blocked() -- the mint-time guard (the LAW, design
-- §3.4). Pure (immutable), no table access, SECURITY INVOKER (no privileged
-- reads; search_path pinned anyway for uniformity). Returns a human-readable
-- refusal reason, or NULL when the name may mint. Definer-internal to
-- partner_mint_venue; no grant.
--
-- DRIFT CONTROL: the token lists below are DUPLICATED from
-- scripts/lib/normalize.js (US_STATE_NAMES, VIRTUAL_MARKERS,
-- STREET_SUFFIX_MAP / STREET_SUFFIXES) by necessity -- SQL cannot import JS.
-- scripts/tests/test-partner-venue-guard.js holds the shared case table
-- (scripts/tests/fixtures/partner-venue-guard-cases.js) and asserts
-- isJunkVenueName / looksLikeStreetAddress agree with it; test block M13 of
-- supabase/tests/partner_accounts_rls.test.sql asserts THIS function against
-- the same table, row for row. Change any list here, or in normalize.js, and
-- one of the two tests goes red until the other side moves too (the ADR
-- §6.2.2 "duplicate + test, never refactor" discipline).
--
-- Families mirror normalize.js exactly:
--   1. bare US state name              (isJunkVenueName family 1)
--   2. virtual/placeholder marker      (isJunkVenueName family 2)
--   3. house-number-less street fragment: <= 3 digit-free tokens whose LAST
--      token is a recognized street suffix (isJunkVenueName family 3)
--   4. address-shaped name: leading house number + a street-suffix token
--      (looksLikeStreetAddress). Partners get NO allowAddressName escape
--      hatch: the refusal tells them to type the venue's NAME and put the
--      address in the address field.
create or replace function partner_venue_name_blocked(p_name text)
returns text
language plpgsql immutable set search_path = public
as $$
declare
  v_key    text;
  v_tokens text[];
  v_words  text[];
  v_last   text;
  v_w      text;
  -- STREET_SUFFIX_MAP from normalize.js, verbatim (copied at build time).
  v_suffix_map constant jsonb := '{
    "boulevard":"blvd","blvd":"blvd",
    "street":"st","st":"st","str":"st",
    "avenue":"ave","ave":"ave","av":"ave",
    "road":"rd","rd":"rd",
    "drive":"dr","dr":"dr",
    "lane":"ln","ln":"ln",
    "court":"ct","ct":"ct",
    "place":"pl","pl":"pl",
    "parkway":"pkwy","pkwy":"pkwy",
    "highway":"hwy","hwy":"hwy",
    "terrace":"ter","ter":"ter",
    "circle":"cir","cir":"cir",
    "square":"sq","sq":"sq",
    "trail":"trl","trl":"trl",
    "way":"way"
  }'::jsonb;
  -- STREET_SUFFIXES = the distinct values of the map above.
  v_suffixes constant text[] := array[
    'blvd','st','ave','rd','dr','ln','ct','pl','pkwy','hwy','ter','cir','sq','trl','way'];
  -- US_STATE_NAMES from normalize.js, verbatim.
  v_states constant text[] := array[
    'alabama','alaska','arizona','arkansas','california','colorado',
    'connecticut','delaware','florida','georgia','hawaii','idaho',
    'illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
    'maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey',
    'new mexico','new york','north carolina','north dakota','ohio',
    'oklahoma','oregon','pennsylvania','rhode island','south carolina',
    'south dakota','tennessee','texas','utah','vermont','virginia',
    'washington','west virginia','wisconsin','wyoming'];
  -- VIRTUAL_MARKERS from normalize.js, verbatim.
  v_virtual constant text[] := array[
    'virtual','online','virtual event','online event','webinar','zoom',
    'livestream','tbd','tba'];
begin
  if p_name is null then return null; end if;
  -- partner_fold_whitespace, not a bare \s collapse: JS \s matches Unicode
  -- whitespace and Postgres \s does not, and "Ohio<nbsp>" must not slide
  -- past a check isJunkVenueName catches (review finding 2026-08-23; the
  -- non-ASCII rows of the shared case table pin this).
  v_key := lower(trim(partner_fold_whitespace(p_name)));
  if v_key = '' then return null; end if;

  -- family 1: bare US state name
  if v_key = any (v_states) then
    return 'That looks like a state name, not a venue. Type the venue''s name.';
  end if;

  -- family 2: virtual/placeholder marker
  if v_key = any (v_virtual) then
    return 'Virtual and placeholder locations are not venues. Leave the venue empty instead.';
  end if;

  -- family 4: address-shaped name (leading house number + street suffix).
  -- Mirrors looksLikeStreetAddress: take the text before the first comma,
  -- strip punctuation, require a leading house number AND a recognized
  -- street-suffix token, so number-led venue names ("Lock 3", "1865
  -- Brewing") pass.
  v_words := regexp_split_to_array(
               trim(regexp_replace(lower(split_part(v_key, ',', 1)),
                                   '[^a-z0-9\s]', ' ', 'g')), '\s+');
  if array_length(v_words, 1) >= 2 and v_words[1] ~ '^\d+[a-z]?$' then
    foreach v_w in array v_words loop
      if coalesce(v_suffix_map ->> v_w, v_w) = any (v_suffixes) then
        return 'That looks like a street address, not a venue name. Type the venue''s name and put the address in the address field.';
      end if;
    end loop;
  end if;

  -- family 3: house-number-less street fragment. Digit-bearing strings are
  -- family 4's territory (or legit number-led names) -- never ours.
  if v_key !~ '\d' then
    v_tokens := array(select t from unnest(regexp_split_to_array(
                  trim(regexp_replace(v_key, '[^a-z\s]', ' ', 'g')), '\s+')) t
                  where t <> '');
    if array_length(v_tokens, 1) between 1 and 3 then
      v_last := v_tokens[array_length(v_tokens, 1)];
      if coalesce(v_suffix_map ->> v_last, v_last) = any (v_suffixes) then
        return 'That looks like a street name without a number, not a venue name. Type the venue''s name and put the address in the address field.';
      end if;
    end if;
  end if;

  return null;
end;
$$;

-- 5.1 partner_upsert_event() -- create (p_event NULL) or update. Design §3.1
-- / §3.2; ADR §6.3.1 / §6.3.2.
--
-- Column allowlist (design §3.3 -- RLS has no column granularity, so THIS
-- loop is the enforcement point): title, description, start_at, end_at,
-- price_min, price_max, age_restriction, ticket_url, source_url, image_url.
-- Everything else raises invalid_parameter_value naming the key -- a typo'd
-- column must never be silently dropped, and `featured` / `status` / `source`
-- / `source_id` / `needs_review` / `reviewed_at` / `reviewed_by` /
-- `manual_overrides` / `is_family` / `is_fundraiser` / `banner_eligible` /
-- `tags` / `slug` / `category_slugs` / schema.org fields are NEVER partner
-- writable (tests N6/N7/N8). featured is a human-ADMIN-only editorial call:
-- hard-set false on create, never touched after.
--
-- Override stamping (design D10, mandatory twice over): every field set gets
-- manual_overrides[field] = {"at": now()} merged SERVER-SIDE onto the row's
-- existing overrides, in the SAME update. (a) ADR §6.5 rules 1/2: the edit
-- must survive re-scrape and any future importer; (b) the live
-- trg_enforce_manual_overrides_events BEFORE UPDATE trigger silently RESTORES
-- any pinned column whose overrides key is not re-stamped with a different
-- value -- a fresh timestamp is always a different value, so partner edits go
-- through on previously-pinned columns too. NEVER set app.bypass_overrides in
-- these functions.
--
-- Stamps use clock_timestamp(), NOT now(): now() is frozen per transaction,
-- so a second write to the same key within one transaction (create then
-- publish, or two status changes) would re-stamp with an IDENTICAL value and
-- the trigger would silently revert the column. clock_timestamp() keeps the
-- "always a different value" premise true unconditionally. Test M10(e)
-- exercises exactly this sequence and fails if this ever regresses to now().
--
-- Create-vs-update guards (ADR §6.3.1, easy to omit): create is reachable
-- ONLY via p_event IS NULL. The update branch checks scope BEFORE row
-- existence -- partner_may_write_event returns false for both "not yours" and
-- "does not exist" (clause 2 fails), one indistinguishable refusal, so
-- probing a foreign UUID is not an existence oracle. Correct and deliberate.
create or replace function partner_upsert_event(
  p_org        uuid,
  p_event      uuid,
  p_patch      jsonb,
  p_venue      uuid   default null,
  p_categories text[] default null
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_key  text;
  v_val  jsonb;
  v_title text;       v_has_title bool := false;
  v_desc  text;       v_has_desc  bool := false;
  v_start timestamptz; v_has_start bool := false;
  v_end   timestamptz; v_has_end   bool := false;
  v_pmin  numeric;    v_has_pmin  bool := false;
  v_pmax  numeric;    v_has_pmax  bool := false;
  v_age   text;       v_has_age   bool := false;
  v_turl  text;       v_has_turl  bool := false;
  v_surl  text;       v_has_surl  bool := false;
  v_iurl  text;       v_has_iurl  bool := false;
  v_stamp jsonb := '{}'::jsonb;
  v_now   timestamptz := clock_timestamp();  -- NOT now(): see the D10 stamp note above
  v_slugs text[];
  v_slug  text;
  v_auto  boolean;
  v_id    uuid;
  v_status text;
  v_may_publish boolean;
  v_blocker text;
  v_row   events%rowtype;
  v_eff_start timestamptz;
  v_eff_pmin  numeric;
begin
  if p_org is null then
    raise exception 'missing argument p_org' using errcode = 'null_value_not_allowed';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'p_patch must be a JSON object' using errcode = 'invalid_parameter_value';
  end if;

  -- Validate the patch against the column allowlist and build the override
  -- stamp. One typed local per column, one static UPDATE/INSERT below --
  -- never dynamic SQL from patch keys.
  for v_key, v_val in select * from jsonb_each(p_patch) loop
    case v_key
      when 'title' then
        v_title := nullif(trim(p_patch ->> 'title'), '');
        if v_title is null or length(v_title) > 200 then
          raise exception 'title must be 1 to 200 characters'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_title := true;
      when 'description' then
        v_desc := p_patch ->> 'description';
        v_has_desc := true;
      when 'start_at' then
        v_start := (p_patch ->> 'start_at')::timestamptz;
        if v_start is null then
          raise exception 'start_at must be a timestamp'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_start := true;
      when 'end_at' then
        v_end := (p_patch ->> 'end_at')::timestamptz;  -- null allowed; > start checked below
        v_has_end := true;
      when 'price_min' then
        v_pmin := coalesce((p_patch ->> 'price_min')::numeric, 0);
        if v_pmin < 0 then
          raise exception 'price_min must be 0 or more'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_pmin := true;
      when 'price_max' then
        v_pmax := (p_patch ->> 'price_max')::numeric;  -- null allowed; >= price_min checked below
        v_has_pmax := true;
      when 'age_restriction' then
        v_age := p_patch ->> 'age_restriction';
        if v_age is null or v_age not in ('not_specified','all_ages','18_plus','21_plus') then
          raise exception 'age_restriction must be one of not_specified, all_ages, 18_plus, 21_plus'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_age := true;
      when 'ticket_url' then
        v_turl := nullif(trim(p_patch ->> 'ticket_url'), '');
        if v_turl is not null and (v_turl !~ '^https?://' or length(v_turl) > 2048) then
          raise exception 'ticket_url must start with http:// or https://'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_turl := true;
      when 'source_url' then
        v_surl := nullif(trim(p_patch ->> 'source_url'), '');
        if v_surl is not null and (v_surl !~ '^https?://' or length(v_surl) > 2048) then
          raise exception 'source_url must start with http:// or https://'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_surl := true;
      when 'image_url' then
        v_iurl := nullif(trim(p_patch ->> 'image_url'), '');
        if v_iurl is not null and (v_iurl !~ '^https?://' or length(v_iurl) > 2048) then
          raise exception 'image_url must start with http:// or https://'
            using errcode = 'invalid_parameter_value';
        end if;
        v_has_iurl := true;
      else
        -- The refusal that keeps `featured`, `status`, `source`, `source_id`
        -- and friends unreachable. Message names the key (tests N6/N7/N8).
        raise exception 'field "%" cannot be set here', v_key
          using errcode = 'invalid_parameter_value';
    end case;
    v_stamp := v_stamp || jsonb_build_object(v_key, jsonb_build_object('at', v_now));
  end loop;

  -- Categories are validated once, used by both branches.
  if p_categories is not null then
    select array_agg(distinct s) into v_slugs from unnest(p_categories) s;
    if v_slugs is null or array_length(v_slugs, 1) not between 1 and 2 then
      raise exception 'choose one or two categories'
        using errcode = 'invalid_parameter_value';
    end if;
    v_stamp := v_stamp || jsonb_build_object('category', jsonb_build_object('at', v_now));
  end if;

  -- p_venue belongs to the CREATE branch only (review finding, 2026-08-23).
  -- On update it used to be validated and then silently dropped -- exactly
  -- the class of quiet no-op the allowlist loop above refuses. Decision:
  -- RAISE rather than apply. Venue changes on an existing event go through
  -- partner_set_event_venue, which carries the multi-venue guard; Phase B
  -- deliberately routes the drawer's venue edits there already.
  if p_event is not null and p_venue is not null then
    raise exception 'p_venue only applies when creating an event. Set the venue with partner_set_event_venue.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_venue is not null and not exists (select 1 from venues v where v.id = p_venue) then
    raise exception 'that venue does not exist' using errcode = 'foreign_key_violation';
  end if;

  if p_event is null then
    -- ── CREATE branch (ADR §6.3.1: clause (1) only) ─────────────────────────
    if not partner_may_create_for_org(p_org) then
      raise exception 'you cannot create events for this organization'
        using errcode = 'insufficient_privilege',
              hint = 'partner_scope refusal; see ADR §6.8';
    end if;
    if not v_has_title or not v_has_start then
      raise exception 'title and start_at are required to create an event'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_has_end and v_end is not null and v_end <= v_start then
      raise exception 'end_at must be after start_at' using errcode = 'invalid_parameter_value';
    end if;
    if v_has_pmax and v_pmax is not null and v_pmax < coalesce(v_pmin, 0) then
      raise exception 'price_max must be at least price_min' using errcode = 'invalid_parameter_value';
    end if;

    -- Resolve slug + tenant policy from partner_orgs, NEVER from the client:
    -- a client-supplied slug would be a second way to forge `source`
    -- (ADR §6.5(4)).
    select po.slug, po.auto_publish into v_slug, v_auto
      from partner_orgs po where po.organization_id = p_org;
    v_status := case when v_auto then 'published' else 'pending_review' end;

    -- Create is a human decision: stamp `status` too, uniform with the admin
    -- drawer's withStatusLock, so the row survives any future importer.
    v_stamp := v_stamp || jsonb_build_object('status', jsonb_build_object('at', v_now));

    -- The moderation trigger fires here (caller role is authenticated, not
    -- admin -> screened, the shipped 059 gate incl. its NULL carve-out,
    -- deviation D11). RETURNING reads the post-trigger row, so a demotion is
    -- reported honestly.
    insert into events (title, description, start_at, end_at, price_min, price_max,
                        age_restriction, ticket_url, source_url, image_url,
                        source, source_id, status, featured, manual_overrides)
    values (v_title, v_desc, v_start,
            case when v_has_end then v_end else null end,
            coalesce(v_pmin, 0),
            case when v_has_pmax then v_pmax else null end,
            coalesce(v_age, 'not_specified'),
            v_turl, v_surl, v_iurl,
            'partner:' || v_slug, null, v_status, false, v_stamp)
    returning id, status into v_id, v_status;

    -- THE only partner-reachable write of the scope edge in the entire
    -- design (ADR §6.3.1 step 3), constrained three ways: the event_id was
    -- minted one statement ago (cannot name a pre-existing row), the
    -- organization_id is p_org (verified in scope at step 1), and it runs
    -- exactly once (no co-host can be added). Do NOT relax any of the three,
    -- and do NOT generalize p_patch to carry an org array.
    insert into event_organizations (event_id, organization_id) values (v_id, p_org);

    if p_venue is not null then
      -- Same semantics as partner_set_event_venue minus the write re-check:
      -- the row is one statement old and owned.
      insert into event_venues (event_id, venue_id) values (v_id, p_venue);
    end if;

    if v_slugs is not null then
      begin
        insert into event_categories (event_id, category)
        select v_id, s from unnest(v_slugs) s
        on conflict do nothing;
      exception when check_violation then
        raise exception 'unknown category; valid categories are music, theater, film, comedy, visual-art, food, sports, fitness, outdoors, learning, festival, market, civic, games, other'
          using errcode = 'invalid_parameter_value';
      end;
    end if;

    -- ADR §6.9 rule 2, run as the GENERAL most-restrictive scan even though
    -- create has exactly one linked org (it degenerates to p_org's own flag):
    -- one code path, so a future change allowing co-hosts at create time
    -- cannot silently skip the rule. Runs AFTER the edge insert. A linked org
    -- that is not a partner_orgs row contributes nothing -- auto_publish is a
    -- statement about a TENANT's output and a non-tenant has none.
    select not exists (
      select 1 from event_organizations eo
      join partner_orgs po on po.organization_id = eo.organization_id
      where eo.event_id = v_id and not po.auto_publish)
    into v_may_publish;
    if not v_may_publish and v_status = 'pending_review' then
      select o.name into v_blocker
        from event_organizations eo
        join partner_orgs po on po.organization_id = eo.organization_id
        join organizations o on o.id = eo.organization_id
       where eo.event_id = v_id and not po.auto_publish
       order by o.name limit 1;
    end if;

    return jsonb_build_object('id', v_id, 'status', v_status,
                              'review_required_by', v_blocker);
  else
    -- ── UPDATE branch (ADR §6.3.2: all three clauses) ───────────────────────
    if not partner_may_write_event(p_org, p_event) then
      raise exception 'this event is not editable as this organization'
        using errcode = 'insufficient_privilege',
              hint = 'partner_scope/all-of refusal; see ADR §6.8';
    end if;
    if v_stamp = '{}'::jsonb then
      raise exception 'nothing to update' using errcode = 'invalid_parameter_value';
    end if;
    -- The row exists: clause (2) of partner_may_write_event probed it.
    select * into v_row from events e where e.id = p_event;

    -- Validate the RESULTING row's range: the patched end (or the row's, when
    -- not patched) must stay after the patched start (or the row's). Catches
    -- both a bad end_at and a start_at moved past an existing end_at.
    v_eff_start := case when v_has_start then v_start else v_row.start_at end;
    if (case when v_has_end then v_end else v_row.end_at end) is not null
       and (case when v_has_end then v_end else v_row.end_at end) <= v_eff_start then
      raise exception 'end_at must be after start_at' using errcode = 'invalid_parameter_value';
    end if;
    v_eff_pmin := case when v_has_pmin then v_pmin else coalesce(v_row.price_min, 0) end;
    if v_has_pmax and v_pmax is not null and v_pmax < v_eff_pmin then
      raise exception 'price_max must be at least price_min' using errcode = 'invalid_parameter_value';
    end if;
    if not v_has_pmax and v_row.price_max is not null and v_has_pmin and v_row.price_max < v_eff_pmin then
      raise exception 'price_min cannot exceed the event''s price_max'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_slugs is not null then
      -- Categories ride along on update too (same swap as
      -- partner_set_event_categories; the stamp is already in v_stamp).
      delete from event_categories ec
       where ec.event_id = p_event and ec.category <> all (v_slugs);
      begin
        insert into event_categories (event_id, category)
        select p_event, s from unnest(v_slugs) s
        on conflict do nothing;
      exception when check_violation then
        raise exception 'unknown category; valid categories are music, theater, film, comedy, visual-art, food, sports, fitness, outdoors, learning, festival, market, civic, games, other'
          using errcode = 'invalid_parameter_value';
      end;
    end if;

    -- One static UPDATE. `status` is NOT patchable here (not on the
    -- allowlist; only partner_set_event_status changes it). The 060
    -- trg_events_reopen_review trigger MAY clear reviewed_at when a partner
    -- changes title/start_at on a needs_review row -- ACCEPTED v1 behavior
    -- (a material partner change to a previously-triaged flagged row
    -- deserves another admin look); test M12b pins it as intended. The
    -- moderation trigger also fires on title/description changes and may
    -- demote status; RETURNING reports the actual outcome.
    update events e set
      title           = case when v_has_title then v_title else e.title end,
      description     = case when v_has_desc  then v_desc  else e.description end,
      start_at        = case when v_has_start then v_start else e.start_at end,
      end_at          = case when v_has_end   then v_end   else e.end_at end,
      price_min       = case when v_has_pmin  then v_pmin  else e.price_min end,
      price_max       = case when v_has_pmax  then v_pmax  else e.price_max end,
      age_restriction = case when v_has_age   then v_age   else e.age_restriction end,
      ticket_url      = case when v_has_turl  then v_turl  else e.ticket_url end,
      source_url      = case when v_has_surl  then v_surl  else e.source_url end,
      image_url       = case when v_has_iurl  then v_iurl  else e.image_url end,
      -- The server-side merge (design D10). Never bypass, never replace.
      manual_overrides = coalesce(e.manual_overrides, '{}'::jsonb) || v_stamp
    where e.id = p_event
    returning e.status into v_status;

    return jsonb_build_object('id', p_event, 'status', v_status,
                              'review_required_by', null);
  end if;
end;
$$;

-- 5.2 partner_set_event_status() -- design §3.6; ADR §6.4/§6.9.
-- 'published' and 'cancelled' ONLY: pending_review is never a
-- partner-REQUESTED status (ADR §6.4 -- the QUEUE outcome is the RPC's
-- decision under rule 2, not the caller's request). The partner unlock
-- control (ADR §6.5(3)) is DEFERRED from v1 -- recorded deviation D5: the
-- only live partner has no feed to go back to; revisit when a partner with a
-- live scraper onboards (add partner_unlock_field later, losing nothing).
--
-- Two more gates on the publish path, both review findings (2026-08-23):
--
--   CANCELLED IS FINAL FOR PARTNERS (session-lead product ruling). A partner
--   may cancel an event they can write, but may never move ANY event out of
--   'cancelled' -- their own cancels included. Restoring a cancelled event is
--   an admin-only action. Without this, an admin's takedown of a partner
--   event would not be durable: the RPC's (correct, D10-required) status
--   re-stamp would carry a partner republish straight past the admin's pin.
--
--   FLAGGED ROWS NEVER PUBLISH THROUGH THIS RPC. trg_moderation_events fires
--   only on INSERT / UPDATE OF title, description, tags -- a bare status
--   flip never re-runs the screen, so without this gate a partner on an
--   auto_publish tenant could create flagged text (screen demotes it), then
--   republish it around the screen. A row with needs_review = true, or whose
--   current text the screen would still demote, resolves to pending_review
--   instead: a flagged row is the ADMIN's to clear, exactly as on the create
--   path. Partners stay on the screened side of the 059 gate (D11).
create or replace function partner_set_event_status(
  p_org uuid, p_event uuid, p_status text
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_may_publish boolean;
  v_blocker text;
  v_target text;
  v_status text;
  v_row events%rowtype;
begin
  if p_org is null or p_event is null or p_status is null then
    raise exception 'missing argument' using errcode = 'null_value_not_allowed';
  end if;
  if p_status not in ('published','cancelled') then
    raise exception 'status must be published or cancelled'
      using errcode = 'invalid_parameter_value';
  end if;
  if not partner_may_write_event(p_org, p_event) then
    raise exception 'this event is not editable as this organization'
      using errcode = 'insufficient_privilege',
            hint = 'partner_scope/all-of refusal; see ADR §6.8';
  end if;

  select * into v_row from events e where e.id = p_event;

  if p_status = 'published' then
    -- Cancelled is final for partners (see the header note). Restoring is an
    -- Akron Pulse action, full stop.
    if v_row.status = 'cancelled' then
      raise exception 'this event is cancelled. Cancellation is permanent; contact Akron Pulse to restore it.'
        using errcode = 'insufficient_privilege';
    end if;

    -- ADR §6.9 rule 2: the most restrictive linked TENANT wins, across ALL
    -- linked orgs including ones the caller is not a member of (safe: definer
    -- context, returns a boolean and one org NAME, never a row). A linked org
    -- with no partner_orgs row contributes nothing.
    select not exists (
      select 1 from event_organizations eo
      join partner_orgs po on po.organization_id = eo.organization_id
      where eo.event_id = p_event and not po.auto_publish)
    into v_may_publish;

    if v_may_publish then
      v_target := 'published';
    else
      -- Loud, not silent (ADR §6.9): the caller is told the outcome AND which
      -- org forced it -- the blocking org may be a co-host the caller cannot
      -- look up, so the RPC must return the name.
      v_target := 'pending_review';
      select o.name into v_blocker
        from event_organizations eo
        join partner_orgs po on po.organization_id = eo.organization_id
        join organizations o on o.id = eo.organization_id
       where eo.event_id = p_event and not po.auto_publish
       order by o.name limit 1;
    end if;

    -- The moderation gate (see the header note): a flagged row, or one whose
    -- text would still flag, goes to review instead of publication.
    -- review_required_by stays as computed: when moderation (not a tenant's
    -- auto_publish) is the cause, it is null, matching the create path.
    if v_target = 'published'
       and (v_row.needs_review
            or moderation_severity(concat_ws(' ', v_row.title, v_row.description,
                                             array_to_string(v_row.tags, ' '))) is not null)
    then
      v_target := 'pending_review';
    end if;
  else
    v_target := 'cancelled';  -- always allowed within the write rule
  end if;

  -- Status change + the status lock stamp in ONE update: consistent with the
  -- admin drawer's withStatusLock, and required by D10 for rows whose status
  -- is already pinned (re-stamping with a different value lets the write
  -- through the enforce_manual_overrides trigger). Never stamps reviewed_at
  -- (admin triage fact; partner paths never touch it).
  update events e
     set status = v_target,
         manual_overrides = coalesce(e.manual_overrides, '{}'::jsonb)
                            || jsonb_build_object('status', jsonb_build_object('at', clock_timestamp()))
   where e.id = p_event
   returning e.status into v_status;

  return jsonb_build_object('id', p_event, 'status', v_status,
                            'review_required_by', v_blocker);
end;
$$;

-- 5.3 partner_set_event_categories() -- design §3.7. Transactional swap:
-- inside one function = one transaction, so the count-between-statements
-- dance the admin drawer performs client-side (its persistCategories
-- interleave, written to appease the 029 max-2 AFTER trigger without a
-- transaction) is unnecessary here; the AFTER trigger fires per row, so
-- delete-first ordering keeps the count <= 2 at every boundary. The 039
-- slug-sync trigger maintains events.category_slugs automatically.
-- Valid slugs (the 029/037 CHECK is the real gate; this comment is the
-- human-readable copy): music, theater, film, comedy, visual-art, food,
-- sports, fitness, outdoors, learning, festival, market, civic, games, other.
create or replace function partner_set_event_categories(
  p_org uuid, p_event uuid, p_slugs text[]
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_slugs text[];
  v_status text;
begin
  if p_org is null or p_event is null or p_slugs is null then
    raise exception 'missing argument' using errcode = 'null_value_not_allowed';
  end if;
  if not partner_may_write_event(p_org, p_event) then
    raise exception 'this event is not editable as this organization'
      using errcode = 'insufficient_privilege',
            hint = 'partner_scope/all-of refusal; see ADR §6.8';
  end if;

  select array_agg(distinct s) into v_slugs from unnest(p_slugs) s;
  if v_slugs is null or array_length(v_slugs, 1) not between 1 and 2 then
    raise exception 'choose one or two categories'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from event_categories ec
   where ec.event_id = p_event and ec.category <> all (v_slugs);
  begin
    insert into event_categories (event_id, category)
    select p_event, s from unnest(v_slugs) s
    on conflict do nothing;
  exception when check_violation then
    raise exception 'unknown category; valid categories are music, theater, film, comedy, visual-art, food, sports, fitness, outdoors, learning, festival, market, civic, games, other'
      using errcode = 'invalid_parameter_value';
  end;

  -- The category lock, exactly as the admin drawer stamps it: key stays
  -- `category` (the scraper checks key presence; the drawer's canonical
  -- choice). NO reviewed_at / needs_review change -- clearing the review flag
  -- is admin triage, not a partner action.
  update events e
     set manual_overrides = coalesce(e.manual_overrides, '{}'::jsonb)
                            || jsonb_build_object('category', jsonb_build_object('at', clock_timestamp()))
   where e.id = p_event
   returning e.status into v_status;

  return jsonb_build_object('id', p_event, 'status', v_status,
                            'review_required_by', null);
end;
$$;

-- 5.4 partner_set_event_venue() -- design §3.5. SET-the-venue semantics, not
-- add-a-link (ADR §6.3 named it partner_link_event_venue; renamed because v1
-- semantics are replace). event_venues is NOT the authorization edge --
-- deleting a venue link moves no scope -- which is why delete-then-insert is
-- safe HERE where the same shape on event_organizations would be catastrophic
-- (ADR §6.3 problem 3). Areas (event_areas) are out of partner v1 entirely.
create or replace function partner_set_event_venue(
  p_org uuid, p_event uuid, p_venue uuid
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_status text;
begin
  if p_org is null or p_event is null then
    raise exception 'missing argument' using errcode = 'null_value_not_allowed';
  end if;
  if not partner_may_write_event(p_org, p_event) then
    raise exception 'this event is not editable as this organization'
      using errcode = 'insufficient_privilege',
            hint = 'partner_scope/all-of refusal; see ADR §6.8';
  end if;
  -- NULL p_venue means "no venue" and is allowed (clears the link).
  if p_venue is not null and not exists (select 1 from venues v where v.id = p_venue) then
    raise exception 'that venue does not exist' using errcode = 'foreign_key_violation';
  end if;
  -- Multi-venue events are festival-hub furniture curated by the admin
  -- (linkEventVenue is add-only; hundreds of such rows exist). A partner
  -- set-venue must not clobber a curated set.
  if (select count(*) from event_venues ev where ev.event_id = p_event) > 1 then
    raise exception 'this event has multiple venues; contact Akron Pulse to change them.'
      using errcode = 'check_violation';
  end if;

  delete from event_venues ev where ev.event_id = p_event;
  if p_venue is not null then
    insert into event_venues (event_id, venue_id) values (p_event, p_venue);
  end if;

  select e.status into v_status from events e where e.id = p_event;
  return jsonb_build_object('id', p_event, 'status', v_status,
                            'review_required_by', null);
end;
$$;

-- 5.5 partner_mint_venue() -- design §3.4. Create-or-resolve. Minting is a
-- create-family right: any live membership qualifies (venues are shared
-- infrastructure, not tenant-scoped). Resolve-before-mint is the ensureVenue
-- order, so a partner can never create a duplicate of a venue we have; the
-- guard is applied at MINT time only, mirroring normalize.js ("venues already
-- in the DB under such a name keep resolving normally" -- an existing
-- guard-shaped name like "Highland Square" resolves and never reaches the
-- guard).
create or replace function partner_mint_venue(
  p_org     uuid,
  p_name    text,
  p_address text,
  p_city    text  default null,
  p_details jsonb default '{}'
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_name text;
  v_reason text;
  v_vid uuid;
  v_next uuid;
  v_addr_key text;
  v_website text;
  v_desc text;
  v_key text;
  v_canonical_name text;
  i int;
begin
  if p_org is null or p_name is null then
    raise exception 'missing argument' using errcode = 'null_value_not_allowed';
  end if;
  if not partner_may_create_for_org(p_org) then
    raise exception 'you cannot add venues for this organization'
      using errcode = 'insufficient_privilege',
            hint = 'partner_scope refusal; see ADR §6.8';
  end if;

  -- Normalize: strip HTML tags (venue names never contain HTML -- the
  -- normalize.js universal rule), collapse whitespace, trim.
  -- Unicode whitespace folds to ASCII here too (partner_fold_whitespace), so
  -- the stored name, the resolve key and the guard all agree with JS about
  -- what a space is.
  v_name := trim(partner_fold_whitespace(regexp_replace(p_name, '<[^>]*>', '', 'g')));
  if v_name = '' then
    raise exception 'venue name is required' using errcode = 'invalid_parameter_value';
  end if;

  -- p_details is an allowlist too: website (sanity-checked) and description
  -- only. No lat/lng/parking from partners; geocoding is the pipeline's job.
  if p_details is not null and jsonb_typeof(p_details) = 'object' then
    for v_key in select jsonb_object_keys(p_details) loop
      case v_key
        when 'website' then
          v_website := nullif(trim(p_details ->> 'website'), '');
          if v_website is not null and (v_website !~ '^https?://' or length(v_website) > 2048) then
            raise exception 'website must start with http:// or https://'
              using errcode = 'invalid_parameter_value';
          end if;
        when 'description' then
          v_desc := p_details ->> 'description';
        else
          raise exception 'field "%" cannot be set here', v_key
            using errcode = 'invalid_parameter_value';
      end case;
    end loop;
  end if;

  -- Resolve (a): exact normalized-name match. Deliberately NARROWER than the
  -- JS venueNameKey fold (no entity decoding, no punctuation fold):
  -- apostrophe-variant misses fall through to (b) or mint, and the nightly
  -- dedupe machinery still exists for events. The venues(name) unique index
  -- (035) backstops a race with a loud 23505 rather than a silent fork.
  select v.id into v_vid
    from venues v
   where lower(regexp_replace(trim(v.name), '\s+', ' ', 'g')) = lower(v_name)
   limit 1;

  -- Resolve (b): normalized-address match when an address was given. Same
  -- normalization on both sides; equality or prefix-of in either direction
  -- (a bare street line vs. one carrying ", Akron, OH ..." tails).
  --
  -- PREFIX MATCHING REQUIRES AT LEAST 2 TOKENS ON THE PREFIX SIDE (review
  -- finding, 2026-08-23): '500 kenmore blvd' LIKE '500 %' is true, so a bare
  -- house number typed as the address would silently bind whatever venue
  -- happens to share the number -- an unrelated venue linked to the event. A
  -- single-token key (either side) matches by EQUALITY only; prefix matching
  -- needs a house number plus at least a street word.
  if v_vid is null and nullif(trim(coalesce(p_address, '')), '') is not null then
    v_addr_key := trim(regexp_replace(lower(partner_fold_whitespace(p_address)), '[^a-z0-9]+', ' ', 'g'));
    select v.id into v_vid
      from venues v
     where v.address is not null
       and (
         trim(regexp_replace(lower(v.address), '[^a-z0-9]+', ' ', 'g')) = v_addr_key
         or (v_addr_key like '% %'
             and trim(regexp_replace(lower(v.address), '[^a-z0-9]+', ' ', 'g')) like v_addr_key || ' %')
         or (trim(regexp_replace(lower(v.address), '[^a-z0-9]+', ' ', 'g')) like '% %'
             and v_addr_key like trim(regexp_replace(lower(v.address), '[^a-z0-9]+', ' ', 'g')) || ' %')
       )
     limit 1;
  end if;

  if v_vid is not null then
    -- Resolve (c): chase venue_aliases to the canonical id. Iterative with a
    -- depth cap of 5: the 050 chain guard keeps real chains short, the cap
    -- makes the loop total.
    for i in 1..5 loop
      select va.canonical_venue_id into v_next
        from venue_aliases va where va.alias_venue_id = v_vid;
      exit when v_next is null;
      v_vid := v_next;
      v_next := null;
    end loop;
    select v.name into v_canonical_name from venues v where v.id = v_vid;
    return jsonb_build_object('venue_id', v_vid, 'created', false,
                              'name', v_canonical_name);
  end if;

  -- Mint-time guard: THE LAW (design §3.4). Only now, at mint time.
  v_reason := partner_venue_name_blocked(v_name);
  if v_reason is not null then
    raise exception '%', v_reason using errcode = 'check_violation';
  end if;

  -- status = 'pending_review' mirrors the public venue-submit path: the venue
  -- stays out of the published venues directory until the admin looks, while
  -- "Public can read venues" (using (true), 001, never narrowed) means it
  -- still renders on the event page immediately. The venues moderation
  -- trigger screens name/description here (caller is authenticated,
  -- non-admin).
  insert into venues (name, address, city, status, listed, website, description)
  values (v_name,
          nullif(trim(coalesce(p_address, '')), ''),
          coalesce(nullif(trim(coalesce(p_city, '')), ''), 'Akron'),
          'pending_review', true, v_website, v_desc)
  returning id into v_vid;

  return jsonb_build_object('venue_id', v_vid, 'created', true, 'name', v_name);
end;
$$;

-- ── 6. Grants ────────────────────────────────────────────────────────────────
-- The is_admin() precedent throughout: every function above is revoked before
-- it is granted, and the grant is the narrowest that works. Supabase's default
-- privileges grant EXECUTE to anon/authenticated DIRECTLY (not only via
-- PUBLIC), so the revokes name those roles explicitly -- `from public` alone
-- would leave the default grants standing (the 030 moderation_severity
-- precedent).

-- Helpers callable by the partner UI: authenticated only.
revoke all on function partner_scope()       from public, anon;
grant  execute on function partner_scope()       to authenticated;
revoke all on function partner_org_context() from public, anon;
grant  execute on function partner_org_context() to authenticated;

-- Definer-internal helpers: granted to NOBODY (the moderation_severity
-- shape). They are called only from inside the SECURITY DEFINER RPCs, which
-- run as the owner.
revoke all on function partner_may_write_event(uuid, uuid) from public, anon, authenticated;
revoke all on function partner_may_create_for_org(uuid)    from public, anon, authenticated;
revoke all on function partner_venue_name_blocked(text)    from public, anon, authenticated;
revoke all on function partner_fold_whitespace(text)       from public, anon, authenticated;

-- Admin-side lookup: the gate is inside (is_admin() or raise).
revoke all on function admin_lookup_auth_user(text) from public, anon;
grant  execute on function admin_lookup_auth_user(text) to authenticated;

-- The five write RPCs: authenticated only. The gate is partner_scope()
-- inside -- an admin or signed-in stranger calling them gets a clean refusal,
-- never definer power (tests N9/M8).
revoke all on function partner_upsert_event(uuid, uuid, jsonb, uuid, text[]) from public, anon;
grant  execute on function partner_upsert_event(uuid, uuid, jsonb, uuid, text[]) to authenticated;
revoke all on function partner_set_event_status(uuid, uuid, text) from public, anon;
grant  execute on function partner_set_event_status(uuid, uuid, text) to authenticated;
revoke all on function partner_set_event_categories(uuid, uuid, text[]) from public, anon;
grant  execute on function partner_set_event_categories(uuid, uuid, text[]) to authenticated;
revoke all on function partner_set_event_venue(uuid, uuid, uuid) from public, anon;
grant  execute on function partner_set_event_venue(uuid, uuid, uuid) to authenticated;
revoke all on function partner_mint_venue(uuid, text, text, text, jsonb) from public, anon;
grant  execute on function partner_mint_venue(uuid, text, text, text, jsonb) to authenticated;

commit;
