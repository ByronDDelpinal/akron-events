-- 058_feedback_email.sql
-- Add an optional, nullable email column to feedback_posts so a visitor
-- can leave a reply-to address with their feedback note. No NOT NULL and
-- no format/regex CHECK at the DB layer (format validation stays
-- client-side only, in src/lib/feedback.ts) — just a length cap matching
-- the practical RFC 5321 max, folded into the existing anon insert
-- policy alongside the other WITH CHECK clauses. A bare empty string is
-- treated the same as "no email" and rejected too (between 1 and 254,
-- not <= 254) so the column is always either a real string or null.

begin;

-- `if not exists` matches 30 of the 32 `add column` statements in this repo.
-- Without it a re-run aborts on 42701 BEFORE reaching the alter policy below,
-- which would leave the length cap enforced client-side only -- the failure
-- mode is silent, and the column would look correctly migrated.
alter table feedback_posts add column if not exists email text;

alter policy "Anon can insert feedback"
  on feedback_posts
  with check (
    is_private = true
    and coalesce(votes, 0) = 0
    and image_url is null
    and category = 'orb'
    and char_length(body) between 1 and 1000
    and status in ('published','pending_review','cancelled')
    and (email is null or char_length(email) between 1 and 254)
  );

commit;
