-- Allow anon to update resolved_at on feedback posts (used by admin resolve button)
create policy "Allow update feedback posts"
  on feedback_posts for update to anon
  using (true)
  with check (true);
