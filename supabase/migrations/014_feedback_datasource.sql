-- Add 'datasource' to feedback category check constraint
alter table feedback_posts drop constraint if exists feedback_posts_category_check;
alter table feedback_posts add constraint feedback_posts_category_check
  check (category in ('bug','love','wish','confusing','idea','datasource','general'));
