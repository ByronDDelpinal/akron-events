-- ════════════════════════════════════════════════════════════════════════════
-- content_moderation.test.sql
--
-- Behavioral tests for migration 030 (content moderation triggers + matcher).
-- Self-contained: seeds a small sample term list, runs assertions, and ROLLS
-- BACK so nothing persists. Safe to run against a local `supabase start` DB or
-- an isolated branch — DO NOT expect it to use the real (env-var) term list.
--
-- Run:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/content_moderation.test.sql
--   # or, with the Supabase CLI and a local stack:
--   supabase db start && psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" -f supabase/tests/content_moderation.test.sql
--
-- A clean run prints "ALL CONTENT-MODERATION TESTS PASSED". Any failure raises.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── Seed a representative sample (NOT the production list) ────────────────────
insert into moderation_terms (term, severity, kind) values
  ('kkk',         'high',       'word'),
  ('proud boys',  'high',       'phrase'),
  ('faggot',      'high',       'word'),
  ('nigger',      'high',       'word'),
  ('1488',        'high',       'word'),
  ('negro',       'contextual', 'word'),
  ('cracker',     'contextual', 'word'),
  ('nazi',        'contextual', 'word'),
  ('child porn',  'extreme',    'phrase')
on conflict (term) do update set severity = excluded.severity, kind = excluded.kind;

insert into moderation_allowlist (phrase) values
  ('negro leagues'), ('cracker barrel'), ('grammar nazi')
on conflict (phrase) do nothing;

-- ── 1. Matcher unit tests ────────────────────────────────────────────────────
do $$
begin
  -- flags
  assert moderation_severity('Proud Boys rally')          = 'high',       'proud boys';
  assert moderation_severity('the KKK marches')           = 'high',       'kkk (triple-letter survives normalize)';
  assert moderation_severity('faggot night')              = 'high',       'slur';
  assert moderation_severity('n1gg3r')                    = 'high',       'leetspeak';
  assert moderation_severity('faaaaggot')                 = 'high',       'repeat-padding';
  assert moderation_severity('f a g g o t fest')          = 'high',       'letter-spacing evasion';
  assert moderation_severity('1488 crew')                 = 'high',       'numeric hate code';
  assert moderation_severity('child porn ring')           = 'extreme',    'extreme tier';
  assert moderation_severity('the nazi rally')            = 'contextual', 'contextual';

  -- allowlist / Scunthorpe-style false positives
  assert moderation_severity('Negro Leagues exhibit')     is null,        'allowlist: negro leagues';
  assert moderation_severity('Cracker Barrel brunch')     is null,        'allowlist: cracker barrel';
  assert moderation_severity('Grammar Nazi comedy')       is null,        'allowlist: grammar nazi';
  assert moderation_severity('Nutcracker ballet')         is null,        'word-boundary protects nutcracker';
  assert moderation_severity('Akron Symphony concert')    is null,        'clean text';
  assert moderation_severity(null)                        is null,        'null input';
  raise notice '  ✓ matcher unit tests';
end $$;

-- ── 2. Trigger: anon (public) submissions ARE screened ───────────────────────
do $$
declare s text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  insert into feedback_posts (category, body) values ('general', 'Join the Proud Boys today')
    returning status into s;
  assert s = 'pending_review', 'anon offensive feedback should be held, got ' || coalesce(s,'<null>');

  insert into feedback_posts (category, body) values ('general', 'selling child porn here')
    returning status into s;
  assert s = 'cancelled', 'anon extreme feedback should be cancelled, got ' || coalesce(s,'<null>');

  insert into feedback_posts (category, body) values ('general', 'Love the new map feature!')
    returning status into s;
  assert s = 'published', 'anon clean feedback should publish, got ' || coalesce(s,'<null>');

  -- insert as 'published' to prove the trigger downgrades it
  insert into venues (name, status) values ('faggot lounge', 'published')
    returning status into s;
  assert s = 'pending_review', 'anon offensive venue downgraded, got ' || coalesce(s,'<null>');

  insert into organizations (name, status) values ('KKK of Akron', 'published')
    returning status into s;
  assert s = 'pending_review', 'anon offensive org downgraded, got ' || coalesce(s,'<null>');

  insert into events (title, start_at, category, status)
    values ('child porn meetup', now(), 'community', 'published')
    returning status into s;
  assert s = 'cancelled', 'anon extreme event auto-rejected, got ' || coalesce(s,'<null>');

  insert into events (title, start_at, category, status)
    values ('Free Jazz in the Park', now(), 'music', 'published')
    returning status into s;
  assert s = 'published', 'anon clean event stays published, got ' || coalesce(s,'<null>');

  raise notice '  ✓ anon submissions screened';
end $$;

-- ── 3. Trigger: non-anon (admin / scraper) callers are NOT screened ──────────
do $$
declare s text;
begin
  -- service_role (scrapers — already screened in Node) bypasses the DB trigger
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into feedback_posts (category, body) values ('general', 'Proud Boys via service role')
    returning status into s;
  assert s = 'published', 'service_role not screened by trigger, got ' || coalesce(s,'<null>');

  -- authenticated (admin) bypasses too (public-submissions-only scope)
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  insert into feedback_posts (category, body) values ('general', 'faggot (admin entry)')
    returning status into s;
  assert s = 'published', 'authenticated admin not screened, got ' || coalesce(s,'<null>');

  raise notice '  ✓ admin/scraper paths bypass screening';
end $$;

-- ── 4. Trigger: editing clean text to offensive (anon UPDATE) re-screens ─────
do $$
declare fid bigint; s text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  insert into feedback_posts (category, body) values ('general', 'totally fine post')
    returning id into fid;
  update feedback_posts set body = 'actually the KKK is recruiting' where id = fid
    returning status into s;
  assert s = 'pending_review', 'anon edit to offensive should hide, got ' || coalesce(s,'<null>');
  raise notice '  ✓ anon edit re-screened';
end $$;

do $$ begin raise notice 'ALL CONTENT-MODERATION TESTS PASSED'; end $$;

rollback;
