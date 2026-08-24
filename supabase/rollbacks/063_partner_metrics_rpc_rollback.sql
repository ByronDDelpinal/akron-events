-- 063_partner_metrics_rpc_rollback.sql
--
-- Rollback for 063_partner_metrics_rpc.sql.
--
-- Rollback scripts live HERE and never in supabase/migrations/: a file in the
-- migrations directory is a file the CLI will apply, and an applied rollback
-- is an outage. Same rule 061's rollback states.
--
-- 063 created exactly one object and changed nothing else, so undoing it is
-- one drop. Nothing in 062 is touched by either direction.
--
-- After running this, the partner analytics block on PartnerHomePage and the
-- admin one on PartnersPage both surface an error, which is the correct
-- behavior: a missing function is a failure, not an empty state.

begin;

drop function if exists partner_event_metrics(uuid, date, date);

commit;
