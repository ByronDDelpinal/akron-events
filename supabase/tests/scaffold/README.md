# Partner-accounts local SQL harness

Local verification for the partner-accounts build (migration 061) on **stock
PostgreSQL 16**, because the two better options do not exist here:

- **Supabase branches are unusable** for this schema: a clean replay from 001
  is known broken — `event_aliases` / `venue_aliases` have no create-table
  migration, so branch replay fails at 041. Do not re-diagnose.
- A **full 001→061 local replay** would need pg_net / pg_cron / gateway shims
  (045, 052, 057) whose divergence from Supabase is exactly the false-green
  CONTRIBUTING.md warns about.

So the harness makes a narrower, provable claim: `partner_scaffold_base.sql`
recreates the **pre-059 state that 059/060/061 and the two chained test files
touch, by name**, and then the REAL migrations apply on top. 059's three
`alter policy` statements have no `IF EXISTS` form, so **059 applying cleanly
is the scaffold-fidelity check**.

## One-command run

```bash
scripts/dev/run-partner-sql-harness.sh
```

Installs PostgreSQL 16 via apt if missing, bootstraps roles, rebuilds a
throwaway database, and runs the whole chain. Exit 0 and the final
`HARNESS GREEN` banner mean everything passed. Re-running rebuilds from
scratch; nothing persists and nothing touches any Supabase project.

## What the chain runs, in order

```text
supabase/tests/scaffold/partner_scaffold_base.sql   -- pre-059 state (this dir)
supabase/migrations/059_admin_boundary.sql          -- real file
supabase/migrations/060_reviewed_at.sql             -- real file
supabase/migrations/061_partner_accounts.sql        -- real file
supabase/tests/admin_boundary_rls.test.sql          -- must STAY green
supabase/tests/partner_accounts_rls.test.sql        -- the partner suite
```

## Manual recipe (what the script automates)

```bash
sudo apt-get install -y postgresql-16 postgresql-contrib-16
sudo pg_ctlcluster 16 main start

# Roles: the Supabase request roles, plus a NON-SUPERUSER owner. A superuser
# owner bypasses RLS and masks the FORCE-RLS lockout landmine (059's header);
# prod's owner is not a superuser and neither is this one.
sudo -u postgres psql -c "create role anon nologin"
sudo -u postgres psql -c "create role authenticated nologin"
sudo -u postgres psql -c "create role service_role nologin bypassrls"
sudo -u postgres psql -c "create role app_owner login password 'app_owner_local_test'"
sudo -u postgres psql -c "grant anon, authenticated, service_role to app_owner"
sudo -u postgres psql -c "create database akron_partner_test owner app_owner"

# The chain, AS app_owner (migrations included: definer functions must be
# owned by a non-superuser, like prod's).
export C="host=127.0.0.1 dbname=akron_partner_test user=app_owner password=app_owner_local_test"
psql "$C" -v ON_ERROR_STOP=1 \
  -f supabase/tests/scaffold/partner_scaffold_base.sql \
  -f supabase/migrations/059_admin_boundary.sql \
  -f supabase/migrations/060_reviewed_at.sql \
  -f supabase/migrations/061_partner_accounts.sql \
  -f supabase/tests/admin_boundary_rls.test.sql \
  -f supabase/tests/partner_accounts_rls.test.sql
```

## What a green run does NOT prove

PostgREST role selection, JWT minting, supabase-js token swapping, the
gateway — the exact layer where the 054 bug lived. That is covered by the
post-apply API runbook (V1–V14 curls; Byron's copy). Three pre-existing red
test files (`day_plan_rls`, `embed_request_rls`, `feedback_orb_rls` — red for
documented non-059 reasons) are not in the chain.

## Never do these

- Never apply `partner_scaffold_base.sql` to any Supabase project.
- Never move anything from this directory (or `supabase/rollbacks/`) into
  `supabase/migrations/` — `supabase db push` applies everything there (the
  059 self-undo incident).
- The `enforce_manual_overrides()` body in the scaffold is a **verbatim prod
  dump dated 2026-08-23**. If the apply runbook's step-0 dump ever differs,
  update the copy and the date together.
