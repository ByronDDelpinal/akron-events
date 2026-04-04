-- Add image_url to feedback posts
alter table feedback_posts
  add column if not exists image_url text;

-- Create storage bucket for feedback images (public so images render without auth)
insert into storage.buckets (id, name, public)
values ('feedback-images', 'feedback-images', true)
on conflict (id) do nothing;

-- Allow anonymous uploads to feedback-images bucket
create policy "Public upload feedback images"
  on storage.objects for insert to anon
  with check (bucket_id = 'feedback-images');

-- Allow public reads
create policy "Public read feedback images"
  on storage.objects for select to anon
  using (bucket_id = 'feedback-images');
