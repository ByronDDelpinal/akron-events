-- ════════════════════════════════════════════════════════════════════════════
-- 043_feedback_orb.sql
--
-- Backs the floating quick-feedback widget ("feedback orb") that replaces the
-- removed /feedback board. Reuses feedback_posts so the 030 content-moderation
-- trigger applies for free. Three changes:
--   1. page_path column (which page the note came from).
--   2. a new 'orb' category value (discriminator for orb notes vs legacy board).
--   3. a tightened anon INSERT policy + a coarse server-side velocity cap.
--
-- The old public board UI is removed, so the wide-open anon INSERT from 012
-- (with check (true)) is no longer needed and is replaced here.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. page_path: path only (no query/hash), so nothing sensitive leaks. ──────
alter table feedback_posts
  add column if not exists page_path text;

-- ── 2. Allow category 'orb' so orb notes are queryable apart from board rows. ─
alter table feedback_posts drop constraint if exists feedback_posts_category_check;
alter table feedback_posts add constraint feedback_posts_category_check
  check (category in ('bug','love','wish','confusing','idea','datasource','general','orb'));

-- ── 3. Replace the wide-open anon INSERT (012) now the board is gone. ─────────
-- Orb notes are always private, image-free, vote-free, category 'orb', and
-- capped at 1000 chars server-side. The status list mirrors 042: the 030
-- moderation BEFORE trigger may flip status to pending_review/cancelled BEFORE
-- this WITH CHECK evaluates, so those values must be allowed here.
drop policy if exists "Public insert feedback_posts" on feedback_posts;
create policy "Anon can insert feedback"
  on feedback_posts for insert to anon
  with check (
    is_private = true
    and coalesce(votes, 0) = 0
    and image_url is null
    and category = 'orb'
    and char_length(body) between 1 and 1000
    and status in ('published','pending_review','cancelled')
  );

-- ── 4. Coarse global velocity cap (server-side flood backstop). ───────────────
-- Postgres has no per-IP identity for anon PostgREST traffic, so this caps flood
-- VOLUME regardless of source. Tuned far above real traffic (a handful/day) so
-- legitimate users never hit it. Per-IP throttling is a documented follow-up.
create or replace function feedback_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare recent int;
begin
  if moderation_request_role() is distinct from 'anon' then return NEW; end if;
  select count(*) into recent
    from feedback_posts
    where created_at > now() - interval '1 minute';
  if recent >= 20 then
    raise exception 'feedback rate limit exceeded' using errcode = 'check_violation';
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_feedback_rate_limit on feedback_posts;
create trigger trg_feedback_rate_limit
  before insert on feedback_posts
  for each row execute function feedback_rate_limit();

commit;
