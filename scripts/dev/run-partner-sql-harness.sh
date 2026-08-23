#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# run-partner-sql-harness.sh — the local SQL verification harness for the
# partner-accounts build (design §6.2, deviation D9: Supabase branches are
# unusable, replay from 001 is known broken at 041).
#
# What it does, end to end and repeatably:
#   1. Installs stock PostgreSQL 16 via apt if missing (postgresql-16 +
#      postgresql-contrib-16 for unaccent/pg_trgm) and starts the cluster.
#   2. Bootstraps the Supabase-shaped roles (anon / authenticated /
#      service_role, nologin) and a NON-SUPERUSER owner role `app_owner`
#      (login). A superuser owner would bypass RLS and mask the FORCE-RLS
#      lockout landmine 059's header documents; prod's owner is not a
#      superuser and neither is this one.
#   3. Drops + recreates the throwaway database, owned by app_owner.
#   4. Runs, AS app_owner, in order:
#        supabase/tests/scaffold/partner_scaffold_base.sql   (pre-059 state)
#        supabase/migrations/059_admin_boundary.sql          (real file)
#        supabase/migrations/060_reviewed_at.sql             (real file)
#        supabase/migrations/061_partner_accounts.sql        (real file)
#        supabase/tests/admin_boundary_rls.test.sql          (must stay green)
#        supabase/tests/partner_accounts_rls.test.sql        (the new suite)
#      059 applying cleanly IS the scaffold-fidelity check: its three
#      `alter policy` statements have no IF EXISTS form and abort on any
#      missing pre-059 policy name.
#
# Everything is disposable: re-running drops and rebuilds the database.
# NOTHING here touches any Supabase project. Exit code 0 = whole chain green.
#
# Usage:  scripts/dev/run-partner-sql-harness.sh
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DB_NAME="akron_partner_test"
OWNER="app_owner"
OWNER_PW="app_owner_local_test"

log() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

# ── 1. PostgreSQL 16 present + running ───────────────────────────────────────
if ! command -v pg_ctlcluster >/dev/null 2>&1 || ! ls /usr/lib/postgresql/16 >/dev/null 2>&1; then
  log "Installing PostgreSQL 16 (apt)"
  sudo apt-get update -qq
  sudo apt-get install -y -qq postgresql-16 postgresql-contrib-16
fi

if ! sudo pg_lsclusters | awk '$1==16 && $2=="main"' | grep -q online; then
  log "Starting cluster 16/main"
  sudo pg_ctlcluster 16 main start
fi

PORT="$(sudo pg_lsclusters | awk '$1==16 && $2=="main" {print $3}')"
PORT="${PORT:-5432}"

psql_super() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }

# ── 2. Roles ─────────────────────────────────────────────────────────────────
log "Bootstrapping roles (anon / authenticated / service_role / ${OWNER})"
psql_super <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = '${OWNER}') then
    create role ${OWNER} login password '${OWNER_PW}';
  end if;
end
\$\$;
-- app_owner must be able to SET ROLE to the request roles (the test files'
-- `set local role anon/authenticated` discipline).
grant anon, authenticated, service_role to ${OWNER};
SQL

# ── 3. Fresh database owned by app_owner ─────────────────────────────────────
log "Recreating database ${DB_NAME} (owner ${OWNER})"
psql_super -c "drop database if exists ${DB_NAME};"
psql_super -c "create database ${DB_NAME} owner ${OWNER};"

# ── 4. The chain, as the non-superuser owner ─────────────────────────────────
CONN="host=127.0.0.1 port=${PORT} dbname=${DB_NAME} user=${OWNER} password=${OWNER_PW}"

run_sql() {
  log "psql -f $1  (as ${OWNER})"
  psql "${CONN}" -v ON_ERROR_STOP=1 -f "${REPO_ROOT}/$1"
}

run_sql supabase/tests/scaffold/partner_scaffold_base.sql
run_sql supabase/migrations/059_admin_boundary.sql
run_sql supabase/migrations/060_reviewed_at.sql
run_sql supabase/migrations/061_partner_accounts.sql
run_sql supabase/tests/admin_boundary_rls.test.sql
run_sql supabase/tests/partner_accounts_rls.test.sql

log "HARNESS GREEN: scaffold + 059 + 060 + 061 + both RLS suites all passed"
