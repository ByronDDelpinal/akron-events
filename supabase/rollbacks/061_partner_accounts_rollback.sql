-- ════════════════════════════════════════════════════════════════════════════
-- 061_partner_accounts_rollback.sql
--
-- Reverses 061_partner_accounts.sql. Written at the same time as 061, not
-- after something goes wrong at 11pm.
--
-- ⚠️  THIS FILE LIVES IN supabase/rollbacks/ AND MUST NEVER BE MOVED INTO
--     supabase/migrations/. `supabase db push` applies anything in
--     migrations/, and the first 059 push self-undid 059 exactly that way
--     (recovery needed `migration repair --status reverted`).
--
-- ⚠️  REACH FOR THE CHEAPER LEVER FIRST. The real emergency control is ONE
--     statement, no migration, reversible:
--
--       update partner_orgs set active = false;
--
--     That empties every partner's scope on their very next query --
--     partner_scope() filters on p.active live -- so every partner policy
--     matches nothing and every RPC refuses, while the schema, the roster and
--     the audit trail all stay intact. Re-activate with the inverse UPDATE.
--     Use THIS file only when the objects themselves have to go.
--
-- ⚠️  STOP-THE-BLEEDING MOVE, NOT A RESTING STATE (the 059 rollback's rule).
--     Roll back, fix forward, re-apply -- do not roll back and leave it.
--
-- WHAT SURVIVES, CORRECTLY: partner-written data. Events partners created or
-- edited are ordinary `events` rows -- `source = 'partner:<slug>'` is claimed
-- by no scraper, and their manual_overrides stamps keep protecting the edited
-- fields from any importer. Partner-minted venues are ordinary
-- pending_review venues. Nothing here deletes or orphans any of it, and the
-- `events` schema is untouched by 061 in both directions (ADR §9.2).
--
-- CLEANLINESS: this rollback is clean -- nothing outside 061 references these
-- objects. The frontend partner surface (Phase B) must be gone or dark before
-- applying, or its role probe calls to partner_org_context() start erroring
-- (they fail closed: the shell renders the no-access state).
--
-- DO NOT APPLY THIS SCRIPT. The maintainer applies it himself, if ever.
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ── 1. Policies (the three partner SELECTs + the two admin partner-table) ────
drop policy if exists "Partner reads own org events"              on events;
drop policy if exists "Partner reads own org rows"                on organizations;
drop policy if exists "Partner reads categories of own org events" on event_categories;
drop policy if exists "Admin full access partner_orgs"            on partner_orgs;
drop policy if exists "Admin full access partner_memberships"     on partner_memberships;

-- ── 2. Functions (RPCs first, then the helpers they call) ────────────────────
drop function if exists partner_upsert_event(uuid, uuid, jsonb, uuid, text[]);
drop function if exists partner_set_event_status(uuid, uuid, text);
drop function if exists partner_set_event_categories(uuid, uuid, text[]);
drop function if exists partner_set_event_venue(uuid, uuid, uuid);
drop function if exists partner_mint_venue(uuid, text, text, text, jsonb);
drop function if exists partner_venue_name_blocked(text);
drop function if exists partner_fold_whitespace(text);
drop function if exists admin_lookup_auth_user(text);
drop function if exists partner_may_write_event(uuid, uuid);
drop function if exists partner_may_create_for_org(uuid);
drop function if exists partner_org_context();
drop function if exists partner_scope();

-- ── 3. Table grants (061 section 4) ──────────────────────────────────────────
revoke select, insert, update on partner_orgs        from authenticated;
revoke select, insert, update on partner_memberships from authenticated;

-- ── 4. Tables (memberships first: FK to partner_orgs) ────────────────────────
drop table if exists partner_memberships;
drop table if exists partner_orgs;

commit;
