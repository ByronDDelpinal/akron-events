-- 050: venue_aliases chain guard
--
-- ensureVenue now resolves venue ids through venue_aliases (alias hop), and
-- the venue-duplicate audit records merges as alias-and-unlist instead of
-- deleting rows. Both assume aliases are FLAT: every alias points directly at
-- a live canonical venue, never at another alias. This trigger makes chains
-- impossible at the database level by rejecting, on insert or update:
--   (a) an alias whose canonical is itself an alias row (would create A→B→C);
--   (b) aliasing away a venue that is canonical for existing aliases (would
--       turn those rows into chains) — writers must re-point the inbound
--       aliases first (audit-venue-duplicates emits exactly that order).
--
-- Precondition: zero existing chains in venue_aliases, verified 2026-08-06 —
-- the trigger only guards new writes and never needs to repair old rows.
--
-- Note: venue_aliases was created directly in the database (no migration file
-- exists for it), so its RLS posture cannot be confirmed from this repo. The
-- block at the bottom mirrors 041_event_aliases_rls.sql for event_aliases
-- (anon: none, authenticated: read-only, service_role: bypasses) and is
-- idempotent — a no-op where the live table already matches.

create or replace function public.venue_aliases_forbid_chains()
returns trigger
language plpgsql
as $$
begin
  -- (0) A venue can never alias itself. The table CHECK already rejects this,
  --     but raise the same shaped error here so all guard failures read alike.
  if new.alias_venue_id = new.canonical_venue_id then
    raise exception
      'venue_aliases: % cannot alias itself', new.alias_venue_id;
  end if;

  -- (a) The canonical must not itself be an alias row.
  if exists (
    select 1 from public.venue_aliases
    where alias_venue_id = new.canonical_venue_id
  ) then
    raise exception
      'venue_aliases: canonical % is itself an alias row — point directly at its canonical instead',
      new.canonical_venue_id;
  end if;

  -- (b) Never alias away a venue that is canonical for existing aliases —
  --     re-point those inbound aliases first.
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

drop trigger if exists venue_aliases_forbid_chains on public.venue_aliases;
create trigger venue_aliases_forbid_chains
  before insert or update of alias_venue_id, canonical_venue_id
  on public.venue_aliases
  for each row
  execute function public.venue_aliases_forbid_chains();

-- RLS: mirror the event_aliases posture from 041 (see header note).
alter table public.venue_aliases enable row level security;

drop policy if exists "Authenticated can read venue_aliases" on public.venue_aliases;
create policy "Authenticated can read venue_aliases"
  on public.venue_aliases
  for select
  to authenticated
  using (true);
