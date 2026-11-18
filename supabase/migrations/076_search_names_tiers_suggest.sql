-- ============================================================
-- Search: venue + organizer names, acronym/compound forms,
-- tiered matching, and a spelling suggestion for empty results
--
-- Problem (visitor feedback, 2026-11-18): a visitor filtered a weekend
-- to Music and could not find shows at Musica or the G.A.R. Hall, then
-- concluded "the search filters may not be working". Checked on prod:
--
--   term                  matched   upcoming events at that venue
--   "gar hall"                 0     13   (name is "The G.A.R. Hall")
--   "goodyear theater"         1     24
--   "akron civic theatre"      4     35
--   "peninsula foundation"     0     (organizer; never searchable)
--
-- Two causes. (1) search_events (074) only indexes an event's own
-- title / description / tags, so a venue or organizer matches only when
-- the description happens to repeat its name. (2) 074 turns every
-- non-alphanumeric into a space, so "G.A.R." is indexed as the three
-- words g, a, r and the query "gar" matches none of them.
--
-- What this migration does
--
--   1. One canonical form for documents AND queries (search_canon_text):
--        "&" -> "and"; dotted initials joined (G.A.R. -> gar, E.J. -> ej,
--        p.m. -> pm); theatre -> theater, centre -> center; then, as
--        before, every other separator becomes a space.
--      Documents additionally carry the joined form of hyphen / slash
--      compounds (sing-along -> singalong, AC/DC -> acdc), so either
--      spelling of the query finds them.
--
--   2. Venue and organizer names are part of the searchable document.
--      The document lives in a side table, event_search_docs, not on
--      events: maintaining it never rewrites an events row, so it cannot
--      trip the events triggers (manual-override pins, review re-open,
--      updated_at) or the skip-unchanged-writes path from 075.
--
--   3. search_events tries two queries and returns the FIRST that
--      matches anything upcoming:
--        T1  the words as an adjacent phrase            (074's behaviour)
--        T2  all the words, any order -- or, for 2-3 words, the words
--            run together ("blu jazz" finds "BLUJazz")
--      Results are sorted by date, not relevance, so tiers are never
--      blended: an any-order match can only appear when no phrase match
--      exists. Both tiers match whole words only: "improv" never
--      returns "improve".
--
--   4. search_suggest(term): when a search finds nothing, the client
--      asks for a replacement term, re-runs the search with it and SAYS
--      SO ("No exact matches for X. Showing results for Y"). Two kinds,
--      both drawn from the words in upcoming titles / venue names /
--      organizer names:
--        completion  the last word finished ("jilly" -> "jillys"),
--                    3+ letters typed
--        spelling    5+ letter words that are not in that vocabulary:
--                    one typo for 5-8 letters, two for 9+, a wrong first
--                    letter counts double (the Meilisearch defaults)
--      Prefix and fuzzy matches are deliberately NOT a silent third tier
--      inside search_events. Measured on prod: "drag" has no whole-word
--      match, and a silent prefix tier answered it with 61 Dungeons &
--      Dragons listings. A labelled single completion shows the visitor
--      what was substituted; an unlabelled one reads as a broken search.
--
--   5. Only events that have not started more than a day ago carry a
--      document. The search floor is always "now", so documents for the
--      ~15,000 past events would be ~35 MB that no query can reach.
--      A daily pg_cron job removes documents as their events pass.
--
-- Security: search_events and search_suggest are SECURITY DEFINER and
-- hard-code status = 'published', the same rule as the "Public can read
-- published events" policy. event_search_docs has RLS on and no
-- policies; only these functions and the maintenance triggers read or
-- write it. Venue and organization names are already world-readable.
--
-- Supersedes 074's expression index (events_search_tsv_idx) and
-- event_search_tsv(); both are dropped. Rollback:
-- supabase/rollbacks/076_search_names_tiers_suggest_rollback.sql
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA extensions;

-- ------------------------------------------------------------
-- 1. Canonical text
-- ------------------------------------------------------------

-- Input is already search_normalize()d (lower-cased, unaccented,
-- apostrophes removed). IMMUTABLE so it can back a stored tsvector.
CREATE OR REPLACE FUNCTION public.search_canon_text(p_normalized text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            replace(coalesce(p_normalized, ''), '&', ' and '),
            -- A single letter at the start of a word, then a dot, then
            -- another single letter: drop the dot. No spaces allowed, so
            -- "Plan B. A talk" is left alone.
            '\m([a-z])\.(?=[a-z](\.|\M))', '\1', 'g'
          ),
          '\mtheatre(s?)\M', 'theater\1', 'g'
        ),
        '\mcentre(s?)\M', 'center\1', 'g'
      ),
      '[^[:alnum:]]+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION public.search_canon_text(text) IS
  'Canonical searchable form of already-normalized text. Applied identically to documents and queries: any rule added here needs a full rebuild of event_search_docs.';

