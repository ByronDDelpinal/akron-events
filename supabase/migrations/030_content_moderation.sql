-- ════════════════════════════════════════════════════════════════════════════
-- 030_content_moderation.sql
--
-- Server-side content moderation for PUBLIC (anon) submissions.
--
-- Scope (per product decision): screens only the anon role — i.e. public
-- submissions via the website (event submit form, org/venue signup, feedback
-- board). Authenticated admins and the service_role scrapers are NOT screened
-- here (scrapers are already screened in Node via scripts/lib/content-moderation.js).
--
-- Mechanism: a BEFORE INSERT/UPDATE trigger on events, venues, organizations and
-- feedback_posts. When the caller is anon and the submitted text matches the
-- blocklist, the row's status is forced to a non-public value:
--     extreme  -> 'cancelled'      (auto-reject; never shown)
--     high/contextual -> 'pending_review'   (held for a human)
-- RLS already hides non-'published' rows from the public site.
--
-- The term list is NOT stored in this migration (it must never be committed).
-- It lives in the MODERATION_TERMS_B64 env var and is loaded into the
-- RLS-protected moderation_terms / moderation_allowlist tables by
-- scripts/load-moderation-terms.js. The matcher reads those tables.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists unaccent;

-- ── Term storage (RLS-protected: not readable by anon/authenticated) ─────────
create table if not exists moderation_terms (
  term     text primary key,
  severity text not null check (severity in ('contextual','high','extreme')),
  kind     text not null default 'word' check (kind in ('word','phrase'))
);

create table if not exists moderation_allowlist (
  phrase text primary key
);

alter table moderation_terms     enable row level security;
alter table moderation_allowlist enable row level security;

-- No policies are created => anon/authenticated get zero rows. service_role
-- bypasses RLS for the loader. Revoke table grants outright so the list is never
-- exposed through PostgREST to the browser.
revoke all on moderation_terms     from anon, authenticated;
revoke all on moderation_allowlist from anon, authenticated;

-- ── Matcher ──────────────────────────────────────────────────────────────────
-- Returns the highest severity matched ('extreme' > 'high' > 'contextual') or
-- NULL when clean. SECURITY DEFINER so it can read the protected term tables;
-- it is never granted to anon/authenticated and is only called by the trigger
-- functions below (which run as the owner).
create or replace function moderation_severity(input text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base   text;
  leet   text;
  base_c text;
  leet_c text;
  condensed   text;
  has_spacing boolean;
  rec    record;
  rx     text;
  best   text := null;
  best_rank int := 0;
  this_rank int;
begin
  if input is null or btrim(input) = '' then
    return null;
  end if;

  -- Normalization variants (mirror scripts/lib/content-moderation.js):
  --   base   : lowercase + de-accent + single-spaced
  --   leet   : base with leetspeak folded to letters
  --   *_c    : runs of 3+ identical chars collapsed (catches "fuuuuck")
  base   := regexp_replace(lower(unaccent(input)), '\s+', ' ', 'g');
  leet   := translate(base, '013457@$!', 'oieastasi');
  base_c := regexp_replace(base, '(.)\1{2,}', '\1', 'g');
  leet_c := regexp_replace(leet, '(.)\1{2,}', '\1', 'g');

  -- Letter-spacing evasion ("f a g g o t"): only scan the condensed string when
  -- the text actually looks spaced out, to limit false positives.
  has_spacing := base ~ '([a-z0-9][^a-z0-9]){2,}[a-z0-9]';
  condensed   := regexp_replace(leet, '[^a-z0-9]', '', 'g');

  for rec in select term, severity, kind from moderation_terms loop
    -- Word-boundary regex; non-alphanumerics in the term match any separator run
    -- so "blow job" also catches "blowjob"/"blow-job" and "neo-nazi" catches "neo nazi".
    rx := '\m' || regexp_replace(rec.term, '[^a-z0-9]+', '[^a-z0-9]*', 'g') || '\M';

    if base ~ rx or base_c ~ rx or leet ~ rx or leet_c ~ rx then
      -- Allowlist: skip if the term only appears inside an allowed phrase
      -- (e.g. "negro" within "negro leagues", "cracker" within "cracker barrel").
      if not exists (
        select 1
        from moderation_allowlist a
        where strpos(base, regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g')) > 0
          and strpos(regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g'), rec.term) > 0
      ) then
        this_rank := case rec.severity when 'extreme' then 3 when 'high' then 2 else 1 end;
        if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
      end if;

    elsif has_spacing
          and rec.kind = 'word'
          and rec.severity in ('high','extreme')
          and length(rec.term) >= 5
          and strpos(condensed, rec.term) > 0 then
      this_rank := case rec.severity when 'extreme' then 3 else 2 end;
      if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
    end if;

    exit when best_rank = 3; -- nothing outranks 'extreme'
  end loop;

  return best;
end;
$$;

revoke all on function moderation_severity(text) from public, anon, authenticated;

-- ── Caller helper ────────────────────────────────────────────────────────────
-- The PostgREST role from the request JWT. anon/authenticated/service_role for
-- API traffic; NULL for direct DB / migration connections.
create or replace function moderation_request_role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;

-- ── Trigger functions (one per table; all gate on anon) ──────────────────────
create or replace function moderation_screen_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.title, NEW.description, array_to_string(NEW.tags, ' ')));
  if sev is null then return NEW; end if;
  NEW.needs_review := true;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_venue()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

create or replace function moderation_screen_organization()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.name, NEW.description));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

-- ── feedback_posts: add a status column + hide non-published from the public ──
alter table feedback_posts
  add column if not exists status text not null default 'published'
    check (status in ('published','pending_review','cancelled'));

-- Existing rows default to 'published' (no behavior change for current content).
drop policy if exists "Public read feedback_posts" on feedback_posts;
create policy "Public read feedback_posts"
  on feedback_posts for select to anon
  using (status = 'published');

create or replace function moderation_screen_feedback()
returns trigger language plpgsql security definer set search_path = public as $$
declare sev text;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  sev := moderation_severity(concat_ws(' ', NEW.body, NEW.author_name));
  if sev is null then return NEW; end if;
  NEW.status := case when sev = 'extreme' then 'cancelled' else 'pending_review' end;
  return NEW;
end; $$;

-- ── Triggers ─────────────────────────────────────────────────────────────────
drop trigger if exists trg_moderation_events on events;
create trigger trg_moderation_events
  before insert or update of title, description, tags on events
  for each row execute function moderation_screen_event();

drop trigger if exists trg_moderation_venues on venues;
create trigger trg_moderation_venues
  before insert or update of name, description on venues
  for each row execute function moderation_screen_venue();

drop trigger if exists trg_moderation_organizations on organizations;
create trigger trg_moderation_organizations
  before insert or update of name, description on organizations
  for each row execute function moderation_screen_organization();

drop trigger if exists trg_moderation_feedback on feedback_posts;
create trigger trg_moderation_feedback
  before insert or update of body, author_name, status on feedback_posts
  for each row execute function moderation_screen_feedback();
