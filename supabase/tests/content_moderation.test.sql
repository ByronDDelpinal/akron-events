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

  -- NOTE: `events.category` was dropped by 029_taxonomy_v2_faceted; these two
  -- inserts named it until 059's test pass and failed with "column category of
  -- relation events does not exist" before reaching section 3 below.
  insert into events (title, start_at, status)
    values ('child porn meetup', now(), 'published')
    returning status into s;
  assert s = 'cancelled', 'anon extreme event auto-rejected, got ' || coalesce(s,'<null>');

  insert into events (title, start_at, status)
    values ('Free Jazz in the Park', now(), 'published')
    returning status into s;
  assert s = 'published', 'anon clean event stays published, got ' || coalesce(s,'<null>');

  raise notice '  ✓ anon submissions screened';
end $$;

-- ── 3. Trigger: who is exempt, and who is not ────────────────────────────────
-- REWRITTEN FOR MIGRATION 059. 030 gated on
-- `moderation_request_role() is distinct from 'anon'`, so this section used to
-- assert that ANY signed-in caller bypassed the screen. That was the bug --
-- the same one 054 fixed for embed_request_force_intake_defaults and 055 for
-- moderation_screen_day_plan. 059 narrows the exemption to three principals
-- and screens everyone else, so the third assertion below now says the
-- opposite of what it said before, on purpose.
--
--   • service_role -- scrapers, already screened in Node (049:18-21)
--   • ANY admin    -- an admin's UPDATEs to the screened columns ARE the
--                     triage; re-screening them would revert their own
--                     decisions. 059 seeds TWO administrators and the roster
--                     is data, so the block below loops over admin_users
--                     instead of naming a uuid: every row on the roster must
--                     bypass, however many rows it has.
--   • a direct database connection with no request JWT -- psql, migrations,
--                     and the Supabase SQL editor, which 051:126-130
--                     documents as the real triage path for tables with no
--                     admin UI. Verified 2026-08-21: in the SQL editor
--                     request.jwt.claims is NULL, so is_admin() is false
--                     there and the admin exemption alone would not cover it.
--   • everyone else, INCLUDING a signed-in non-admin, is screened.
do $$
declare s text; v_admin uuid; v_seen int := 0;
begin
  assert exists (select 1 from admin_users),
    'admin_users is empty -- migration 059 must seed the administrators before any policy references is_admin()';

  -- service_role (scrapers — already screened in Node) bypasses the DB trigger
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into feedback_posts (category, body) values ('general', 'Proud Boys via service role')
    returning status into s;
  assert s = 'published', 'service_role not screened by trigger, got ' || coalesce(s,'<null>');

  -- EVERY admin bypasses too: a JWT whose `sub` is in admin_users. Walking the
  -- table rather than picking one row is what makes this hold for the second
  -- administrator 059 seeds, and for any added afterwards by hand.
  for v_admin in select user_id from admin_users order by email loop
    perform set_config('request.jwt.claims',
      '{"role":"authenticated","sub":"' || v_admin || '"}', true);
    insert into feedback_posts (category, body)
    values ('general', 'faggot (admin entry ' || v_admin || ')')
      returning status into s;
    assert s = 'published',
      'admin ' || v_admin || ' must not be screened -- an admin''s edits are the triage, got ' || coalesce(s,'<null>');
    v_seen := v_seen + 1;
  end loop;

  assert v_seen >= 2,
    '059 seeds TWO administrators; only ' || v_seen || ' row(s) on the roster were exercised -- check the section 2 seed';

  -- a direct database connection (no request JWT at all) bypasses too
  perform set_config('request.jwt.claims', '', true);
  insert into feedback_posts (category, body) values ('general', 'faggot (SQL editor entry)')
    returning status into s;
  assert s = 'published', 'a direct database connection must not be screened, got ' || coalesce(s,'<null>');

  -- but a SIGNED-IN NON-ADMIN is screened. Before 059 this row published
  -- unscreened, which is the whole reason 059 touches these four functions.
  -- The uuid is synthetic and must stay off the roster, or this assertion is
  -- vacuous -- both real auth users are administrators.
  assert not exists (select 1 from admin_users where user_id = '00000000-0000-4000-8000-000000000000'),
    'the non-admin fixture is on the admin roster -- pick a uuid that is not';
  perform set_config('request.jwt.claims',
    '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000000"}', true);
  insert into feedback_posts (category, body) values ('general', 'faggot (signed-in stranger)')
    returning status into s;
  assert s = 'pending_review',
    'a signed-in NON-admin must be screened -- migration 059; got ' || coalesce(s,'<null>');

  raise notice '  ✓ service_role / every seeded admin / direct-DB bypass screening; a signed-in non-admin does not';
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
