-- ════════════════════════════════════════════════════════════════════════════
-- 066_org_opt_outs_rollback.sql
--
-- Undoes 066_org_opt_outs.sql. Drops the guard triggers, the reconcile trigger,
-- the table, and every function 066 created, in dependency-safe order:
-- triggers before the functions that back them, the table before the functions
-- its CHECK/guards reference.
--
-- Rollback scripts live ONLY here, never in supabase/migrations/ - `supabase db
-- push` would otherwise apply this as a migration and instantly undo 066.
-- Byron applies this himself; DO NOT APPLY, do not commit.
--
-- NOTE: this does NOT un-cancel orgs/events that 066 cancelled while it was
-- live. Cancellation is a status change on those rows, not owned by this table;
-- reversing it is a separate, deliberate data step (flip active=false first so
-- the guards stop firing, let a scrape republish, THEN roll back the DDL).
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- Triggers first (they depend on their functions).
drop trigger if exists trg_opt_out_organizations_cancel on organizations;
drop trigger if exists trg_opt_out_event_org_guard      on event_organizations;
drop trigger if exists trg_opt_out_event_org_reconcile   on event_organizations;
drop trigger if exists trg_opt_out_events_cancel        on events;
drop trigger if exists trg_opt_out_reconcile            on org_opt_outs;

-- Trigger-backing functions (now unreferenced by any trigger).
drop function if exists opt_out_organizations_cancel();
drop function if exists opt_out_event_org_guard();
drop function if exists opt_out_event_org_reconcile();
drop function if exists opt_out_events_cancel();
drop function if exists reconcile_org_opt_outs();

-- The table before the fold function its CHECK references.
drop table if exists org_opt_outs;

-- Guard predicates, then the fold function they call.
drop function if exists is_org_opted_out(uuid);
drop function if exists is_name_opted_out(text);
drop function if exists org_name_match_key(text);

commit;
