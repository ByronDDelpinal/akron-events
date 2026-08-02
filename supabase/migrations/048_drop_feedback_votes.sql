-- ════════════════════════════════════════════════════════════════════════════
-- 048_drop_feedback_votes.sql
--
-- Drops the orphaned feedback_votes table left behind by the Town Square
-- board removal. The public board UI was removed 2026-07-25 (043 replaced it
-- with the header orb dialog), and nothing reads or writes feedback_votes
-- anymore. 038 (lines 130-132) intentionally left the 012 anon INSERT/SELECT/
-- DELETE policies on feedback_votes live because the board still used them,
-- so anon could still write rows into a dead table; dropping the table closes
-- that surface.
--
-- Dropping the table also removes its index (idx_feedback_votes_post), the
-- FK to feedback_posts, and the four 012-era RLS policies on it. The
-- feedback_posts.votes column and the migration files 012-017 themselves are
-- untouched.
--
-- src/lib/database.types.ts is regenerated after this is applied.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Vote-count trigger on feedback_votes (012). ────────────────────────────
drop trigger if exists trg_feedback_vote_count on feedback_votes;

-- ── 2. The trigger function it called (012). ──────────────────────────────────
drop function if exists update_feedback_vote_count();

-- ── 3. The table itself: takes the index, FK, and RLS policies with it. ───────
drop table if exists feedback_votes;

commit;
