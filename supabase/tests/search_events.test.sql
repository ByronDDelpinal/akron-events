-- ════════════════════════════════════════════════════════════════════════════
-- search_events.test.sql
--
-- Regression tests for migration 076 (venue + organizer names in search,
-- acronym / compound forms, tiered matching, spelling suggestion).
--
-- THE BUG. A visitor searched for shows at "GAR Hall" and found nothing: the
-- venue is "The G.A.R. Hall", search only looked at an event's own title /
-- description / tags, and "G.A.R." was indexed as the words g, a, r.
--
-- What this file pins:
--
--   §1  Venue and organizer names are searchable, including the acronym
--       spellings a person actually types.
--   §2  Equivalent spellings: theatre/theater, & / and, hyphen compounds,
--       run-together names, apostrophes, accents.
--   §3  ⚠️  TIER DISCIPLINE. Results are date-sorted, so a looser tier must
--       never be blended into a tighter one. "improv" must not return
--       "improve" while an improv event exists; a phrase match must suppress
--       the any-order matches. If someone turns the tiers into a UNION, these
--       are the assertions that fail.
--   §4  The any-order tier does fire when no phrase matches; a prefix never
--       matches silently.
--   §5  search_suggest offers a completion or a spelling correction ONLY when
--       the search is empty, only for long-enough words, and never invents a
--       first letter for a short word.
--   §6  The document follows its sources: rename, re-link, retitle, delete.
--       A refresh that changes nothing writes nothing. Past events carry no
--       document; one moved into the future gains one.
--   §7  Published + floor rules, the venue scope, and who may touch what.
--
-- Run against a database with 076 applied. Rolls itself back. Fixtures are
-- tagged source = 'search_test' and every assertion filters on it.
--
-- Local chain on stock PostgreSQL 16 (same roles and non-superuser owner as
-- supabase/tests/scaffold/README.md; fuzzystrmatch must be creatable, so
-- create the `extensions` schema and the extension as a superuser first):
--   psql "$C" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/scaffold/partner_scaffold_base.sql \
--     -f supabase/migrations/072_search_strip_apostrophes.sql \
--     -f supabase/migrations/074_search_events_fts.sql \
--     -f supabase/migrations/076_search_names_tiers_suggest.sql \
--     -f supabase/tests/search_events.test.sql
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- Titles found for a term, sorted, as one string. Fixtures all carry the
-- source 'search_test', so rows already in the database are ignored.
create function pg_temp.found(p_term text, p_cities text[] default null)
returns text language sql as $$
  select coalesce(string_agg(title, ' | ' order by title), '')
  from search_events(p_term, now(), null, p_cities)
  where source = 'search_test';
$$;

create function pg_temp.expect(p_label text, p_got text, p_want text)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL %: got [%], want [%]', p_label, p_got, p_want;
  end if;
end;
$$;

do $$
declare
  v_gar uuid; v_civic uuid; v_jillys uuid; v_blu uuid; v_musica uuid; v_rialto uuid; v_ej uuid;
  o_pen uuid; o_sym uuid;
  e_horse uuid; e_piano uuid; e_sing uuid; e_blu uuid; e_y2 uuid; e_rb uuid;
  e_improv uuid; e_improve uuid; e_jn uuid; e_nj uuid; e_past uuid; e_draft uuid;
  e_jilly uuid; e_rialto uuid; e_mozart uuid; e_poke uuid;
  v_xmin_before xid; v_xmin_after xid;
  v_n int;
  soon constant timestamptz := now() + interval '3 days';
