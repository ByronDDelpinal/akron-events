-- ==========================================================================
-- Migration 019 — schema.org Event fields
-- ==========================================================================
-- Adds the remaining columns needed to emit complete Event JSON-LD per
-- Google's 2026 structured-data spec. All three have sensible defaults so
-- existing events keep rendering correctly; scrapers and admin forms can
-- start populating them over time.
--
-- See docs/seo-proposal.md for the full rationale.
-- ==========================================================================

-- ─── event_attendance_mode ──────────────────────────────────────────────
-- schema.org expects one of three modes. Almost every Akron event is
-- offline; default to that and let organizers/admins flip online/hybrid.
alter table events
  add column if not exists event_attendance_mode text
  not null default 'offline'
  check (event_attendance_mode in ('offline','online','hybrid'));

comment on column events.event_attendance_mode is
  'schema.org eventAttendanceMode — maps to OfflineEventAttendanceMode / '
  'OnlineEventAttendanceMode / MixedEventAttendanceMode in JSON-LD.';

-- ─── event_status ───────────────────────────────────────────────────────
-- Tracks the Event lifecycle. Distinct from events.status (which gates
-- publication): a published event can still be cancelled or rescheduled
-- and needs to surface that in structured data.
alter table events
  add column if not exists event_status text
  not null default 'scheduled'
  check (event_status in (
    'scheduled','rescheduled','postponed','cancelled','moved_online'
  ));

comment on column events.event_status is
  'schema.org eventStatus — maps to EventScheduled / EventCancelled / '
  'EventRescheduled / EventPostponed / EventMovedOnline in JSON-LD. '
  'Distinct from events.status (publication gating).';

-- ─── is_accessible_for_free ─────────────────────────────────────────────
-- True iff the event is genuinely free of cost (no suggested donation,
-- no optional tickets). Derives from price_min=0 in most cases, but an
-- explicit column lets organizers confirm and lets the schema emitter
-- avoid inferring from ambiguous price data.
alter table events
  add column if not exists is_accessible_for_free boolean
  not null default false;

comment on column events.is_accessible_for_free is
  'schema.org isAccessibleForFree — true when an event is genuinely '
  'free of cost (no ticket, no donation). Populates free-event rich '
  'results in Google.';

-- ─── Backfill: flag obviously-free events ─────────────────────────────
-- If price_min is 0 AND price_max is null or 0, call it free.
update events
  set is_accessible_for_free = true
where price_min = 0
  and (price_max is null or price_max = 0);