-- Raw text -> canonical. STABLE because unaccent() is.
CREATE OR REPLACE FUNCTION public.search_canon(p_raw text)
RETURNS text
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT search_canon_text(search_normalize(p_raw));
$$;

-- Joined spellings of hyphen / slash compounds, for documents only.
CREATE OR REPLACE FUNCTION public.search_joined_forms(p_normalized text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT coalesce(string_agg(DISTINCT regexp_replace(m[1], '[-/]', '', 'g'), ' '), '')
  FROM regexp_matches(
         coalesce(p_normalized, ''),
         '\m([a-z0-9]+(?:[-/][a-z0-9]+){1,3})\M', 'g'
       ) AS m
  WHERE length(m[1]) <= 40;
$$;

CREATE OR REPLACE FUNCTION public.search_doc_tsv(
  p_title_normalized text,
  p_description_normalized text,
  p_names_normalized text
)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT to_tsvector(
    'pg_catalog.simple'::regconfig,
    public.search_canon_text(b.body) || ' ' || public.search_joined_forms(b.body)
  )
  FROM (
    SELECT coalesce(p_title_normalized, '') || ' '
        || coalesce(p_names_normalized, '') || ' '
        || coalesce(p_description_normalized, '') AS body
  ) AS b;
$$;

-- Title + venue + organizer words only: the vocabulary search_suggest
-- corrects against. Descriptions are deliberately excluded.
CREATE OR REPLACE FUNCTION public.search_name_tsv(
  p_title_normalized text,
  p_names_normalized text
)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT to_tsvector(
    'pg_catalog.simple'::regconfig,
    public.search_canon_text(coalesce(p_title_normalized, '') || ' ' || coalesce(p_names_normalized, ''))
  );
$$;

-- ------------------------------------------------------------
-- 2. The search document table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_search_docs (
  event_id uuid PRIMARY KEY REFERENCES public.events (id) ON DELETE CASCADE,
  tsv      tsvector NOT NULL,
  name_tsv tsvector NOT NULL
);

COMMENT ON TABLE public.event_search_docs IS
  'Derived search document per event: title, description, tags, venue names and organizer names in canonical form. Maintained by the event_search_docs_* triggers; read only by search_events() and search_suggest(). Holds upcoming events only (started no more than a day ago). Rebuild: SELECT refresh_event_search_docs(ARRAY(SELECT id FROM events)).';

CREATE INDEX IF NOT EXISTS event_search_docs_tsv_idx
  ON public.event_search_docs USING gin (tsv);

ALTER TABLE public.event_search_docs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_search_docs FROM PUBLIC, anon, authenticated;

-- Recompute the document for the given events. Writes only when the
-- document actually changed. An event that started more than a day ago
-- gets no document, and loses the one it had.
CREATE OR REPLACE FUNCTION public.refresh_event_search_docs(p_event_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM event_search_docs d
  USING events e
  WHERE d.event_id = ANY (p_event_ids)
    AND e.id = d.event_id
    AND e.start_at < now() - interval '1 day';

  INSERT INTO event_search_docs AS d (event_id, tsv, name_tsv)
  SELECT e.id,
         search_doc_tsv(e.title_normalized, e.description_normalized, n.names),
         search_name_tsv(e.title_normalized, n.names)
  FROM events e
  CROSS JOIN LATERAL (
    SELECT search_normalize(coalesce(string_agg(DISTINCT x.name, ' '), '')) AS names
    FROM (
      SELECT v.name
      FROM event_venues ev
      JOIN venues v ON v.id = ev.venue_id
      WHERE ev.event_id = e.id
      UNION ALL
      SELECT o.name
      FROM event_organizations eo
      JOIN organizations o ON o.id = eo.organization_id
      WHERE eo.event_id = e.id
    ) AS x
  ) AS n
  WHERE e.id = ANY (p_event_ids)
    AND e.start_at >= now() - interval '1 day'
  ON CONFLICT (event_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, name_tsv = EXCLUDED.name_tsv
    WHERE d.tsv IS DISTINCT FROM EXCLUDED.tsv
       OR d.name_tsv IS DISTINCT FROM EXCLUDED.name_tsv;
$$;

REVOKE ALL ON FUNCTION public.refresh_event_search_docs(uuid[]) FROM PUBLIC, anon, authenticated;

-- Trigger functions. SECURITY DEFINER: the writers include anon (public
-- submit form) and partners, none of whom may touch event_search_docs.

CREATE OR REPLACE FUNCTION public.event_search_docs_on_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_event_search_docs(ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;

-- Shared by event_venues and event_organizations (both carry event_id).
CREATE OR REPLACE FUNCTION public.event_search_docs_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_event_search_docs(ARRAY[OLD.event_id]);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM refresh_event_search_docs(ARRAY[OLD.event_id, NEW.event_id]);
  ELSE
    PERFORM refresh_event_search_docs(ARRAY[NEW.event_id]);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.event_search_docs_on_venue_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_event_search_docs(
    ARRAY(SELECT ev.event_id FROM event_venues ev WHERE ev.venue_id = NEW.id)
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.event_search_docs_on_org_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM refresh_event_search_docs(
    ARRAY(SELECT eo.event_id FROM event_organizations eo WHERE eo.organization_id = NEW.id)
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.event_search_docs_on_event()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.event_search_docs_on_link()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.event_search_docs_on_venue_rename() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.event_search_docs_on_org_rename()   FROM PUBLIC, anon, authenticated;

-- events: the *_normalized columns are filled by the BEFORE trigger
-- events_search_normalized_sync, so they never appear in an UPDATE's SET
-- list and `AFTER UPDATE OF ...` would not fire. Compare OLD and NEW.
-- start_at is included because a past event moved into the future needs
-- a document it never had.
DROP TRIGGER IF EXISTS event_search_docs_event_insert ON public.events;
CREATE TRIGGER event_search_docs_event_insert
  AFTER INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.event_search_docs_on_event();

DROP TRIGGER IF EXISTS event_search_docs_event_update ON public.events;
CREATE TRIGGER event_search_docs_event_update
  AFTER UPDATE ON public.events
  FOR EACH ROW
  WHEN (OLD.title_normalized IS DISTINCT FROM NEW.title_normalized
     OR OLD.description_normalized IS DISTINCT FROM NEW.description_normalized
     OR OLD.start_at IS DISTINCT FROM NEW.start_at)
  EXECUTE FUNCTION public.event_search_docs_on_event();

DROP TRIGGER IF EXISTS event_search_docs_venue_link ON public.event_venues;
CREATE TRIGGER event_search_docs_venue_link
  AFTER INSERT OR DELETE ON public.event_venues
  FOR EACH ROW EXECUTE FUNCTION public.event_search_docs_on_link();

DROP TRIGGER IF EXISTS event_search_docs_venue_link_update ON public.event_venues;
CREATE TRIGGER event_search_docs_venue_link_update
  AFTER UPDATE ON public.event_venues
  FOR EACH ROW
  WHEN (OLD.event_id IS DISTINCT FROM NEW.event_id OR OLD.venue_id IS DISTINCT FROM NEW.venue_id)
  EXECUTE FUNCTION public.event_search_docs_on_link();

DROP TRIGGER IF EXISTS event_search_docs_org_link ON public.event_organizations;
CREATE TRIGGER event_search_docs_org_link
  AFTER INSERT OR DELETE ON public.event_organizations
  FOR EACH ROW EXECUTE FUNCTION public.event_search_docs_on_link();

DROP TRIGGER IF EXISTS event_search_docs_org_link_update ON public.event_organizations;
CREATE TRIGGER event_search_docs_org_link_update
  AFTER UPDATE ON public.event_organizations
  FOR EACH ROW
  WHEN (OLD.event_id IS DISTINCT FROM NEW.event_id OR OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public.event_search_docs_on_link();

DROP TRIGGER IF EXISTS event_search_docs_venue_rename ON public.venues;
CREATE TRIGGER event_search_docs_venue_rename
  AFTER UPDATE ON public.venues
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.event_search_docs_on_venue_rename();

DROP TRIGGER IF EXISTS event_search_docs_org_rename ON public.organizations;
CREATE TRIGGER event_search_docs_org_rename
  AFTER UPDATE ON public.organizations
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.event_search_docs_on_org_rename();

-- Backfill. refresh_event_search_docs skips events already past.
SELECT public.refresh_event_search_docs(
  ARRAY(SELECT id FROM public.events WHERE start_at >= now() - interval '1 day')
);

-- Remove documents as their events pass. Guarded so the migration also
-- applies where pg_cron is absent (the local SQL harness).
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'prune-event-search-docs',
      '23 9 * * *',  -- 09:23 UTC daily, clear of the nightly scrape
      $job$DELETE FROM public.event_search_docs d USING public.events e WHERE e.id = d.event_id AND e.start_at < now() - interval '1 day'$job$
    );
  END IF;
END
$cron$;

-- ------------------------------------------------------------
-- 3. Tiered matching
-- ------------------------------------------------------------

-- The queries to try for a canonical term, tightest first. Whole words
-- only: prefixes and misspellings are search_suggest's job.
CREATE OR REPLACE FUNCTION public.search_tier_queries(p_canon text)
RETURNS tsquery[]
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  cfg     CONSTANT regconfig := 'pg_catalog.simple';
  v_words text[];
  v_n     int;
  v_q     tsquery;
  v_out   tsquery[] := '{}';
BEGIN
  IF coalesce(p_canon, '') = '' THEN
    RETURN v_out;
  END IF;
  v_words := regexp_split_to_array(p_canon, ' +');
  v_n     := cardinality(v_words);

  -- T1: adjacent phrase.
  v_out := array_append(v_out, phraseto_tsquery(cfg, p_canon));

  -- T2: every word, any order; or the words run together (2-3 words).
  IF v_n > 1 THEN
    v_q := plainto_tsquery(cfg, p_canon);
    IF v_n <= 3 THEN
      v_q := v_q || plainto_tsquery(cfg, array_to_string(v_words, ''));
    END IF;
    v_out := array_append(v_out, v_q);
  END IF;

  RETURN v_out;
END;
$$;

-- The first tier that matches any published event at/after p_floor,
-- or NULL. Decided across the whole calendar, before any venue scope or
-- client-side filter, so a hub page never loosens a search that has
-- exact matches elsewhere.
CREATE OR REPLACE FUNCTION public.search_first_matching_query(p_canon text, p_floor timestamptz)
RETURNS tsquery
LANGUAGE plpgsql STABLE
SET search_path = public
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_q tsquery;
BEGIN
  FOREACH v_q IN ARRAY search_tier_queries(p_canon) LOOP
    IF EXISTS (
      SELECT 1
      FROM event_search_docs d
      JOIN events e ON e.id = d.event_id
      WHERE d.tsv @@ v_q
        AND e.status = 'published'
        AND e.start_at >= p_floor
    ) THEN
      RETURN v_q;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.search_first_matching_query(text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Same signature and return type as 074, so every existing caller and
-- every PostgREST filter / order / embed / count chained on it is
-- unchanged.
CREATE OR REPLACE FUNCTION public.search_events(
  p_term text,
  p_floor timestamptz DEFAULT now(),
  p_neighborhood text DEFAULT NULL,
  p_cities text[] DEFAULT NULL
)
RETURNS SETOF public.events
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_q tsquery := search_first_matching_query(search_canon(p_term), p_floor);
BEGIN
  IF v_q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT e.*
  FROM event_search_docs d
  JOIN events e ON e.id = d.event_id
  WHERE d.tsv @@ v_q
    AND e.status = 'published'
    AND e.start_at >= p_floor
    AND (
      (p_neighborhood IS NULL AND p_cities IS NULL)
      OR EXISTS (
        SELECT 1
        FROM event_venues ev
        JOIN venues v ON v.id = ev.venue_id
        WHERE ev.event_id = e.id
          AND (p_neighborhood IS NULL OR v.neighborhood_slug = p_neighborhood)
          AND (p_cities IS NULL OR v.city = ANY (p_cities))
      )
    );
END;
$$;

COMMENT ON FUNCTION public.search_events(text, timestamptz, text, text[]) IS
  'Public event search: published events starting at/after p_floor whose title, description, tags, venue names or organizer names match p_term, optionally limited to events with a venue in p_neighborhood / p_cities. Tries the phrase, then all the words in any order, and returns the first tier that matches anything (see search_tier_queries); whole words only. SECURITY DEFINER so the full-text index is usable; returns SETOF events so PostgREST can filter, order, embed and count on top.';

REVOKE ALL ON FUNCTION public.search_events(text, timestamptz, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_events(text, timestamptz, text, text[]) TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Replacement term for empty results
-- ------------------------------------------------------------

-- Edit distance between what was typed and a known word. Swapping two
-- neighbouring letters is one typo (plain Levenshtein charges two), and
-- a wrong first letter costs one extra.
CREATE OR REPLACE FUNCTION public.search_typo_cost(p_typed text, p_word text)
RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_typed = p_word THEN 0
    ELSE
      CASE
        WHEN length(p_typed) = length(p_word) AND EXISTS (
          SELECT 1
          FROM generate_series(1, length(p_typed) - 1) AS i
          WHERE substr(p_typed, i, 1)     = substr(p_word, i + 1, 1)
            AND substr(p_typed, i + 1, 1) = substr(p_word, i, 1)
            AND left(p_typed, i - 1)      = left(p_word, i - 1)
            AND substr(p_typed, i + 2)    = substr(p_word, i + 2)
        ) THEN 1
        ELSE extensions.levenshtein_less_equal(p_typed, p_word, 3)
      END
      + CASE WHEN left(p_typed, 1) <> left(p_word, 1) THEN 1 ELSE 0 END
  END;
$$;

CREATE OR REPLACE FUNCTION public.search_suggest(
  p_term text,
  p_floor timestamptz DEFAULT now()
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_canon      text := search_canon(p_term);
  v_words      text[];
  v_n          int;
  v_head       text;
  v_last       text;
  v_vocab      text[];   -- words in upcoming titles / venue / organizer names,
  v_ndoc       int[];    -- and how many events carry each; most common first
  v_candidate  text;
  v_suggestion text;
BEGIN
  IF v_canon = '' OR length(v_canon) > 80 THEN
    RETURN NULL;
  END IF;
  -- Only ever a fallback: if the term matches as typed, say nothing.
  IF search_first_matching_query(v_canon, p_floor) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  v_words := regexp_split_to_array(v_canon, ' +');
  v_n     := cardinality(v_words);
  IF v_n > 6 THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(s.word ORDER BY s.ndoc DESC, s.word),
         array_agg(s.ndoc ORDER BY s.ndoc DESC, s.word)
  INTO v_vocab, v_ndoc
  FROM ts_stat(format(
    'SELECT d.name_tsv FROM public.event_search_docs d JOIN public.events e ON e.id = d.event_id '
    'WHERE e.status = ''published'' AND e.start_at >= %L::timestamptz',
    p_floor
  )) AS s;
  IF v_vocab IS NULL THEN
    RETURN NULL;
  END IF;

  -- 1. Completion: finish the last word. Try the most common endings
  --    first and keep the first one the whole term then matches with.
  v_last := v_words[v_n];
  v_head := array_to_string(v_words[1 : v_n - 1], ' ');
  IF length(v_last) >= 3 THEN
    FOR v_candidate IN
      SELECT v.word
      FROM unnest(v_vocab) WITH ORDINALITY AS v (word, ord)
      WHERE left(v.word, length(v_last)) = v_last
        AND v.word <> v_last
      ORDER BY v.ord
      LIMIT 5
    LOOP
      v_suggestion := btrim(v_head || ' ' || v_candidate);
      IF search_first_matching_query(v_suggestion, p_floor) IS NOT NULL THEN
        RETURN v_suggestion;
      END IF;
    END LOOP;
  END IF;

  -- 2. Spelling: replace each long, unknown word with its nearest known
  --    word, if one is near enough.
  SELECT string_agg(
           CASE
             WHEN length(t.w) < 5
               OR t.w ~ '[0-9]'
               OR t.w = ANY (v_vocab)
             THEN t.w
             ELSE coalesce((
               SELECT v.word
               FROM unnest(v_vocab, v_ndoc) AS v (word, ndoc)
               WHERE abs(length(v.word) - length(t.w)) <= 2
                 AND search_typo_cost(t.w, v.word) <= CASE WHEN length(t.w) >= 9 THEN 2 ELSE 1 END
               ORDER BY search_typo_cost(t.w, v.word), v.ndoc DESC, v.word
               LIMIT 1
             ), t.w)
           END,
           ' ' ORDER BY t.ord
         )
  INTO v_suggestion
  FROM unnest(v_words) WITH ORDINALITY AS t (w, ord);

  IF v_suggestion IS NULL OR v_suggestion = v_canon THEN
    RETURN NULL;
  END IF;
  IF search_first_matching_query(v_suggestion, p_floor) IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN v_suggestion;
END;
$$;

COMMENT ON FUNCTION public.search_suggest(text, timestamptz) IS
  'Replacement term for a search that found nothing, or NULL: the last word completed (3+ letters typed), else misspelled 5+ letter words corrected (1 typo for 5-8 letters, 2 for 9+, wrong first letter counts double). Vocabulary is upcoming published titles / venue names / organizer names. The returned term always matches something; NULL whenever the original term does.';

REVOKE ALL ON FUNCTION public.search_suggest(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_suggest(text, timestamptz) TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Retire 074's index and helper
-- ------------------------------------------------------------

DROP INDEX IF EXISTS public.events_search_tsv_idx;
DROP FUNCTION IF EXISTS public.event_search_tsv(text, text);

ANALYZE public.event_search_docs;
