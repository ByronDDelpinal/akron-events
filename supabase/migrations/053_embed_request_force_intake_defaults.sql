-- ════════════════════════════════════════════════════════════════════════════
-- 053_embed_request_force_intake_defaults.sql
--
-- BUG FIX: every real submission from the embed builder failed with
-- 403 / SQLSTATE 42501 "new row violates row-level security policy for table
-- embed_requests", while the row sat perfectly valid and the form showed
-- "Something went wrong."
--
-- 051's anon INSERT policy pins three columns the visitor does not own:
--
--   with check (status = 'new' and notified_at is null and embed_path is null)
--
-- That works only if the client NEVER mentions those columns, so their
-- defaults apply. It is a policy that depends on client good behaviour, which
-- is exactly backwards: RLS exists precisely because the client cannot be
-- trusted. Any request that names one of them -- explicitly, as an echoed
-- null, or through some intermediary that materializes the full row -- gets
-- the WHOLE insert rejected, and PostgREST reports it as a flat 403 with no
-- indication of which column was at fault.
--
-- Worse, it fails CLOSED in the least useful direction: a legitimate partner
-- request is refused, while the thing the policy was defending against (an
-- attacker setting status='approved' to self-approve, or planting a crafted
-- embed_path that would later be rendered into the operator's email) was only
-- ever *rejected*, never *neutralized*.
--
-- Fix: force the three columns server-side in a BEFORE INSERT trigger for
-- anon, and keep 051's WITH CHECK as a backstop. The policy can now never be
-- the thing that rejects an honest submission, and a hostile payload is
-- sanitized rather than bounced. Verified 2026-08-09: an anon insert claiming
-- status='approved', notified_at='2020-01-01' and embed_path='/embed?evil=1'
-- now lands as ('new', null, null) and returns 201.
--
-- Trigger ordering note: Postgres fires BEFORE triggers in NAME order, and
-- `trg_embed_request_force_defaults` sorts before
-- `trg_embed_request_rate_limit`, so the rate limiter still sees the final
-- row. All BEFORE triggers run before the RLS WITH CHECK is evaluated, which
-- is what makes this work at all.
--
-- See also [feedback: test anon paths via the API, not the DB] -- this class
-- of bug is invisible to service-role SQL, because `moderation_request_role()`
-- is not 'anon' there and the policy is never even evaluated.
-- ════════════════════════════════════════════════════════════════════════════

begin;

create or replace function embed_request_force_intake_defaults()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- service_role / authenticated (the notifier claiming notified_at, the
  -- maintainer triaging status) must pass through untouched.
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;

  NEW.status      := 'new';
  NEW.notified_at := null;
  NEW.embed_path  := null;
  return NEW;
end; $$;

revoke all on function embed_request_force_intake_defaults() from public, anon, authenticated;

drop trigger if exists trg_embed_request_force_defaults on embed_requests;
create trigger trg_embed_request_force_defaults
  before insert on embed_requests
  for each row execute function embed_request_force_intake_defaults();

commit;
