-- Feedback board ("Town Square")
-- Public-facing feedback with upvoting

create table feedback_posts (
  id          bigint generated always as identity primary key,
  category    text not null check (category in ('bug','love','wish','confusing','idea','general')),
  body        text not null,
  author_name text not null default 'Anonymous',
  is_private  boolean not null default false,
  votes       int  not null default 0,
  created_at  timestamptz not null default now()
);

-- Tracks individual upvotes so each browser fingerprint can only vote once per post
create table feedback_votes (
  id          bigint generated always as identity primary key,
  post_id     bigint not null references feedback_posts(id) on delete cascade,
  voter_id    text not null,            -- browser fingerprint or session id
  created_at  timestamptz not null default now(),
  unique(post_id, voter_id)
);

-- Index for fast lookups
create index idx_feedback_posts_category on feedback_posts(category);
create index idx_feedback_votes_post     on feedback_votes(post_id);

-- RLS: anyone can read posts and votes
alter table feedback_posts  enable row level security;
alter table feedback_votes  enable row level security;

create policy "Public read feedback_posts"
  on feedback_posts for select to anon using (true);

create policy "Public insert feedback_posts"
  on feedback_posts for insert to anon with check (true);

create policy "Public read feedback_votes"
  on feedback_votes for select to anon using (true);

create policy "Public insert feedback_votes"
  on feedback_votes for insert to anon with check (true);

-- Allow the vote count to be updated via an RPC or trigger
-- Using a trigger keeps it simple: auto-increment/decrement votes on feedback_posts
create or replace function update_feedback_vote_count()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    update feedback_posts set votes = votes + 1 where id = NEW.post_id;
    return NEW;
  elsif TG_OP = 'DELETE' then
    update feedback_posts set votes = votes - 1 where id = OLD.post_id;
    return OLD;
  end if;
end;
$$ language plpgsql security definer;

create trigger trg_feedback_vote_count
  after insert or delete on feedback_votes
  for each row execute function update_feedback_vote_count();

-- Allow deleting own vote (for un-voting)
create policy "Public delete own feedback_votes"
  on feedback_votes for delete to anon using (true);
