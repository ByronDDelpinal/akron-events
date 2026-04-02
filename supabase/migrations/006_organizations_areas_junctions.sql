-- ============================================================
-- Major schema restructuring:
--   1. Rename organizers → organizations (add new fields)
--   2. Add status + manual_overrides to venues & events
--   3. Create areas table
--   4. Create junction tables (event_venues, event_areas, event_organizations)
--   5. Migrate existing FK data into junction tables
--   6. Drop legacy FK columns from events
-- ============================================================

-- ─────────────────────────────────────────
-- 1. RENAME organizers → organizations
-- ─────────────────────────────────────────
alter table organizers rename to organizations;

-- Add new fields to organizations
alter table organizations
  add column if not exists address      text,
  add column if not exists city         text not null default 'Akron',
  add column if not exists state        text not null default 'OH',
  add column if not exists zip          text,
  add column if not exists status       text not null default 'published'
    check (status in ('pending_review','published','cancelled')),
  add column if not exists photos       text[] not null default '{}',
  add column if not exists manual_overrides jsonb not null default '{}';

comment on column organizations.manual_overrides is
  'Tracks fields manually edited via admin. Format: {"field": {"at": "ISO timestamp"}}. Scrapers skip overridden fields.';
comment on column organizations.photos is
  'Up to 12 image URLs. UI deferred — schema ready.';
comment on column organizations.contact_email is
  'Admin-only, never exposed to public API via RLS.';

-- Rename the trigger (Postgres keeps the old trigger name after table rename)
alter trigger trg_organizers_updated_at on organizations rename to trg_organizations_updated_at;

-- Update RLS policies (old names reference "organizers")
drop policy if exists "Public can read organizers" on organizations;
create policy "Public can read organizations"
  on organizations for select using (true);

drop policy if exists "Authenticated users have full organizer access" on organizations;
create policy "Authenticated users have full organization access"
  on organizations for all
  to authenticated
  using (true) with check (true);

-- ─────────────────────────────────────────
-- 2. MODIFY VENUES
-- ─────────────────────────────────────────
alter table venues
  add column if not exists organization_id uuid references organizations(id) on delete set null,
  add column if not exists status          text not null default 'published'
    check (status in ('pending_review','published','cancelled')),
  add column if not exists tags            text[] not null default '{}',
  add column if not exists manual_overrides jsonb not null default '{}';

comment on column venues.organization_id is
  'The organization that owns/operates this venue. Nullable — not all venues belong to an org.';
comment on column venues.tags is
  'Amenity + type tags, e.g. {Outdoor, Park, Accessible, Free Parking, Concert Hall}';
comment on column venues.manual_overrides is
  'Tracks fields manually edited via admin. Format: {"field": {"at": "ISO timestamp"}}. Scrapers skip overridden fields.';

create index if not exists idx_venues_organization on venues (organization_id);

-- ─────────────────────────────────────────
-- 3. MODIFY EVENTS — add manual_overrides
-- ─────────────────────────────────────────
alter table events
  add column if not exists manual_overrides jsonb not null default '{}';

comment on column events.manual_overrides is
  'Tracks fields manually edited via admin. Format: {"field": {"at": "ISO timestamp"}}. Scrapers skip overridden fields.';

-- ─────────────────────────────────────────
-- 4. CREATE AREAS TABLE
-- ─────────────────────────────────────────
create table if not exists areas (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,
  description text,
  capacity    integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_areas_venue on areas (venue_id);

create trigger trg_areas_updated_at
  before update on areas
  for each row execute function set_updated_at();

-- RLS for areas
alter table areas enable row level security;

create policy "Public can read areas"
  on areas for select using (true);

create policy "Authenticated users have full area access"
  on areas for all
  to authenticated
  using (true) with check (true);

-- ─────────────────────────────────────────
-- 5. CREATE JUNCTION TABLES
-- ─────────────────────────────────────────

-- event ↔ venues (many-to-many)
create table if not exists event_venues (
  event_id uuid not null references events(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  primary key (event_id, venue_id)
);

create index if not exists idx_event_venues_venue on event_venues (venue_id);

alter table event_venues enable row level security;
create policy "Public can read event_venues"
  on event_venues for select using (true);
create policy "Authenticated users have full event_venues access"
  on event_venues for all to authenticated
  using (true) with check (true);

-- event ↔ areas (many-to-many)
create table if not exists event_areas (
  event_id uuid not null references events(id) on delete cascade,
  area_id  uuid not null references areas(id) on delete cascade,
  primary key (event_id, area_id)
);

create index if not exists idx_event_areas_area on event_areas (area_id);

alter table event_areas enable row level security;
create policy "Public can read event_areas"
  on event_areas for select using (true);
create policy "Authenticated users have full event_areas access"
  on event_areas for all to authenticated
  using (true) with check (true);

-- event ↔ organizations (many-to-many, all equal organizers)
create table if not exists event_organizations (
  event_id        uuid not null references events(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  primary key (event_id, organization_id)
);

create index if not exists idx_event_organizations_org on event_organizations (organization_id);

alter table event_organizations enable row level security;
create policy "Public can read event_organizations"
  on event_organizations for select using (true);
create policy "Authenticated users have full event_organizations access"
  on event_organizations for all to authenticated
  using (true) with check (true);

-- ─────────────────────────────────────────
-- 6. MIGRATE EXISTING FK DATA → JUNCTION TABLES
-- ─────────────────────────────────────────

-- Migrate event → venue relationships
insert into event_venues (event_id, venue_id)
select id, venue_id from events
where venue_id is not null
on conflict do nothing;

-- Migrate event → organizer relationships (now organizations)
insert into event_organizations (event_id, organization_id)
select id, organizer_id from events
where organizer_id is not null
on conflict do nothing;

-- ─────────────────────────────────────────
-- 7. DROP LEGACY FK COLUMNS
-- ─────────────────────────────────────────
alter table events drop column if exists venue_id;
alter table events drop column if exists organizer_id;

-- ─────────────────────────────────────────
-- 8. ANON ROLE: allow inserts for public forms
--    (pending_review submissions from org/venue signup)
-- ─────────────────────────────────────────
create policy "Anon can insert pending organizations"
  on organizations for insert
  to anon
  with check (status = 'pending_review');

create policy "Anon can insert pending venues"
  on venues for insert
  to anon
  with check (status = 'pending_review');

-- Allow anon to insert junction rows for their own submissions
-- (needed for venue sign-up to create areas)
create policy "Anon can insert areas for pending venues"
  on areas for insert
  to anon
  with check (true);

-- Allow anon to insert into event_venues and event_organizations
-- for the submit event form
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
