-- Add resolved timestamp to feedback posts
alter table feedback_posts
  add column if not exists resolved_at timestamptz;
