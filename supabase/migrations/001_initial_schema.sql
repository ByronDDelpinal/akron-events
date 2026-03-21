-- ============================================================
-- The 330 — Akron & Summit County Events
-- Initial Schema Migration
-- ============================================================

-- ─────────────────────────────────────────
-- VENUES
-- ─────────────────────────────────────────
create table if not exists venues (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  address      text,
  city         text not null default 'Akron',
  state        text not null default 'OH',
  zip          text,
  lat          numeric(9,6),
  lng          numeric(9,6),
  parking_type text check (parking_type in ('street','lot','garage','none','unknown')) default 'unknown',
  parking_notes text,
  website      text,
  description  text,
  image_url    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- ORGANIZERS
-- ─────────────────────────────────────────
create table if not exists organizers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  website       text,
  contact_email text,   -- admin-only, never exposed to public
  description   text,
  image_url     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- EVENTS
-- ─────────────────────────────────────────
create table if not exists events (
  id               uuid primary key default gen_random_uuid(),

  -- core info
  title            text not null,
  description      text,
  start_at         timestamptz not null,
  end_at           timestamptz,

  -- location
  venue_id         uuid references venues(id) on delete set null,

  -- organizer
  organizer_id     uuid references organizers(id) on delete set null,

  -- categorization
  category         text not null check (category in (
                     'music','art','community','nonprofit',
                     'food','sports','education','other'
                   )),
  tags             text[] not null default '{}',

  -- pricing  (0/0 = free, null max = single price tier)
  price_min        numeric(8,2) not null default 0,
  price_max        numeric(8,2),

  -- audience
  age_restriction  text not null default 'not_specified' check (age_restriction in (
                     'not_specified','all_ages','18_plus','21_plus'
                   )),

  -- media & links
  image_url        text,
  ticket_url       text,

  -- ingestion metadata
  source           text not null default 'manual',
  source_id        text,                          -- original ID from external source

  -- content flags
  featured         boolean not null default false,
  status           text not null default 'pending_review' check (status in (
                     'pending_review','published','cancelled'
                   )),

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- prevent duplicate ingestion from same source
  unique (source, source_id)
);

-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────

-- browsing: filter published events by date
create index idx_events_start_at   on events (start_at) where status = 'published';
create index idx_events_category   on events (category) where status = 'published';
create index idx_events_featured   on events (featured) where status = 'published' and featured = true;

-- tag search (GIN index for array containment queries)
create index idx_events_tags on events using gin (tags);

-- ingestion dedup lookup
create index idx_events_source on events (source, source_id);

-- ─────────────────────────────────────────
-- UPDATED_AT TRIGGER
-- ─────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_venues_updated_at
  before update on venues
  for each row execute function set_updated_at();

create trigger trg_organizers_updated_at
  before update on organizers
  for each row execute function set_updated_at();

create trigger trg_events_updated_at
  before update on events
  for each row execute function set_updated_at();

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────
-- Public reads only published events; only authenticated users (you, the admin)
-- can insert/update/delete. Enable RLS in Supabase dashboard after running this.

alter table events     enable row level security;
alter table venues     enable row level security;
alter table organizers enable row level security;

-- Anyone can read published events
create policy "Public can read published events"
  on events for select
  using (status = 'published');

-- Anyone can read venues and organizers
create policy "Public can read venues"
  on venues for select using (true);

create policy "Public can read organizers"
  on organizers for select using (true);

-- Authenticated users (admin) have full access
create policy "Authenticated users have full event access"
  on events for all
  to authenticated
  using (true) with check (true);

create policy "Authenticated users have full venue access"
  on venues for all
  to authenticated
  using (true) with check (true);

create policy "Authenticated users have full organizer access"
  on organizers for all
  to authenticated
  using (true) with check (true);
