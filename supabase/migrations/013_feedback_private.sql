-- Add is_private flag to feedback_posts (missed in 012)
alter table feedback_posts
  add column if not exists is_private boolean not null default false;