begin
  -- ── Fixtures ───────────────────────────────────────────────────────────
  insert into venues (name, city) values ('zzt The G.A.R. Hall', 'Peninsula') returning id into v_gar;
  insert into venues (name, city) values ('zzt Akron Civic Theatre', 'Akron')  returning id into v_civic;
  insert into venues (name, city) values ('zzt Jilly''s Music Room', 'Akron')  returning id into v_jillys;
  insert into venues (name, city) values ('zzt BLUJazz+', 'Akron')             returning id into v_blu;
  insert into venues (name, city) values ('zzt Musica', 'Akron')               returning id into v_musica;
  insert into venues (name, city) values ('zzt The Rialto Theatre', 'Akron')   returning id into v_rialto;
  insert into venues (name, city) values ('zzt E.J. Thomas Performing Arts Hall', 'Akron') returning id into v_ej;
  insert into organizations (name) values ('zzt Peninsula Foundation')         returning id into o_pen;
  insert into organizations (name) values ('zzt Akron Symphony Orchestra')     returning id into o_sym;

  insert into events (title, description, start_at, status, source, source_id)
    values ('High Horse', 'An evening of bluegrass.', soon, 'published', 'search_test', '1') returning id into e_horse;
  insert into events (title, description, start_at, status, source, source_id)
    values ('The Piano Guys', 'Two pianos.', soon, 'published', 'search_test', '2') returning id into e_piano;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Sing-Along Social', 'Bring a friend.', soon, 'published', 'search_test', '3') returning id into e_sing;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Sam Blakeslee Large Group', 'Album release.', soon, 'published', 'search_test', '4') returning id into e_blu;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Y2AKRON: The Ultimate 2000s Night', 'Dance party.', soon, 'published', 'search_test', '5') returning id into e_y2;
  insert into events (title, description, start_at, status, source, source_id)
    values ('R&B Brunch', 'Food & drink specials.', soon, 'published', 'search_test', '6') returning id into e_rb;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Improv Night', 'Short-form comedy.', soon, 'published', 'search_test', '7') returning id into e_improv;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Improve Your Garden', 'A workshop.', soon, 'published', 'search_test', '8') returning id into e_improve;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Jazz Night', 'Weekly.', soon, 'published', 'search_test', '9') returning id into e_jn;
  insert into events (title, description, start_at, status, source, source_id)
    values ('A Night of Cool Jazz', 'One time only.', soon, 'published', 'search_test', '10') returning id into e_nj;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Zydeco Reunion', 'Last year.', now() - interval '30 days', 'published', 'search_test', '11') returning id into e_past;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Zydeco Preview', 'Not yet approved.', soon, 'pending_review', 'search_test', '12') returning id into e_draft;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Back & Forth: Foo Fighters Tribute', 'Loud.', soon, 'published', 'search_test', '13') returning id into e_jilly;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Charley Bowman in the Living Room', 'Acoustic.', soon, 'published', 'search_test', '14') returning id into e_rialto;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Mozart Requiem', 'Full chorus.', soon, 'published', 'search_test', '15') returning id into e_mozart;
  insert into events (title, description, start_at, status, source, source_id)
    values ('Pokémon Club', 'Trade cards.', soon, 'published', 'search_test', '16') returning id into e_poke;

  insert into event_venues (event_id, venue_id) values
    (e_horse, v_gar), (e_piano, v_civic), (e_blu, v_blu), (e_y2, v_musica),
    (e_jilly, v_jillys), (e_rialto, v_rialto), (e_mozart, v_ej);
  insert into event_organizations (event_id, organization_id) values
    (e_horse, o_pen), (e_mozart, o_sym);

  -- ── §1  Venue and organizer names ─────────────────────────────────────
  perform pg_temp.expect('1a gar hall',        pg_temp.found('gar hall'),        'High Horse');
  perform pg_temp.expect('1b GAR Hall',        pg_temp.found('GAR Hall'),        'High Horse');
  perform pg_temp.expect('1c g.a.r. hall',     pg_temp.found('g.a.r. hall'),     'High Horse');
  perform pg_temp.expect('1d G.A.R',           pg_temp.found('G.A.R'),           'High Horse');
  perform pg_temp.expect('1e organizer',       pg_temp.found('peninsula foundation'), 'High Horse');
  perform pg_temp.expect('1f title + venue',   pg_temp.found('high horse gar hall'),  'High Horse');
  perform pg_temp.expect('1g ej thomas',       pg_temp.found('ej thomas'),       'Mozart Requiem');
  perform pg_temp.expect('1h e.j. thomas',     pg_temp.found('E.J. Thomas'),     'Mozart Requiem');
  perform pg_temp.expect('1i musica',          pg_temp.found('musica'),          'Y2AKRON: The Ultimate 2000s Night');

  -- ── §2  Equivalent spellings ──────────────────────────────────────────
  perform pg_temp.expect('2a theater -> theatre', pg_temp.found('akron civic theater'), 'The Piano Guys');
  perform pg_temp.expect('2b theatre',            pg_temp.found('akron civic theatre'), 'The Piano Guys');
  perform pg_temp.expect('2c singalong',          pg_temp.found('singalong'),   'Sing-Along Social');
  perform pg_temp.expect('2d sing along',         pg_temp.found('sing along'),  'Sing-Along Social');
  perform pg_temp.expect('2e sing-along',         pg_temp.found('sing-along'),  'Sing-Along Social');
  perform pg_temp.expect('2f blu jazz',           pg_temp.found('blu jazz'),    'Sam Blakeslee Large Group');
  perform pg_temp.expect('2g blujazz',            pg_temp.found('blujazz'),     'Sam Blakeslee Large Group');
  perform pg_temp.expect('2h r&b',                pg_temp.found('r&b'),         'R&B Brunch');
  perform pg_temp.expect('2i r and b',            pg_temp.found('r and b'),     'R&B Brunch');
  perform pg_temp.expect('2j food and drink',     pg_temp.found('food and drink'), 'R&B Brunch');
  perform pg_temp.expect('2k jillys',             pg_temp.found('jillys'),      'Back & Forth: Foo Fighters Tribute');
  perform pg_temp.expect('2l jilly''s',           pg_temp.found('jilly''s music room'), 'Back & Forth: Foo Fighters Tribute');
  perform pg_temp.expect('2m pokemon',            pg_temp.found('pokemon'),     'Pokémon Club');
  perform pg_temp.expect('2n y2akron',            pg_temp.found('y2akron'),     'Y2AKRON: The Ultimate 2000s Night');

  -- ── §3  Tier discipline ───────────────────────────────────────────────
  -- Whole word exists -> the prefix tier must not run.
  perform pg_temp.expect('3a improv is not improve', pg_temp.found('improv'), 'Improv Night');
  -- Phrase exists -> the any-order tier must not run.
  perform pg_temp.expect('3b phrase beats any-order', pg_temp.found('jazz night'), 'Jazz Night');
  -- Every word is required: "jazz" alone is not enough.
  perform pg_temp.expect('3c all words required',     pg_temp.found('jazz requiem'), '');
  -- Punctuation-only and empty terms match nothing rather than everything.
  perform pg_temp.expect('3d empty',       pg_temp.found(''),    '');
  perform pg_temp.expect('3e punctuation', pg_temp.found('...'), '');

  -- ── §4  Any-order fires when no phrase matches; prefixes never do ─────
  perform pg_temp.expect('4a any order',       pg_temp.found('hall gar'),     'High Horse');
  perform pg_temp.expect('4b any order, title', pg_temp.found('jazz cool'),   'A Night of Cool Jazz');
  -- A prefix is never a silent match, even when nothing else matches.
  perform pg_temp.expect('4c no silent prefix', pg_temp.found('jilly'),       '');
  perform pg_temp.expect('4d no silent prefix', pg_temp.found('mozart requ'), '');
  delete from events where id = e_improv;
  perform pg_temp.expect('4e improv is never improve', pg_temp.found('improv'), '');

  -- ── §5  Spelling suggestion ───────────────────────────────────────────
  perform pg_temp.expect('5a one typo',        search_suggest('musika'),           'musica');
  perform pg_temp.expect('5b transposition',   search_suggest('railto'),           'rialto');
  perform pg_temp.expect('5c in a phrase',     search_suggest('symphony orchesta'), 'symphony orchestra');
  perform pg_temp.expect('5d two words fixed', search_suggest('peninsulla fondation'), 'peninsula foundation');
  -- Two typos are allowed from 9 letters, not below.
  perform pg_temp.expect('5e two typos, 9+',   search_suggest('peninsula fondasion'), 'peninsula foundation');
  perform pg_temp.expect('5e2 two typos, <9',  search_suggest('symphony orkestra'), null);
  -- The term matches -> never a suggestion, even though a near word exists.
  perform pg_temp.expect('5f term matches',    search_suggest('musica'),           null);
  perform pg_temp.expect('5g prefix matches',  search_suggest('music'),            null);
  -- Words under 5 letters are never corrected.
  perform pg_temp.expect('5h short word',      search_suggest('gra'),              null);
  -- Completion: 3+ letters typed, the whole term must then match.
  perform pg_temp.expect('5m completion',          search_suggest('jilly'),       'jillys');
  perform pg_temp.expect('5n completion, 2 words', search_suggest('mozart requ'), 'mozart requiem');
  perform pg_temp.expect('5o completion, 3 chars', search_suggest('jaz'),         'jazz');
  perform pg_temp.expect('5p too short',           search_suggest('mozart re'),   null);
  perform pg_temp.expect('5q no such pairing',     search_suggest('mozart jill'), null);
  -- Wrong first letter on a short word costs two typos: no suggestion.
  perform pg_temp.expect('5j first letter',    search_suggest('nusica'),           null);
  -- Nothing close: no suggestion.
  perform pg_temp.expect('5k nonsense',        search_suggest('qwertyuiop'),       null);
  -- Only upcoming, published vocabulary is used.
  perform pg_temp.expect('5l past/draft vocab', search_suggest('zydeko'),          null);

  -- ── §6  The document follows its sources ──────────────────────────────
  update venues set name = 'zzt Peninsula Opera House' where id = v_gar;
  perform pg_temp.expect('6a rename: old name gone', pg_temp.found('gar hall'),    '');
  perform pg_temp.expect('6b rename: new name found', pg_temp.found('opera house'), 'High Horse');

  update organizations set name = 'zzt Valley Arts Trust' where id = o_pen;
  perform pg_temp.expect('6c org rename', pg_temp.found('valley arts trust'), 'High Horse');

  delete from event_venues where event_id = e_horse and venue_id = v_gar;
  perform pg_temp.expect('6d unlink', pg_temp.found('opera house'), '');

  update event_venues set venue_id = v_gar where event_id = e_y2;
  perform pg_temp.expect('6e re-link: new venue', pg_temp.found('opera house'), 'Y2AKRON: The Ultimate 2000s Night');
  perform pg_temp.expect('6f re-link: old venue', pg_temp.found('musica'),      '');

  update events set title = 'Low Pony' where id = e_horse;
  perform pg_temp.expect('6g retitle: new', pg_temp.found('low pony'),   'Low Pony');
  perform pg_temp.expect('6h retitle: old', pg_temp.found('high horse'), '');

  -- An update that leaves the searchable text alone must not rewrite the doc,
  -- and neither must an explicit refresh.
  select xmin into v_xmin_before from event_search_docs where event_id = e_horse;
  update events set price_min = 5 where id = e_horse;
  perform refresh_event_search_docs(array[e_horse]);
  select xmin into v_xmin_after from event_search_docs where event_id = e_horse;
  if v_xmin_before is distinct from v_xmin_after then
    raise exception 'FAIL 6i: unchanged document was rewritten';
  end if;

  delete from events where id = e_horse;
  select count(*) into v_n from event_search_docs where event_id = e_horse;
  if v_n <> 0 then raise exception 'FAIL 6j: document outlived its event'; end if;

  -- Past events carry no document; rescheduling one into the future adds it,
  -- and letting it lapse again removes it.
  select count(*) into v_n from event_search_docs where event_id = e_past;
  if v_n <> 0 then raise exception 'FAIL 6k: a past event has a document'; end if;
  update events set start_at = soon where id = e_past;
  perform pg_temp.expect('6l rescheduled into the future', pg_temp.found('zydeco reunion'), 'Zydeco Reunion');
  update events set start_at = now() - interval '30 days' where id = e_past;
  select count(*) into v_n from event_search_docs where event_id = e_past;
  if v_n <> 0 then raise exception 'FAIL 6m: a lapsed event kept its document'; end if;

  -- ── §7  Published + floor, scope, privileges ──────────────────────────
  perform pg_temp.expect('7a past event hidden',  pg_temp.found('zydeco reunion'), '');
  perform pg_temp.expect('7b draft hidden',       pg_temp.found('zydeco preview'), '');
  perform pg_temp.expect('7c city scope keeps',   pg_temp.found('piano', array['Akron']),     'The Piano Guys');
  perform pg_temp.expect('7d city scope drops',   pg_temp.found('piano', array['Peninsula']), '');

  if has_table_privilege('anon', 'event_search_docs', 'select')
     or has_table_privilege('authenticated', 'event_search_docs', 'select') then
    raise exception 'FAIL 7e: event_search_docs is readable by a request role';
  end if;
  if has_function_privilege('anon', 'refresh_event_search_docs(uuid[])', 'execute') then
    raise exception 'FAIL 7f: anon can call refresh_event_search_docs';
  end if;
  if not has_function_privilege('anon', 'search_events(text, timestamptz, text, text[])', 'execute')
     or not has_function_privilege('anon', 'search_suggest(text, timestamptz)', 'execute') then
    raise exception 'FAIL 7g: anon cannot call the public search functions';
  end if;

  raise notice 'search_events.test.sql: all assertions passed';
end
$$;

-- §7h  The public functions work AS anon (definer rights reach the doc table).
set local role anon;
do $$
begin
  if (select count(*) from search_events('piano guys') where source = 'search_test') <> 1 then
    raise exception 'FAIL 7h: anon search_events returned the wrong rows';
  end if;
  perform search_suggest('pianno guys');
  raise notice 'search_events.test.sql: anon checks passed';
end
$$;
reset role;

rollback;
