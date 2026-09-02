-- ════════════════════════════════════════════════════════════════════════════
-- 070_slug_uniqueness_sees_hidden_rows_rollback.sql
--
-- Reverts migration 070: turnout_unique_slug back to SECURITY INVOKER with no
-- pinned search_path, exactly as the out-of-band original was found in prod
-- on 2026-09-02. Reverting reintroduces the 23505 on repeated-title anon
-- submits; do it only if the definer form causes a problem.
--
-- Grants: the explicit anon / authenticated / service_role EXECUTE grants
-- were already present in prod before 070 and are left in place; only the
-- implicit PUBLIC grant 070 revoked is restored, so the ACL returns to its
-- pre-070 shape exactly.
--
-- Rollback scripts NEVER live in supabase/migrations/ (the 059 incident).
-- ════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

alter function public.turnout_unique_slug(text, uuid, text)
  security invoker
  reset search_path;

grant execute on function public.turnout_unique_slug(text, uuid, text) to public;

comment on function public.turnout_unique_slug(text, uuid, text) is null;

commit;
